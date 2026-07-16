#!/usr/bin/env python3
"""
Deep Learning Training Script for Cryptocurrency Trading Signal Prediction
===========================================================================
Trains 4 neural architectures on sequences of 30 MTF feature vectors:
  1. BiLSTM with Multi-Head Attention
  2. Temporal Convolutional Network (TCN)
  3. Mini-PatchTST (Transformer-based)
  4. Simple CNN (baseline)

All models process FEATURE SEQUENCES (30 bars x 30 features), not single-bar
snapshots. Chronological train/val/test split by timestamp. No future data.

Usage:
  /opt/anavitrade/venv/bin/python3 scripts/ml/dl_train.py
  /opt/anavitrade/venv/bin/python3 scripts/ml/dl_train.py --quick
  /opt/anavitrade/venv/bin/python3 scripts/ml/dl_train.py --models lstm,tcn
  /opt/anavitrade/venv/bin/python3 scripts/ml/dl_train.py --epochs 50
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import warnings
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler
from torch.utils.data import DataLoader, Dataset

warnings.filterwarnings("ignore")

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

NUM_FEATURES: int = len(FEATURE_NAMES)  # 30
SEQ_LEN: int = 30  # 30 bars lookback
BATCH_SIZE: int = 64
DEFAULT_EPOCHS: int = 100
MODEL_OUTPUT_DIR: Path = Path("/opt/anavitrade/models/dl")
REPORT_PATH: Path = MODEL_OUTPUT_DIR / "report.json"
EXPANDED_DATA_PATH: Path = Path("scripts/data/training-data-mtf-expanded.json")
KLINES_PATH: Path = Path("scripts/data/klines-mtf.json")

# Backtest config for feature computation (inline from production-backtest.py)
STOP_ATR_MULT: float = 2.0
RR_TARGET: float = 2.0
MAX_LOOKFORWARD_BARS: int = 48
MA_SLOW: int = 99


# ─────────────────────────────────────────────────────────────────────────────
# SELF-CONTAINED INDICATOR FUNCTIONS (inlined from pipeline/features.py)
# ─────────────────────────────────────────────────────────────────────────────

def _sma(values: np.ndarray, period: int) -> np.ndarray:
    """Simple Moving Average. First (period-1) values are 0."""
    out = np.zeros_like(values)
    if len(values) < period:
        return out
    cumsum = np.cumsum(np.insert(values, 0, 0.0))
    out[period - 1:] = (cumsum[period:] - cumsum[:-period]) / period
    return out


def _ema(values: np.ndarray, period: int) -> np.ndarray:
    """Exponential Moving Average."""
    out = np.zeros_like(values)
    if len(values) < 2:
        out[0] = values[0]
        return out
    k = 2.0 / (period + 1)
    out[0] = values[0]
    for i in range(1, len(values)):
        out[i] = values[i] * k + out[i - 1] * (1.0 - k)
    return out


def _true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    tr = np.zeros_like(high)
    tr[0] = high[0] - low[0]
    for i in range(1, len(high)):
        tr[i] = max(
            high[i] - low[i],
            abs(high[i] - close[i - 1]),
            abs(low[i] - close[i - 1]),
        )
    return tr


def _atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int) -> np.ndarray:
    return _sma(_true_range(high, low, close), period)


def _rsi(close: np.ndarray, period: int) -> np.ndarray:
    out = np.full(len(close), 50.0)
    if len(close) < period + 1:
        return out
    delta = np.diff(close)
    gains = np.maximum(delta, 0)
    losses = np.maximum(-delta, 0)
    for i in range(period, len(close)):
        avg_gain = gains[i - period : i].mean()
        avg_loss = losses[i - period : i].mean()
        if avg_loss == 0:
            out[i] = 100.0
        else:
            out[i] = 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    return out


def _bb(close: np.ndarray, period: int, std_mult: float) -> Tuple[
    np.ndarray, np.ndarray, np.ndarray, np.ndarray,
]:
    mid = _sma(close, period)
    upper = np.zeros_like(close)
    lower = np.zeros_like(close)
    width = np.zeros_like(close)
    for i in range(period - 1, len(close)):
        window = close[i - period + 1 : i + 1]
        std = np.std(window)
        upper[i] = mid[i] + std_mult * std
        lower[i] = mid[i] - std_mult * std
        width[i] = (upper[i] - lower[i]) / mid[i] * 100.0 if mid[i] > 0 else 0.0
    return mid, upper, lower, width


def _ao(high: np.ndarray, low: np.ndarray, fast: int = 5, slow: int = 34) -> np.ndarray:
    hl2 = (high + low) / 2.0
    return _sma(hl2, fast) - _sma(hl2, slow)


def _zscore(values: np.ndarray, period: int) -> np.ndarray:
    out = np.zeros_like(values)
    for i in range(period - 1, len(values)):
        w = values[i - period + 1 : i + 1]
        s = np.std(w)
        out[i] = (values[i] - np.mean(w)) / s if s > 0 else 0.0
    return out


def _slope(values: np.ndarray, lookback: int, idx: int) -> float:
    """Linear slope of `values` over `lookback` bars ending at `idx`."""
    if idx < lookback - 1:
        return 0.0
    ys = values[idx - lookback + 1 : idx + 1]
    xs = np.arange(lookback, dtype=np.float64)
    if len(set(ys)) < 2:
        return 0.0
    return float(np.polyfit(xs, ys, 1)[0])


def _percent_rank(values: np.ndarray, period: int) -> np.ndarray:
    out = np.full(len(values), 0.5)
    for i in range(period - 1, len(values)):
        w = values[i - period + 1 : i + 1]
        out[i] = np.sum(w <= values[i]) / period
    return out


def _bb_squeeze_intensity(bb_widths: np.ndarray, idx: int, lookback: int = 20) -> float:
    if idx < lookback:
        return 0.5
    window = bb_widths[idx - lookback + 1 : idx + 1]
    mn = float(window.min())
    mx = float(window.max())
    w = float(bb_widths[idx])
    return (w - mn) / (mx - mn) if mx > mn else 0.5


def compute_macd_hist(close: np.ndarray, fast: int = 12, slow: int = 26, signal: int = 9) -> np.ndarray:
    ema_fast = _ema(close, fast)
    ema_slow = _ema(close, slow)
    macd_line = ema_fast - ema_slow
    signal_line = _ema(macd_line, signal)
    return macd_line - signal_line


def swing_dist_to_close(
    high: np.ndarray, low: np.ndarray, close_val: float, idx: int,
    atr_val: float, lookback: int = 15,
) -> float:
    """Min distance from close to nearest swing high/low, in ATR units."""
    min_dist = 999.0
    for k in range(max(0, idx - lookback), idx):
        # Swing high
        ph = True
        for j in range(1, min(3, k + 1)):
            if k - j >= 0 and high[k] < high[k - j]:
                ph = False
                break
        if ph:
            for j in range(1, min(3, len(high) - k)):
                if k + j < idx and high[k] < high[k + j]:
                    ph = False
                    break
        if ph and high[k] > close_val:
            d = (high[k] - close_val) / atr_val if atr_val > 0 else 999.0
            min_dist = min(min_dist, d)
        # Swing low
        pl = True
        for j in range(1, min(3, k + 1)):
            if k - j >= 0 and low[k] > low[k - j]:
                pl = False
                break
        if pl:
            for j in range(1, min(3, len(low) - k)):
                if k + j < idx and low[k] > low[k + j]:
                    pl = False
                    break
        if pl and low[k] < close_val:
            d = (close_val - low[k]) / atr_val if atr_val > 0 else 999.0
            min_dist = min(min_dist, d)
    return min(min_dist, 5.0) if min_dist < 500 else 5.0


# ─────────────────────────────────────────────────────────────────────────────
# FORWARD OUTCOME COMPUTATION (inlined from pipeline/labels.py)
# ─────────────────────────────────────────────────────────────────────────────

def compute_outcome(
    high: np.ndarray, low: np.ndarray, close: np.ndarray,
    entry_idx: int, atr_val: float, direction: str,
) -> Dict:
    """Compute forward outcome from entry bar. NO lookahead — scans forward only."""
    is_long = direction == "long"
    entry = close[entry_idx]
    if atr_val <= 0 or entry <= 0:
        return {"hitTP": False, "hitStop": False, "pnlR": 0.0, "barsToOutcome": 0}

    stop_dist = STOP_ATR_MULT * atr_val
    if is_long:
        stop_price = entry - stop_dist
        tp_price = entry + stop_dist * RR_TARGET
    else:
        stop_price = entry + stop_dist
        tp_price = entry - stop_dist * RR_TARGET

    if stop_dist <= 0:
        return {"hitTP": False, "hitStop": False, "pnlR": 0.0, "barsToOutcome": 0}

    max_fav = 0.0
    max_adv = 0.0
    hit_tp = False
    hit_stop = False
    bars_to = 0

    scan_end = min(len(close), entry_idx + MAX_LOOKFORWARD_BARS + 1)
    for fi in range(entry_idx + 1, scan_end):
        if is_long:
            fav = (high[fi] - entry) / stop_dist
            adv = (entry - low[fi]) / stop_dist
        else:
            fav = (entry - low[fi]) / stop_dist
            adv = (high[fi] - entry) / stop_dist
        max_fav = max(max_fav, fav)
        max_adv = max(max_adv, adv)
        if fav >= RR_TARGET:
            hit_tp = True
            bars_to = fi - entry_idx
            break
        if adv >= 1.0:
            hit_stop = True
            bars_to = fi - entry_idx
            break

    pnl_r = max_fav if hit_tp else (-max_adv if hit_stop else 0.0)
    return {
        "hitTP": hit_tp, "hitStop": hit_stop,
        "pnlR": pnl_r, "barsToOutcome": bars_to,
    }


# ─────────────────────────────────────────────────────────────────────────────
# MTF FEATURE BUILDER (self-contained version of production-backtest.py logic)
# ─────────────────────────────────────────────────────────────────────────────

def build_mtf_features_from_raw(raw_15m: List[Dict], raw_1h: List[Dict],
                                  raw_4h: List[Dict]) -> Optional[Tuple[
    np.ndarray, np.ndarray, np.ndarray, List[Dict],
]]:
    """Build 30-feature vectors + labels from raw OHLCV kline dicts.

    Returns (X, y_win, y_pnl, metadata) or None if insufficient data.
    """
    if len(raw_15m) < MA_SLOW + 50:
        return None

    # Extract arrays
    o15 = np.array([k["open"] for k in raw_15m], dtype=np.float64)
    h15 = np.array([k["high"] for k in raw_15m], dtype=np.float64)
    l15 = np.array([k["low"] for k in raw_15m], dtype=np.float64)
    c15 = np.array([k["close"] for k in raw_15m], dtype=np.float64)
    v15 = np.array([k["volume"] for k in raw_15m], dtype=np.float64)
    ts15 = np.array([k["timestamp"] for k in raw_15m])

    o1h = np.array([k["open"] for k in raw_1h], dtype=np.float64)
    h1h = np.array([k["high"] for k in raw_1h], dtype=np.float64)
    l1h = np.array([k["low"] for k in raw_1h], dtype=np.float64)
    c1h = np.array([k["close"] for k in raw_1h], dtype=np.float64)
    v1h = np.array([k["volume"] for k in raw_1h], dtype=np.float64)
    ts1h = np.array([k["timestamp"] for k in raw_1h])

    o4h = np.array([k["open"] for k in raw_4h], dtype=np.float64)
    h4h = np.array([k["high"] for k in raw_4h], dtype=np.float64)
    l4h = np.array([k["low"] for k in raw_4h], dtype=np.float64)
    c4h = np.array([k["close"] for k in raw_4h], dtype=np.float64)
    v4h = np.array([k["volume"] for k in raw_4h], dtype=np.float64)
    ts4h = np.array([k["timestamp"] for k in raw_4h])

    # ── 15m indicators ──
    ma7_15m = _sma(c15, 7)
    ma25_15m = _sma(c15, 25)
    ma99_15m = _sma(c15, MA_SLOW)
    atr14_15m = _atr(h15, l15, c15, 14)
    atr_pct_15m = _percent_rank(atr14_15m, 28)
    rsi14_15m = _rsi(c15, 14)
    bb_mid_15m, bb_upper_15m, bb_lower_15m, bb_width_15m = _bb(c15, 20, 2.0)
    ao_15m = _ao(h15, l15)
    vol_ma_15m = _sma(v15, 20)
    vol_z_15m = _zscore(v15, 20)
    macd_15m = compute_macd_hist(c15)
    bb_price_pos_15m = np.where(
        bb_upper_15m > bb_lower_15m,
        (c15 - bb_lower_15m) / (bb_upper_15m - bb_lower_15m),
        0.5,
    )
    trend_bull_15m = (ma7_15m > ma25_15m) & (ma25_15m > ma99_15m)
    trend_bear_15m = (ma7_15m < ma25_15m) & (ma25_15m < ma99_15m)
    trend_15m = trend_bull_15m.astype(int) - trend_bear_15m.astype(int)
    bb_sqz_15m = np.array([
        _bb_squeeze_intensity(bb_width_15m, i) for i in range(len(bb_width_15m))
    ])

    # ── 1h indicators ──
    ma7_1h = _sma(c1h, 7)
    ma25_1h = _sma(c1h, 25)
    ma99_1h = _sma(c1h, MA_SLOW)
    rsi14_1h = _rsi(c1h, 14)
    bb_mid_1h, bb_upper_1h, bb_lower_1h, bb_width_1h = _bb(c1h, 20, 2.0)
    ao_1h = _ao(h1h, l1h)
    vol_z_1h = _zscore(v1h, 20)
    macd_1h = compute_macd_hist(c1h)
    bb_price_pos_1h = np.where(
        bb_upper_1h > bb_lower_1h,
        (c1h - bb_lower_1h) / (bb_upper_1h - bb_lower_1h),
        0.5,
    )
    trend_bull_1h = (ma7_1h > ma25_1h) & (ma25_1h > ma99_1h)
    trend_bear_1h = (ma7_1h < ma25_1h) & (ma25_1h < ma99_1h)
    trend_1h = trend_bull_1h.astype(int) - trend_bear_1h.astype(int)
    bb_sqz_1h = np.array([
        _bb_squeeze_intensity(bb_width_1h, i) for i in range(len(bb_width_1h))
    ])

    # ── 4h indicators ──
    ma7_4h = _sma(c4h, 7)
    ma25_4h = _sma(c4h, 25)
    ma99_4h = _sma(c4h, MA_SLOW)
    rsi14_4h = _rsi(c4h, 14)
    bb_mid_4h, bb_upper_4h, bb_lower_4h, bb_width_4h = _bb(c4h, 20, 2.0)
    ao_4h = _ao(h4h, l4h)
    macd_4h = compute_macd_hist(c4h)
    bb_price_pos_4h = np.where(
        bb_upper_4h > bb_lower_4h,
        (c4h - bb_lower_4h) / (bb_upper_4h - bb_lower_4h),
        0.5,
    )
    trend_bull_4h = (ma7_4h > ma25_4h) & (ma25_4h > ma99_4h)
    trend_bear_4h = (ma7_4h < ma25_4h) & (ma25_4h < ma99_4h)
    trend_4h = trend_bull_4h.astype(int) - trend_bear_4h.astype(int)

    # ── Build rows ──
    warmup = MA_SLOW
    max_end = len(raw_15m) - MAX_LOOKFORWARD_BARS
    if max_end <= warmup:
        return None

    rows: List[Dict] = []
    for i in range(warmup, max_end):
        ts = int(ts15[i])
        atr_val = float(atr14_15m[i])
        close_val = float(c15[i])
        if atr_val <= 0 or close_val <= 0:
            continue

        h1_idx = max(0, int(np.searchsorted(ts1h, ts, side="right")) - 1)
        h4_idx = max(0, int(np.searchsorted(ts4h, ts, side="right")) - 1)

        m15_tv = int(trend_15m[i])
        h1_tv = int(trend_1h[h1_idx])
        h4_tv = int(trend_4h[h4_idx])

        rsi_grad = float(rsi14_15m[i]) - float(rsi14_15m[max(0, i - 3)])
        bb_sqz_prod = float(bb_sqz_15m[i] * bb_sqz_1h[h1_idx])

        mtf_15_1h = 1 if (m15_tv == h1_tv and m15_tv != 0) else 0
        mtf_triple = 1 if (m15_tv == h1_tv == h4_tv and m15_tv != 0) else 0
        tf_vol_sum = float(vol_z_15m[i] + vol_z_1h[h1_idx])
        sw_dist = swing_dist_to_close(h15, l15, close_val, i, atr_val)

        ao_slope_15m = float(ao_15m[i]) - float(ao_15m[max(0, i - 3)])
        m15_ma7_slope = _slope(ma7_15m, 5, i)
        h1_ma7_slope = _slope(ma7_1h, 5, h1_idx)

        features = {
            "ao_gradient": ao_slope_15m,
            "bb_sqz_product": bb_sqz_prod,
            "h1_ao": float(ao_1h[h1_idx]),
            "h1_bb_pos": float(bb_price_pos_1h[h1_idx]),
            "h1_bb_width": float(bb_width_1h[h1_idx]),
            "h1_ma7_slope": h1_ma7_slope,
            "h1_macd": float(macd_1h[h1_idx]),
            "h1_rsi": float(rsi14_1h[h1_idx]),
            "h1_trend": h1_tv,
            "h1_vol_z": float(vol_z_1h[h1_idx]),
            "h4_ao": float(ao_4h[h4_idx]),
            "h4_bb_pos": float(bb_price_pos_4h[h4_idx]),
            "h4_bb_width": float(bb_width_4h[h4_idx]),
            "h4_macd": float(macd_4h[h4_idx]),
            "h4_rsi": float(rsi14_4h[h4_idx]),
            "h4_trend": h4_tv,
            "m15_ao": float(ao_15m[i]),
            "m15_atr_pct": float(atr_pct_15m[i]),
            "m15_bb_pos": float(bb_price_pos_15m[i]),
            "m15_bb_width": float(bb_width_15m[i]),
            "m15_ma7_slope": m15_ma7_slope,
            "m15_macd": float(macd_15m[i]),
            "m15_rsi": float(rsi14_15m[i]),
            "m15_swing_dist": sw_dist,
            "m15_trend": m15_tv,
            "m15_vol_z": float(vol_z_15m[i]),
            "mtf_15_1h_agree": mtf_15_1h,
            "mtf_triple_agree": mtf_triple,
            "rsi_gradient": rsi_grad,
            "tf_vol_sum": tf_vol_sum,
        }

        outcome = compute_outcome(h15, l15, c15, i, atr_val, "long")
        row = {"timestamp": ts, **features, **outcome}
        rows.append(row)

    if not rows:
        return None

    X = np.array([[r[f] for f in FEATURE_NAMES] for r in rows], dtype=np.float32)
    y_win = np.array([1 if r["hitTP"] else 0 for r in rows], dtype=np.int32)
    y_pnl = np.array([float(r.get("pnlR", 0) or 0) for r in rows], dtype=np.float32)
    meta = [{"timestamp": r["timestamp"], "pnlR": r["pnlR"]} for r in rows]

    return X, y_win, y_pnl, meta


# ─────────────────────────────────────────────────────────────────────────────
# DATA LOADING
# ─────────────────────────────────────────────────────────────────────────────

def load_expanded_data() -> Optional[Tuple[np.ndarray, np.ndarray, np.ndarray, List[Dict]]]:
    """Load pre-computed features from expanded JSONL file.

    Deduplicates by (symbol, timestamp), taking the 'long' direction.
    """
    if not EXPANDED_DATA_PATH.exists():
        print(f"  Expanded data not found at {EXPANDED_DATA_PATH}")
        return None

    print(f"Loading expanded data from {EXPANDED_DATA_PATH} ...")
    rows = []
    with open(EXPANDED_DATA_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    if not rows:
        return None

    # Deduplicate by (symbol, timestamp): keep 'long' direction row
    seen: Dict[Tuple[str, int], Dict] = {}
    for r in rows:
        key = (r.get("symbol", "UNKNOWN"), r.get("timestamp", 0))
        if key not in seen:
            seen[key] = r
        elif r.get("direction") == "long":
            seen[key] = r

    unique_rows = sorted(seen.values(), key=lambda r: (r.get("symbol", ""), r.get("timestamp", 0)))

    # Extract features and labels
    X = np.array([[float(r.get(f, 0) or 0) for f in FEATURE_NAMES] for r in unique_rows], dtype=np.float32)
    y_win = np.array([1 if r.get("hitTP") else 0 for r in unique_rows], dtype=np.int32)
    y_pnl = np.array([float(r.get("pnlR", 0) or 0) for r in unique_rows], dtype=np.float32)
    meta = [{"timestamp": r["timestamp"], "symbol": r.get("symbol", ""), "pnlR": r.get("pnlR", 0)}
            for r in unique_rows]

    print(f"  Loaded {len(X)} unique feature vectors from {len(rows)} total rows")
    return X, y_win, y_pnl, meta


def load_klines_data(quick: bool = False) -> Optional[Tuple[np.ndarray, np.ndarray, np.ndarray, List[Dict]]]:
    """Build MTF features from raw OHLCV klines-mtf.json. Fallback path."""
    if not KLINES_PATH.exists():
        print(f"  Klines data not found at {KLINES_PATH}")
        return None

    print(f"Building MTF features from {KLINES_PATH} ...")
    with open(KLINES_PATH) as f:
        pairs = json.load(f)

    if quick:
        pairs = pairs[:5]
        print(f"  QUICK MODE: Using first {len(pairs)} pairs")

    all_X: List[np.ndarray] = []
    all_y_win: List[np.ndarray] = []
    all_y_pnl: List[np.ndarray] = []
    all_meta: List[Dict] = []
    t_start = time.time()

    for pi, pair in enumerate(pairs):
        symbol = pair["symbol"]
        klines = pair.get("klines", {})
        raw_15m = klines.get("15m", [])
        raw_1h = klines.get("1h", [])
        raw_4h = klines.get("4h", [])

        if len(raw_15m) < 100 or len(raw_1h) < 100 or len(raw_4h) < 100:
            if not quick:
                print(f"  [{pi + 1}/{len(pairs)}] {symbol}: SKIP (insufficient data)")
            continue

        result = build_mtf_features_from_raw(raw_15m, raw_1h, raw_4h)
        if result is None:
            if not quick:
                print(f"  [{pi + 1}/{len(pairs)}] {symbol}: SKIP (feature build failed)")
            continue

        X_p, yw_p, yp_p, meta_p = result
        all_X.append(X_p)
        all_y_win.append(yw_p)
        all_y_pnl.append(yp_p)
        for m in meta_p:
            m["symbol"] = symbol
        all_meta.extend(meta_p)

        if not quick and ((pi + 1) % 10 == 0 or pi == len(pairs) - 1):
            elapsed = time.time() - t_start
            print(f"  [{pi + 1}/{len(pairs)}] {symbol}: {len(meta_p)} rows ({elapsed:.0f}s)")

    if not all_X:
        print("  No features built from any pair!")
        return None

    X = np.vstack(all_X)
    y_win = np.concatenate(all_y_win)
    y_pnl = np.concatenate(all_y_pnl)

    n_wins = int(y_win.sum())
    baseline_wr = n_wins / len(y_win)
    print(f"  Total: {len(X)} rows, {n_wins} wins (WR={baseline_wr * 100:.1f}%), "
          f"elapsed={time.time() - t_start:.0f}s")
    return X, y_win, y_pnl, all_meta


# ─────────────────────────────────────────────────────────────────────────────
# SEQUENCE BUILDER
# ─────────────────────────────────────────────────────────────────────────────

def build_sequences(
    X: np.ndarray, y_win: np.ndarray, y_pnl: np.ndarray,
    meta: List[Dict], seq_len: int = SEQ_LEN,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, List[Dict]]:
    """Build sequences from feature vectors.

    For each bar at index i >= seq_len-1, create sequence:
      [X[i-seq_len+1], ..., X[i]]  shape: (seq_len, num_features)

    The label and pnl are from bar i. Metadata is from bar i.
    NO future data — sequence only uses bars through index i.
    """
    n = len(X)
    if n < seq_len:
        print(f"  WARNING: Only {n} rows, need at least {seq_len} for sequences")
        return np.array([]), np.array([]), np.array([]), []

    n_seqs = n - seq_len + 1
    X_seq = np.zeros((n_seqs, seq_len, NUM_FEATURES), dtype=np.float32)
    y_seq = np.zeros(n_seqs, dtype=np.int32)
    y_pnl_seq = np.zeros(n_seqs, dtype=np.float32)
    meta_seq: List[Dict] = []

    for i in range(seq_len - 1, n):
        seq_idx = i - seq_len + 1
        X_seq[seq_idx] = X[i - seq_len + 1 : i + 1]
        y_seq[seq_idx] = y_win[i]
        y_pnl_seq[seq_idx] = y_pnl[i]
        meta_seq.append(meta[i])

    return X_seq, y_seq, y_pnl_seq, meta_seq


# ─────────────────────────────────────────────────────────────────────────────
# CHRONOLOGICAL SPLIT
# ─────────────────────────────────────────────────────────────────────────────

def chronological_split(
    metadatas: List[Dict], train_ratio: float = 0.70,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Split indices by unique timestamps chronologically (70/15/15)."""
    timestamps = sorted(set(r["timestamp"] for r in metadatas))
    n = len(timestamps)
    t_end = int(n * train_ratio)
    v_end = int(n * (train_ratio + (1.0 - train_ratio) / 2))

    train_ts = set(timestamps[:t_end])
    val_ts = set(timestamps[t_end:v_end])
    test_ts = set(timestamps[v_end:])

    def _indices(ts_set):
        return np.array([i for i, r in enumerate(metadatas) if r["timestamp"] in ts_set])

    return _indices(train_ts), _indices(val_ts), _indices(test_ts)


