"""Pure indicator computation — takes raw klines, returns enriched bars with all indicators.
No SMC, no labels, no lookahead. Just math on OHLCV."""

import numpy as np
from typing import List, Dict, Tuple
from dataclasses import dataclass, field


@dataclass
class EnrichedBar:
    """One bar with ALL computed indicators."""
    timestamp: int
    open: float; high: float; low: float; close: float; volume: float
    # MAs
    ma7: float; ma25: float; ma99: float
    # ATR
    atr14: float; atr_percentile: float
    # RSI
    rsi14: float
    # Bollinger Bands
    bb_mid: float; bb_upper: float; bb_lower: float
    bb_width_pct: float; bb_squeeze_intensity: float; bb_expanding: int
    # Awesome Oscillator
    ao: float; ao_slope: float; ao_accel: float
    # Volume
    vol_ma20: float; vol_zscore: float; vol_ratio: float
    # Candle properties
    range_pct: float = 0; body_ratio: float = 0
    close_position: float = 0; wick_magnitude: float = 0
    # Derived
    ma25_slope: float = 0; displacement: float = 0
    ma_sep_atr: float = 0
    # Trend flags
    trend_bull: int = 0; trend_bear: int = 0
    # BB position
    price_in_bb: float = 0.5
    # RSI extremes
    rsi_extreme_bull: int = 0; rsi_extreme_bear: int = 0
    # AO crosses
    ao_cross_up: int = 0; ao_cross_down: int = 0
    ao_dist_zero_atr: float = 0


# ═══ Vectorized indicator functions ═══

def _sma(values: np.ndarray, period: int) -> np.ndarray:
    """Simple Moving Average. First (period-1) values are 0."""
    out = np.zeros_like(values)
    if len(values) < period:
        return out
    cumsum = np.cumsum(np.insert(values, 0, 0))
    out[period-1:] = (cumsum[period:] - cumsum[:-period]) / period
    return out


def _ema(values: np.ndarray, period: int) -> np.ndarray:
    """Exponential Moving Average."""
    out = np.zeros_like(values)
    if len(values) < 2:
        out[0] = values[0]
        return out
    k = 2 / (period + 1)
    out[0] = values[0]
    for i in range(1, len(values)):
        out[i] = values[i] * k + out[i-1] * (1 - k)
    return out


def _true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    tr = np.zeros_like(high)
    tr[0] = high[0] - low[0]
    for i in range(1, len(high)):
        tr[i] = max(high[i]-low[i], abs(high[i]-close[i-1]), abs(low[i]-close[i-1]))
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
        avg_gain = gains[i-period:i].mean()
        avg_loss = losses[i-period:i].mean()
        if avg_loss == 0: out[i] = 100
        else: out[i] = 100 - 100/(1 + avg_gain/avg_loss)
    return out


def _bb(close: np.ndarray, period: int, std_mult: float) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    mid = _sma(close, period)
    upper = np.zeros_like(close); lower = np.zeros_like(close)
    width = np.zeros_like(close)
    for i in range(period-1, len(close)):
        window = close[i-period+1:i+1]
        std = np.std(window)
        upper[i] = mid[i] + std_mult * std
        lower[i] = mid[i] - std_mult * std
        width[i] = (upper[i]-lower[i])/mid[i]*100 if mid[i] > 0 else 0
    return mid, upper, lower, width


def _ao(high: np.ndarray, low: np.ndarray, fast: int = 5, slow: int = 34) -> np.ndarray:
    hl2 = (high + low) / 2
    return _sma(hl2, fast) - _sma(hl2, slow)


def _zscore(values: np.ndarray, period: int) -> np.ndarray:
    out = np.zeros_like(values)
    for i in range(period-1, len(values)):
        w = values[i-period+1:i+1]
        s = np.std(w)
        out[i] = (values[i]-np.mean(w))/s if s > 0 else 0
    return out


def _percent_rank(values: np.ndarray, period: int) -> np.ndarray:
    out = np.full(len(values), 0.5)
    for i in range(period-1, len(values)):
        w = values[i-period+1:i+1]
        out[i] = np.sum(w <= values[i]) / period
    return out


def _slope(values: np.ndarray, lookback: int, idx: int) -> float:
    """Linear slope of `values` over `lookback` bars ending at `idx`."""
    if idx < lookback - 1: return 0.0
    ys = values[idx-lookback+1:idx+1]
    xs = np.arange(lookback, dtype=np.float64)
    if len(set(ys)) < 2: return 0.0
    return np.polyfit(xs, ys, 1)[0]


def _bb_squeeze(bars: List, idx: int, lookback: int = 20) -> float:
    if idx < lookback: return 0.5
    widths = [b.bb_width_pct for b in bars[idx-lookback+1:idx+1]]
    mn, mx = min(widths), max(widths)
    return (bars[idx].bb_width_pct - mn) / (mx - mn) if mx > mn else 0.5


