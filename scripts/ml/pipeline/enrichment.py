"""Merge indicator bars + SMC signals into model-ready feature vectors.

Takes enriched bars + SMC detection results → returns dict rows (one per bar, per direction).
This is the final step before training/inference. Features are immutable dicts."""

from typing import List, Dict
import numpy as np
from .features import EnrichedBar
from .smc import SMCSignals
from .config import PipelineConfig, DEFAULT


def _swap_smc(smc: SMCSignals, is_long: bool):
    """Return direction-relevant SMC results."""
    if is_long:
        return smc.ob_bull, smc.fvg_bull, smc.sweep_bull, smc.choch_bull
    return smc.ob_bear, smc.fvg_bear, smc.sweep_bear, smc.choch_bear


def _cap(v: float, lo: float = -100, hi: float = 100) -> float:
    if not np.isfinite(v): return 0.0
    return float(max(lo, min(hi, v)))


def build_row(bars: List[EnrichedBar], smc_signals: List[SMCSignals],
              idx: int, direction: str, symbol: str, cfg: PipelineConfig = DEFAULT) -> Dict:
    """Build ONE feature row for bar `idx` in given direction.

    Args:
        bars: EnrichedBar list (all indicators pre-computed)
        smc_signals: SMCSignals list (all patterns pre-detected)
        idx: Bar index
        direction: 'long' or 'short'
        symbol: Pair symbol for metadata
        cfg: PipelineConfig

    Returns:
        Dict with all features ready for model training/inference
    """
    is_long = direction == 'long'
    b = bars[idx]
    atr = b.atr14
    if atr <= 0: return {}

    smc = smc_signals[idx]
    fib = smc.fib
    d_ob, d_fvg, d_swp, d_ch = _swap_smc(smc, is_long)

    # ── SMC distance metrics ──
    close = b.close
    ob_dist = min(20.0, abs(close - d_ob.top) / max(atr, 0.0001)) if d_ob.found else 0.0
    ob_size = min(3.0, abs(d_ob.top - d_ob.bottom) / max(atr, 0.0001)) if d_ob.found else 0.0
    fvg_dist = min(20.0, abs(close - d_fvg.top) / max(atr, 0.0001)) if d_fvg.found else 0.0
    fvg_size = min(3.0, abs(d_fvg.top - d_fvg.bottom) / max(atr, 0.0001)) if d_fvg.found else 0.0
    swp_depth = min(3.0, d_swp.depth_atr) if d_swp.found else 0.0

    conf = sum([d_ob.found, d_fvg.found, d_swp.found, d_ch.found])

    # ── Fib golden pocket distance ──
    fib_dist = 5.0
    if fib.found:
        p_top = max(fib.fib_618, fib.fib_786)
        p_bot = min(fib.fib_618, fib.fib_786)
        if p_bot <= close <= p_top:
            fib_dist = 0.0
        else:
            fib_dist = min(abs(close - p_top), abs(close - p_bot)) / atr if atr > 0 else 5.0
        fib_dist = min(5.0, fib_dist)

    # ── Swing distance ──
    sw_dist = 5.0
    h_vals = [bars[k].high for k in range(max(3, idx-30), idx-3)
              if smc_signals[k].fib.found or True]  # approximate
    l_vals = [bars[k].low for k in range(max(3, idx-30), idx-3)
              if smc_signals[k].fib.found or True]
    for pv in h_vals:
        if pv > close: sw_dist = min(sw_dist, (pv - close) / atr) if atr > 0 else sw_dist
    for pv in l_vals:
        if pv < close: sw_dist = min(sw_dist, (close - pv) / atr) if atr > 0 else sw_dist

    # ── Interaction features ──
    ix1 = _cap(b.bb_squeeze_intensity * fvg_dist) if d_fvg.found else 0.0
    ix2 = _cap(b.ao_accel * ob_dist) if d_ob.found else 0.0
    ix3 = _cap(b.ma_sep_atr * (b.rsi14 - bars[max(0, idx-3)].rsi14))
    ix4 = _cap(b.atr_percentile * b.bb_squeeze_intensity)

    return {
        # Metadata
        'symbol': symbol,
        'timestamp': b.timestamp,
        'direction': direction,
        # Trend (4 features)
        'trend_bull': b.trend_bull, 'trend_bear': b.trend_bear,
        'ma_sep_atr': b.ma_sep_atr, 'ma25_slope': b.ma25_slope,
        'atr_percentile': b.atr_percentile, 'trend_strength': abs(b.ma_sep_atr),
        # Fibonacci (2 features)
        'fib_detected': 1 if fib.found else 0,
        'fib_golden_dist_atr': fib_dist,
        'swing_dist_atr': sw_dist,
        # BB/AO continuous (7 features)
        'bb_width_pct': b.bb_width_pct, 'bb_squeeze': b.bb_squeeze_intensity,
        'bb_expanding': b.bb_expanding,
        'ao_value': b.ao, 'ao_slope': b.ao_slope, 'ao_accel': b.ao_accel,
        'ao_dist_zero_atr': b.ao_dist_zero_atr,
        # SMC patterns (16 features)
        'ob_bull': 1 if smc.ob_bull.found else 0, 'ob_bear': 1 if smc.ob_bear.found else 0,
        'ob_dist_atr': ob_dist, 'ob_size_atr': ob_size, 'ob_present': 1 if d_ob.found else 0,
        'fvg_bull': 1 if smc.fvg_bull.found else 0, 'fvg_bear': 1 if smc.fvg_bear.found else 0,
        'fvg_dist_atr': fvg_dist, 'fvg_size_atr': fvg_size, 'fvg_present': 1 if d_fvg.found else 0,
        'sweep_bull': 1 if smc.sweep_bull.found else 0, 'sweep_bear': 1 if smc.sweep_bear.found else 0,
        'sweep_depth_atr': swp_depth, 'sweep_present': 1 if d_swp.found else 0,
        'choch_bull': 1 if smc.choch_bull.found else 0, 'choch_bear': 1 if smc.choch_bear.found else 0,
        'smc_confluence': conf, 'smc_any': 1 if (d_ob.found or d_fvg.found or d_swp.found or d_ch.found) else 0,
        # Continuous features (10 features)
        'rsi': b.rsi14, 'rsi_velocity': b.rsi14 - bars[max(0, idx-3)].rsi14,
        'rsi_extreme_bull': b.rsi_extreme_bull, 'rsi_extreme_bear': b.rsi_extreme_bear,
        'volume_zscore': b.vol_zscore, 'volume_ratio': b.vol_ratio,
        'displacement': b.displacement, 'body_ratio': b.body_ratio,
        'close_position': b.close_position, 'wick_atr': b.wick_magnitude / atr if atr > 0 else 0,
        'ao_cross_up': b.ao_cross_up, 'ao_cross_down': b.ao_cross_down,
        'price_in_bb': b.price_in_bb,
        # Interaction features (4 features)
        'bb_sqz_x_fvg_dist': ix1, 'ao_accel_x_ob_dist': ix2,
        'ma_sep_x_rsi_vel': ix3, 'atr_pct_x_bb_sqz': ix4,
    }
