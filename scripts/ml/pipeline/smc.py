"""SMC/ICT pattern detection — ORDER BLOCKS, FAIR VALUE GAPS, LIQUIDITY SWEEPS, CHoCH.

Each function takes List[EnrichedBar] + index + config → detection result.
Swap this module to change pattern detection without touching anything else."""

from typing import List, Optional
from dataclasses import dataclass


@dataclass
class OBResult:
    found: bool = False
    top: float = 0; bottom: float = 0
    offset: int = 0


@dataclass
class FVGResult:
    found: bool = False
    top: float = 0; bottom: float = 0
    offset: int = 0


@dataclass
class SweepResult:
    found: bool = False
    depth_atr: float = 0


@dataclass
class ChoChResult:
    found: bool = False


@dataclass
class FibResult:
    found: bool = False
    swing_low: float = 0; swing_high: float = 0
    fib_618: float = 0; fib_786: float = 0
    direction: str = "bull"


@dataclass
class SMCSignals:
    """All SMC signals for one bar in both directions."""
    ob_bull: OBResult; ob_bear: OBResult
    fvg_bull: FVGResult; fvg_bear: FVGResult
    sweep_bull: SweepResult; sweep_bear: SweepResult
    choch_bull: ChoChResult; choch_bear: ChoChResult
    fib: FibResult

    @classmethod
    def empty(cls):
        return cls(
            OBResult(), OBResult(),
            FVGResult(), FVGResult(),
            SweepResult(), SweepResult(),
            ChoChResult(), ChoChResult(),
            FibResult(),
        )


# ═══ Helpers ═══

def _is_pivot_high(highs: List[float], idx: int, lookback: int = 3) -> bool:
    if idx < lookback or idx >= len(highs) - lookback:
        return False
    v = highs[idx]
    for j in range(1, lookback + 1):
        if highs[idx - j] >= v or highs[idx + j] >= v:
            return False
    return True


def _is_pivot_low(lows: List[float], idx: int, lookback: int = 3) -> bool:
    if idx < lookback or idx >= len(lows) - lookback:
        return False
    v = lows[idx]
    for j in range(1, lookback + 1):
        if lows[idx - j] <= v or lows[idx + j] <= v:
            return False
    return True


# ═══ Order Block Detection ═══

def detect_ob(bars, idx: int, is_long: bool, cfg) -> OBResult:
    """Detect unmitigated Order Block near bar `idx`."""
    empty = OBResult()
    h = [b.high for b in bars]; l = [b.low for b in bars]
    c = [b.close for b in bars]; o = [b.open for b in bars]
    lb = cfg.smc_swing_lookback; ob_lb = cfg.smc_ob_lookback

    if idx < lb + 1:
        return empty

    for rel_off in range(lb, ob_lb):
        ob_idx = idx - rel_off
        if ob_idx < lb:
            continue

        if is_long:
            if not _is_pivot_low(l, ob_idx, lb):
                continue
            # Find the actual candle that created the pivot
            actual = ob_idx
            for j in range(ob_idx - 1, max(0, ob_idx - lb) - 1, -1):
                if l[j] <= l[ob_idx]:
                    actual = j; break
            # Must be bearish
            if c[actual] >= o[actual]:
                if actual + 1 < len(bars) and c[actual+1] < o[actual+1]:
                    actual += 1
                else:
                    continue
            ob_t = max(o[actual], c[actual]); ob_b = min(o[actual], c[actual])
            # Rally check: max price after OB
            after_max = max(h[:actual]) if actual > 0 else h[0]
            if after_max <= ob_t * (1 + cfg.smc_ob_rally_pct / 100):
                continue
            # Unmitigated: no close below OB bottom since rally
            mitigated = any(c[k] < ob_b for k in range(actual - 1, -1, -1))
            if mitigated: continue
            return OBResult(True, ob_t, ob_b, rel_off)
        else:
            if not _is_pivot_high(h, ob_idx, lb):
                continue
            actual = ob_idx
            for j in range(ob_idx - 1, max(0, ob_idx - lb) - 1, -1):
                if h[j] >= h[ob_idx]:
                    actual = j; break
            if c[actual] <= o[actual]:
                if actual + 1 < len(bars) and c[actual+1] > o[actual+1]:
                    actual += 1
                else:
                    continue
            ob_t = max(o[actual], c[actual]); ob_b = min(o[actual], c[actual])
            after_min = min(l[:actual]) if actual > 0 else l[0]
            if after_min >= ob_b * (1 - cfg.smc_ob_rally_pct / 100):
                continue
            mitigated = any(c[k] > ob_t for k in range(actual - 1, -1, -1))
            if mitigated: continue
            return OBResult(True, ob_t, ob_b, rel_off)

    return empty


