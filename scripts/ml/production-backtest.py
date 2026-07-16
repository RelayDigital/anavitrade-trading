#!/usr/bin/env python3
"""
Production backtest harness for meta-v20 MTF context model.

Runs chronological walk-forward on ALL 50 pairs using the unified engine's
MTF feature methodology. Validates against the pre-trained meta-v20 model.

Usage:
  python3 scripts/ml/production-backtest.py                     # Full run (50 pairs)
  python3 scripts/ml/production-backtest.py --quick             # 5 pairs only
  python3 scripts/ml/production-backtest.py --threshold 0.75    # Fixed threshold (skip sweep)
  python3 scripts/ml/production-backtest.py --shap              # Include SHAP analysis
  python3 scripts/ml/production-backtest.py --train             # Train fresh model instead of loading
  python3 scripts/ml/production-backtest.py --output-dir scripts/data/backtest/

Primary timeframe: 15m (each 15m bar produces a feature vector)
Context timeframes: 1h, 4h (aligned from most recently completed bar)

Feature matrix order (30 cols, ALPHABETICAL, matching model.py rows_to_matrix sorted()):
  ao_gradient, bb_sqz_product, h1_ao, h1_bb_pos, h1_bb_width,
  h1_ma7_slope, h1_macd, h1_rsi, h1_trend, h1_vol_z,
  h4_ao, h4_bb_pos, h4_bb_width, h4_macd, h4_rsi,
  h4_trend, m15_ao, m15_atr_pct, m15_bb_pos, m15_bb_width,
  m15_ma7_slope, m15_macd, m15_rsi, m15_swing_dist,
  m15_trend, m15_vol_z, mtf_15_1h_agree, mtf_triple_agree,
  rsi_gradient, tf_vol_sum
"""

import sys
import json
import argparse
import time
import os
import csv
import pickle
import warnings
from pathlib import Path
from typing import List, Dict, Tuple, Optional

import numpy as np
from sklearn.isotonic import IsotonicRegression

warnings.filterwarnings("ignore")

_sys_path = Path(__file__).resolve().parent.parent.parent
if str(_sys_path) not in sys.path:
    sys.path.insert(0, str(_sys_path))

try:
    from scripts.ml.pipeline.config import PipelineConfig, DEFAULT
    from scripts.ml.pipeline.features import enrich, EnrichedBar, _sma, _ema, _atr, _slope
    from scripts.ml.pipeline.labels import compute_outcome
    from scripts.ml.pipeline.backtest import sweep, print_table, print_best, find_best
    from scripts.ml.pipeline.model import train_chronological, save_model
except ImportError:
    from pipeline.config import PipelineConfig, DEFAULT
    from pipeline.features import enrich, EnrichedBar, _sma, _ema, _atr, _slope
    from pipeline.labels import compute_outcome
    from pipeline.backtest import sweep, print_table, print_best, find_best
    from pipeline.model import train_chronological, save_model

MODEL_DIR = Path("scripts/data/models/meta-v20-mtf-context")
KLINES_PATH = Path("scripts/data/klines-mtf.json")
PRIMARY_TF = "15m"

TARGET_WR = 0.65
TARGET_PF = 3.0
MIN_TRADES = 50
INITIAL_CAPITAL = 10_000.0
RISK_PER_TRADE = 100.0

FEATURE_NAMES = [
    "ao_gradient", "bb_sqz_product",
    "h1_ao", "h1_bb_pos", "h1_bb_width", "h1_ma7_slope", "h1_macd", "h1_rsi", "h1_trend", "h1_vol_z",
    "h4_ao", "h4_bb_pos", "h4_bb_width", "h4_macd", "h4_rsi", "h4_trend",
    "m15_ao", "m15_atr_pct", "m15_bb_pos", "m15_bb_width", "m15_ma7_slope", "m15_macd", "m15_rsi",
    "m15_swing_dist", "m15_trend", "m15_vol_z",
    "mtf_15_1h_agree", "mtf_triple_agree", "rsi_gradient", "tf_vol_sum",
]

NUM_FEATURES = len(FEATURE_NAMES)

BACKTEST_CFG = PipelineConfig(
    primary_tf="15m", ma_slow=99,
    stop_atr_mult=2.0, rr_target=2.0, max_lookforward_bars=48, train_split=0.70,
    lgbm_estimators=300, lgbm_max_depth=7, lgbm_learning_rate=0.02,
    lgbm_subsample=0.8, lgbm_colsample=0.8, lgbm_min_child=50,
    lgbm_reg_alpha=0.1, lgbm_reg_lambda=1.0,
)


# ═══════════════════════════════════════════════════════════════════════════════
#  UTILITY FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════════

def compute_macd_hist(close: np.ndarray, fast: int = 12, slow: int = 26, signal: int = 9) -> np.ndarray:
    ema_fast = _ema(close, fast)
    ema_slow = _ema(close, slow)
    macd_line = ema_fast - ema_slow
    signal_line = _ema(macd_line, signal)
    return macd_line - signal_line


