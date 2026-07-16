"""Forward outcome computation — NO lookahead by construction.
Takes enriched bars + entry params → scans ahead → returns label dict.

Labels are computed ONLY from bars that occur AFTER the entry bar.
This is the definitive backtest outcome source."""

from typing import List, Dict
import numpy as np
from .features import EnrichedBar
from .config import PipelineConfig, DEFAULT


def compute_outcome(bars: List[EnrichedBar], entry_idx: int,
                    direction: str, cfg: PipelineConfig = DEFAULT) -> Dict:
    """Compute forward outcome from entry bar `entry_idx`.

    Scans ahead up to `cfg.max_lookforward_bars`. Uses ATR-based stop
    with `cfg.stop_atr_mult` and TP at `cfg.rr_target * stop_distance`.

    NO lookahead — all bars scanned are STRICTLY after entry_idx.

    Returns:
        Dict with keys: hitTP, hitStop, maxFavorableR, maxAdverseR, pnlR, barsToOutcome
    """
    is_long = direction == 'long'
    entry = bars[entry_idx].close
    atr = bars[entry_idx].atr14
    if atr <= 0 or entry <= 0:
        return {'hitTP': False, 'hitStop': False, 'maxFavorableR': 0.0,
                'maxAdverseR': 0.0, 'pnlR': 0.0, 'barsToOutcome': 0}

    stop_dist = cfg.stop_atr_mult * atr
    if is_long:
        stop = entry - stop_dist
        tp = entry + stop_dist * cfg.rr_target
    else:
        stop = entry + stop_dist
        tp = entry - stop_dist * cfg.rr_target

    if stop_dist <= 0:
        return {'hitTP': False, 'hitStop': False, 'maxFavorableR': 0.0,
                'maxAdverseR': 0.0, 'pnlR': 0.0, 'barsToOutcome': 0}

    max_fav = 0.0; max_adv = 0.0
    hit_tp = False; hit_stop = False
    bars_to = 0

    scan_end = min(len(bars), entry_idx + cfg.max_lookforward_bars + 1)
    for fi in range(entry_idx + 1, scan_end):
        fb = bars[fi]
        if is_long:
            fav = (fb.high - entry) / stop_dist
            adv = (entry - fb.low) / stop_dist
        else:
            fav = (entry - fb.low) / stop_dist
            adv = (fb.high - entry) / stop_dist

        max_fav = max(max_fav, fav)
        max_adv = max(max_adv, adv)

        if fav >= cfg.rr_target:
            hit_tp = True; bars_to = fi - entry_idx; break
        if adv >= 1.0:
            hit_stop = True; bars_to = fi - entry_idx; break

    pnl_r = max_fav if hit_tp else (-max_adv if hit_stop else 0.0)
    return {
        'hitTP': hit_tp, 'hitStop': hit_stop,
        'maxFavorableR': max_fav, 'maxAdverseR': max_adv,
        'pnlR': pnl_r, 'barsToOutcome': bars_to,
    }


def label_rows(rows: List[Dict], bars: List[EnrichedBar],
               cfg: PipelineConfig = DEFAULT) -> List[Dict]:
    """Annotate feature rows with forward outcomes."""
    for r in rows:
        idx = r.get('_bar_index', -1)
        if idx < 0 or idx >= len(bars):
            continue
        outcome = compute_outcome(bars, idx, r['direction'], cfg)
        r.update(outcome)
    return rows
