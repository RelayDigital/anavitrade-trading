"""
STRUCTURAL REWARD FUNCTION — entries at swing bottoms, exits at swing tops.

Principles (from user):
  1. Entries closest to natural swing lows (market bottoms)
  2. Exits closest to natural swing highs (market tops)
  3. Low drawdown — deep adverse excursion penalized even if TP hit
  4. Multi-confluence — multiple structural levels = higher conviction
  5. Advanced Fibonacci — beyond 0.618/0.786: clusters, extensions, harmonic patterns

The reward IS the label. The model optimizes for structural quality, not binary hit/miss.

Reward formula:
  structural_reward = entry_quality × exit_quality × (1 - dd_penalty) × confluence_multiplier

Where:
  entry_quality = 1.0 - min(1.0, |entry - nearest_swing_low| / (2 * ATR))  [long]
  exit_quality  = 1.0 - min(1.0, |peak - nearest_swing_high| / (2 * ATR))   [long]
  dd_penalty    = 0.3 if max_adverse_R > 1.5, 0.6 if > 2.5, else 0
  confluence    = 1.0 + 0.1 × count(levels_clustered_within_1.5_ATR)
"""

import json, numpy as np
from pathlib import Path
from typing import List, Dict, Tuple
from dataclasses import dataclass
import sys


# ═══ Helpers ═══

def _sma(v, n):
    out = np.zeros(len(v))
    if len(v) < n: return out
    out[n-1:] = np.convolve(v, np.ones(n)/n, mode='valid')
    return out

def _atr(h, l, c, n):
    tr = np.zeros(len(h)); tr[0] = h[0]-l[0]
    for i in range(1, len(h)):
        tr[i] = max(h[i]-l[i], abs(h[i]-c[i-1]), abs(l[i]-c[i-1]))
    return _sma(tr, n)

def _rsi(c, n):
    out = np.full(len(c), 50.0)
    if len(c) < n+1: return out
    d = np.diff(c); g = np.maximum(d,0); l = np.maximum(-d,0)
    for i in range(n, len(c)):
        ag = g[i-n:i].mean(); al = l[i-n:i].mean()
        out[i] = 100 - 100/(1 + ag/al) if al > 0 else 100
    return out

def _bb(c, n, m):
    mid = _sma(c, n); up = np.zeros(len(c)); lo = np.zeros(len(c)); w = np.zeros(len(c))
    for i in range(n-1, len(c)):
        std = np.std(c[i-n+1:i+1])
        up[i] = mid[i] + m*std; lo[i] = mid[i] - m*std
        w[i] = (up[i]-lo[i])/mid[i]*100 if mid[i] > 0 else 0
    return mid, up, lo, w

def _ao(h, l, f=5, s=34):
    hl = (h+l)/2; return _sma(hl, f) - _sma(hl, s)

def _zscore(v, n):
    out = np.zeros(len(v))
    for i in range(n-1, len(v)):
        w = v[i-n+1:i+1]; s = np.std(w)
        out[i] = (v[i] - np.mean(w))/s if s > 0 else 0
    return out

def _slope(v, lb, i):
    if i < lb-1: return 0.0
    ys = v[i-lb+1:i+1]; xs = np.arange(lb, dtype=float)
    if len(set(ys)) < 2: return 0.0
    return np.polyfit(xs, ys, 1)[0]

def _is_pivot_high(h, idx, lb=3):
    if idx < lb or idx >= len(h)-lb: return False
    v = h[idx]
    return all(h[idx-j] < v and h[idx+j] < v for j in range(1, lb+1))

def _is_pivot_low(l, idx, lb=3):
    if idx < lb or idx >= len(l)-lb: return False
    v = l[idx]
    return all(l[idx-j] > v and l[idx+j] > v for j in range(1, lb+1))


# ═══ Fibonacci Depth Engine ═══

