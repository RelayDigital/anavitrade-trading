#!/usr/bin/env python3
"""
Reinforcement Learning Trading Agent — PPO with dual-regime reward function
===========================================================================
The agent learns WHEN to enter trades and HOW long to hold, using a reward
function that maximizes profit while heavily penalizing drawdown.

Architecture:
  - Observation: 30 MTF features + 7 context features = 37-dimensional
  - Action space: 0=HOLD, 1=ENTER_LONG, 2=EXIT
  - Reward: asymmetric (losses hurt 2x more than wins help)
  - Environment: Gymnasium TradingEnv with chronological bar-by-bar stepping

Usage:
  /opt/anavitrade/venv/bin/python3 scripts/ml/rl_train.py
  /opt/anavitrade/venv/bin/python3 scripts/ml/rl_train.py --quick
  /opt/anavitrade/venv/bin/python3 scripts/ml/rl_train.py --timesteps 1000000
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

warnings.filterwarnings("ignore")
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"

import gymnasium as gym
from gymnasium import spaces
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback, EvalCallback
from stable_baselines3.common.vec_env import DummyVecEnv, VecNormalize

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────────────────────────────────────

FEATURE_NAMES: List[str] = [
    "ao_gradient", "bb_sqz_product",
    "h1_ao", "h1_bb_pos", "h1_bb_width", "h1_ma7_slope", "h1_macd", "h1_rsi",
    "h1_trend", "h1_vol_z",
    "h4_ao", "h4_bb_pos", "h4_bb_width", "h4_macd", "h4_rsi", "h4_trend",
    "m15_ao", "m15_atr_pct", "m15_bb_pos", "m15_bb_width", "m15_ma7_slope",
    "m15_macd", "m15_rsi", "m15_swing_dist", "m15_trend", "m15_vol_z",
    "mtf_15_1h_agree", "mtf_triple_agree", "rsi_gradient", "tf_vol_sum",
]

NUM_FEATURES = len(FEATURE_NAMES)  # 30
CONTEXT_FEATURES = 7  # in_position, pnl_pct, bars_held, fav, adv, dist_from_entry, dd_pct
OBS_DIM = NUM_FEATURES + CONTEXT_FEATURES  # 37

DEFAULT_TIMESTEPS = 500_000
POSITION_SIZE_PCT = 0.05  # 5% of equity per trade
STOP_ATR_MULT = 2.0
TP_RR = 2.0  # 1:2 risk-reward
MAX_BARS_HELD = 48

MODEL_OUTPUT_DIR = Path("/opt/anavitrade/models/rl")
KLINES_PATH = Path("scripts/data/klines-mtf.json")
EXPANDED_DATA_PATH = Path("scripts/data/training-data-mtf-expanded.json")

# ─────────────────────────────────────────────────────────────────────────────
# SELF-CONTAINED INDICATOR FUNCTIONS (same math as pipeline/features.py)
# ─────────────────────────────────────────────────────────────────────────────

def _sma(values: np.ndarray, period: int) -> np.ndarray:
    """Simple Moving Average."""
    out = np.zeros_like(values)
    if len(values) < period:
        return out
    cumsum = np.cumsum(np.insert(values, 0, 0))
    out[period - 1:] = (cumsum[period:] - cumsum[:-period]) / period
    return out


def _ema(values: np.ndarray, period: int) -> np.ndarray:
    """Exponential Moving Average."""
    out = np.zeros(len(values), dtype=np.float64)
    if len(values) == 0:
        return out
    alpha = 2.0 / (period + 1)
    out[0] = float(values[0])
    for i in range(1, len(values)):
        out[i] = alpha * float(values[i]) + (1 - alpha) * out[i - 1]
    return out


def _rsi(close: np.ndarray, period: int = 14) -> np.ndarray:
    """Relative Strength Index (0-100). Uses Wilder's smoothing."""
    out = np.full(len(close), 50.0)
    if len(close) < period + 1:
        return out
    delta = np.diff(close)
    gain = np.where(delta > 0, delta, 0.0)
    loss = np.where(delta < 0, -delta, 0.0)
    avg_gain = _ema(gain, period)  # use EMA for correct length
    avg_loss = _ema(loss, period)
    avg_gain[avg_gain == 0] = 1e-10
    avg_loss[avg_loss == 0] = 1e-10
    rs = avg_gain / avg_loss
    # out is len(close), rs is len(close)-1
    out[period + 1:] = 100.0 - (100.0 / (1.0 + rs[period:]))
    return np.clip(out, 0, 100)


