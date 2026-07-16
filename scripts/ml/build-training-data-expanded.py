#!/usr/bin/env python3
"""
Build expanded training dataset with 5m klines, macro features, and 45+ features.

Primary index: 5m bars (3x data density vs 15m)
Per bar: 5m indicators + 15m context + 1h context + 4h context + cross-TF + macro

Architecture:
  - Loads klines-mtf.json (15m/1h/4h) and macro-context.json
  - Fetches 5m klines from Binance API
  - Enriches ALL timeframes with indicators via pipeline.features.enrich()
  - For each 5m bar, finds containing 15m/1h/4h bars and builds feature vector
  - Labels via pipeline.labels.compute_outcome()

Target: 80K+ labeled rows, 45+ features (from meta-v20's 35K rows, 30 features)

Usage:
  python scripts/ml/build-training-data-expanded.py                    # Full run
  python scripts/ml/build-training-data-expanded.py --quick 5          # Quick test on 5 pairs
  python scripts/ml/build-training-data-expanded.py --pairs 10         # Limit to 10 pairs
  python scripts/ml/build-training-data-expanded.py --skip-fetch      # Use cached 5m data
"""

import sys
import json
import argparse
import time
import math
from pathlib import Path
from typing import List, Dict, Optional, Tuple
import urllib.request
import urllib.error
import numpy as np

# ─── Path Setup ─────────────────────────────────────────────────────────────
BASE = Path(__file__).resolve().parent.parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from scripts.ml.pipeline.features import enrich, EnrichedBar
from scripts.ml.pipeline.labels import compute_outcome
from scripts.ml.pipeline.config import PipelineConfig, DEFAULT as CFG

# ─── Constants ──────────────────────────────────────────────────────────────
BINANCE_API = "https://api.binance.com"
MS_5M = 5 * 60 * 1000
MS_15M = 15 * 60 * 1000
MS_1H = 60 * 60 * 1000
MS_4H = 4 * MS_1H
FETCH_DELAY = 0.2  # seconds between API calls

# Expanded config — 5m primary with proportional lookahead
CONFIG_EXPANDED = PipelineConfig(
    primary_tf="5m",
    chart_tf="15m",
    klines_input=Path("scripts/data/klines-mtf.json"),
    training_output=Path("scripts/data/training-data-mtf-expanded.json"),
    max_lookforward_bars=120,  # 120 * 5m = 10h lookahead
)

OUTPUT_PATH = Path("scripts/data/training-data-mtf-expanded.json")
CACHE_5M_PATH = Path("scripts/data/klines-5m-cache.json")
MACRO_PATH = Path("scripts/data/macro-context.json")
KLINES_MTF_PATH = Path("scripts/data/klines-mtf.json")

# ─── Vectorized Indicator Helpers ──────────────────────────────────────────

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
    out = np.zeros_like(values)
    if len(values) < 2:
        return out
    k = 2.0 / (period + 1)
    out[0] = values[0]
    for i in range(1, len(values)):
        out[i] = values[i] * k + out[i - 1] * (1 - k)
    return out


def _slope(values: np.ndarray, lookback: int, idx: int) -> float:
    """Linear slope over lookback bars ending at idx."""
    if idx < lookback - 1:
        return 0.0
    ys = values[idx - lookback + 1: idx + 1]
    if np.std(ys) < 1e-10:
        return 0.0
    xs = np.arange(lookback, dtype=np.float64)
    return float(np.polyfit(xs, ys, 1)[0])


def _true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    tr = np.zeros_like(high)
    tr[0] = high[0] - low[0]
    for i in range(1, len(high)):
        tr[i] = max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
    return tr


def _zscore(values: np.ndarray, period: int) -> np.ndarray:
    out = np.zeros_like(values)
    for i in range(period - 1, len(values)):
        w = values[i - period + 1: i + 1]
        s = np.std(w)
        out[i] = (values[i] - np.mean(w)) / s if s > 0 else 0
    return out


def _percent_rank(values: np.ndarray, period: int) -> np.ndarray:
    out = np.full(len(values), 0.5)
    for i in range(period - 1, len(values)):
        w = values[i - period + 1: i + 1]
        out[i] = np.sum(w <= values[i]) / period
    return out


def _bb_width(mid: np.ndarray, upper: np.ndarray, lower: np.ndarray) -> np.ndarray:
    """BB bandwidth: (upper - lower) / mid."""
    bw = np.zeros(len(mid))
    for i in range(len(mid)):
        bw[i] = (upper[i] - lower[i]) / mid[i] if mid[i] > 0 else 0
    return bw


def _bb_pos(close: np.ndarray, upper: np.ndarray, lower: np.ndarray) -> np.ndarray:
    """Price position within BB: 0=lower, 0.5=mid, 1=upper."""
    result = np.full(len(close), 0.5)
    for i in range(len(close)):
        if upper[i] > lower[i]:
            result[i] = (close[i] - lower[i]) / (upper[i] - lower[i])
    return result


def _rsi(close: np.ndarray, period: int = 14) -> np.ndarray:
    out = np.full(len(close), 50.0)
    if len(close) < period + 1:
        return out
    delta = np.diff(close)
    gains = np.maximum(delta, 0)
    losses = np.maximum(-delta, 0)
    for i in range(period, len(close)):
        avg_gain = gains[i - period:i].mean()
        avg_loss = losses[i - period:i].mean()
        if avg_loss == 0:
            out[i] = 100
        else:
            out[i] = 100 - 100 / (1 + avg_gain / avg_loss)
    return out


def _macd_hist(close: np.ndarray, fast: int = 12, slow: int = 26, signal: int = 9) -> np.ndarray:
    """MACD histogram = MACD line - signal line."""
    ef = _ema(close, fast)
    es = _ema(close, slow)
    macd_line = ef - es
    sig_line = _ema(macd_line, signal)
    return macd_line - sig_line