def format_ts(ts: int) -> str:
    from datetime import datetime
    return datetime.utcfromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")


# ─────────────────────────────────────────────────────────────────────────────
# PYTORCH DATASET
# ─────────────────────────────────────────────────────────────────────────────

class SequenceDataset(Dataset):
    """PyTorch Dataset for (batch, seq_len, features) sequences."""

    def __init__(self, X: np.ndarray, y: np.ndarray) -> None:
        self.X = torch.from_numpy(X).float()
        self.y = torch.from_numpy(y).float()

    def __len__(self) -> int:
        return len(self.X)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        return self.X[idx], self.y[idx]


# ─────────────────────────────────────────────────────────────────────────────
# MODEL 1: BiLSTM WITH MULTI-HEAD ATTENTION
# ─────────────────────────────────────────────────────────────────────────────

class BiLSTMAttention(nn.Module):
    """Bidirectional LSTM with multi-head self-attention and global pooling."""

    def __init__(
        self,
        input_dim: int = 30,
        hidden_dim: int = 128,
        num_layers: int = 2,
        num_heads: int = 4,
        lstm_dropout: float = 0.3,
        fc_dropout1: float = 0.4,
        fc_dropout2: float = 0.3,
    ) -> None:
        super().__init__()
        self.lstm = nn.LSTM(
            input_dim, hidden_dim, num_layers=num_layers,
            batch_first=True, bidirectional=True, dropout=lstm_dropout,
        )
        lstm_out_dim = hidden_dim * 2  # bidirectional -> 256

        self.attention = nn.MultiheadAttention(
            embed_dim=lstm_out_dim, num_heads=num_heads,
            batch_first=True, dropout=lstm_dropout,
        )
        self.layer_norm = nn.LayerNorm(lstm_out_dim)

        self.fc = nn.Sequential(
            nn.Linear(lstm_out_dim * 2, 128),  # max_pool + avg_pool concatenated
            nn.ReLU(),
            nn.Dropout(fc_dropout1),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Dropout(fc_dropout2),
            nn.Linear(64, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (batch, seq_len, input_dim)
        lstm_out, _ = self.lstm(x)  # (batch, seq_len, 256)
        attn_out, _ = self.attention(lstm_out, lstm_out, lstm_out)  # (batch, seq_len, 256)
        attn_out = self.layer_norm(attn_out + lstm_out)  # residual + norm

        max_pooled, _ = attn_out.max(dim=1)  # (batch, 256)
        avg_pooled = attn_out.mean(dim=1)   # (batch, 256)
        pooled = torch.cat([max_pooled, avg_pooled], dim=1)  # (batch, 512)

        return torch.sigmoid(self.fc(pooled))  # (batch, 1)


# ─────────────────────────────────────────────────────────────────────────────
# MODEL 2: TEMPORAL CONVOLUTIONAL NETWORK (TCN)
# ─────────────────────────────────────────────────────────────────────────────

class CausalConv1d(nn.Module):
    """1D convolution with left-only padding for causality."""

    def __init__(self, in_channels: int, out_channels: int,
                 kernel_size: int, dilation: int = 1) -> None:
        super().__init__()
        self.padding = (kernel_size - 1) * dilation
        self.conv = nn.Conv1d(
            in_channels, out_channels, kernel_size,
            dilation=dilation, padding=0,
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (batch, channels, seq_len)
        x = F.pad(x, (self.padding, 0))
        return self.conv(x)


class TCNBlock(nn.Module):
    """TCN residual block with two causal conv layers."""

    def __init__(self, in_channels: int, out_channels: int,
                 kernel_size: int = 3, dilation: int = 1,
                 dropout: float = 0.2) -> None:
        super().__init__()
        self.conv1 = CausalConv1d(in_channels, out_channels, kernel_size, dilation)
        self.bn1 = nn.BatchNorm1d(out_channels)
        self.conv2 = CausalConv1d(out_channels, out_channels, kernel_size, dilation)
        self.bn2 = nn.BatchNorm1d(out_channels)
        self.dropout = nn.Dropout(dropout)
        self.relu = nn.ReLU()

        self.downsample: nn.Module = (
            nn.Conv1d(in_channels, out_channels, 1)
            if in_channels != out_channels
            else nn.Identity()
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = self.downsample(x)
        out = self.relu(self.bn1(self.conv1(x)))
        out = self.dropout(out)
        out = self.bn2(self.conv2(out))
        out = self.relu(out + residual)
        return self.dropout(out)


class TCN(nn.Module):
    """Temporal Convolutional Network with dilation rates [1, 2, 4, 8]."""

    def __init__(
        self, input_dim: int = 30, num_channels: int = 64,
        kernel_size: int = 3, dropout: float = 0.2,
    ) -> None:
        super().__init__()
        dilations = [1, 2, 4, 8]
        layers = []
        in_ch = input_dim
        for d in dilations:
            layers.append(TCNBlock(in_ch, num_channels, kernel_size, d, dropout))
            in_ch = num_channels
        self.network = nn.Sequential(*layers)

        self.output = nn.Sequential(
            nn.AdaptiveAvgPool1d(1),
            nn.Flatten(),
            nn.Linear(num_channels, 32),
            nn.ReLU(),
            nn.Linear(32, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (batch, seq_len, features) -> permute to (batch, features, seq_len)
        x = x.permute(0, 2, 1)
        x = self.network(x)  # (batch, num_channels, seq_len)
        return torch.sigmoid(self.output(x))  # (batch, 1)


# ─────────────────────────────────────────────────────────────────────────────
# MODEL 3: MINI-PATCHTST (Transformer-based patching)
# ─────────────────────────────────────────────────────────────────────────────

class MiniPatchTST(nn.Module):
    """PatchTST-style model: patches + transformer encoder."""

    def __init__(
        self, input_dim: int = 30, patch_len: int = 5,
        d_model: int = 128, num_layers: int = 4, num_heads: int = 4,
        dropout: float = 0.2,
    ) -> None:
        super().__init__()
        self.patch_len = patch_len
        # Conv1d does the patching: (batch, 30, 30) -> (batch, 128, 6)
        self.patch_embed = nn.Conv1d(input_dim, d_model, kernel_size=patch_len, stride=patch_len)
        # Learnable positional encoding: (1, max_patches, d_model)
        max_patches = 30 // patch_len  # 6
        self.pos_encoding = nn.Parameter(torch.randn(1, max_patches, d_model) * 0.02)

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model, nhead=num_heads, dropout=dropout,
            batch_first=True, dim_feedforward=d_model * 4,
        )
        self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)
        self.dropout = nn.Dropout(dropout)

        self.output = nn.Sequential(
            nn.Linear(d_model, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (batch, seq_len, features) -> permute for Conv1d: (batch, features, seq_len)
        x = x.permute(0, 2, 1)
        patches = self.patch_embed(x)  # (batch, d_model, num_patches)
        patches = patches.permute(0, 2, 1)  # (batch, num_patches, d_model)
        patches = patches + self.pos_encoding[:, :patches.size(1), :]
        patches = self.dropout(patches)

        encoded = self.transformer(patches)  # (batch, num_patches, d_model)
        pooled = encoded.mean(dim=1)  # (batch, d_model)

        return torch.sigmoid(self.output(pooled))  # (batch, 1)


# ─────────────────────────────────────────────────────────────────────────────
# MODEL 4: SIMPLE CNN (Baseline)
# ─────────────────────────────────────────────────────────────────────────────

class SimpleCNN(nn.Module):
    """Simple 1D CNN baseline treating (seq_len, features) as a 1-channel image."""

    def __init__(self, input_dim: int = 30, seq_len: int = 30) -> None:
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv1d(input_dim, 64, kernel_size=5, padding=2),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.MaxPool1d(2),  # 30 -> 15

            nn.Conv1d(64, 128, kernel_size=3, padding=1),
            nn.BatchNorm1d(128),
            nn.ReLU(),
            nn.MaxPool1d(2),  # 15 -> 7

            nn.Conv1d(128, 256, kernel_size=3, padding=1),
            nn.BatchNorm1d(256),
            nn.ReLU(),
            nn.AdaptiveAvgPool1d(1),  # -> (batch, 256, 1)
        )
        self.output = nn.Sequential(
            nn.Flatten(),
            nn.Linear(256, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x.permute(0, 2, 1)  # (batch, features, seq_len)
        x = self.conv(x)
        return torch.sigmoid(self.output(x))


# ─────────────────────────────────────────────────────────────────────────────
# MODEL FACTORY
# ─────────────────────────────────────────────────────────────────────────────

MODEL_REGISTRY = {
    "lstm": BiLSTMAttention,
    "tcn": TCN,
    "patchtst": MiniPatchTST,
    "cnn": SimpleCNN,
}


def count_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


# ─────────────────────────────────────────────────────────────────────────────
# TRAINING LOOP
# ─────────────────────────────────────────────────────────────────────────────

def train_model(
    model: nn.Module,
    train_loader: DataLoader,
    val_loader: DataLoader,
    name: str,
    epochs: int = 100,
    pos_weight: float = 3.0,
    patience: int = 15,
    device: torch.device = torch.device("cpu"),
) -> Tuple[float, float]:
    """Train one model. Returns (best_val_auc, training_time_minutes)."""
    model = model.to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="max", patience=10, factor=0.5,
    )
    criterion = nn.BCELoss()

    best_val_auc = 0.0
    best_epoch = 0
    no_improve = 0
    t_start = time.time()

    for epoch in range(epochs):
        # ── Train ──
        model.train()
        train_loss = 0.0
        for X_batch, y_batch in train_loader:
            X_batch = X_batch.to(device)
            y_batch = y_batch.to(device)

            optimizer.zero_grad()
            preds = model(X_batch).squeeze(-1)

            # Weighted BCE
            weights = torch.where(y_batch > 0.5, pos_weight, 1.0)
            losses = F.binary_cross_entropy(preds, y_batch, reduction="none")
            loss = (losses * weights).mean()

            loss.backward()
            optimizer.step()
            train_loss += loss.item() * len(X_batch)

        train_loss /= len(train_loader.dataset)  # type: ignore[arg-type]

        # ── Validate ──
        val_auc, val_loss = evaluate_model(model, val_loader, criterion, device)
        scheduler.step(val_auc)

        if val_auc > best_val_auc:
            best_val_auc = val_auc
            best_epoch = epoch + 1
            no_improve = 0
            model_path = MODEL_OUTPUT_DIR / f"{name}_best.pt"
            torch.save(model.state_dict(), model_path)
        else:
            no_improve += 1

        if (epoch + 1) % 10 == 0 or epoch == 0:
            lr = optimizer.param_groups[0]["lr"]
            print(f"  {name} epoch {epoch + 1:3d}/{epochs} | "
                  f"train_loss={train_loss:.4f} | val_loss={val_loss:.4f} | "
                  f"val_auc={val_auc:.4f} | lr={lr:.6f} | best_ep={best_epoch}")

        if no_improve >= patience:
            print(f"  {name}: early stopping at epoch {epoch + 1} "
                  f"(no improvement for {patience} epochs)")
            break

    train_time = (time.time() - t_start) / 60.0
    print(f"  {name}: best val AUC={best_val_auc:.4f} at epoch {best_epoch}, "
          f"time={train_time:.2f} min")

    # Load best weights for final evaluation
    best_path = MODEL_OUTPUT_DIR / f"{name}_best.pt"
    if best_path.exists():
        model.load_state_dict(torch.load(best_path, map_location=device))

    return best_val_auc, train_time


# ─────────────────────────────────────────────────────────────────────────────
# EVALUATION
# ─────────────────────────────────────────────────────────────────────────────

@torch.no_grad()
def evaluate_model(
    model: nn.Module, loader: DataLoader,
    criterion: nn.Module, device: torch.device,
) -> Tuple[float, float]:
    """Compute AUC and loss for a data loader."""
    model.eval()
    all_preds = []
    all_targets = []
    total_loss = 0.0

    for X_batch, y_batch in loader:
        X_batch = X_batch.to(device)
        y_batch = y_batch.to(device)
        preds = model(X_batch).squeeze(-1)
        loss = criterion(preds, y_batch)
        total_loss += loss.item() * len(X_batch)
        all_preds.append(preds.cpu().numpy())
        all_targets.append(y_batch.cpu().numpy())

    all_preds_np = np.concatenate(all_preds)
    all_targets_np = np.concatenate(all_targets)
    avg_loss = total_loss / len(loader.dataset)  # type: ignore[arg-type]

    try:
        auc = roc_auc_score(all_targets_np, all_preds_np)
    except ValueError:
        auc = 0.5

    return auc, avg_loss


def compute_metrics_at_threshold(
    probs: np.ndarray, targets: np.ndarray, pnls: np.ndarray,
    threshold: float,
) -> Dict:
    """Compute WR and PF at a given probability threshold."""
    mask = probs >= threshold
    n = int(mask.sum())
    if n == 0:
        return {"trades": 0, "wr": 0, "pf": 0, "threshold": threshold}

    wins = int(targets[mask].sum())
    wr = wins / n

    selected_pnls = pnls[mask]
    gp = float(selected_pnls[selected_pnls > 0].sum())
    gl = float(abs(selected_pnls[selected_pnls < 0].sum()))
    pf = gp / gl if gl > 0 else (999.0 if gp > 0 else 0.0)

    return {"trades": n, "wr": wr, "pf": pf, "threshold": threshold}


def evaluate_full(
    model: nn.Module, loader: DataLoader, pnls: np.ndarray,
    device: torch.device,
) -> Dict:
    """Full evaluation: AUC, best-threshold WR, best-threshold PF."""
    model.eval()
    all_preds = []
    all_targets = []
    with torch.no_grad():
        for X_batch, y_batch in loader:
            preds = model(X_batch.to(device)).squeeze(-1).cpu().numpy()
            all_preds.append(preds)
            all_targets.append(y_batch.numpy())

    probs = np.concatenate(all_preds)
    targets = np.concatenate(all_targets)

    try:
        auc = roc_auc_score(targets, probs)
    except ValueError:
        auc = 0.5

    # Find best threshold by Youden's index (J = sensitivity + specificity - 1)
    best_thresh = 0.5
    best_j = -1.0
    for t in np.arange(0.10, 0.91, 0.02):
        mask = probs >= t
        n = int(mask.sum())
        if n < 20:
            continue
        tp = int((targets[mask] == 1).sum())
        tn = int((targets[~mask] == 0).sum())
        fp = int((targets[~mask] == 1).sum())
        fn = int((targets[mask] == 0).sum())
        sens = tp / (tp + fn) if (tp + fn) > 0 else 0
        spec = tn / (tn + fp) if (tn + fp) > 0 else 0
        j = sens + spec - 1.0
        if j > best_j:
            best_j = j
            best_thresh = t

    metrics = compute_metrics_at_threshold(probs, targets, pnls, best_thresh)
    metrics["auc"] = auc
    metrics["best_threshold"] = best_thresh
    return metrics


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Deep Learning Training for Crypto Signal Prediction",
    )
    parser.add_argument("--epochs", type=int, default=DEFAULT_EPOCHS,
                        help=f"Number of epochs (default: {DEFAULT_EPOCHS})")
    parser.add_argument("--models", type=str, default="lstm,tcn,patchtst,cnn",
                        help="Comma-separated model names: lstm,tcn,patchtst,cnn")
    parser.add_argument("--quick", action="store_true",
                        help="Limit to 5 pairs, 20 epochs")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE,
                        help=f"Batch size (default: {BATCH_SIZE})")
    parser.add_argument("--expanded", action="store_true",
                        help="Use expanded JSONL data instead of klines fallback")
    args = parser.parse_args()

    model_names = [m.strip().lower() for m in args.models.split(",")]
    for m in model_names:
        if m not in MODEL_REGISTRY:
            print(f"ERROR: Unknown model '{m}'. Available: {list(MODEL_REGISTRY.keys())}")
            sys.exit(1)

    quick = args.quick
    # In quick mode, default to 20 epochs unless explicitly overridden
    if quick and "--epochs" not in sys.argv:
        epochs = 20
    else:
        epochs = args.epochs

    MODEL_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 70)
    print("DEEP LEARNING TRAINING — Crypto Signal Prediction")
    print("=" * 70)
    print(f"  Models: {model_names}")
    print(f"  Epochs: {epochs}")
    print(f"  Quick:  {quick}")
    print(f"  Device: CPU")
    print()

    # ── 1. Load data ──
    print("=" * 70)
    print("LOADING DATA")
    print("=" * 70)

    result = None
    if args.expanded:
        result = load_expanded_data()
        if result is None:
            print("  Expanded data loading failed, falling back to klines")
            result = load_klines_data(quick)
    else:
        result = load_klines_data(quick)
        if result is None:
            print("  Klines fallback failed, trying expanded data")
            result = load_expanded_data()

    if result is None:
        print("ERROR: Could not load data from any source.")
        sys.exit(1)

    X, y_win, y_pnl, meta = result
    baseline_wr = y_win.mean()
    print(f"\n  Data: {len(X)} rows, baseline WR={baseline_wr * 100:.1f}%")
    print()

    # ── 2. Build sequences ──
    print("=" * 70)
    print("BUILDING SEQUENCES (30 bars x 30 features)")
    print("=" * 70)

    X_seq, y_seq, y_pnl_seq, meta_seq = build_sequences(X, y_win, y_pnl, meta)
    print(f"  Sequences: {len(X_seq)} ({X_seq.shape[0]} x {X_seq.shape[1]} x {X_seq.shape[2]})")
    print()

    if len(X_seq) < 100:
        print("ERROR: Not enough sequences for training (< 100).")
        sys.exit(1)

    # ── 3. Chronological split ──
    print("=" * 70)
    print("CHRONOLOGICAL SPLIT (70/15/15)")
    print("=" * 70)

    train_idx, val_idx, test_idx = chronological_split(meta_seq, 0.70)

    X_train = X_seq[train_idx]
    y_train = y_seq[train_idx]
    pnl_train = y_pnl_seq[train_idx]

    X_val = X_seq[val_idx]
    y_val = y_seq[val_idx]
    pnl_val = y_pnl_seq[val_idx]

    X_test = X_seq[test_idx]
    y_test = y_seq[test_idx]
    pnl_test = y_pnl_seq[test_idx]

    train_wr = y_train.mean()
    val_wr = y_val.mean()
    test_wr = y_test.mean()

    _train_metas = [meta_seq[i] for i in train_idx]
    _test_metas = [meta_seq[i] for i in test_idx]
    train_tss = sorted(set(m["timestamp"] for m in _train_metas))
    test_tss = sorted(set(m["timestamp"] for m in _test_metas))

    print(f"  Train: {len(X_train)} seqs | WR={train_wr * 100:.1f}% | "
          f"{format_ts(train_tss[0])} -> {format_ts(train_tss[-1])}" if train_tss else f"  Train: {len(X_train)}")
    print(f"  Val:   {len(X_val)} seqs | WR={val_wr * 100:.1f}%")
    print(f"  Test:  {len(X_test)} seqs | WR={test_wr * 100:.1f}% | "
          f"{format_ts(test_tss[0])} -> {format_ts(test_tss[-1])}" if test_tss else f"  Test: {len(X_test)}")
    print()

    # ── 4. Scale features ──
    print("=" * 70)
    print("FEATURE SCALING (StandardScaler fit on TRAIN only)")
    print("=" * 70)

    # Reshape for scaling: (n_seqs * seq_len, n_features)
    n_train, seq_len, n_feat = X_train.shape
    X_train_flat = X_train.reshape(-1, n_feat)
    scaler = StandardScaler()
    scaler.fit(X_train_flat)

    X_train_scaled = scaler.transform(X_train_flat).reshape(n_train, seq_len, n_feat)
    X_val_scaled = scaler.transform(X_val.reshape(-1, n_feat)).reshape(len(X_val), seq_len, n_feat)
    X_test_scaled = scaler.transform(X_test.reshape(-1, n_feat)).reshape(len(X_test), seq_len, n_feat)

    print(f"  Train mean: {X_train_flat.mean(axis=0)[:5].round(4)}")
    print(f"  Scaled train mean: {X_train_scaled.reshape(-1, n_feat).mean(axis=0)[:5].round(4)}")
    print()

    # ── 5. Create DataLoaders ──
    train_dataset = SequenceDataset(X_train_scaled, y_train)
    val_dataset = SequenceDataset(X_val_scaled, y_val)
    test_dataset = SequenceDataset(X_test_scaled, y_test)

    train_loader = DataLoader(train_dataset, batch_size=args.batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=args.batch_size, shuffle=False)
    test_loader = DataLoader(test_dataset, batch_size=args.batch_size, shuffle=False)

    device = torch.device("cpu")

    # ── 6. Train all models ──
    print("=" * 70)
    print("TRAINING MODELS")
    print("=" * 70)

    results: Dict[str, Dict] = {}

    for model_name in model_names:
        print(f"\n--- {model_name.upper()} ---")
        model_cls = MODEL_REGISTRY[model_name]
        model = model_cls()

        n_params = count_params(model)
        print(f"  Parameters: {n_params:,}")

        val_auc, train_time = train_model(
            model, train_loader, val_loader, model_name,
            epochs=epochs, device=device,
        )

        # Evaluate on test set
        pos_weight = 3.0
        total_samples = len(y_train)
        n_pos = int(y_train.sum())
        if n_pos > 0:
            class_weight = total_samples / (2.0 * n_pos)
        else:
            class_weight = pos_weight

        print(f"  Evaluating {model_name} on test set ...")
        test_metrics = evaluate_full(model, test_loader, pnl_test, device)

        results[model_name] = {
            "val_auc": round(val_auc, 4),
            "test_auc": round(test_metrics["auc"], 4),
            "test_wr": round(test_metrics["wr"], 4),
            "test_pf": round(test_metrics["pf"], 2),
            "test_trades": test_metrics["trades"],
            "best_threshold": round(test_metrics["best_threshold"], 3),
            "params": n_params,
            "train_time_min": round(train_time, 2),
        }

        print(f"  {model_name} results: AUC(val={val_auc:.4f}, test={test_metrics['auc']:.4f}) | "
              f"WR={test_metrics['wr'] * 100:.1f}% | PF={test_metrics['pf']:.2f} | "
              f"Trades={test_metrics['trades']}")

    # ── 7. Comparison Table ──
    print()
    print("=" * 70)
    print("COMPARISON REPORT")
    print("=" * 70)
    print()

    header = f"{'Model':<15} {'Val AUC':>8} {'Test AUC':>9} {'Test WR':>8} {'Test PF':>8} {'Params':>10} {'Time(min)':>10}"
    sep = "-" * len(header)
    print(header)
    print(sep)

    best_model = None
    best_combined = -1.0

    for name in model_names:
        r = results[name]
        combined = r["test_auc"] * 0.4 + r["test_wr"] * 0.4 + min(r["test_pf"], 5.0) / 5.0 * 0.2
        if combined > best_combined:
            best_combined = combined
            best_model = name

        wr_str = f"{r['test_wr'] * 100:.1f}%"
        print(f"{name:<15} {r['val_auc']:>8.4f} {r['test_auc']:>9.4f} {wr_str:>8} "
              f"{r['test_pf']:>8.2f} {r['params']:>10,} {r['train_time_min']:>9.1f}")

    print(sep)
    print()

    if best_model:
        best = results[best_model]
        print(f"Best model: {best_model.upper()} "
              f"(val AUC={best['val_auc']:.4f}, test AUC={best['test_auc']:.4f}, "
              f"WR={best['test_wr'] * 100:.1f}%, PF={best['test_pf']:.2f})")

    # ── 8. Save report ──
    report = {
        "version": "dl_train_v1",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "config": {
            "seq_len": SEQ_LEN,
            "num_features": NUM_FEATURES,
            "batch_size": args.batch_size,
            "epochs": epochs,
            "quick": quick,
            "data_source": "expanded" if args.expanded else "klines-mtf",
        },
        "data": {
            "total_sequences": len(X_seq),
            "train_sequences": len(X_train),
            "val_sequences": len(X_val),
            "test_sequences": len(X_test),
            "train_wr": round(float(train_wr), 4),
            "val_wr": round(float(val_wr), 4),
            "test_wr": round(float(test_wr), 4),
            "train_period": f"{format_ts(train_tss[0])} -> {format_ts(train_tss[-1])}" if train_tss else "N/A",
            "test_period": f"{format_ts(test_tss[0])} -> {format_ts(test_tss[-1])}" if test_tss else "N/A",
        },
        "results": results,
        "best_model": best_model,
        "models_trained": model_names,
    }

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(REPORT_PATH, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nReport saved to {REPORT_PATH}")

    # ── 9. Summary ──
    print()
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"  Models trained: {', '.join(model_names)}")
    for name in model_names:
        r = results[name]
        print(f"  {name:>12}: val_auc={r['val_auc']:.4f} test_auc={r['test_auc']:.4f} "
              f"wr={r['test_wr'] * 100:.1f}% pf={r['test_pf']:.2f} "
              f"trades={r['test_trades']} time={r['train_time_min']:.1f}min")
    print(f"  Report: {REPORT_PATH}")
    print(f"  Best model: {best_model}")
    print("=" * 70)


if __name__ == "__main__":
    main()
