"""Volume-at-price and order-flow-style features from OHLCV.

Since we don't have tick data or bid/ask, we reconstruct market
microstructure signals from bar-level patterns:

  - VWAP + 1σ/2σ bands (institutional reference)
  - Volume climax / absorption (high vol + small range = smart money)
  - Volume dryness (low vol + tight range = compression / spring)
  - Effort vs Result (large range = effort, small close move = no result → reversal)
  - Relative volume at swing levels (was the swing accompanied by volume?)
  - Cumulative volume delta proxy (buy vol vs sell vol from candle composition)
"""

import numpy as np
from typing import Tuple


def compute_vwap(high: np.ndarray, low: np.ndarray, close: np.ndarray,
                 volume: np.ndarray, lookback: int = None) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Anchored VWAP from the most recent swing point, plus cumulative VWAP.

    Returns: vwap, upper_1sd, lower_1sd, upper_2sd, lower_2sd
    Uses rolling window. VWAP = Σ(price × volume) / Σ(volume)
    """
    n = len(close)
    typical = (high + low + close) / 3.0
    pv = typical * volume  # price × volume

    if lookback is None:
        lookback = n

    vwap = np.zeros(n)
    upper_1s = np.zeros(n); lower_1s = np.zeros(n)
    upper_2s = np.zeros(n); lower_2s = np.zeros(n)

    for i in range(n):
        start = max(0, i - lookback + 1)
        window_pv = pv[start:i+1]
        window_vol = volume[start:i+1]
        total_vol = window_vol.sum()

        if total_vol > 0:
            v = window_pv.sum() / total_vol
            vwap[i] = v

            # Variance of price around VWAP
            variance = (window_vol * (typical[start:i+1] - v) ** 2).sum() / total_vol
            std = np.sqrt(variance) if variance > 0 else 0

            upper_1s[i] = v + std
            lower_1s[i] = v - std
            upper_2s[i] = v + 2 * std
            lower_2s[i] = v - 2 * std
        elif i > 0:
            vwap[i] = vwap[i-1]
            upper_1s[i] = upper_1s[i-1]
            lower_1s[i] = lower_1s[i-1]
            upper_2s[i] = upper_2s[i-1]
            lower_2s[i] = lower_2s[i-1]

    return vwap, upper_1s, lower_1s, upper_2s, lower_2s


def vwap_features(vwap_arr: np.ndarray, upper_1s: np.ndarray, lower_1s: np.ndarray,
                  upper_2s: np.ndarray, lower_2s: np.ndarray,
                  close: np.ndarray, idx: int) -> dict:
    """Compute VWAP-relative features for bar `idx`."""
    v = vwap_arr[idx]
    c = close[idx]
    if v <= 0:
        return {}

    price_to_vwap_pct = (c - v) / v * 100
    dist_1s = (upper_1s[idx] - lower_1s[idx])
    dist_2s = (upper_2s[idx] - lower_2s[idx])

    # Normalized position: 0 = at lower 2σ, 0.5 = at VWAP, 1.0 = at upper 2σ
    vwap_range = upper_2s[idx] - lower_2s[idx]
    vwap_position = (c - lower_2s[idx]) / vwap_range if vwap_range > 0 else 0.5

    return {
        'vwap_price_pct': float(price_to_vwap_pct),
        'vwap_position': float(vwap_position),
        'vwap_above': int(c > v),
        'vwap_above_1s': int(c > upper_1s[idx]),
        'vwap_below_1s': int(c < lower_1s[idx]),
        'vwap_above_2s': int(c > upper_2s[idx]),
        'vwap_below_2s': int(c < lower_2s[idx]),
        'vwap_bandwidth_pct': float(dist_1s / v * 100) if v > 0 else 0,
    }


def volume_climax_score(volume: np.ndarray, high: np.ndarray, low: np.ndarray,
                        close: np.ndarray, open_arr: np.ndarray,
                        idx: int, lookback: int = 20) -> dict:
    """
    Detect volume climax (absorption) and volume dryness (compression).

    Volume climax: volume spike (z > 2) + small range → smart money absorbing.
    Volume dryness: volume low (z < -1) + tight range → spring coiling.
    """
    if idx < lookback:
        return {}

    vol_win = volume[idx - lookback + 1:idx + 1]
    vol_mean = vol_win.mean()
    vol_std = vol_win.std()
    vol_z = (volume[idx] - vol_mean) / vol_std if vol_std > 0 else 0

    # Range relative to recent average
    ranges = high[idx-lookback+1:idx+1] - low[idx-lookback+1:idx+1]
    range_avg = ranges.mean()
    range_now = high[idx] - low[idx]
    range_ratio = range_now / range_avg if range_avg > 0 else 1.0

    # Body vs range (doji/indecision)
    body = abs(close[idx] - open_arr[idx])
    body_ratio = body / range_now if range_now > 0 else 0

    return {
        'vol_zscore': float(vol_z),
        'vol_climax': int(vol_z > 2.0 and range_ratio < 0.8),
        'vol_dryness': int(vol_z < -1.2 and range_ratio < 0.6),
        'vol_absorption': int(vol_z > 1.5 and range_ratio < 0.7 and body_ratio < 0.4),
        'vol_expansion': int(vol_z > 1.5 and range_ratio > 1.3),
        'vol_contraction': int(vol_z < -0.5 and range_ratio < 0.7),
        'range_ratio': float(range_ratio),
        'effort_vs_result': float(abs(close[idx] - open_arr[idx]) / range_now) if range_now > 0 else 0,
    }


def buy_sell_pressure(high: np.ndarray, low: np.ndarray, close: np.ndarray,
                      open_arr: np.ndarray, volume: np.ndarray,
                      idx: int, lookback: int = 10) -> dict:
    """
    Proxy cumulative delta from candle structure.
    Bull candle = closing > open → buying pressure
    Bear candle = closing < open → selling pressure
    Weight by volume and candle position (close near high = strong buy).
    """
    if idx < lookback:
        return {}

    buy_vol = 0.0; sell_vol = 0.0
    for k in range(max(0, idx - lookback + 1), idx + 1):
        c = close[k]; o = open_arr[k]; v = volume[k]
        rng = high[k] - low[k]
        if rng <= 0:
            continue

        # Close position: 1 = at high (strong buy), 0 = at low (strong sell)
        cp = (c - low[k]) / rng

        # Allocate volume proportionally
        buy_vol += v * cp
        sell_vol += v * (1 - cp)

    total = buy_vol + sell_vol
    if total > 0:
        delta = (buy_vol - sell_vol) / total  # -1 to +1
        pressure = buy_vol / total  # 0 to 1
    else:
        delta = 0; pressure = 0.5

    # Recent trend of delta
    recent_delta = 0
    if idx >= 3:
        delta_now = delta
        delta_prev = 0
        for k in range(max(0, idx - 3), idx):
            bv = sv = 0
            r = high[k] - low[k]
            if r > 0:
                cp = (close[k] - low[k]) / r
                bv = volume[k] * cp
                sv = volume[k] * (1 - cp)
            if bv + sv > 0:
                delta_prev = (bv - sv) / (bv + sv)
        recent_delta = delta_now - delta_prev

    return {
        'buy_pressure': float(pressure),
        'cum_delta_proxy': float(delta),
        'delta_momentum': float(recent_delta),
        'buy_vol_dominance': int(pressure > 0.6),
        'sell_vol_dominance': int(pressure < 0.4),
    }