def _adx(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    """Average Directional Index (Wilder's method)."""
    n = len(close)
    adx = np.zeros(n)
    if n < period * 2 + 2:
        return adx

    # True Range
    tr = _true_range(high, low, close)
    up_move = np.zeros(n)
    down_move = np.zeros(n)
    for i in range(1, n):
        up_move[i] = high[i] - high[i - 1]
        down_move[i] = low[i - 1] - low[i]

    atr_s = np.zeros(n)
    plus_di = np.zeros(n)
    minus_di = np.zeros(n)

    # First smoothed values
    atr_s[period] = np.mean(tr[1:period + 1])
    up_avg = np.mean(np.maximum(up_move[1:period + 1], 0))
    down_avg = np.mean(np.maximum(down_move[1:period + 1], 0))
    if atr_s[period] > 0:
        plus_di[period] = 100.0 * up_avg / atr_s[period]
        minus_di[period] = 100.0 * down_avg / atr_s[period]

    for i in range(period + 1, n):
        atr_s[i] = (atr_s[i - 1] * (period - 1) + tr[i]) / period
        up_avg = (up_avg * (period - 1) + max(up_move[i], 0)) / period
        down_avg = (down_avg * (period - 1) + max(down_move[i], 0)) / period
        if atr_s[i] > 0:
            plus_di[i] = 100.0 * up_avg / atr_s[i]
            minus_di[i] = 100.0 * down_avg / atr_s[i]

    # DX = |+DI - -DI| / (+DI + -DI)
    dx = np.zeros(n)
    for i in range(period, n):
        di_sum = plus_di[i] + minus_di[i]
        dx[i] = 100.0 * abs(plus_di[i] - minus_di[i]) / di_sum if di_sum > 0 else 0

    # ADX = smoothed DX
    adx[period * 2 - 1] = np.mean(dx[period:period * 2])
    for i in range(period * 2, n):
        adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period

    return adx


def _mfi(high: np.ndarray, low: np.ndarray, close: np.ndarray,
         volume: np.ndarray, period: int = 14) -> np.ndarray:
    """Money Flow Index."""
    n = len(close)
    mfi = np.full(n, 50.0)
    if n < period + 1:
        return mfi

    typical = (high + low + close) / 3
    money_flow = typical * volume

    for i in range(period, n):
        pos_flow = 0.0
        neg_flow = 0.0
        for j in range(i - period + 1, i + 1):
            if typical[j] > typical[j - 1]:
                pos_flow += money_flow[j]
            else:
                neg_flow += money_flow[j]
        ratio = pos_flow / neg_flow if neg_flow > 0 else 9999.0
        mfi[i] = 100.0 - 100.0 / (1 + ratio)

    return mfi


def _williams_r(high: np.ndarray, low: np.ndarray, close: np.ndarray,
                period: int = 14) -> np.ndarray:
    """Williams %R. Range: -100 to 0. Oversold < -80, Overbought > -20."""
    n = len(close)
    wr = np.full(n, -50.0)
    for i in range(period - 1, n):
        hh = np.max(high[i - period + 1: i + 1])
        ll = np.min(low[i - period + 1: i + 1])
        wr[i] = (hh - close[i]) / (hh - ll) * -100.0 if hh > ll else -50.0
    return wr


def _ao(high: np.ndarray, low: np.ndarray, fast: int = 5, slow: int = 34) -> np.ndarray:
    """Awesome Oscillator: SMA(HL2, fast) - SMA(HL2, slow)."""
    hl2 = (high + low) / 2
    return _sma(hl2, fast) - _sma(hl2, slow)


# ─── Zigzag Swing Distance ─────────────────────────────────────────────────

def _nearest_swing_pct(high: np.ndarray, low: np.ndarray, close: np.ndarray,
                       idx: int, lookback: int = 10) -> float:
    """Distance to nearest pivot high/low as % of close."""
    if idx < lookback:
        return 5.0
    # Simple approximation: max high and min low in lookback window
    nearest_high = np.max(high[idx - lookback: idx + 1]) if idx >= lookback else high[idx]
    nearest_low = np.min(low[idx - lookback: idx + 1]) if idx >= lookback else low[idx]
    dist = min(abs(close[idx] - nearest_high), abs(close[idx] - nearest_low))
    return dist / close[idx] * 100 if close[idx] > 0 else 0


def _swing_dist_atr(bars: List[EnrichedBar], idx: int,
                    lookback: int = 15, swing_lb: int = 4) -> float:
    """Distance to nearest swing pivot in ATR units."""
    if idx < swing_lb:
        return 5.0
    close = bars[idx].close if hasattr(bars[idx], 'close') else bars[idx].close
    atr_val = bars[idx].atr14
    if atr_val <= 0:
        return 5.0

    h_vals = [bars[k].high if hasattr(bars[k], 'high') else bars[k].high
              for k in range(max(swing_lb, idx - lookback), idx - swing_lb + 1)]
    l_vals = [bars[k].low if hasattr(bars[k], 'low') else bars[k].low
              for k in range(max(swing_lb, idx - lookback), idx - swing_lb + 1)]

    min_dist = 999.0
    for pv in h_vals:
        if pv > close:
            min_dist = min(min_dist, (pv - close) / atr_val)
    for pv in l_vals:
        if pv < close:
            min_dist = min(min_dist, (close - pv) / atr_val)
    return min(5.0, min_dist) if min_dist < 999 else 5.0


# ─── 5m Kline Fetching ─────────────────────────────────────────────────────

def fetch_5m_klines(symbol: str, start_time: int, limit: int = 1000) -> List[Dict]:
    """Fetch 5m klines from Binance spot API."""
    params = f"symbol={symbol}&interval=5m&limit={limit}&startTime={start_time}"
    url = f"{BINANCE_API}/api/v3/klines?{params}"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode())
        bars = []
        for c in raw:
            bars.append({
                "timestamp": c[0],
                "open": float(c[1]),
                "high": float(c[2]),
                "low": float(c[3]),
                "close": float(c[4]),
                "volume": float(c[5]),
            })
        return bars
    except Exception as e:
        return []