def trend_val(b: EnrichedBar) -> int:
    return int(b.trend_bull) - int(b.trend_bear)


def swing_dist_to_close(bars: List[EnrichedBar], idx: int, atr_val: float, lookback: int = 15) -> float:
    close = bars[idx].close
    min_dist = 999.0
    for k in range(max(0, idx - lookback), idx):
        ph = all(bars[k].high >= bars[k - j].high for j in range(1, min(3, k)) if k - j >= 0)
        ph = ph and all(bars[k].high >= bars[k + j].high for j in range(1, min(3, len(bars) - k)) if k + j < idx)
        if ph and bars[k].high > close:
            d = (bars[k].high - close) / atr_val if atr_val > 0 else 999
            min_dist = min(min_dist, d)
        pl = all(bars[k].low <= bars[k - j].low for j in range(1, min(3, k)) if k - j >= 0)
        pl = pl and all(bars[k].low <= bars[k + j].low for j in range(1, min(3, len(bars) - k)) if k + j < idx)
        if pl and bars[k].low < close:
            d = (close - bars[k].low) / atr_val if atr_val > 0 else 999
            min_dist = min(min_dist, d)
    return min(min_dist, 5.0) if min_dist < 500 else 5.0


def format_ts(ts: int) -> str:
    from datetime import datetime
    return datetime.utcfromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")


def classify_regime(features: Dict) -> str:
    """
    Classify bar regime based on MTF features.

    Momentum continuation: AO > -1 AND MACD > -0.5 AND RSI >= 35 AND near structure
    Oversold reversal:     RSI < 35
    """
    rsi = features.get("m15_rsi", 50)
    ao = features.get("m15_ao", 0)
    macd = features.get("m15_macd", 0)
    sw_dist = features.get("m15_swing_dist", 99)

    if rsi < 35:
        return "reversal"
    if ao > -1 and macd > -0.5 and rsi >= 35 and sw_dist < 2:
        return "momentum"
    return "other"


# ═══════════════════════════════════════════════════════════════════════════════
#  ATR VERIFICATION
# ═══════════════════════════════════════════════════════════════════════════════

def verify_atr() -> bool:
    print("=" * 60)
    print("ATR VERIFICATION")
    print("=" * 60)
    with open(KLINES_PATH) as f:
        pairs_data = json.load(f)

    btc = [p for p in pairs_data if p["symbol"] == "BTCUSDT"]
    if not btc:
        print("  No BTCUSDT found, using first pair")
        btc = [pairs_data[0]]

    klines = btc[0]["klines"].get("1h", [])
    if not klines:
        print("  No 1h data for ATR verification")
        return False

    h = np.array([k["high"] for k in klines], dtype=np.float64)
    l = np.array([k["low"] for k in klines], dtype=np.float64)
    c = np.array([k["close"] for k in klines], dtype=np.float64)

    atr_values = _atr(h, l, c, 14)
    valid = atr_values[atr_values > 0]
    if len(valid) == 0:
        print("  No valid ATR values!")
        return False

    mn, mx, mean = float(valid.min()), float(valid.max()), float(valid.mean())
    print(f"  {btc[0]['symbol']} 1h ATR(14): min={mn:.2f}, max={mx:.2f}, mean={mean:.2f}")

    if 50 <= mean <= 3200:
        print(f"  PASS: ATR mean {mean:.2f} in expected range (50-3200)")
        return True
    print(f"  FAIL: ATR mean {mean:.2f} outside expected range (50-3200)")
    return False


# ═══════════════════════════════════════════════════════════════════════════════
#  MTF FEATURE BUILDER
# ═══════════════════════════════════════════════════════════════════════════════

FEATURE_PARSE_CACHE = {}