# ═══ Fair Value Gap Detection ═══

def detect_fvg(bars, idx: int, is_long: bool, cfg) -> FVGResult:
    empty = FVGResult()
    h = [b.high for b in bars]; l = [b.low for b in bars]
    c = [b.close for b in bars]; o = [b.open for b in bars]
    atr_v = [b.atr14 for b in bars]
    fvg_lb = cfg.smc_fvg_lookback

    if idx < 3:
        return empty

    for rel_off in range(2, fvg_lb):
        a_i = idx - rel_off - 2; b_i = idx - rel_off - 1; c_i = idx - rel_off
        if a_i < 0 or b_i < 0 or c_i < 0:
            continue

        # Gap: low[a] > high[c] for bullish FVG
        gap_top = l[a_i]; gap_bot = h[c_i]
        if gap_top <= gap_bot:
            continue
        gap_size = gap_top - gap_bot
        if gap_size < cfg.smc_fvg_min_size_atr * atr_v[c_i]:
            continue

        # Candle B must be impulsive
        b_body = abs(c[b_i] - o[b_i]); b_range = h[b_i] - l[b_i]
        b_impulsive = b_range > 0 and b_body / b_range >= 0.5
        if is_long and not (b_impulsive and c[b_i] > o[b_i]):
            continue
        if not is_long and not (b_impulsive and c[b_i] < o[b_i]):
            continue

        # Unmitigated
        mitigated = any(
            h[idx-k] >= gap_bot and l[idx-k] <= gap_top
            for k in range(rel_off-1, -1, -1) if idx-k >= 0
        )
        if mitigated:
            continue

        return FVGResult(True, gap_top, gap_bot, rel_off)

    return empty


# ═══ Liquidity Sweep Detection ═══

def detect_sweep(bars, idx: int, is_long: bool, cfg) -> SweepResult:
    empty = SweepResult()
    h = [b.high for b in bars]; l = [b.low for b in bars]
    c = [b.close for b in bars]
    atr_v = [b.atr14 for b in bars]
    lb = cfg.smc_swing_lookback; sw_lb = cfg.smc_sweep_lookback

    if idx < lb + 1:
        return empty

    for rel_off in range(lb, sw_lb):
        sw_idx = idx - rel_off
        if sw_idx < lb:
            continue

        if is_long:
            if not _is_pivot_low(l, sw_idx, lb):
                continue
            pivot = l[sw_idx]
            wicked = False; reclaimed = False; max_depth = 0
            for k in range(rel_off - 1, -1, -1):
                ki = idx - k
                if ki < 0: break
                if l[ki] < pivot:
                    wicked = True
                    max_depth = max(max_depth, pivot - l[ki])
                if wicked and c[ki] > pivot:
                    reclaimed = True; break
            if not (wicked and reclaimed): continue
            if c[idx] <= pivot: continue
            depth = max_depth / atr_v[idx] if atr_v[idx] > 0 else 0
            return SweepResult(True, depth)
        else:
            if not _is_pivot_high(h, sw_idx, lb):
                continue
            pivot = h[sw_idx]
            wicked = False; rejected = False; max_depth = 0
            for k in range(rel_off - 1, -1, -1):
                ki = idx - k
                if ki < 0: break
                if h[ki] > pivot:
                    wicked = True
                    max_depth = max(max_depth, h[ki] - pivot)
                if wicked and c[ki] < pivot:
                    rejected = True; break
            if not (wicked and rejected): continue
            if c[idx] >= pivot: continue
            depth = max_depth / atr_v[idx] if atr_v[idx] > 0 else 0
            return SweepResult(True, depth)

    return empty


# ═══ CHoCH Detection ═══