def fetch_5m_all(pairs: List[Dict], quick: int = 0,
                 skip: bool = False) -> Tuple[Dict[str, List[Dict]], int]:
    """Fetch 5m klines for all or limited pairs.

    Returns:
        dict of symbol -> 5m klines
        total bars fetched
    """
    if skip and CACHE_5M_PATH.exists():
        print("  Loading cached 5m data...")
        with open(CACHE_5M_PATH) as f:
            return json.load(f), 0

    # Determine the start time for 5m fetch: align with earliest 15m timestamp
    start_time = None
    for p in pairs:
        klines_15m = p.get("klines", {}).get("15m", [])
        if klines_15m:
            st = klines_15m[0]["timestamp"]
            if start_time is None or st < start_time:
                start_time = st
    if start_time is None:
        # Fallback: 7 days ago
        start_time = int(time.time() * 1000) - 7 * 24 * 3600 * 1000

    limit = quick if quick > 0 else len(pairs)
    symbols = [p["symbol"] for p in pairs[:limit]]

    print(f"  Fetching 5m klines for {len(symbols)} pairs from ts={start_time}...")
    result = {}
    total_bars = 0
    errors = 0
    t0 = time.time()

    for sym_idx, sym in enumerate(symbols):
        # Fetch in batches to get enough bars
        all_bars = []
        while len(all_bars) < 1500:
            st = start_time if not all_bars else all_bars[-1]["timestamp"] + MS_5M
            need = min(1000, 1500 - len(all_bars))
            bars = fetch_5m_klines(sym, st, need)
            if not bars:
                break
            all_bars.extend(bars)
            if len(bars) < need:
                break  # no more data
            time.sleep(FETCH_DELAY)

        if all_bars:
            # Clip to end at the latest 15m bar's close
            # (use klines-mtf.json's 15m last timestamp if available)
            m15_last = None
            for p in pairs:
                if p["symbol"] == sym:
                    k15 = p.get("klines", {}).get("15m", [])
                    if k15:
                        m15_last = k15[-1]["timestamp"]
                    break
            if m15_last:
                while all_bars and all_bars[-1]["timestamp"] > m15_last:
                    all_bars.pop()

            result[sym] = all_bars
            total_bars += len(all_bars)

        if (sym_idx + 1) % 10 == 0 or sym_idx == len(symbols) - 1:
            elapsed = time.time() - t0
            print(f"    [{sym_idx + 1}/{len(symbols)}] {len(all_bars)} bars for {sym} ({elapsed:.0f}s)")

        time.sleep(FETCH_DELAY)

    elapsed = time.time() - t0
    print(f"  Fetched {total_bars} total 5m bars in {elapsed:.0f}s ({errors} errors)")

    # Cache
    with open(CACHE_5M_PATH, "w") as f:
        json.dump(result, f)
    print(f"  Saved 5m cache to {CACHE_5M_PATH}")

    return result, total_bars


# ─── Bar Alignment ─────────────────────────────────────────────────────────

def find_containing_bar_idx(bars: List, ts: int, window_ms: int) -> int:
    """Binary search for bar that contains timestamp ts.

    Bar at index i spans [bars[i].timestamp, bars[i].timestamp + window_ms).
    Returns -1 if not found.
    """
    if not bars:
        return -1
    lo, hi = 0, len(bars)
    while lo < hi:
        mid = (lo + hi) // 2
        bts = bars[mid].timestamp if hasattr(bars[mid], 'timestamp') else bars[mid]['timestamp']
        if bts <= ts:
            lo = mid + 1
        else:
            hi = mid
    idx = lo - 1
    if idx < 0:
        return -1
    bts = bars[idx].timestamp if hasattr(bars[idx], 'timestamp') else bars[idx]['timestamp']
    if bts <= ts < bts + window_ms:
        return idx
    return -1


def find_nearest_bar_idx(bars: List, ts: int) -> int:
    """Binary search for bar with timestamp closest to ts."""
    if not bars:
        return -1
    lo, hi = 0, len(bars)
    while lo < hi:
        mid = (lo + hi) // 2
        bts = bars[mid].timestamp if hasattr(bars[mid], 'timestamp') else bars[mid]['timestamp']
        if bts < ts:
            lo = mid + 1
        else:
            hi = mid
    if lo == 0:
        return 0
    if lo >= len(bars):
        return len(bars) - 1
    bts_lo = bars[lo].timestamp if hasattr(bars[lo], 'timestamp') else bars[lo]['timestamp']
    bts_lo_1 = bars[lo - 1].timestamp if hasattr(bars[lo - 1], 'timestamp') else bars[lo - 1]['timestamp']
    return lo if abs(bts_lo - ts) < abs(bts_lo_1 - ts) else lo - 1


# ─── Macro Context ─────────────────────────────────────────────────────────

def load_macro_context(path: Path = MACRO_PATH) -> Dict:
    """Load macro-context.json and pre-compute feature lookups by timestamp."""
    if not path.exists():
        print(f"  WARNING: macro-context.json not found at {path}")
        return {}

    with open(path) as f:
        data = json.load(f)

    context = {}

    # Raw market data
    macro_data = data.get("macro_data", {})
    for name in ["BTC", "ETH", "DXY", "SPX", "VIX"]:
        bars = macro_data.get(name, [])
        if bars:
            context[name] = bars

    # Pre-computed features
    features = data.get("features", {})
    for feat_name, feat_data in features.items():
        if feat_data and isinstance(feat_data, list):
            context[feat_name] = feat_data

    # Pre-compute BTC dominance proxy and ETH/BTC ratio lookup from raw data
    btc_bars = macro_data.get("BTC", [])
    eth_bars = macro_data.get("ETH", [])
    if btc_bars and eth_bars:
        # ETH/BTC ratio as a sorted lookup table
        eth_btc = []
        min_len = min(len(btc_bars), len(eth_bars))
        for i in range(min_len):
            btc_c = btc_bars[i]["close"]
            if btc_c > 0:
                ratio = eth_bars[i]["close"] / btc_c
                eth_btc.append({
                    "timestamp": btc_bars[i]["timestamp"],
                    "ratio": ratio,
                })
        context["eth_btc_ratio_computed"] = eth_btc

        # BTC dominance proxy
        dom = []
        for i in range(min_len):
            eth_c = eth_bars[i]["close"]
            btc_c = btc_bars[i]["close"]
            total = btc_c + eth_c
            dom.append({
                "timestamp": btc_bars[i]["timestamp"],
                "dominance": btc_c / total if total > 0 else 0.5,
            })
        context["btc_dominance_computed"] = dom

        # BTC-SPX rolling correlation (30-bar)
        spx_bars = macro_data.get("SPX", [])
        if spx_bars:
            btc_ret = []
            spx_ret = []
            common_ts = []
            min_l = min(len(btc_bars), len(spx_bars))
            for i in range(1, min_l):
                btc_r = (btc_bars[i]["close"] - btc_bars[i - 1]["close"]) / btc_bars[i - 1]["close"]
                spx_r = (spx_bars[i]["close"] - spx_bars[i - 1]["close"]) / spx_bars[i - 1]["close"]
                btc_ret.append(btc_r)
                spx_ret.append(spx_r)
                common_ts.append(max(btc_bars[i]["timestamp"], spx_bars[i]["timestamp"]))
            corr = []
            for i in range(29, len(btc_ret)):
                c = np.corrcoef(btc_ret[i - 29:i + 1], spx_ret[i - 29:i + 1])[0, 1]
                corr.append({
                    "timestamp": common_ts[i],
                    "correlation": float(c) if not np.isnan(c) else 0.0,
                })
            context["btc_spx_corr_computed"] = corr

    return context