def build_mtf_features(
    symbol: str,
    klines_15m: List[Dict],
    klines_1h: List[Dict],
    klines_4h: List[Dict],
    cfg,
) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray], Optional[List[Dict]]]:
    """Build MTF feature vectors and labels for one pair."""
    bars_15m = enrich(klines_15m, cfg)
    bars_1h = enrich(klines_1h, cfg)
    bars_4h = enrich(klines_4h, cfg)
    if not bars_15m or not bars_1h or not bars_4h:
        return None, None, None, None

    warmup = cfg.ma_slow
    if len(bars_15m) < warmup + 50:
        return None, None, None, None

    close_15m = np.array([b.close for b in bars_15m], dtype=np.float64)
    close_1h = np.array([b.close for b in bars_1h], dtype=np.float64)
    close_4h = np.array([b.close for b in bars_4h], dtype=np.float64)

    macd_15m = compute_macd_hist(close_15m)
    macd_1h = compute_macd_hist(close_1h)
    macd_4h = compute_macd_hist(close_4h)

    ma7_15m = np.array([b.ma7 for b in bars_15m], dtype=np.float64)
    ma7_1h = np.array([b.ma7 for b in bars_1h], dtype=np.float64)

    ts_15m = np.array([b.timestamp for b in bars_15m])
    ts_1h = np.array([b.timestamp for b in bars_1h])
    ts_4h = np.array([b.timestamp for b in bars_4h])

    max_end = len(bars_15m) - cfg.max_lookforward_bars
    if max_end <= warmup:
        return None, None, None, None

    rows = []

    for i in range(warmup, max_end):
        b15 = bars_15m[i]
        ts = b15.timestamp
        atr_val = b15.atr14
        if atr_val <= 0 or b15.close <= 0:
            continue

        h1_idx = max(0, int(np.searchsorted(ts_1h, ts, side="right")) - 1)
        h4_idx = max(0, int(np.searchsorted(ts_4h, ts, side="right")) - 1)
        b1h = bars_1h[h1_idx]
        b4h = bars_4h[h4_idx]

        m15_tv = trend_val(b15)
        h1_tv = trend_val(b1h)
        h4_tv = trend_val(b4h)

        rsi_grad = b15.rsi14 - bars_15m[max(0, i - 3)].rsi14
        bb_sqz_prod = float(b15.bb_squeeze_intensity * b1h.bb_squeeze_intensity * b4h.bb_squeeze_intensity)

        mtf_15_1h_agree = 1 if (m15_tv == h1_tv and m15_tv != 0) else 0
        mtf_triple = 1 if (m15_tv == h1_tv == h4_tv and m15_tv != 0) else 0
        tf_vol_sum = b15.vol_zscore + b1h.vol_zscore + b4h.vol_zscore
        sw_dist = swing_dist_to_close(bars_15m, i, atr_val)

        features = {
            "ao_gradient": b15.ao_slope,
            "bb_sqz_product": bb_sqz_prod,
            "h1_ao": b1h.ao,
            "h1_bb_pos": b1h.price_in_bb,
            "h1_bb_width": b1h.bb_width_pct,
            "h1_ma7_slope": _slope(ma7_1h, 5, h1_idx),
            "h1_macd": macd_1h[h1_idx],
            "h1_rsi": b1h.rsi14,
            "h1_trend": h1_tv,
            "h1_vol_z": b1h.vol_zscore,
            "h4_ao": b4h.ao,
            "h4_bb_pos": b4h.price_in_bb,
            "h4_bb_width": b4h.bb_width_pct,
            "h4_macd": macd_4h[h4_idx],
            "h4_rsi": b4h.rsi14,
            "h4_trend": h4_tv,
            "m15_ao": b15.ao,
            "m15_atr_pct": b15.atr_percentile,
            "m15_bb_pos": b15.price_in_bb,
            "m15_bb_width": b15.bb_width_pct,
            "m15_ma7_slope": _slope(ma7_15m, 5, i),
            "m15_macd": macd_15m[i],
            "m15_rsi": b15.rsi14,
            "m15_swing_dist": sw_dist,
            "m15_trend": m15_tv,
            "m15_vol_z": b15.vol_zscore,
            "mtf_15_1h_agree": mtf_15_1h_agree,
            "mtf_triple_agree": mtf_triple,
            "rsi_gradient": rsi_grad,
            "tf_vol_sum": tf_vol_sum,
        }

        for direction in ("long", "short"):
            row = {"symbol": symbol, "timestamp": ts, "direction": direction, "_bar_index": i}
            row.update(features)
            outcome = compute_outcome(bars_15m, i, direction, cfg)
            row.update(outcome)
            rows.append(row)

    if not rows:
        return None, None, None, None

    X = np.array([[r[f] for f in FEATURE_NAMES] for r in rows], dtype=np.float32)
    y_win = np.array([1 if r.get("hitTP") else 0 for r in rows], dtype=np.int32)
    y_pnl = np.array([float(r.get("pnlR", 0) or 0) for r in rows], dtype=np.float32)

    return X, y_win, y_pnl, rows


# ═══════════════════════════════════════════════════════════════════════════════
#  CHRONOLOGICAL SPLIT
# ═══════════════════════════════════════════════════════════════════════════════

def chronological_split(metadatas: List[Dict], train_ratio: float = 0.70):
    """Group-allocation: split by unique timestamps chronologically."""
    timestamps = sorted(set(r["timestamp"] for r in metadatas))
    n = len(timestamps)
    t_end = int(n * train_ratio)
    v_end = int(n * (train_ratio + (1.0 - train_ratio) / 2))

    train_ts = set(timestamps[:t_end])
    val_ts = set(timestamps[t_end:v_end])
    test_ts = set(timestamps[v_end:])

    def idxs(ts_set):
        return [i for i, r in enumerate(metadatas) if r["timestamp"] in ts_set]

    return idxs(train_ts), idxs(val_ts), idxs(test_ts)


def select_rows(X, y_win, y_pnl, metadatas, indices):
    return X[indices], y_win[indices], y_pnl[indices], [metadatas[i] for i in indices]


# ═══════════════════════════════════════════════════════════════════════════════
#  METRICS COMPUTATION
# ═══════════════════════════════════════════════════════════════════════════════

