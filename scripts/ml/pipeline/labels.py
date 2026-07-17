"""Forward outcome computation using conservative OHLC bracket semantics."""

from typing import List, Dict

from .features import EnrichedBar
from .config import PipelineConfig, DEFAULT


def compute_outcome(
    bars: List[EnrichedBar],
    entry_idx: int,
    direction: str,
    cfg: PipelineConfig = DEFAULT,
) -> Dict:
    """Compute a forward ATR-bracket outcome from bars after ``entry_idx``.

    When one OHLC candle touches both stop and target, the stop wins because
    bar data cannot establish the intrabar path. Bracket fills are booked at
    exactly -1R or the configured reward target rather than at bar extremes.
    """
    is_long = direction == "long"
    entry = bars[entry_idx].close
    atr = bars[entry_idx].atr14
    if atr <= 0 or entry <= 0:
        return {
            "hitTP": False,
            "hitStop": False,
            "maxFavorableR": 0.0,
            "maxAdverseR": 0.0,
            "pnlR": 0.0,
            "barsToOutcome": 0,
        }

    stop_dist = cfg.stop_atr_mult * atr
    if stop_dist <= 0:
        return {
            "hitTP": False,
            "hitStop": False,
            "maxFavorableR": 0.0,
            "maxAdverseR": 0.0,
            "pnlR": 0.0,
            "barsToOutcome": 0,
        }

    max_fav = 0.0
    max_adv = 0.0
    hit_tp = False
    hit_stop = False
    bars_to = 0

    scan_end = min(len(bars), entry_idx + cfg.max_lookforward_bars + 1)
    for fi in range(entry_idx + 1, scan_end):
        future = bars[fi]
        if is_long:
            fav = (future.high - entry) / stop_dist
            adv = (entry - future.low) / stop_dist
        else:
            fav = (entry - future.low) / stop_dist
            adv = (future.high - entry) / stop_dist

        max_fav = max(max_fav, fav)
        max_adv = max(max_adv, adv)

        if adv >= 1.0:
            hit_stop = True
            bars_to = fi - entry_idx
            break
        if fav >= cfg.rr_target:
            hit_tp = True
            bars_to = fi - entry_idx
            break

    pnl_r = float(cfg.rr_target) if hit_tp else (-1.0 if hit_stop else 0.0)
    return {
        "hitTP": hit_tp,
        "hitStop": hit_stop,
        "maxFavorableR": max_fav,
        "maxAdverseR": max_adv,
        "pnlR": pnl_r,
        "barsToOutcome": bars_to,
    }


def label_rows(
    rows: List[Dict],
    bars: List[EnrichedBar],
    cfg: PipelineConfig = DEFAULT,
) -> List[Dict]:
    """Annotate feature rows with forward outcomes."""
    for row in rows:
        idx = row.get("_bar_index", -1)
        if idx < 0 or idx >= len(bars):
            continue
        row.update(compute_outcome(bars, idx, row["direction"], cfg))
    return rows