# ═══ Main enrichment function ═══

def enrich(klines: List[Dict], config=None) -> List[EnrichedBar]:
    """
    Compute all indicators from raw kline dicts. Returns enriched bars.

    Args:
        klines: List of dicts with keys: timestamp, open, high, low, close, volume
        config: PipelineConfig (uses DEFAULT if None)

    Returns:
        List[EnrichedBar] — same length as input, first bars have partial data
    """
    from .config import DEFAULT as cfg
    if config: cfg = config

    n = len(klines)
    if n < cfg.ma_slow + 1:
        return []

    o = np.array([k['open'] for k in klines]); h = np.array([k['high'] for k in klines])
    l = np.array([k['low'] for k in klines]); c = np.array([k['close'] for k in klines])
    v = np.array([k['volume'] for k in klines]); ts = [k['timestamp'] for k in klines]

    # Compute all indicators vectorized
    ma7 = _sma(c, cfg.ma_fast); ma25 = _sma(c, cfg.ma_mid); ma99 = _sma(c, cfg.ma_slow)
    atr14 = _atr(h, l, c, cfg.atr_period)
    atr_pct = _percent_rank(atr14, cfg.atr_period * 2)
    rsi14 = _rsi(c, cfg.rsi_period)
    mid, upper, lower, width = _bb(c, cfg.bb_period, cfg.bb_std)
    ao_vals = _ao(h, l, cfg.ao_fast, cfg.ao_slow)
    vol_ma = _sma(v, cfg.vol_period); vol_z = _zscore(v, cfg.vol_period)

    bars = []
    for i in range(n):
        b = EnrichedBar(
            timestamp=ts[i], open=o[i], high=h[i], low=l[i], close=c[i], volume=v[i],
            ma7=ma7[i], ma25=ma25[i], ma99=ma99[i],
            atr14=atr14[i], atr_percentile=atr_pct[i],
            rsi14=rsi14[i],
            bb_mid=mid[i], bb_upper=upper[i], bb_lower=lower[i],
            bb_width_pct=width[i], bb_squeeze_intensity=0.5, bb_expanding=0,
            ao=ao_vals[i], ao_slope=0, ao_accel=0,
            vol_ma20=vol_ma[i], vol_zscore=vol_z[i],
            vol_ratio=v[i]/vol_ma[i] if vol_ma[i] > 0 else 1.0,
            range_pct=(h[i]-l[i])/c[i]*100 if c[i] > 0 else 0,
            body_ratio=abs(c[i]-o[i])/(h[i]-l[i]) if h[i] > l[i] else 0,
            close_position=(c[i]-l[i])/(h[i]-l[i]) if h[i] > l[i] else 0.5,
            wick_magnitude=max(h[i]-max(o[i],c[i]), min(o[i],c[i])-l[i]),
            displacement=(c[i]-ma7[i])/atr14[i] if atr14[i] > 0 else 0,
            ma_sep_atr=(ma7[i]-ma25[i])/atr14[i] if atr14[i] > 0 else 0,
            trend_bull=1 if (ma7[i] > ma25[i] > ma99[i]) else 0,
            trend_bear=1 if (ma7[i] < ma25[i] < ma99[i]) else 0,
            price_in_bb=((c[i]-lower[i])/(upper[i]-lower[i]) if upper[i] > lower[i] else 0.5),
            rsi_extreme_bull=1 if rsi14[i] > 70 else 0,
            rsi_extreme_bear=1 if rsi14[i] < 30 else 0,
        )
        bars.append(b)

    # Post-compute: AO slope, acceleration, crosses, BB squeeze
    for i in range(len(bars)):
        if i >= 3:
            bars[i].ao_slope = bars[i].ao - bars[i-3].ao
        if i >= 4:
            bars[i].ao_accel = bars[i].ao - 2*bars[i-2].ao + bars[i-4].ao
        if i >= 1:
            bars[i].bb_expanding = 1 if bars[i].bb_width_pct > bars[i-1].bb_width_pct else 0
            bars[i].ao_cross_up = 1 if (bars[i-1].ao < 0 and bars[i].ao > 0) else 0
            bars[i].ao_cross_down = 1 if (bars[i-1].ao > 0 and bars[i].ao < 0) else 0
        bars[i].ma25_slope = _slope(np.array([b.ma25 for b in bars]), 5, i)
        bars[i].ao_dist_zero_atr = abs(bars[i].ao)/bars[i].atr14 if bars[i].atr14 > 0 else 0

    # BB squeeze intensity (needs bars list built first)
    for i in range(len(bars)):
        bars[i].bb_squeeze_intensity = _bb_squeeze(bars, i)

    return bars