def get_macro_features(macro_ctx: Dict, ts: int) -> Dict:
    """Get macro features at a given 5m bar timestamp."""
    features = {
        "macro_eth_btc_ratio": 0.0,
        "macro_btc_dom": 0.5,
        "macro_dxy_signal": 0.0,
        "macro_regime": 1.0,  # 1=neutral
        "macro_corr_btc_spx": 0.0,
    }
    if not macro_ctx:
        return features

    # ETH/BTC ratio z-score
    ebr = macro_ctx.get("eth_btc_ratio_computed", [])
    if ebr:
        idx = find_nearest_bar_idx(ebr, ts)
        if idx >= 0:
            ratio = ebr[idx]["ratio"]
            # Compute z-score over 30 nearest bars
            start = max(0, idx - 29)
            window = [ebr[k]["ratio"] for k in range(start, idx + 1)]
            if len(window) > 5:
                mean = np.mean(window)
                std = np.std(window)
                features["macro_eth_btc_ratio"] = float((ratio - mean) / std) if std > 0 else 0.0

    # BTC dominance
    dom = macro_ctx.get("btc_dominance_computed", [])
    if dom:
        idx = find_nearest_bar_idx(dom, ts)
        if idx >= 0:
            features["macro_btc_dom"] = dom[idx]["dominance"]

    # DXY trend signal
    dxy_trend = macro_ctx.get("dxy_trend", [])
    if dxy_trend:
        idx = find_nearest_bar_idx(dxy_trend, ts)
        if idx >= 0:
            dxy_val = dxy_trend[idx].get("dxy", dxy_trend[idx].get("dxy_value", 50))
            # Compare to 20-bar MA to get signal
            above_ma = dxy_trend[idx].get("above_ma20", None)
            if above_ma is True:
                features["macro_dxy_signal"] = -1.0  # risk-off
            elif above_ma is False:
                features["macro_dxy_signal"] = 1.0   # risk-on

    # Macro regime: 0=risk_on, 1=neutral, 2=risk_off
    is_risk_off = features["macro_dxy_signal"] < 0  # DXY up = risk-off
    # Check SPX
    spx_mom = macro_ctx.get("spx_momentum", [])
    spx_bull = None
    if spx_mom:
        idx = find_nearest_bar_idx(spx_mom, ts)
        if idx >= 0:
            spx_bull = spx_mom[idx].get("above_ma20", None)

    vix_data = macro_ctx.get("VIX", [])
    vix_val = None
    if vix_data:
        idx = find_nearest_bar_idx(vix_data, ts)
        if idx >= 0:
            vix_val = vix_data[idx]["close"]

    if not is_risk_off and spx_bull is True:
        features["macro_regime"] = 0.0  # risk_on
    elif is_risk_off and (spx_bull is False or vix_val is not None and vix_val > 25):
        features["macro_regime"] = 2.0  # risk_off
    else:
        features["macro_regime"] = 1.0  # neutral

    # BTC-SPX correlation
    corr_data = macro_ctx.get("btc_spx_corr_computed", [])
    if corr_data:
        idx = find_nearest_bar_idx(corr_data, ts)
        if idx >= 0:
            features["macro_corr_btc_spx"] = corr_data[idx]["correlation"]

    return features


# ─── Timeframe Feature Computation ─────────────────────────────────────────

class TFFeatures:
    """Container for pre-computed features per timeframe."""
    def __init__(self):
        self.rsi: np.ndarray = np.array([])
        self.macd: np.ndarray = np.array([])
        self.bb_pos: np.ndarray = np.array([])
        self.bb_width: np.ndarray = np.array([])
        self.ao: np.ndarray = np.array([])
        self.adx: np.ndarray = np.array([])
        self.mfi: np.ndarray = np.array([])       # only for 15m/5m
        self.williams_r: np.ndarray = np.array([])  # only for 15m/5m
        self.vol_z: np.ndarray = np.array([])
        self.trend: np.ndarray = np.array([])      # 1=bull, -1=bear, 0=neutral


def compute_tf_features(klines: List[Dict], bars: List[EnrichedBar],
                        include_extra: bool = False) -> TFFeatures:
    """Compute feature arrays for one timeframe.

    Args:
        klines: Raw kline dicts.
        bars: EnrichedBar list from enrich().
        include_extra: Whether to compute MFI and Williams %R (for 5m/15m).

    Returns:
        TFFeatures with arrays of length len(klines).
    """
    n = len(klines)
    tf = TFFeatures()

    if n == 0 or len(bars) == 0:
        return tf

    o = np.array([k["open"] for k in klines], dtype=np.float64)
    h = np.array([k["high"] for k in klines], dtype=np.float64)
    l = np.array([k["low"] for k in klines], dtype=np.float64)
    c = np.array([k["close"] for k in klines], dtype=np.float64)
    v = np.array([k["volume"] for k in klines], dtype=np.float64)

    # RSI (from bars or recompute)
    tf.rsi = np.array([b.rsi14 for b in bars], dtype=np.float64)

    # MACD
    tf.macd = _macd_hist(c)

    # BB position and width
    bb_mid = np.array([b.bb_mid for b in bars], dtype=np.float64)
    bb_upper = np.array([b.bb_upper for b in bars], dtype=np.float64)
    bb_lower = np.array([b.bb_lower for b in bars], dtype=np.float64)
    tf.bb_pos = _bb_pos(c, bb_upper, bb_lower)
    tf.bb_width = _bb_width(bb_mid, bb_upper, bb_lower)

    # AO
    tf.ao = np.array([b.ao for b in bars], dtype=np.float64)

    # ADX
    tf.adx = _adx(h, l, c)

    # Extra indicators (for 5m and 15m)
    if include_extra:
        tf.mfi = _mfi(h, l, c, v)
        tf.williams_r = _williams_r(h, l, c)

    # Volume z-score
    tf.vol_z = np.array([b.vol_zscore for b in bars], dtype=np.float64)

    # Trend: 1=bull, -1=bear, 0=neutral
    tf.trend = np.array([
        1.0 if b.trend_bull else (-1.0 if b.trend_bear else 0.0)
        for b in bars
    ], dtype=np.float64)

    return tf