def _atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    """Average True Range."""
    tr = np.zeros(len(high))
    tr[0] = float(high[0] - low[0])
    for i in range(1, len(high)):
        tr[i] = max(
            float(high[i] - low[i]),
            abs(float(high[i] - close[i - 1])),
            abs(float(low[i] - close[i - 1])),
        )
    return _sma(tr, period)


def _bollinger(close: np.ndarray, period: int = 20, n_std: float = 2.0) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Bollinger Bands returning (middle, upper, lower)."""
    mid = _sma(close, period)
    rolling_std = np.zeros(len(close))
    for i in range(period - 1, len(close)):
        window = close[i - period + 1 : i + 1]
        rolling_std[i] = float(np.std(window, ddof=0))  # population std = training match
    upper = mid + n_std * rolling_std
    lower = mid - n_std * rolling_std
    return mid, upper, lower


def _awesome(high: np.ndarray, low: np.ndarray) -> np.ndarray:
    """Awesome Oscillator: SMA5(HL/2) - SMA34(HL/2)."""
    hl2 = (high + low) / 2.0
    return _sma(hl2, 5) - _sma(hl2, 34)


def _macd_hist(close: np.ndarray, fast: int = 12, slow: int = 26, signal: int = 9) -> Tuple[np.ndarray, np.ndarray]:
    """MACD line and histogram."""
    ema_fast = _ema(close, fast)
    ema_slow = _ema(close, slow)
    macd_line = ema_fast - ema_slow
    signal_line = _ema(macd_line, signal)
    histogram = macd_line - signal_line
    return macd_line, histogram


def _slope(values: np.ndarray, lookback: int = 7) -> np.ndarray:
    """Linear regression slope per bar (degrees)."""
    out = np.zeros(len(values))
    if len(values) < lookback:
        return out
    xs = np.arange(lookback, dtype=np.float64)
    xs_mean = xs.mean()
    denom = ((xs - xs_mean) ** 2).sum()
    for i in range(lookback - 1, len(values)):
        ys = values[i - lookback + 1 : i + 1]
        slope = ((xs - xs_mean) * (ys - ys.mean())).sum() / denom if denom > 0 else 0
        out[i] = float(np.degrees(np.arctan(slope)))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# FEATURE BUILDER
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Bar:
    open: float
    high: float
    low: float
    close: float
    volume: float
    timestamp: int
    features: Dict[str, float] = field(default_factory=dict)


def build_features_from_candles(candles: List[Dict]) -> List[Bar]:
    """Compute all 30 MTF features for a list of OHLCV candles. Returns list of Bars."""
    if len(candles) < 100:
        return []
    o = np.array([c["open"] for c in candles], dtype=np.float64)
    h = np.array([c["high"] for c in candles], dtype=np.float64)
    l_ = np.array([c["low"] for c in candles], dtype=np.float64)
    c = np.array([c["close"] for c in candles], dtype=np.float64)
    v = np.array([c["volume"] for c in candles], dtype=np.float64)
    t = np.array([c["timestamp"] for c in candles], dtype=np.int64)

    n = len(c)
    atr14 = _atr(h, l_, c, 14)
    rsi14 = _rsi(c, 14)
    mid, upper, lower = _bollinger(c, 20, 2.0)
    bb_width = np.where(mid > 0, (upper - lower) / mid, 0.0)
    bb_pos = np.where((upper - lower) > 0, (c - lower) / (upper - lower), 0.5)
    ao = _awesome(h, l_)
    macd_line, macd_hist = _macd_hist(c)
    ma7_slope = _slope(_sma(c, 7), 7)
    atr_pct = np.where(c > 0, atr14 / c * 100, 0.0)
    vol_mean = _sma(v, 20)
    vol_z = np.where(vol_mean > 0, (v - vol_mean) / vol_mean, 0.0)
    trend = np.where(c > _sma(c, 25), 1.0, 0.0)

    warmup = max(34, 26, 20, 14) + 5
    if n < warmup:
        return []

    bars = []
    for i in range(n):
        features = {
            "rsi": float(rsi14[i]) if i < n else 50.0,
            "bb_pos": float(np.clip(bb_pos[i], 0, 1)),
            "bb_width": float(bb_width[i]),
            "ao": float(ao[i]) if i < n else 0.0,
            "macd": 1.0 if macd_hist[i] > 0 else 0.0,
            "atr_pct": float(atr_pct[i]) if i < n else 1.0,
            "vol_z": float(vol_z[i]) if i < n else 0.0,
            "ma7_slope": float(ma7_slope[i]) if i < n else 0.0,
            "trend": float(trend[i]) if i < n else 0.0,
        }
        bars.append(Bar(
            open=float(o[i]), high=float(h[i]), low=float(l_[i]),
            close=float(c[i]), volume=float(v[i]),
            timestamp=int(t[i]), features=features,
        ))
    return bars


def build_mtf_bars(raw_15m: List[Dict], raw_1h: List[Dict], raw_4h: List[Dict]) -> Optional[List[Dict[str, float]]]:
    """Build 30-feature vectors for all 15m bars, aligning 1h/4h context."""
    bars_15m = build_features_from_candles(raw_15m)
    bars_1h = build_features_from_candles(raw_1h)
    bars_4h = build_features_from_candles(raw_4h)
    warmup = max(34, 26, 20, 14) + 5
    if len(bars_15m) < warmup:
        return None

    rows = []
    for i, b15 in enumerate(bars_15m):
        if i < warmup:
            continue
        ts = b15.timestamp

        # Find most recent completed 1h bar
        h1_idx = None
        for j in range(len(bars_1h) - 1, -1, -1):
            if bars_1h[j].timestamp < ts:
                h1_idx = j
                break
        b1h = bars_1h[h1_idx] if h1_idx is not None else b15

        # Find most recent completed 4h bar
        h4_idx = None
        for j in range(len(bars_4h) - 1, -1, -1):
            if bars_4h[j].timestamp < ts:
                h4_idx = j
                break
        b4h = bars_4h[h4_idx] if h4_idx is not None else b15

        f15 = b15.features
        f1h = b1h.features
        f4h = b4h.features

        # Cross-TF features
        h1m15_agree = 1.0 if f15["macd"] > 0 and f1h["macd"] > 0 else 0.0
        if f15["macd"] <= 0 and f1h["macd"] <= 0:
            h1m15_agree = 1.0
        triple_agree = 1.0 if f15["macd"] > 0 and f1h["macd"] > 0 and f4h["macd"] > 0 else 0.0
        if f15["macd"] <= 0 and f1h["macd"] <= 0 and f4h["macd"] <= 0:
            triple_agree = 1.0
        prev_15 = bars_15m[i - 1] if i > 0 else b15
        rsi_grad = f15["rsi"] - prev_15.features["rsi"]
        ao_grad = f15["ao"] - prev_15.features["ao"]
        bb_sqz = 1.0 / (f15["bb_width"] * f1h["bb_width"] + 1e-10)
        tf_vol = f15["vol_z"] + f1h["vol_z"]

        row = {
            "ao_gradient": ao_grad,
            "bb_sqz_product": min(bb_sqz, 100.0),
            "h1_ao": f1h["ao"], "h1_bb_pos": f1h["bb_pos"], "h1_bb_width": f1h["bb_width"],
            "h1_ma7_slope": f1h["ma7_slope"], "h1_macd": f1h["macd"], "h1_rsi": f1h["rsi"],
            "h1_trend": f1h["trend"], "h1_vol_z": f1h["vol_z"],
            "h4_ao": f4h["ao"], "h4_bb_pos": f4h["bb_pos"], "h4_bb_width": f4h["bb_width"],
            "h4_macd": f4h["macd"], "h4_rsi": f4h["rsi"], "h4_trend": f4h["trend"],
            "m15_ao": f15["ao"], "m15_atr_pct": f15["atr_pct"], "m15_bb_pos": f15["bb_pos"],
            "m15_bb_width": f15["bb_width"], "m15_ma7_slope": f15["ma7_slope"],
            "m15_macd": f15["macd"], "m15_rsi": f15["rsi"],
            "m15_swing_dist": 1.0, "m15_trend": f15["trend"], "m15_vol_z": f15["vol_z"],
            "mtf_15_1h_agree": h1m15_agree, "mtf_triple_agree": triple_agree,
            "rsi_gradient": rsi_grad, "tf_vol_sum": tf_vol,
            "_bar": b15, "_bar_1h": b1h, "_bar_4h": b4h,  # keep for reward computation
        }
        rows.append(row)
    return rows


# ─────────────────────────────────────────────────────────────────────────────
# TRADING ENVIRONMENT
# ─────────────────────────────────────────────────────────────────────────────

class TradingEnv(gym.Env):
    """
    Bar-by-bar trading environment for PPO training.

    Observation (37-d): [30 MTF features, in_position, unrealized_pnl_pct,
                         bars_held_norm, max_favorable_r, max_adverse_r,
                         dist_from_entry_norm, account_dd_pct]

    Action: 0=HOLD, 1=ENTER_LONG, 2=EXIT
    """

    def __init__(self, feature_rows: List[Dict], initial_equity: float = 10000.0,
                 position_pct: float = 0.05):
        super().__init__()
        self.feature_rows = feature_rows
        self.initial_equity = initial_equity
        self.position_pct = position_pct
        self.cur_idx = 0

        # Observation: 37 continuous values
        self.observation_space = spaces.Box(
            low=-np.inf, high=np.inf, shape=(OBS_DIM,), dtype=np.float64,
        )
        # Action: 0=HOLD, 1=ENTER, 2=EXIT
        self.action_space = spaces.Discrete(3)

        # State
        self.in_position = False
        self.entry_idx = -1
        self.entry_price = 0.0
        self.position_size = 0.0
        self.equity = initial_equity
        self.max_fav_r = 0.0
        self.max_adv_r = 0.0
        self.peak_equity = initial_equity
        self.total_pnl = 0.0
        self.trade_count = 0
        self.win_count = 0

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self.cur_idx = np.random.randint(0, max(1, len(self.feature_rows) - 200))
        self.in_position = False
        self.entry_idx = -1
        self.entry_price = 0.0
        self.position_size = 0.0
        self.equity = self.initial_equity
        self.max_fav_r = 0.0
        self.max_adv_r = 0.0
        self.peak_equity = self.initial_equity
        self.total_pnl = 0.0
        self.trade_count = 0
        self.win_count = 0
        return self._get_obs(), {}

    def _get_obs(self) -> np.ndarray:
        row = self.feature_rows[self.cur_idx]
        feats = [float(row.get(fn, 0) or 0) for fn in FEATURE_NAMES]

        pnl_pct = 0.0
        bars_held_norm = 0.0
        fav_r = self.max_fav_r
        adv_r = self.max_adv_r
        dist_norm = 0.0

        if self.in_position and self.entry_price > 0:
            bar = row.get("_bar")
            if bar:
                current_price = bar.close
                pnl_pct = (current_price - self.entry_price) / self.entry_price
                bars_held = self.cur_idx - self.entry_idx
                bars_held_norm = min(bars_held / MAX_BARS_HELD, 1.0)
                atr = float(row.get("m15_atr_pct", 1.0) or 1.0) / 100 * self.entry_price
                if atr > 0:
                    dist_norm = (current_price - self.entry_price) / atr

        dd_pct = (self.peak_equity - self.equity) / self.peak_equity if self.peak_equity > 0 else 0.0

        context = [
            float(self.in_position), pnl_pct, bars_held_norm,
            fav_r, adv_r, dist_norm, dd_pct,
        ]
        return np.array(feats + context, dtype=np.float64)

    def _compute_reward(self, action: int) -> float:
        """Asymmetric reward: losses hurt 2x more than wins."""
        row = self.feature_rows[self.cur_idx]
        r = 0.0

        if action == 1:  # ENTER
            if not self.in_position:
                h4_bb_pos = float(row.get("h4_bb_pos", 0.5) or 0.5)
                m15_rsi = float(row.get("m15_rsi", 50) or 50)
                if h4_bb_pos < 0.3 and m15_rsi < 45:
                    r += 0.1  # quality entry bonus
            else:
                r -= 1.0  # invalid: already in position

        elif action == 0:  # HOLD
            mtf_triple = float(row.get("mtf_triple_agree", 0) or 0)
            if not self.in_position and mtf_triple > 0:
                r -= 0.01  # small penalty for skipping aligned setup

        elif action == 2:  # EXIT
            if not self.in_position:
                r -= 1.0  # invalid: nothing to exit
            else:
                bar = row.get("_bar")
                current_price = bar.close if bar else self.entry_price
                pnl_r = max(self.max_fav_r, 0.0) if self.max_fav_r > 0 else (-max(self.max_adv_r, 0.0))
                pnl_pct = (current_price - self.entry_price) / self.entry_price
                self.equity += self.equity * pnl_pct * self.position_pct
                self.total_pnl += pnl_pct * self.position_pct * self.initial_equity

                if pnl_r > 0:
                    r += 1.0 + 0.1 * pnl_r
                    self.win_count += 1
                else:
                    r -= 2.0 + 0.2 * abs(pnl_r)  # losses hurt 2x
                self.trade_count += 1

                if self.max_adv_r < -1.0:
                    r -= 0.5  # drawdown penalty

                self.in_position = False
                self.max_fav_r = 0.0
                self.max_adv_r = 0.0

        # Update tracked values for current bar (in-position)
        if self.in_position:
            bar = row.get("_bar")
            if bar:
                current_price = bar.close
                atr = max(float(row.get("m15_atr_pct", 1.0) or 1.0) / 100 * self.entry_price,
                          self.entry_price * 0.001)
                if atr > 0:
                    pnl_r = (current_price - self.entry_price) / atr
                    self.max_fav_r = max(self.max_fav_r, pnl_r)
                    self.max_adv_r = min(self.max_adv_r, pnl_r)

            # Auto-exit conditions
            bars_held = self.cur_idx - self.entry_idx
            if bars_held > MAX_BARS_HELD:
                r -= 0.5  # penalize bag-holding
            if self.max_adv_r < -1.0:
                r -= 0.02 * bars_held  # decaying penalty for holding through drawdown

        # Global drawdown penalty
        dd_pct = (self.peak_equity - max(self.equity, 1.0)) / max(self.peak_equity, 1.0)
        if dd_pct > 0.10:
            r -= 1.0

        self.peak_equity = max(self.peak_equity, self.equity)

        return r

    def step(self, action: int):
        reward = self._compute_reward(action)

        # Process ENTER action
        if action == 1 and not self.in_position:
            self.in_position = True
            self.entry_idx = self.cur_idx
            bar = self.feature_rows[self.cur_idx].get("_bar")
            self.entry_price = bar.close if bar else 0.0
            self.max_fav_r = 0.0
            self.max_adv_r = 0.0

        # Advance bar
        self.cur_idx += 1
        terminated = self.cur_idx >= len(self.feature_rows) - 1
        truncated = self.cur_idx >= len(self.feature_rows) - 2

        # Force exit on termination
        if terminated and self.in_position:
            force_reward = self._compute_reward(2)
            reward += force_reward

        obs = self._get_obs()
        return obs, reward, terminated, truncated, {
            "equity": self.equity,
            "in_position": int(self.in_position),
            "trades": self.trade_count,
            "win_rate": self.win_count / max(self.trade_count, 1),
        }


# ─────────────────────────────────────────────────────────────────────────────
# EVALUATION
# ─────────────────────────────────────────────────────────────────────────────

def evaluate_agent(model, feature_rows: List[Dict], initial_equity: float = 10000.0) -> Dict:
    """Run the trained agent on out-of-sample data and report metrics."""
    env = TradingEnv(feature_rows, initial_equity=initial_equity)
    obs, _ = env.reset()

    equity_curve = [initial_equity]
    trades_log = []
    in_trade = False
    trade_entry = 0.0
    trade_entry_idx = 0

    for step_idx in range(len(feature_rows) - 2):
        action, _ = model.predict(obs, deterministic=True)
        prev_in_position = env.in_position
        prev_entry_price = env.entry_price
        obs, reward, terminated, truncated, info = env.step(int(action))

        equity_curve.append(env.equity)

        if prev_in_position and not env.in_position:
            # Trade closed
            exit_price = feature_rows[env.cur_idx].get("_bar").close if step_idx < len(feature_rows) - 1 else prev_entry_price
            pnl_pct = (exit_price - prev_entry_price) / prev_entry_price if prev_entry_price > 0 else 0
            trades_log.append({
                "entry_idx": trade_entry_idx,
                "exit_idx": step_idx,
                "entry_price": prev_entry_price,
                "exit_price": exit_price,
                "pnl_pct": pnl_pct,
                "win": pnl_pct > 0,
            })
        elif not prev_in_position and env.in_position:
            trade_entry_idx = step_idx
            bar = feature_rows[step_idx].get("_bar")
            trade_entry = bar.close if bar else 0.0

        if terminated:
            break

    n_trades = len(trades_log)
    if n_trades == 0:
        return {"error": "No trades executed", "trades": 0}

    wins = sum(1 for t in trades_log if t["win"])
    wr = wins / n_trades
    gross_profit = sum(t["pnl_pct"] for t in trades_log if t["pnl_pct"] > 0)
    gross_loss = abs(sum(t["pnl_pct"] for t in trades_log if t["pnl_pct"] < 0))
    pf = gross_profit / gross_loss if gross_loss > 0 else 999.0

    equity_arr = np.array(equity_curve)
    peak = np.maximum.accumulate(equity_arr)
    dd = (peak - equity_arr) / peak
    max_dd = float(dd.max() * 100)

    returns = np.diff(equity_arr) / equity_arr[:-1]
    sharpe = float(np.mean(returns) / np.std(returns) * np.sqrt(252)) if len(returns) > 1 and np.std(returns) > 0 else 0.0

    total_return = (equity_arr[-1] - initial_equity) / initial_equity * 100

    return {
        "trades": n_trades,
        "win_rate": round(wr, 4),
        "profit_factor": round(pf, 2),
        "total_return_pct": round(total_return, 1),
        "max_drawdown_pct": round(max_dd, 1),
        "sharpe": round(sharpe, 2),
        "avg_holding_bars": round(np.mean([t["exit_idx"] - t["entry_idx"] for t in trades_log]), 1) if n_trades > 0 else 0,
        "equity_start": float(equity_arr[0]),
        "equity_end": float(equity_arr[-1]),
    }


def random_baseline(feature_rows: List[Dict], n_runs: int = 5) -> Dict:
    """Random agent baseline."""
    results = []
    for _ in range(n_runs):
        env = TradingEnv(feature_rows)
        obs, _ = env.reset()
        for _ in range(len(feature_rows) - 2):
            action = np.random.choice([0, 1, 2], p=[0.7, 0.15, 0.15])
            obs, _, terminated, truncated, _ = env.step(action)
            if terminated:
                break
        results.append({"trades": env.trade_count, "win_rate": env.win_count / max(env.trade_count, 1) if env.trade_count > 0 else 0})
    return {
        "avg_trades": round(np.mean([r["trades"] for r in results]), 1),
        "avg_wr": round(np.mean([r["win_rate"] for r in results]), 2),
    }


# ─────────────────────────────────────────────────────────────────────────────
# DATA LOADING
# ─────────────────────────────────────────────────────────────────────────────

def load_features_from_klines(json_path: Path) -> Optional[List[Dict]]:
    """Load klines-mtf.json and build MTF features."""
    if not json_path.exists():
        print(f"ERROR: {json_path} not found")
        return None
    with open(json_path) as f:
        pairs = json.load(f)

    all_rows = []
    for pair in pairs:
        klines = pair.get("klines", {})
        raw_15m = klines.get("15m", [])
        raw_1h = klines.get("1h", [])
        raw_4h = klines.get("4h", [])
        if len(raw_15m) < 100 or len(raw_1h) < 50 or len(raw_4h) < 20:
            continue

        rows = build_mtf_bars(raw_15m, raw_1h, raw_4h)
        if rows:
            all_rows.extend(rows)

    if len(all_rows) == 0:
        print("ERROR: No valid feature rows generated")
        return None
    print(f"Loaded {len(all_rows)} feature rows from {len(pairs)} pairs")
    return all_rows


def load_features_from_expanded(json_path: Path) -> Optional[List[Dict]]:
    """Load from expanded training data JSONL (each line is a dict with 30 features)."""
    if not json_path.exists():
        return None
    rows = []
    with open(json_path) as f:
        for line in f:
            row = json.loads(line.strip())
            # Check we have all features
            if all(fn in row for fn in FEATURE_NAMES):
                rows.append(row)
    if len(rows) == 0:
        return None
    print(f"Loaded {len(rows)} feature rows from expanded dataset")
    return rows


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="RL Trading Agent — PPO training")
    parser.add_argument("--timesteps", type=int, default=DEFAULT_TIMESTEPS, help="Total PPO timesteps")
    parser.add_argument("--output", type=str, default=str(MODEL_OUTPUT_DIR), help="Output directory")
    parser.add_argument("--quick", action="store_true", help="Quick test (5 pairs, 50K timesteps)")
    parser.add_argument("--expanded", action="store_true", help="Use expanded training data")
    parser.add_argument("--ent-coef", type=float, default=0.01, help="Entropy coefficient")
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.quick:
        args.timesteps = 50000
        print(f"=== QUICK MODE: {args.timesteps} timesteps ===")

    # Load data
    rows = None
    if args.expanded and EXPANDED_DATA_PATH.exists():
        rows = load_features_from_expanded(EXPANDED_DATA_PATH)
    if rows is None:
        rows = load_features_from_klines(KLINES_PATH)
    if rows is None:
        print("FATAL: No data available")
        sys.exit(1)

    # Chronological split (70/30)
    split_idx = int(len(rows) * 0.7)
    train_rows = rows[:split_idx]
    test_rows = rows[split_idx:]

    # Limit pairs in quick mode
    if args.quick:
        train_rows = train_rows[:5000]
        test_rows = test_rows[:1000]

    print(f"Train rows: {len(train_rows)}, Test rows: {len(test_rows)}")

    # Create environments
    def make_train_env():
        return TradingEnv(train_rows, position_pct=POSITION_SIZE_PCT)

    def make_eval_env():
        return TradingEnv(test_rows, position_pct=POSITION_SIZE_PCT)

    train_env = DummyVecEnv([make_train_env])
    train_env = VecNormalize(train_env, norm_obs=True, norm_reward=False)

    eval_env = DummyVecEnv([make_eval_env])
    eval_env = VecNormalize(eval_env, norm_obs=True, norm_reward=False)

    # PPO model
    import torch.nn as nn
    policy_kwargs = dict(
        net_arch=dict(pi=[128, 64], vf=[128, 64]),
        activation_fn=nn.ReLU,
    )

    model = PPO(
        "MlpPolicy",
        train_env,
        policy_kwargs=policy_kwargs,
        learning_rate=3e-4,
        n_steps=2048,
        batch_size=64,
        n_epochs=10,
        gamma=0.99,
        gae_lambda=0.95,
        clip_range=0.2,
        ent_coef=args.ent_coef,
        vf_coef=0.5,
        max_grad_norm=0.5,
        verbose=1,
    )

    # Eval callback
    eval_callback = EvalCallback(
        eval_env,
        best_model_save_path=str(output_dir / "best"),
        log_path=str(output_dir / "logs"),
        eval_freq=10000,
        n_eval_episodes=3,
        deterministic=True,
        render=False,
    )

    print(f"\n=== Training PPO for {args.timesteps} timesteps ===")
    model.learn(total_timesteps=args.timesteps, callback=eval_callback)
    model.save(str(output_dir / "ppo_trading_agent"))
    train_env.save(str(output_dir / "vec_normalize.pkl"))

    print(f"\n=== Model saved to {output_dir}/ppo_trading_agent.zip ===")

    # Evaluate
    print("\n=== Evaluation ===")
    eval_model = PPO.load(str(output_dir / "ppo_trading_agent"))
    results = evaluate_agent(eval_model, test_rows)
    print(f"  Trades: {results.get('trades', 0)}")
    print(f"  Win Rate: {results.get('win_rate', 0)*100:.1f}%")
    print(f"  Profit Factor: {results.get('profit_factor', 0):.2f}")
    print(f"  Total Return: {results.get('total_return_pct', 0):.1f}%")
    print(f"  Max DD: {results.get('max_drawdown_pct', 0):.1f}%")
    print(f"  Sharpe: {results.get('sharpe', 0):.2f}")

    # Random baseline
    rand = random_baseline(test_rows)
    print(f"\n=== Random Baseline ===")
    print(f"  Avg Trades: {rand['avg_trades']}")
    print(f"  Avg WR: {rand['avg_wr']*100:.1f}%")

    # Save report
    report = {
        "version": "rl_train_v1",
        "algorithm": "PPO",
        "timesteps": args.timesteps,
        "data": {"train_rows": len(train_rows), "test_rows": len(test_rows)},
        "eval": results,
        "random_baseline": rand,
        "config": {
            "position_size_pct": POSITION_SIZE_PCT,
            "stop_atr_mult": STOP_ATR_MULT,
            "tp_rr": TP_RR,
            "ent_coef": args.ent_coef,
        },
    }
    with open(output_dir / "eval_report.json", "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nReport saved to {output_dir}/eval_report.json")


if __name__ == "__main__":
    main()