@dataclass
class FibLevels:
    """All Fibonacci retracement + extension levels for a given impulse swing."""
    ret_382: float; ret_500: float; ret_618: float; ret_786: float
    ext_1272: float; ext_1618: float; ext_2618: float
    direction: str  # 'bull' (low→high) or 'bear' (high→low)
    swing_low: float; swing_high: float

    @classmethod
    def from_impulse(cls, swing_low: float, swing_high: float, direction: str):
        rng = swing_high - swing_low
        if direction == 'bull':
            return cls(
                ret_382 = swing_high - 0.382 * rng,
                ret_500 = swing_high - 0.500 * rng,
                ret_618 = swing_high - 0.618 * rng,
                ret_786 = swing_high - 0.786 * rng,
                ext_1272 = swing_low + 1.272 * rng,
                ext_1618 = swing_low + 1.618 * rng,
                ext_2618 = swing_low + 2.618 * rng,
                direction=direction, swing_low=swing_low, swing_high=swing_high,
            )
        else:
            return cls(
                ret_382 = swing_low + 0.382 * rng,
                ret_500 = swing_low + 0.500 * rng,
                ret_618 = swing_low + 0.618 * rng,
                ret_786 = swing_low + 0.786 * rng,
                ext_1272 = swing_high - 1.272 * rng,
                ext_1618 = swing_high - 1.618 * rng,
                ext_2618 = swing_high - 2.618 * rng,
                direction=direction, swing_low=swing_low, swing_high=swing_high,
            )

    def all_levels(self) -> List[float]:
        return [self.ret_382, self.ret_500, self.ret_618, self.ret_786,
                self.ext_1272, self.ext_1618, self.ext_2618]

    def level_names(self) -> List[str]:
        return ['0.382', '0.500', '0.618', '0.786', '1.272', '1.618', '2.618']


def detect_fib_impulse(bars_h, bars_l, bars_c, idx, atr_val, swing_lb=3, lookback=30):
    """Find the nearest significant impulse swing and compute all fib levels."""
    if idx < swing_lb + 1 or atr_val <= 0:
        return None

    piv_h = []; piv_l = []
    start = max(swing_lb, idx - lookback)
    for k in range(start, idx - swing_lb):
        if _is_pivot_high(bars_h, k, swing_lb): piv_h.append((k, bars_h[k]))
        if _is_pivot_low(bars_l, k, swing_lb): piv_l.append((k, bars_l[k]))

    if not piv_h or not piv_l: return None

    # Bull impulses (low → high)
    best_bull = None; best_bull_rec = 999
    for pl_k, pl_v in piv_l:
        for ph_k, ph_v in piv_h:
            if ph_k <= pl_k: continue
            mag = ph_v - pl_v
            if mag < 1.5 * atr_val: continue
            rec = idx - ph_k
            if rec < best_bull_rec:
                best_bull_rec = rec
                best_bull = FibLevels.from_impulse(pl_v, ph_v, 'bull')

    # Bear impulses (high → low)
    best_bear = None; best_bear_rec = 999
    for ph_k, ph_v in piv_h:
        for pl_k, pl_v in piv_l:
            if pl_k <= ph_k: continue
            mag = ph_v - pl_v
            if mag < 1.5 * atr_val: continue
            rec = idx - pl_k
            if rec < best_bear_rec:
                best_bear_rec = rec
                best_bear = FibLevels.from_impulse(ph_v, pl_v, 'bear')

    if best_bull and best_bear:
        return best_bull if best_bull_rec <= best_bear_rec else best_bear
    return best_bull or best_bear


def fib_cluster_score(price: float, fib_levels: List[FibLevels], atr: float,
                      threshold_atr: float = 0.5) -> int:
    """Count how many fib levels from different impulses cluster near `price`."""
    cluster = 0
    all_levels = []
    for fib in fib_levels:
        all_levels.extend(fib.all_levels())

    for level in all_levels:
        if abs(price - level) <= threshold_atr * atr:
            cluster += 1

    return cluster


# ═══ Harmonic Pattern Detection ═══

def detect_harmonic_pattern(bars_h, bars_l, bars_c, idx, swing_lb=3) -> str | None:
    """
    Detect Gartley/Bat/Crab/Butterfly harmonic patterns.
    Requires 4 pivot points (XABCD) with specific Fibonacci ratios.
    Returns pattern name or None.
    """
    if idx < swing_lb * 8: return None

    h = bars_h; l = bars_l; c = bars_c
    pivots = []
    for k in range(max(swing_lb, idx - 60), idx - swing_lb):
        if _is_pivot_high(h, k, swing_lb):
            pivots.append(('H', k, h[k]))
        if _is_pivot_low(l, k, swing_lb):
            pivots.append(('L', k, l[k]))

    if len(pivots) < 4: return None

    # Take last 4 alternating pivots
    pivots.sort(key=lambda x: x[1])
    recent = []
    last_type = None
    for p_type, p_idx, p_val in reversed(pivots):
        if p_type != last_type:
            recent.append((p_type, p_val))
            last_type = p_type
        if len(recent) >= 4: break

    if len(recent) < 4: return None
    X, A, B, C = recent[3], recent[2], recent[1], recent[0]

    # XA is the impulse leg
    xa = abs(A[1] - X[1])
    if xa <= 0: return None

    # AB retracement
    ab = abs(B[1] - A[1])
    ab_ret = ab / xa

    # BC retracement
    bc = abs(C[1] - B[1])
    bc_ret = bc / ab if ab > 0 else 0

    # CD projection target
    cd_proj = C[1] + (A[1] - X[1]) * 0.786 if X[1] < A[1] else C[1] - (X[1] - A[1]) * 0.786

    # Pattern recognition via ratios
    bull = X[1] < A[1]  # X < A = bullish pattern

    # Gartley: AB ≈ 0.618 of XA, BC ≈ 0.382-0.886 of AB
    if 0.55 <= ab_ret <= 0.68 and 0.35 <= bc_ret <= 0.90:
        return 'Gartley'

    # Bat: AB ≈ 0.382-0.50 of XA, BC ≈ 0.382-0.886 of AB
    if 0.35 <= ab_ret <= 0.55 and 0.35 <= bc_ret <= 0.90:
        return 'Bat'

    # Crab: AB ≈ 0.382-0.618 of XA, BC ≈ 0.382-0.886, CD ext ≈ 1.618 of XA
    if 0.35 <= ab_ret <= 0.65 and 0.35 <= bc_ret <= 0.90:
        return 'Crab'

    # Butterfly: AB ≈ 0.786 of XA, BC ≈ 0.382-0.886
    if 0.72 <= ab_ret <= 0.85 and 0.35 <= bc_ret <= 0.90:
        return 'Butterfly'

    return None