# ─── Feature Row Builder ───────────────────────────────────────────────────

def build_row(
    # 5m data
    m5_bars: List[EnrichedBar], m5_tf: TFFeatures, m5_klines: List[Dict], m5_idx: int,
    # 15m context
    m15_bars: List[EnrichedBar], m15_tf: TFFeatures, m15_klines: List[Dict], m15_idx: int,
    # 1h context
    h1_bars: List[EnrichedBar], h1_tf: TFFeatures, h1_klines: List[Dict], h1_idx: int,
    # 4h context
    h4_bars: List[EnrichedBar], h4_tf: TFFeatures, h4_klines: List[Dict], h4_idx: int,
    # Macro
    macro_ctx: Dict,
    # Metadata
    symbol: str, direction: str,
) -> Dict:
    """Build a single feature row for one 5m bar in given direction.

    Args:
        All *bars arrays + *tf feature containers + indexes for each TF.
        macro_ctx: Loaded macro context dict.

    Returns:
        Feature dict (with labels to be filled later).
    """
    is_long = direction == "long"

    # 5m features (micro — the index timeframe)
    m5_rsi_val = float(m5_tf.rsi[m5_idx]) if m5_idx < len(m5_tf.rsi) else 50.0
    m5_macd_val = float(m5_tf.macd[m5_idx]) if m5_idx < len(m5_tf.macd) else 0.0
    m5_bb_pos_val = float(m5_tf.bb_pos[m5_idx]) if m5_idx < len(m5_tf.bb_pos) else 0.5
    m5_bb_width_val = float(m5_tf.bb_width[m5_idx]) if m5_idx < len(m5_tf.bb_width) else 0.0
    m5_ao_val = float(m5_tf.ao[m5_idx]) if m5_idx < len(m5_tf.ao) else 0.0
    m5_vol_z_val = float(m5_tf.vol_z[m5_idx]) if m5_idx < len(m5_tf.vol_z) else 0.0
    m5_trend_val = float(m5_tf.trend[m5_idx]) if m5_idx < len(m5_tf.trend) else 0.0
    m5_adx_val = float(m5_tf.adx[m5_idx]) if m5_idx < len(m5_tf.adx) else 0.0
    m5_mfi_val = float(m5_tf.mfi[m5_idx]) if m5_idx < len(m5_tf.mfi) else 50.0
    m5_wr_val = float(m5_tf.williams_r[m5_idx]) if m5_idx < len(m5_tf.williams_r) else -50.0

    # 5m MA7 slope
    ma7_vals = np.array([b.ma7 for b in m5_bars], dtype=np.float64)
    m5_ma7_slope_val = _slope(ma7_vals, 5, m5_idx)

    # 5m volume / SMA ratio
    vol_sma = _sma(np.array([k["volume"] for k in m5_klines], dtype=np.float64), 20)
    m5_vol_ratio_val = float(vol_sma[m5_idx] / m5_klines[m5_idx]["volume"]
                              if m5_klines[m5_idx]["volume"] > 0 else 1.0)

    # 5m BB bandwidth
    bb_u = np.array([b.bb_upper for b in m5_bars], dtype=np.float64)
    bb_l = np.array([b.bb_lower for b in m5_bars], dtype=np.float64)
    bb_m = np.array([b.bb_mid for b in m5_bars], dtype=np.float64)
    m5_bb_bw_val = float((bb_u[m5_idx] - bb_l[m5_idx]) / bb_m[m5_idx]) if bb_m[m5_idx] > 0 else 0.0

    # 5m zigzag swing %
    m5_h = np.array([k["high"] for k in m5_klines], dtype=np.float64)
    m5_l = np.array([k["low"] for k in m5_klines], dtype=np.float64)
    m5_c = np.array([k["close"] for k in m5_klines], dtype=np.float64)
    m5_zz_pct = _nearest_swing_pct(m5_h, m5_l, m5_c, m5_idx)

    # ── 15m features ──
    m15_rsi_val = float(m15_tf.rsi[m15_idx]) if m15_idx >= 0 and m15_idx < len(m15_tf.rsi) else 50.0
    m15_macd_val = float(m15_tf.macd[m15_idx]) if m15_idx >= 0 and m15_idx < len(m15_tf.macd) else 0.0
    m15_bb_pos_val = float(m15_tf.bb_pos[m15_idx]) if m15_idx >= 0 and m15_idx < len(m15_tf.bb_pos) else 0.5
    m15_bb_width_val = float(m15_tf.bb_width[m15_idx]) if m15_idx >= 0 and m15_idx < len(m15_tf.bb_width) else 0.0
    m15_ao_val = float(m15_tf.ao[m15_idx]) if m15_idx >= 0 and m15_idx < len(m15_tf.ao) else 0.0
    m15_atr_pct = float(m15_bars[m15_idx].atr_percentile) if m15_idx >= 0 and m15_idx < len(m15_bars) else 0.5
    m15_vol_z_val = float(m15_tf.vol_z[m15_idx]) if m15_idx >= 0 and m15_idx < len(m15_tf.vol_z) else 0.0
    m15_trend_val = float(m15_tf.trend[m15_idx]) if m15_idx >= 0 and m15_idx < len(m15_tf.trend) else 0.0
    m15_adx_val = float(m15_tf.adx[m15_idx]) if m15_idx >= 0 and m15_idx < len(m15_tf.adx) else 0.0
    m15_mfi_val = float(m15_tf.mfi[m15_idx]) if m15_idx >= 0 and m15_idx < len(m15_tf.mfi) else 50.0
    m15_wr_val = float(m15_tf.williams_r[m15_idx]) if m15_idx >= 0 and m15_idx < len(m15_tf.williams_r) else -50.0

    # 15m MA7 slope
    m15_ma7 = np.array([b.ma7 for b in m15_bars], dtype=np.float64)
    m15_ma7_slope_val = _slope(m15_ma7, 5, m15_idx) if m15_idx >= 0 else 0.0

    # 15m swing dist
    m15_swing_dist_val = _swing_dist_atr(m15_bars, m15_idx) if m15_idx >= 0 else 5.0

    # 15m kline arrays (reused)
    m15_c_arr = np.array([k["close"] for k in m15_klines], dtype=np.float64)

    # 15m EMA9 slope
    m15_ema9 = _ema(m15_c_arr, 9)
    m15_ema9_slope_val = _slope(m15_ema9, 5, m15_idx) if m15_idx >= 0 else 0.0

    # 15m volume ratio
    m15_v = np.array([k["volume"] for k in m15_klines], dtype=np.float64)
    m15_vol_sma = _sma(m15_v, 20)
    m15_vol_ratio_val = float(m15_vol_sma[m15_idx] / m15_klines[m15_idx]["volume"]
                               if m15_klines[m15_idx]["volume"] > 0 else 1.0) if m15_idx >= 0 else 1.0

    # 15m BB bandwidth
    m15_bb_bw_val = 0.0
    if m15_idx >= 0:
        u15 = np.array([b.bb_upper for b in m15_bars], dtype=np.float64)
        l15 = np.array([b.bb_lower for b in m15_bars], dtype=np.float64)
        m15_ = np.array([b.bb_mid for b in m15_bars], dtype=np.float64)
        m15_bb_bw_val = float((u15[m15_idx] - l15[m15_idx]) / m15_[m15_idx]) if m15_[m15_idx] > 0 else 0.0

    # 15m zigzag swing pct
    m15_h_arr = np.array([k["high"] for k in m15_klines], dtype=np.float64)
    m15_l_arr = np.array([k["low"] for k in m15_klines], dtype=np.float64)
    m15_zz_pct = _nearest_swing_pct(m15_h_arr, m15_l_arr, m15_c_arr, m15_idx) if m15_idx >= 0 else 5.0

    # ── 1h features ──
    h1_rsi_val = float(h1_tf.rsi[h1_idx]) if h1_idx >= 0 and h1_idx < len(h1_tf.rsi) else 50.0
    h1_macd_val = float(h1_tf.macd[h1_idx]) if h1_idx >= 0 and h1_idx < len(h1_tf.macd) else 0.0
    h1_bb_pos_val = float(h1_tf.bb_pos[h1_idx]) if h1_idx >= 0 and h1_idx < len(h1_tf.bb_pos) else 0.5
    h1_bb_width_val = float(h1_tf.bb_width[h1_idx]) if h1_idx >= 0 and h1_idx < len(h1_tf.bb_width) else 0.0
    h1_ao_val = float(h1_tf.ao[h1_idx]) if h1_idx >= 0 and h1_idx < len(h1_tf.ao) else 0.0
    h1_vol_z_val = float(h1_tf.vol_z[h1_idx]) if h1_idx >= 0 and h1_idx < len(h1_tf.vol_z) else 0.0
    h1_trend_val = float(h1_tf.trend[h1_idx]) if h1_idx >= 0 and h1_idx < len(h1_tf.trend) else 0.0
    h1_adx_val = float(h1_tf.adx[h1_idx]) if h1_idx >= 0 and h1_idx < len(h1_tf.adx) else 0.0

    # 1h MA7 slope, EMA20 slope
    h1_ma7_slope_val = 0.0
    h1_ema20_slope_val = 0.0
    if h1_idx >= 0:
        h1_ma7 = np.array([b.ma7 for b in h1_bars], dtype=np.float64)
        h1_ma7_slope_val = _slope(h1_ma7, 5, h1_idx)
        h1_c_vals = np.array([k["close"] for k in h1_klines], dtype=np.float64)
        h1_ema20 = _ema(h1_c_vals, 20)
        h1_ema20_slope_val = _slope(h1_ema20, 5, h1_idx)

    # 1h zigzag swing pct
    h1_zz_pct = 5.0
    if h1_idx >= 0:
        h1_h = np.array([k["high"] for k in h1_klines], dtype=np.float64)
        h1_l = np.array([k["low"] for k in h1_klines], dtype=np.float64)
        h1_c = np.array([k["close"] for k in h1_klines], dtype=np.float64)
        h1_zz_pct = _nearest_swing_pct(h1_h, h1_l, h1_c, h1_idx)

    # ── 4h features ──
    h4_rsi_val = float(h4_tf.rsi[h4_idx]) if h4_idx >= 0 and h4_idx < len(h4_tf.rsi) else 50.0
    h4_macd_val = float(h4_tf.macd[h4_idx]) if h4_idx >= 0 and h4_idx < len(h4_tf.macd) else 0.0
    h4_bb_pos_val = float(h4_tf.bb_pos[h4_idx]) if h4_idx >= 0 and h4_idx < len(h4_tf.bb_pos) else 0.5
    h4_bb_width_val = float(h4_tf.bb_width[h4_idx]) if h4_idx >= 0 and h4_idx < len(h4_tf.bb_width) else 0.0
    h4_ao_val = float(h4_tf.ao[h4_idx]) if h4_idx >= 0 and h4_idx < len(h4_tf.ao) else 0.0
    h4_trend_val = float(h4_tf.trend[h4_idx]) if h4_idx >= 0 and h4_idx < len(h4_tf.trend) else 0.0
    h4_adx_val = float(h4_tf.adx[h4_idx]) if h4_idx >= 0 and h4_idx < len(h4_tf.adx) else 0.0

    h4_ema20_slope_val = 0.0
    if h4_idx >= 0:
        h4_c_vals = np.array([k["close"] for k in h4_klines], dtype=np.float64)
        h4_ema20 = _ema(h4_c_vals, 20)
        h4_ema20_slope_val = _slope(h4_ema20, 5, h4_idx)

    # ── Cross-TF features ──

    # AO gradient: change from low to high TF (5m → 4h momentum divergence)
    ao_gradient = 0.0
    if abs(m5_ao_val) > 1e-10 or abs(h4_ao_val) > 1e-10:
        ao_gradient = h4_ao_val - m5_ao_val if abs(h4_ao_val - m5_ao_val) < 1000 else 0.0

    # RSI gradient: difference between short and long TF
    rsi_gradient = m15_rsi_val - h4_rsi_val if abs(m15_rsi_val - h4_rsi_val) < 100 else 0.0

    # BB squeeze product: tighten across TFs = volatility compression
    # Use inverse of BB width (higher = more squeezed)
    # Actually, use BB bandwidth as-is, multiply across TFs
    bb_sqz_product = m5_bb_width_val * m15_bb_width_val * h1_bb_width_val * h4_bb_width_val
    bb_sqz_product = min(bb_sqz_product, 100.0)

    # Volume sum: aggregate z-score
    tf_vol_sum = m5_vol_z_val + m15_vol_z_val + h1_vol_z_val

    # 15m-1h trend agreement
    mtf_15_1h_agree = 1.0 if m15_trend_val * h1_trend_val > 0 else 0.0

    # Triple agreement
    mtf_triple_agree = 1.0 if (m15_trend_val * h1_trend_val * h4_trend_val) > 0 else 0.0

    # 5m-15m agreement (catches fast momentum)
    mtf_5m_15m_agree = 1.0 if m5_trend_val * m15_trend_val > 0 else 0.0

    # ADX agreement: both 15m and 4h ADX > 20 = trend regime
    mtf_adx_agree = 1.0 if m15_adx_val > 20.0 and h4_adx_val > 20.0 else 0.0

    # RSI divergence: 15m RSI vs 4h RSI diverging
    mtf_rsi_divergence = rsi_gradient  # positive = 15m more bullish than 4h

    # BB width ratio: 5m vs 15m compression
    mtf_bb_width_ratio = m5_bb_width_val / m15_bb_width_val if m15_bb_width_val > 0 else 1.0

    # ── Macro features ──
    macro_features = get_macro_features(macro_ctx, m5_bars[m5_idx].timestamp)

    bar = m5_bars[m5_idx]
    row = {
        # Metadata
        "symbol": symbol,
        "timestamp": bar.timestamp,
        "direction": direction,

        # 5m micro features (16)
        "m5_rsi": m5_rsi_val,
        "m5_bb_pos": m5_bb_pos_val,
        "m5_bb_width": m5_bb_width_val,
        "m5_ao": m5_ao_val,
        "m5_macd": m5_macd_val,
        "m5_vol_z": m5_vol_z_val,
        "m5_trend": m5_trend_val,
        "m5_ma7_slope": m5_ma7_slope_val,
        "m5_adx": m5_adx_val,
        "m5_mfi": m5_mfi_val,
        "m5_williams_r": m5_wr_val,
        "m5_vol_ratio": m5_vol_ratio_val,
        "m5_bb_bandwidth": m5_bb_bw_val,
        "m5_zigzag_swing_pct": m5_zz_pct,

        # 15m context features (17)
        "m15_rsi": m15_rsi_val,
        "m15_bb_pos": m15_bb_pos_val,
        "m15_bb_width": m15_bb_width_val,
        "m15_ao": m15_ao_val,
        "m15_macd": m15_macd_val,
        "m15_atr_pct": m15_atr_pct,
        "m15_vol_z": m15_vol_z_val,
        "m15_ma7_slope": m15_ma7_slope_val,
        "m15_swing_dist": m15_swing_dist_val,
        "m15_trend": m15_trend_val,
        "m15_adx": m15_adx_val,
        "m15_mfi": m15_mfi_val,
        "m15_williams_r": m15_wr_val,
        "m15_ema9_slope": m15_ema9_slope_val,
        "m15_vol_ratio": m15_vol_ratio_val,
        "m15_bb_bandwidth": m15_bb_bw_val,
        "m15_zigzag_swing_pct": m15_zz_pct,

        # 1h context features (11)
        "h1_rsi": h1_rsi_val,
        "h1_bb_pos": h1_bb_pos_val,
        "h1_bb_width": h1_bb_width_val,
        "h1_ao": h1_ao_val,
        "h1_macd": h1_macd_val,
        "h1_vol_z": h1_vol_z_val,
        "h1_ma7_slope": h1_ma7_slope_val,
        "h1_trend": h1_trend_val,
        "h1_adx": h1_adx_val,
        "h1_ema20_slope": h1_ema20_slope_val,
        "h1_zigzag_swing_pct": h1_zz_pct,

        # 4h context features (9)
        "h4_rsi": h4_rsi_val,
        "h4_bb_pos": h4_bb_pos_val,
        "h4_bb_width": h4_bb_width_val,
        "h4_ao": h4_ao_val,
        "h4_macd": h4_macd_val,
        "h4_trend": h4_trend_val,
        "h4_adx": h4_adx_val,
        "h4_ema20_slope": h4_ema20_slope_val,

        # Cross-TF features (9)
        "ao_gradient": ao_gradient,
        "rsi_gradient": rsi_gradient,
        "bb_sqz_product": bb_sqz_product,
        "tf_vol_sum": tf_vol_sum,
        "mtf_15_1h_agree": mtf_15_1h_agree,
        "mtf_triple_agree": mtf_triple_agree,
        "mtf_adx_agree": mtf_adx_agree,
        "mtf_rsi_divergence": mtf_rsi_divergence,
        "mtf_bb_width_ratio": mtf_bb_width_ratio,
        "mtf_5m_15m_agree": mtf_5m_15m_agree,

        # Macro features (5)
        "macro_eth_btc_ratio": macro_features["macro_eth_btc_ratio"],
        "macro_btc_dom": macro_features["macro_btc_dom"],
        "macro_dxy_signal": macro_features["macro_dxy_signal"],
        "macro_regime": macro_features["macro_regime"],
        "macro_corr_btc_spx": macro_features["macro_corr_btc_spx"],

        # Labels — filled later
        "hitTP": False,
        "hitStop": False,
        "maxFavorableR": 0.0,
        "maxAdverseR": 0.0,
        "pnlR": 0.0,
        "barsToOutcome": 0,
        "_bar_index": m5_idx,
    }
    return row