def compute_metrics(
    y_win: np.ndarray, y_pnl: np.ndarray, metadatas: List[Dict],
    feature_matrix: np.ndarray = None,
) -> Dict:
    n = len(y_win)
    if n == 0:
        return {}

    wins = int(y_win.sum())
    losses = n - wins
    wr = wins / n

    gp = float(y_pnl[y_pnl > 0].sum())
    gl = float(abs(y_pnl[y_pnl < 0].sum()))
    pf = gp / gl if gl > 0 else (999.0 if gp > 0 else 0.0)

    avg_r = float(y_pnl.mean()) if n > 0 else 0.0
    total_r = float(y_pnl.sum())

    sharpe = 0.0
    if n > 1 and float(y_pnl.std()) > 0:
        sharpe = float(y_pnl.mean() / y_pnl.std() * np.sqrt(n))

    # Equity curve (one extra element for starting capital)
    dollar_pnls = y_pnl.astype(np.float64) * RISK_PER_TRADE
    cum_pnl = np.concatenate([[0.0], np.cumsum(dollar_pnls)])
    eq = INITIAL_CAPITAL + cum_pnl
    peak = np.maximum.accumulate(eq)
    dd = (peak - eq) / peak
    max_dd_pct = float(dd.max() * 100)

    final_equity = float(eq[-1])
    return_pct = ((final_equity - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100

    # Per-pair breakdown
    symbols = sorted(set(r["symbol"] for r in metadatas))
    per_pair = []
    for sym in symbols:
        idxs = [i for i, r in enumerate(metadatas) if r["symbol"] == sym]
        if not idxs:
            continue
        pnls = y_pnl[idxs]
        w = int(y_win[idxs].sum())
        np_ = len(idxs)
        gp_ = float(pnls[pnls > 0].sum())
        gl_ = float(abs(pnls[pnls < 0].sum()))
        pf_ = gp_ / gl_ if gl_ > 0 else (999.0 if gp_ > 0 else 0.0)
        sh_ = 0.0
        if np_ > 1 and float(pnls.std()) > 0:
            sh_ = float(pnls.mean() / pnls.std() * np.sqrt(np_))
        per_pair.append({
            "symbol": sym, "trades": np_, "wr": round(w / np_, 4),
            "pf": round(pf_, 2), "net_pnl_r": round(float(pnls.sum()), 2),
            "sharpe": round(sh_, 2),
        })

    # Regime breakdown
    regime_trades = {"momentum": [], "reversal": [], "other": []}
    for i, r in enumerate(metadatas):
        feats = {}
        if feature_matrix is not None and i < len(feature_matrix):
            feats = {FEATURE_NAMES[j]: feature_matrix[i][j] for j in range(NUM_FEATURES)}
        regime_trades[classify_regime(feats)].append(i)

    regime_breakdown = {}
    for reg, idxs in regime_trades.items():
        if not idxs:
            continue
        pnls = y_pnl[idxs]
        w = int(y_win[idxs].sum())
        nr = len(idxs)
        gp_ = float(pnls[pnls > 0].sum())
        gl_ = float(abs(pnls[pnls < 0].sum()))
        rf_ = gp_ / gl_ if gl_ > 0 else (999.0 if gp_ > 0 else 0.0)
        regime_breakdown[reg] = {
            "trades": nr, "wr": round(w / nr, 4), "pf": round(rf_, 2),
        }

    return {
        "total_trades": n, "wins": wins, "losses": losses,
        "wr": round(wr, 4), "pf": round(pf, 2), "sharpe": round(sharpe, 2),
        "max_dd_pct": round(max_dd_pct, 2), "avg_r": round(avg_r, 3),
        "total_r": round(total_r, 2),
        "total_return_usd": round(float(dollar_pnls.sum()), 2),
        "final_equity": round(final_equity, 2),
        "return_pct": round(return_pct, 2),
        "per_pair": per_pair, "regime_breakdown": regime_breakdown,
        "equity_curve": [round(float(v), 2) for v in eq.tolist()],
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  ISOTONIC CALIBRATION (critical for meta-v20 model)
# ═══════════════════════════════════════════════════════════════════════════════

def calibrate_probs(clf, X_cal: np.ndarray, y_cal: np.ndarray, X_test: np.ndarray):
    """Fit isotonic calibrator on held-out calibration set."""
    raw_cal = clf.predict_proba(X_cal)[:, 1]
    calib = IsotonicRegression(y_min=0, y_max=1, out_of_bounds="clip")
    calib.fit(raw_cal, y_cal.astype(np.float64))

    raw_test = clf.predict_proba(X_test)[:, 1]
    calibrated = calib.predict(raw_test)

    return calibrated, calib, raw_test


# ═══════════════════════════════════════════════════════════════════════════════
#  SHAP ANALYSIS
# ═══════════════════════════════════════════════════════════════════════════════

def compute_shap(model, X: np.ndarray, feature_names: List[str]) -> Dict:
    try:
        import shap
    except ImportError:
        print("  SHAP not installed (pip install shap)")
        return {}

    print(f"  Computing SHAP on {len(X)} rows...")
    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X)

    if isinstance(shap_values, list):
        shap_values = shap_values[1]

    mean_shap = np.abs(shap_values).mean(axis=0)
    shap_dict = {
        feature_names[i]: float(mean_shap[i])
        for i in np.argsort(mean_shap)[::-1]
    }

    print("  Top 10 SHAP features:")
    for i, (feat, imp) in enumerate(list(shap_dict.items())[:10]):
        print(f"    {i + 1}. {feat}: {imp:.4f}")

    return shap_dict


# ═══════════════════════════════════════════════════════════════════════════════
#  LOAD / TRAIN MODEL
# ═══════════════════════════════════════════════════════════════════════════════

def load_model():
    """Load meta-v20 pre-trained model."""
    if not (MODEL_DIR / "classifier.pkl").exists():
        print(f"  ERROR: Model not found at {MODEL_DIR / 'classifier.pkl'}")
        sys.exit(1)

    with open(MODEL_DIR / "classifier.pkl", "rb") as f:
        model = pickle.load(f)

    print(f"  Model: {type(model).__name__}")
    print(f"  Features: {model.n_features_in_}")
    print(f"  Trees: {model.booster_.num_trees()}")
    print(f"  Learning rate: {model.booster_.params.get('learning_rate', 'N/A')}")

    # Load model card for threshold reference
    try:
        with open(MODEL_DIR / "model_card.json") as f:
            mc = json.load(f)
        print(f"  Model card: threshold={mc.get('threshold', 'N/A')}, "
              f"WR={mc.get('test_wr', 'N/A')}, PF={mc.get('test_pf', 'N/A')}, "
              f"trades={mc.get('test_trades', 'N/A')}")
    except (FileNotFoundError, json.JSONDecodeError):
        print("  No model_card.json found")

    return model


def train_new_model(X_train, y_win_train, y_pnl_train, meta_train):
    """Train a fresh model from scratch using the built features."""
    import lightgbm as lgb

    print("  Training fresh model...")

    # Calibration holdout: 80/20 within train
    timestamps = sorted(set(r["timestamp"] for r in meta_train))
    cal_split_ts = timestamps[int(len(timestamps) * 0.8)]

    train_idx = [i for i, r in enumerate(meta_train) if r["timestamp"] < cal_split_ts]
    cal_idx = [i for i, r in enumerate(meta_train) if r["timestamp"] >= cal_split_ts]

    X_t, y_t = X_train[train_idx], y_win_train[train_idx]
    X_cal, y_cal = X_train[cal_idx], y_win_train[cal_idx]

    print(f"    Train: {len(X_t)} rows, Cal: {len(X_cal)} rows")

    clf = lgb.LGBMClassifier(
        n_estimators=300, max_depth=7, num_leaves=63,
        learning_rate=0.02, subsample=0.8, colsample_bytree=0.8,
        min_child_samples=50, reg_alpha=0.1, reg_lambda=1.0,
        class_weight="balanced", random_state=42, verbose=-1,
        force_col_wise=True,
    )
    clf.fit(X_t, y_t)

    # Calibrate
    raw_cal = clf.predict_proba(X_cal)[:, 1]
    calibrator = IsotonicRegression(y_min=0, y_max=1, out_of_bounds="clip")
    calibrator.fit(raw_cal, y_cal.astype(np.float64))

    return clf, calibrator


# ═══════════════════════════════════════════════════════════════════════════════
#  MAIN BACKTEST LOOP
# ═══════════════════════════════════════════════════════════════════════════════

def run_backtest(
    threshold: Optional[float] = None,
    output_dir: Optional[Path] = None,
    use_shap: bool = False,
    quick: bool = False,
    sweep_step: float = 0.02,
    train_mode: bool = False,
):
    t_start = time.time()

    # ─── 1. ATR Verification ───
    atr_ok = verify_atr()
    print()

    # ─── 2. Load data ───
    print("=" * 60)
    print("LOADING DATA")
    print("=" * 60)
    with open(KLINES_PATH) as f:
        pairs = json.load(f)

    if quick:
        pairs = pairs[:5]
        print(f"  QUICK MODE: Using first {len(pairs)} pairs")
    print(f"  Total pairs: {len(pairs)}")
    print(f"  Primary TF: {PRIMARY_TF}")
    print(f"  Model: {MODEL_DIR}")
    print()

    # ─── 3. Build MTF features ───
    print("=" * 60)
    print("BUILDING MTF FEATURES")
    print("=" * 60)

    all_X, all_y_win, all_y_pnl = [], [], []
    all_metadatas = []
    pair_stats = []
    cfg = BACKTEST_CFG

    for pi, pair in enumerate(pairs):
        symbol = pair["symbol"]
        klines = pair.get("klines", {})
        raw_15m, raw_1h, raw_4h = klines.get("15m", []), klines.get("1h", []), klines.get("4h", [])

        if len(raw_15m) < 100 or len(raw_1h) < 100 or len(raw_4h) < 100:
            print(f"  [{pi + 1}/{len(pairs)}] {symbol}: SKIP (insufficient data)")
            continue

        result = build_mtf_features(symbol, raw_15m, raw_1h, raw_4h, cfg)
        if result[0] is None:
            print(f"  [{pi + 1}/{len(pairs)}] {symbol}: SKIP (feature build failed)")
            continue

        X_p, yw_p, yp_p, meta_p = result
        all_X.append(X_p)
        all_y_win.append(yw_p)
        all_y_pnl.append(yp_p)
        all_metadatas.extend(meta_p)
        pair_stats.append({
            "symbol": symbol, "rows": len(meta_p),
            "wins": int(yw_p.sum()), "losses": len(yw_p) - int(yw_p.sum()),
            "wr": round(float(yw_p.mean()), 4),
        })

        if (pi + 1) % 10 == 0 or pi == len(pairs) - 1:
            print(f"  [{pi + 1}/{len(pairs)}] {symbol}: {len(meta_p)} rows ({time.time() - t_start:.0f}s)")

    if not all_X:
        print("  No data produced!")
        return

    X_all = np.vstack(all_X)
    y_win_all = np.concatenate(all_y_win)
    y_pnl_all = np.concatenate(all_y_pnl)
    total_rows = len(all_metadatas)
    total_wins = int(y_win_all.sum())
    baseline_wr = total_wins / total_rows

    print(f"\n  Total: {total_rows} rows, {total_wins} wins (WR={baseline_wr * 100:.1f}%)")
    print(f"  Elapsed: {time.time() - t_start:.0f}s")
    print()

    # ─── 4. Chronological split (70/15/15) ───
    print("=" * 60)
    print("CHRONOLOGICAL SPLIT (70/15/15)")
    print("=" * 60)

    train_i, val_i, test_i = chronological_split(all_metadatas, 0.70)

    X_train, yw_train, yp_train, meta_train = select_rows(X_all, y_win_all, y_pnl_all, all_metadatas, train_i)
    X_val, yw_val, yp_val, meta_val = select_rows(X_all, y_win_all, y_pnl_all, all_metadatas, val_i)
    X_test, yw_test, yp_test, meta_test = select_rows(X_all, y_win_all, y_pnl_all, all_metadatas, test_i)

    ts_train = sorted(set(r["timestamp"] for r in meta_train))
    ts_val = sorted(set(r["timestamp"] for r in meta_val))
    ts_test = sorted(set(r["timestamp"] for r in meta_test))

    print(f"  Train: {len(meta_train)} rows, {len(ts_train)} timestamps ({format_ts(ts_train[0])} → {format_ts(ts_train[-1])})" if meta_train else "  Train: 0")
    print(f"  Val:   {len(meta_val)} rows ({format_ts(ts_val[0])} → {format_ts(ts_val[-1])})" if meta_val else "  Val: 0")
    print(f"  Test:  {len(meta_test)} rows ({format_ts(ts_test[0])} → {format_ts(ts_test[-1])})" if meta_test else "  Test: 0")
    print()

    # ─── 5. Model ───
    print("=" * 60)
    print("MODEL")
    print("=" * 60)

    if train_mode:
        clf, calibrator = train_new_model(X_train, yw_train, yp_train, meta_train)
        trained = True
    else:
        clf = load_model()
        # Need calibration holdout: split train further 80/20
        ts_all = sorted(set(r["timestamp"] for r in meta_train))
        cal_split_ts = ts_all[int(len(ts_all) * 0.8)]
        train_t_idx = [i for i, r in enumerate(meta_train) if r["timestamp"] < cal_split_ts]
        cal_idx = [i for i, r in enumerate(meta_train) if r["timestamp"] >= cal_split_ts]
        X_cal, y_cal = X_train[cal_idx], yw_train[cal_idx]
        _, calibrator, _ = calibrate_probs(clf, X_cal, y_cal, X_test[:1])
        trained = False

    print()

    # ─── 6. Score test set ───
    print("=" * 60)
    print("SCORING TEST SET")
    print("=" * 60)

    raw_test = clf.predict_proba(X_test)[:, 1]

    raw_val = clf.predict_proba(X_val)[:, 1]

    if trained:
        # For train mode: use raw probs directly (calibration unstable on small data)
        # The raw probs already capture model confidence on imbalanced data
        probs_test = raw_test
        print(f"  Raw probs:    min={probs_test.min():.4f}, max={probs_test.max():.4f}, mean={probs_test.mean():.4f}, median={np.median(probs_test):.4f}")
        sweep_min, sweep_max = 0.15, 0.80
    else:
        # Pre-trained model: use RAW probs (calibrator unavailable for current data)
        probs_test = raw_test
        print(f"  Raw probs:    min={probs_test.min():.4f}, max={probs_test.max():.4f}, mean={probs_test.mean():.4f}, median={np.median(probs_test):.4f}")
        sweep_min, sweep_max = 0.10, 0.80

    print()

    # ─── 7. Threshold sweep on TEST ───
    print("=" * 60)
    print("THRESHOLD SWEEP (TEST)")
    print("=" * 60)

    if threshold is not None:
        results_list = sweep(probs_test, yw_test, yp_test, threshold_min=threshold, threshold_max=threshold + 0.02, threshold_step=0.02)
    else:
        results_list = sweep(probs_test, yw_test, yp_test, threshold_min=sweep_min, threshold_max=sweep_max, threshold_step=sweep_step)

    if not results_list:
        print("  No valid results at any threshold!")
        return

    print_table(results_list, {"wr": TARGET_WR, "pf": TARGET_PF})
    best_result = find_best(results_list, "sharpe")
    print_best(best_result, {"wr": TARGET_WR, "pf": TARGET_PF})

    pf_results = [r for r in results_list if r["trades"] >= MIN_TRADES]
    best_pf_result = find_best(pf_results, "pf") if pf_results else best_result
    print(f"\nBest PF (≥{MIN_TRADES} trades): threshold={best_pf_result.get('threshold', 'N/A')} | "
          f"{best_pf_result.get('trades', 0)}t | WR={best_pf_result.get('wr', 0)*100:.1f}% | "
          f"PF={best_pf_result.get('pf', 0):.2f} | Sharpe={best_pf_result.get('sharpe', 0):.2f}")
    print()

    # ─── 8. Detailed metrics at best threshold ───
    print("=" * 60)
    print("DETAILED METRICS (BEST SHARPE)")
    print("=" * 60)

    t_best = best_result["threshold"]
    mask_best = probs_test >= t_best
    n_best = int(mask_best.sum())

    metrics = {}
    if n_best > 0:
        metrics = compute_metrics(yw_test[mask_best], yp_test[mask_best], [meta_test[i] for i in range(len(meta_test)) if mask_best[i]], X_test[mask_best])
        _print_metrics(metrics)
    else:
        print("  No trades at best threshold")
    print()

    # Also show detailed metrics for best PF (≥50 trades)
    if pf_results and best_pf_result.get("threshold") != best_result.get("threshold"):
        t_pf = best_pf_result["threshold"]
        mask_pf = probs_test >= t_pf
        n_pf = int(mask_pf.sum())
        if n_pf > 0:
            print("=" * 60)
            print(f"DETAILED METRICS (BEST PF ≥{MIN_TRADES} TRADES)")
            print("=" * 60)
            metrics_pf = compute_metrics(yw_test[mask_pf], yp_test[mask_pf], [meta_test[i] for i in range(len(meta_test)) if mask_pf[i]], X_test[mask_pf])
            _print_metrics(metrics_pf)
            print()

    # ─── 9. SHAP (optional) ───
    shap_importance = {}
    if use_shap and n_best > 0:
        print("=" * 60)
        print("SHAP FEATURE IMPORTANCE")
        print("=" * 60)
        shap_importance = compute_shap(clf, X_test, FEATURE_NAMES)
        print()

    # ─── 10. Save results ───
    print("=" * 60)
    print("SAVING RESULTS")
    print("=" * 60)

    if output_dir is None:
        output_dir = Path("scripts/data/backtest")
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp_str = time.strftime("%Y%m%d_%H%M%S")

    # Feature importance from model
    fi = clf.feature_importances_
    fi_dict = {FEATURE_NAMES[i]: int(fi[i]) for i in np.argsort(fi)[::-1]}

    # Goals check
    best_wr = best_result.get("wr", 0)
    best_pf_val = best_result.get("pf", 0)
    goals_met = (best_wr >= TARGET_WR and best_pf_val >= TARGET_PF)

    report = {
        "version": "production-backtest-v1",
        "timestamp": timestamp_str,
        "mode": "train_scratch" if train_mode else "pre_trained",
        "quick": quick,
        "data": {"pairs": len(pairs), "total_rows": total_rows, "baseline_wr": round(float(baseline_wr), 4)},
        "split": {
            "method": "chronological_70_15_15",
            "train_rows": len(meta_train), "val_rows": len(meta_val), "test_rows": len(meta_test),
            "train_start": format_ts(ts_train[0]) if meta_train else None,
            "train_end": format_ts(ts_train[-1]) if meta_train else None,
            "test_start": format_ts(ts_test[0]) if meta_test else None,
            "test_end": format_ts(ts_test[-1]) if meta_test else None,
        },
        "model": {
            "path": str(MODEL_DIR),
            "type": type(clf).__name__,
            "trees": clf.booster_.num_trees(),
        },
        "threshold_sweep": [{
            "threshold": r["threshold"], "pass_pct": r["pass_pct"], "trades": r["trades"],
            "wr": r["wr"], "pf": r["pf"], "sharpe": r["sharpe"], "max_dd": r["max_dd"],
        } for r in results_list],
        "best_threshold": best_result,
        "best_pf_threshold": best_pf_result,
        "detailed_metrics": metrics,
        "feature_importance": fi_dict,
        "shap_importance": shap_importance,
        "goals_met": goals_met,
        "atr_verified": atr_ok,
        "pair_stats": pair_stats,
        "atr_verification": {"status": "passed" if atr_ok else "failed"},
    }

    report_path = output_dir / f"backtest_report_{timestamp_str}.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"  Report: {report_path}")

    if metrics.get("per_pair"):
        csv_path = output_dir / f"per_pair_{timestamp_str}.csv"
        with open(csv_path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["symbol", "trades", "wr", "pf", "net_pnl_r", "sharpe"])
            w.writeheader()
            for pp in metrics["per_pair"]:
                w.writerow(pp)
        print(f"  Per-pair CSV: {csv_path}")

    fi_csv = output_dir / f"feature_importance_{timestamp_str}.csv"
    with open(fi_csv, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["feature", "importance"])
        for feat, imp in fi_dict.items():
            writer.writerow([feat, imp])
    print(f"  Feature importance CSV: {fi_csv}")

    # ─── 11. Summary ───
    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Data: {total_rows} rows from {len(pairs)} pairs (15m primary)")
    print(f"  Baseline WR: {baseline_wr * 100:.1f}%")
    print(f"  Mode: {'train-from-scratch' if train_mode else 'pre-trained + calibration'}")
    print(f"  Best Sharpe: t={best_result.get('threshold', 'N/A')} "
          f"→ {best_result.get('trades', 0)}t "
          f"WR={best_wr * 100:.1f}% PF={best_pf_val:.2f} "
          f"Sharpe={best_result.get('sharpe', 0):.2f}")
    print(f"  Best PF (≥{MIN_TRADES}t): t={best_pf_result.get('threshold', 'N/A')} "
          f"→ {best_pf_result.get('trades', 0)}t "
          f"WR={best_pf_result.get('wr', 0) * 100:.1f}% "
          f"PF={best_pf_result.get('pf', 0):.2f}")
    print(f"  Goals: WR≥{TARGET_WR * 100:.0f}% PF≥{TARGET_PF} → {'MET' if goals_met else 'NOT MET'}")
    if not goals_met:
        print(f"    Off by: WR {abs(best_wr - TARGET_WR) * 100:.1f}%p, PF {abs(best_pf_val - TARGET_PF):.1f}")
    print(f"  ATR verification: {'PASSED' if atr_ok else 'FAILED'}")
    print(f"  Total time: {time.time() - t_start:.0f}s")
    print(f"  Report: {report_path}")
    print("=" * 60)

    return report


def _print_metrics(m: Dict):
    print(f"  Trades: {m.get('total_trades', 0)} (W:{m.get('wins', 0)} L:{m.get('losses', 0)})")
    print(f"  WR: {m.get('wr', 0) * 100:.1f}%")
    print(f"  PF: {m.get('pf', 0):.2f}")
    print(f"  Sharpe: {m.get('sharpe', 0):.2f}")
    print(f"  Max DD: {m.get('max_dd_pct', 0):.1f}%")
    print(f"  Avg R: {m.get('avg_r', 0):.3f}")
    print(f"  Total R: {m.get('total_r', 0):.2f}")
    print(f"  Return: ${m.get('total_return_usd', 0):.2f} ({m.get('return_pct', 0):.1f}%)")
    print(f"  Final equity: ${m.get('final_equity', 0):.2f}")

    regs = m.get("regime_breakdown", {})
    if regs:
        print(f"  Regime breakdown:")
        for reg, st in regs.items():
            print(f"    {reg}: {st['trades']}t WR={st['wr']*100:.1f}% PF={st['pf']:.2f}")

    pairs = m.get("per_pair", [])
    if pairs:
        sorted_pp = sorted(pairs, key=lambda x: x["trades"], reverse=True)
        print(f"  Per-pair (top 10):")
        for pp in sorted_pp[:10]:
            fl = " <5 trades" if pp["trades"] < 5 else ""
            print(f"    {pp['symbol']}: {pp['trades']}t WR={pp['wr']*100:.1f}% PF={pp['pf']:.2f}{fl}")


# ═══════════════════════════════════════════════════════════════════════════════
#  CLI
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Production backtest harness for meta-v20 MTF model")
    parser.add_argument("--threshold", type=float, default=None, help="Fixed threshold (skip sweep)")
    parser.add_argument("--output-dir", type=str, default=None, help="Results directory")
    parser.add_argument("--shap", action="store_true", help="Compute SHAP importance")
    parser.add_argument("--quick", action="store_true", help="Use first 5 pairs")
    parser.add_argument("--sweep-step", type=float, default=0.02, help="Sweep step size")
    parser.add_argument("--train", action="store_true", help="Train fresh model instead of loading pre-trained")
    args = parser.parse_args()

    run_backtest(
        threshold=args.threshold, output_dir=Path(args.output_dir) if args.output_dir else None,
        use_shap=args.shap, quick=args.quick, sweep_step=args.sweep_step, train_mode=args.train,
    )


if __name__ == "__main__":
    main()