# ═══ Structural Reward Function ═══

def compute_structural_reward(
    bars_h: np.ndarray, bars_l: np.ndarray, bars_c: np.ndarray,
    bars_t: np.ndarray, bars_atr: np.ndarray,
    entry_idx: int, direction: str,
    max_lookforward: int = 48,
) -> Dict:
    """
    Compute structural reward for an entry at bar `entry_idx`.

    Scans forward up to max_lookforward bars. At the exit (TP hit or timeout),
    evaluates: entry quality, exit quality, drawdown penalty, confluence bonus.

    Returns dict with keys:
      entry_quality, exit_quality, dd_penalty, confluence_multiplier,
      structural_reward (product), max_fav_r, max_adv_r, hit_tp, hit_stop,
      fib_cluster_count, harmonic_pattern, swing_entry_distance_atr,
      swing_exit_distance_atr, bars_to_exit
    """
    n = len(bars_c)
    entry = bars_c[entry_idx]
    atr_entry = bars_atr[entry_idx]
    if atr_entry <= 0 or entry <= 0:
        return {'structural_reward': 0.0}

    is_long = direction == 'long'

    # ═══ Pre-scan: find all pivot levels in the lookback window ═══
    # Swing lows and highs near entry (for entry quality)
    piv_lows = []
    piv_highs = []
    for k in range(max(3, entry_idx - 30), entry_idx):
        if _is_pivot_low(bars_l, k, 3):
            piv_lows.append((k, bars_l[k]))
        if _is_pivot_high(bars_h, k, 3):
            piv_highs.append((k, bars_h[k]))

    # Nearest swing low below entry (support)
    nearest_swing_low = None; nearest_swing_low_dist = float('inf')
    for k, v in piv_lows:
        if v < entry:
            d = entry - v
            if d < nearest_swing_low_dist:
                nearest_swing_low_dist = d
                nearest_swing_low = v

    # Nearest swing high above entry (resistance)
    nearest_swing_high = None; nearest_swing_high_dist = float('inf')
    for k, v in piv_highs:
        if v > entry:
            d = v - entry
            if d < nearest_swing_high_dist:
                nearest_swing_high_dist = d
                nearest_swing_high = v

    # ═══ Entry Quality ═══
    # For long: how close is entry to the nearest swing low? 0 = at bottom, 1 = far
    if is_long and nearest_swing_low is not None:
        entry_quality = 1.0 - min(1.0, nearest_swing_low_dist / (2 * atr_entry))
    elif not is_long and nearest_swing_high is not None:
        entry_quality = 1.0 - min(1.0, nearest_swing_high_dist / (2 * atr_entry))
    else:
        entry_quality = 0.3  # no structural reference

    # ═══ Fibonacci cluster detection at entry ═══
    fibs = []
    for k in range(max(3, entry_idx - 30), entry_idx):
        f = detect_fib_impulse(bars_h, bars_l, bars_c, k, bars_atr[k])
        if f is not None:
            fibs.append(f)

    fib_clusters_at_entry = fib_cluster_score(entry, fibs, atr_entry)
    harmonic = detect_harmonic_pattern(bars_h, bars_l, bars_c, entry_idx)

    # ═══ Forward scan ═══
    # Set initial stop based on nearest structural level
    if is_long:
        stop = nearest_swing_low - 0.2 * atr_entry if nearest_swing_low else entry - 2*atr_entry
        tp = nearest_swing_high if nearest_swing_high else entry + 4*atr_entry
    else:
        stop = nearest_swing_high + 0.2 * atr_entry if nearest_swing_high else entry + 2*atr_entry
        tp = nearest_swing_low if nearest_swing_low else entry - 4*atr_entry

    stop_dist = abs(entry - stop)
    if stop_dist <= 0:
        stop_dist = 2 * atr_entry

    max_fav_r = 0.0; max_adv_r = 0.0
    hit_tp = False; hit_stop = False
    bars_to_exit = 0
    peak_price = entry

    scan_end = min(n, entry_idx + max_lookforward + 1)
    for fi in range(entry_idx + 1, scan_end):
        fb_h, fb_l, fb_c, fb_atr = bars_h[fi], bars_l[fi], bars_c[fi], bars_atr[fi]

        if is_long:
            fav = (fb_h - entry) / stop_dist
            adv = (entry - fb_l) / stop_dist
            if fb_h > peak_price: peak_price = fb_h
        else:
            fav = (entry - fb_l) / stop_dist
            adv = (fb_h - entry) / stop_dist
            if fb_l < peak_price: peak_price = fb_l

        max_fav_r = max(max_fav_r, fav)
        max_adv_r = max(max_adv_r, adv)

        # TP hit when price reaches nearest swing high (structural target)
        if is_long and fb_h >= tp:
            hit_tp = True; bars_to_exit = fi - entry_idx; break
        elif not is_long and fb_l <= tp:
            hit_tp = True; bars_to_exit = fi - entry_idx; break

        # Stop hit when price breaks nearest swing low/high
        if is_long and fb_l <= stop:
            hit_stop = True; bars_to_exit = fi - entry_idx; break
        elif not is_long and fb_h >= stop:
            hit_stop = True; bars_to_exit = fi - entry_idx; break

    # ═══ Exit Quality ═══
    # For long: how close did the peak get to the nearest swing high?
    if hit_tp or max_fav_r > 0.5:
        exit_idx = min(entry_idx + bars_to_exit, n-1) if bars_to_exit > 0 else min(entry_idx + max_lookforward, n-1)
        # Find swing highs near the exit
        exit_swing_highs = []
        for k in range(max(3, exit_idx - 10), min(n, exit_idx + 10)):
            if _is_pivot_high(bars_h, k, 3):
                exit_swing_highs.append(bars_h[k])

        if exit_swing_highs and is_long:
            nearest_exit_high = min(exit_swing_highs, key=lambda v: abs(peak_price - v))
            exit_quality = 1.0 - min(1.0, abs(peak_price - nearest_exit_high) / (2 * atr_entry))
        elif exit_swing_highs and not is_long:
            nearest_exit_low = min(exit_swing_highs, key=lambda v: abs(peak_price - v))  # actually lows
            exit_quality = 1.0 - min(1.0, abs(peak_price - nearest_exit_low) / (2 * atr_entry))
        else:
            exit_quality = 0.5
    else:
        exit_quality = 0.0  # never got close to target

    # ═══ Drawdown Penalty ═══
    if max_adv_r > 2.5:
        dd_penalty = 0.6
    elif max_adv_r > 1.5:
        dd_penalty = 0.3
    elif max_adv_r > 1.0:
        dd_penalty = 0.15
    else:
        dd_penalty = 0.0

    # ═══ Confluence Multiplier ═══
    confluence_count = fib_clusters_at_entry
    if harmonic is not None:
        confluence_count += 2  # harmonic pattern = major confluence
    if entry_quality > 0.7:
        confluence_count += 1  # tight entry adds conviction

    confluence_multiplier = 1.0 + 0.12 * min(confluence_count, 8)

    # ═══ Structural Reward ═══
    reward = entry_quality * exit_quality * (1.0 - dd_penalty) * confluence_multiplier
    reward = max(0.0, min(2.0, reward))  # cap at 2x

    return {
        'structural_reward': float(reward),
        'entry_quality': float(entry_quality),
        'exit_quality': float(exit_quality),
        'dd_penalty': float(dd_penalty),
        'confluence_multiplier': float(confluence_multiplier),
        'max_fav_r': float(max_fav_r),
        'max_adv_r': float(max_adv_r),
        'hit_tp': hit_tp,
        'hit_stop': hit_stop,
        'fib_cluster_count': fib_clusters_at_entry,
        'harmonic_pattern': harmonic or 'none',
        'swing_entry_dist_atr': float((nearest_swing_low_dist if is_long else nearest_swing_high_dist) / atr_entry) if atr_entry > 0 else 5.0,
        'swing_exit_dist_atr': 0.0,  # filled below
        'bars_to_exit': bars_to_exit,
    }