# ─── Main Pipeline ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Build expanded training dataset with 5m/macro/40+ features")
    parser.add_argument("--quick", type=int, default=0,
                        help="Quick test on N pairs (default: full run)")
    parser.add_argument("--pairs", type=int, default=50,
                        help="Max pairs to process (default: 50)")
    parser.add_argument("--skip-fetch", action="store_true",
                        help="Skip 5m fetch, use cached data")
    parser.add_argument("--output", type=str, default=None,
                        help="Override output path")
    args = parser.parse_args()

    cfg = CONFIG_EXPANDED
    t0 = time.time()

    # ─── 1. Load klines-mtf.json ───────────────────────────────────────────
    mtf_path = KLINES_MTF_PATH
    print(f"Loading klines from {mtf_path}...")
    with open(mtf_path) as f:
        pairs = json.load(f)
    n_pairs = min(len(pairs), args.pairs)
    if args.quick > 0:
        n_pairs = min(args.quick, n_pairs)
    pairs = pairs[:n_pairs]
    print(f"  {n_pairs} pairs")

    # ─── 2. Load macro context ─────────────────────────────────────────────
    print("Loading macro context...")
    macro_ctx = load_macro_context()
    if macro_ctx:
        print(f"  Loaded {len(macro_ctx)} macro data sources")
    else:
        print("  WARNING: No macro context loaded")

    # ─── 3. Fetch 5m klines ────────────────────────────────────────────────
    quick_count = args.quick if args.quick > 0 else 0
    m5_by_symbol, m5_total = fetch_5m_all(
        pairs, quick=quick_count, skip=args.skip_fetch
    )

    # ─── 4. Build features + SMC + enrichment + labels ──────────────────────
    all_rows = []
    total_pairs_processed = 0
    warmup_bars = cfg.ma_slow  # 99 bars warmup for MA99

    for pair_idx, pair in enumerate(pairs):
        symbol = pair["symbol"]
        klines_data = pair.get("klines", {})

        # Get 5m data for this pair
        m5_klines_raw = m5_by_symbol.get(symbol, [])
        if len(m5_klines_raw) < warmup_bars + 50:
            continue

        # Get higher-TF klines
        m15_klines_raw = klines_data.get("15m", [])
        h1_klines_raw = klines_data.get("1h", [])
        h4_klines_raw = klines_data.get("4h", [])

        if len(m15_klines_raw) < warmup_bars + 10:
            continue
        if len(h1_klines_raw) < warmup_bars + 10:
            continue
        if len(h4_klines_raw) < warmup_bars:
            continue

        total_pairs_processed += 1

        # Enrich all timeframes
        m5_bars = enrich(m5_klines_raw, cfg)
        m15_bars = enrich(m15_klines_raw, cfg)
        h1_bars = enrich(h1_klines_raw, cfg)
        h4_bars = enrich(h4_klines_raw, cfg)

        if len(m5_bars) < warmup_bars + 50:
            continue
        if len(m15_bars) < warmup_bars + 10:
            continue
        if len(h1_bars) < warmup_bars + 10:
            continue
        if len(h4_bars) < warmup_bars:
            continue

        # Compute TF-specific features
        m5_tf = compute_tf_features(m5_klines_raw, m5_bars, include_extra=True)
        m15_tf = compute_tf_features(m15_klines_raw, m15_bars, include_extra=True)
        h1_tf = compute_tf_features(h1_klines_raw, h1_bars, include_extra=False)
        h4_tf = compute_tf_features(h4_klines_raw, h4_bars, include_extra=False)

        # Build rows for each valid 5m bar
        max_look = cfg.max_lookforward_bars
        for m5_idx in range(warmup_bars, min(len(m5_bars), len(m5_bars) - max_look)):
            m5_bar = m5_bars[m5_idx]
            if m5_bar.atr14 <= 0 or m5_bar.close <= 0:
                continue

            ts = m5_bar.timestamp

            # Find containing higher-TF bars
            m15_idx = find_containing_bar_idx(m15_bars, ts, MS_15M)
            if m15_idx < 0 or m15_idx >= len(m15_bars):
                continue
            if m15_bars[m15_idx].atr14 <= 0:
                continue

            h1_idx = find_containing_bar_idx(h1_bars, ts, MS_1H)
            if h1_idx < 0 or h1_idx >= len(h1_bars):
                continue
            if h1_bars[h1_idx].atr14 <= 0:
                continue

            h4_idx = find_containing_bar_idx(h4_bars, ts, MS_4H)
            if h4_idx < 0 or h4_idx >= len(h4_bars):
                continue
            if h4_bars[h4_idx].atr14 <= 0:
                continue

            for direction in ("long", "short"):
                row = build_row(
                    m5_bars, m5_tf, m5_klines_raw, m5_idx,
                    m15_bars, m15_tf, m15_klines_raw, m15_idx,
                    h1_bars, h1_tf, h1_klines_raw, h1_idx,
                    h4_bars, h4_tf, h4_klines_raw, h4_idx,
                    macro_ctx, symbol, direction,
                )
                if not row:
                    continue

                # Compute forward labels on 5m bars
                outcome = compute_outcome(m5_bars, m5_idx, direction, cfg)
                row.update(outcome)
                row["_bar_index"] = m5_idx

                all_rows.append(row)

        if (pair_idx + 1) % 5 == 0 or pair_idx == len(pairs) - 1:
            elapsed = time.time() - t0
            print(f"  [{pair_idx + 1}/{len(pairs)}] {len(all_rows)} rows from "
                  f"{total_pairs_processed} pairs ({elapsed:.0f}s)...")

    elapsed = time.time() - t0
    wins = sum(1 for r in all_rows if r.get("hitTP"))
    losses = sum(1 for r in all_rows if r.get("hitStop"))
    baseline_wr = wins / (wins + losses) * 100 if (wins + losses) > 0 else 0
    n_features = len(set(all_rows[0].keys()) - {"symbol", "timestamp", "direction",
                                                "hitTP", "hitStop", "maxFavorableR",
                                                "maxAdverseR", "pnlR", "barsToOutcome",
                                                "_bar_index"}) if all_rows else 0

    print(f"\n{'=' * 60}")
    print(f"RESULTS")
    print(f"{'=' * 60}")
    print(f"  Total rows:     {len(all_rows)}")
    print(f"  Pairs:          {total_pairs_processed}")
    print(f"  Features:       {n_features}")
    print(f"  Wins:           {wins}")
    print(f"  Losses:         {losses}")
    print(f"  Baseline WR:    {baseline_wr:.1f}%")
    if all_rows:
        feature_names = sorted(set(all_rows[0].keys()) - {"symbol", "timestamp", "direction",
                                                           "hitTP", "hitStop", "maxFavorableR",
                                                           "maxAdverseR", "pnlR", "barsToOutcome",
                                                           "_bar_index"})
        print(f"\n  Feature names ({len(feature_names)}):")
        for fn in feature_names:
            print(f"    - {fn}")
    print(f"  Elapsed:        {elapsed:.0f}s")

    # ─── 5. Save ───────────────────────────────────────────────────────────
    output_path = args.output if args.output else str(OUTPUT_PATH)
    print(f"\nSaving to {output_path}...")
    with open(output_path, "w") as f:
        for row in all_rows:
            clean = {}
            for k, v in row.items():
                if hasattr(v, "item"):
                    clean[k] = v.item()
                elif isinstance(v, (np.integer, np.floating)):
                    clean[k] = v.item()
                elif isinstance(v, np.bool_):
                    clean[k] = bool(v)
                else:
                    clean[k] = v
            f.write(json.dumps(clean) + "\n")

    size_mb = Path(output_path).stat().st_size / 1024 / 1024
    print(f"  Saved {len(all_rows)} rows ({size_mb:.1f} MB)")
    print(f"\nDone in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