def detect_choch(bars, idx: int, is_long: bool, cfg) -> ChoChResult:
    empty = ChoChResult()
    h = [b.high for b in bars]; l = [b.low for b in bars]
    c = [b.close for b in bars]
    ma25 = [b.ma25 for b in bars]; ma99 = [b.ma99 for b in bars]
    lb = cfg.smc_swing_lookback; ch_lb = cfg.smc_choch_lookback

    if idx < ch_lb + lb:
        return empty

    if is_long:
        # Need downtrend context for bullish CHoCH
        if not (idx >= 99 and c[idx] < ma25[idx] and ma25[idx] < ma99[idx]):
            if not (c[idx] < ma25[idx]):  # relaxed: at least below MA25
                return empty
        last_lh = 0.0
        for k in range(ch_lb, -1, -1):
            ki = idx - k
            if ki < lb: continue
            if _is_pivot_high(h, ki, lb):
                last_lh = h[ki]; break
        if last_lh <= 0: return empty
        broke = any(c[idx-k] > last_lh for k in range(ch_lb) if idx-k >= 0)
        return ChoChResult(broke)
    else:
        if not (idx >= 99 and c[idx] > ma25[idx] and ma25[idx] > ma99[idx]):
            if not (c[idx] > ma25[idx]):
                return empty
        last_hl = float('inf')
        for k in range(ch_lb, -1, -1):
            ki = idx - k
            if ki < lb: continue
            if _is_pivot_low(l, ki, lb):
                last_hl = l[ki]; break
        if last_hl == float('inf'): return empty
        broke = any(c[idx-k] < last_hl for k in range(ch_lb) if idx-k >= 0)
        return ChoChResult(broke)


# ═══ Fibonacci Level Detection ═══

def detect_fib(bars, idx: int, cfg) -> FibResult:
    """Find nearest impulse swing and compute 0.618/0.786 retracement levels."""
    empty = FibResult()
    h = [b.high for b in bars]; l = [b.low for b in bars]
    atr_v = bars[idx].atr14; lb = cfg.smc_swing_lookback
    if atr_v <= 0 or idx < lb + 1:
        return empty

    piv_h = []; piv_l = []
    start = max(lb, idx - 30)
    for k in range(start, idx - lb):
        if _is_pivot_high(h, k, lb): piv_h.append((k, h[k]))
        if _is_pivot_low(l, k, lb): piv_l.append((k, l[k]))

    if not piv_h or not piv_l:
        return empty

    # Bull fib: pivot low → pivot high, retrace back to 0.618-0.786
    best_bull = None; best_bull_rec = 999
    for pl_k, pl_v in piv_l:
        for ph_k, ph_v in piv_h:
            if ph_k <= pl_k: continue
            mag = ph_v - pl_v
            if mag < 1.5 * atr_v: continue
            rec = idx - ph_k
            if rec < best_bull_rec:
                best_bull_rec = rec
                best_bull = FibResult(True, pl_v, ph_v,
                                     ph_v - 0.618 * mag, ph_v - 0.786 * mag, "bull")

    # Bear fib: pivot high → pivot low
    best_bear = None; best_bear_rec = 999
    for ph_k, ph_v in piv_h:
        for pl_k, pl_v in piv_l:
            if pl_k <= ph_k: continue
            mag = ph_v - pl_v
            if mag < 1.5 * atr_v: continue
            rec = idx - pl_k
            if rec < best_bear_rec:
                best_bear_rec = rec
                best_bear = FibResult(True, pl_v, ph_v,
                                     pl_v + 0.618 * mag, pl_v + 0.786 * mag, "bear")

    if best_bull and best_bear:
        return best_bull if best_bull_rec <= best_bear_rec else best_bear
    return best_bull or best_bear or empty


# ═══ Full SMC extraction for one bar ═══

def extract(bars, idx: int, cfg) -> SMCSignals:
    """Extract all SMC signals for bar `idx` in one call."""
    return SMCSignals(
        ob_bull=detect_ob(bars, idx, True, cfg),
        ob_bear=detect_ob(bars, idx, False, cfg),
        fvg_bull=detect_fvg(bars, idx, True, cfg),
        fvg_bear=detect_fvg(bars, idx, False, cfg),
        sweep_bull=detect_sweep(bars, idx, True, cfg),
        sweep_bear=detect_sweep(bars, idx, False, cfg),
        choch_bull=detect_choch(bars, idx, True, cfg),
        choch_bear=detect_choch(bars, idx, False, cfg),
        fib=detect_fib(bars, idx, cfg),
    )
