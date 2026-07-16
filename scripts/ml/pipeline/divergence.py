"""Momentum divergence detection — the REAL edge.

RSI/MACD/AO divergence: when price makes a lower low but momentum
makes a higher low (bullish) or price makes a higher high but momentum
makes a lower high (bearish). This is what Market Cipher, Wolfpack,
and every professional trader watches.

Divergence types detected:
  - Class A (regular): price extreme → momentum extreme diverge
  - Class B (hidden): continuation divergence during pullback
  - Class C (extended): 3-drive pattern with worsening momentum
"""

import numpy as np
from typing import List, Tuple, Optional


def _find_swing_points(values: np.ndarray, lookback: int = 5,
                       find_highs: bool = True) -> List[Tuple[int, float]]:
    """Find swing highs or lows in a series."""
    points = []
    for i in range(lookback, len(values) - lookback):
        if find_highs:
            if all(values[i] > values[i-j] for j in range(1, lookback+1)) and \
               all(values[i] > values[i+j] for j in range(1, lookback+1)):
                points.append((i, values[i]))
        else:
            if all(values[i] < values[i-j] for j in range(1, lookback+1)) and \
               all(values[i] < values[i+j] for j in range(1, lookback+1)):
                points.append((i, values[i]))
    return points


def detect_rsi_divergence(price: np.ndarray, rsi_arr: np.ndarray,
                          idx: int, direction: str,
                          lookback: int = 30) -> Tuple[int, float, str]:
    """
    Detect RSI divergence at bar `idx`.

    Bullish divergence (long signal):
      Price makes lower low vs prior swing low
      RSI makes HIGHER low vs prior swing low
      → Momentum strengthening while price weakens → reversal incoming

    Bearish divergence (short signal):
      Price makes higher high vs prior swing high
      RSI makes LOWER high vs prior swing high
      → Momentum weakening while price rises → reversal incoming

    Returns: (divergence_type: 0=none 1=regular 2=hidden 3=extended,
              strength: 0-1, description: str)
    """
    if idx < lookback:
        return 0, 0.0, ""

    window = slice(max(0, idx - lookback), idx + 1)
    price_win = price[window]
    rsi_win = rsi_arr[window]

    if direction == 'long':
        # Look for bullish divergence
        # Price: find two swing lows where second is LOWER
        price_lows = _find_swing_points(price_win, 3, False)
        if len(price_lows) < 2:
            return 0, 0.0, ""

        # Last two swing lows
        p1_idx, p1_val = price_lows[-2]
        p2_idx, p2_val = price_lows[-1]

        # Must be at or near the last swing
        if abs(p2_idx - (len(price_win) - 1)) > 3:
            return 0, 0.0, ""

        # Price must make lower low
        if p2_val >= p1_val * 0.998:
            return 0, 0.0, ""

        # RSI must make higher low
        rsi_p1 = rsi_win[p1_idx]
        rsi_p2 = rsi_win[p2_idx]

        if rsi_p2 > rsi_p1 + 2:  # 2-point minimum divergence
            strength = min(1.0, (rsi_p2 - rsi_p1) / 10.0)
            # Classify severity
            if p2_val < p1_val * 0.97 and rsi_p2 > rsi_p1 + 5:
                return 3, strength, "RSI_bull_div_extended"
            return 1, strength, "RSI_bull_div"

        # Hidden bullish: price higher low, RSI lower low (continuation)
        if p2_val > p1_val and rsi_p2 < rsi_p1 - 2:
            return 2, 0.7, "RSI_hidden_bull_div"

    else:  # short
        price_highs = _find_swing_points(price_win, 3, True)
        if len(price_highs) < 2:
            return 0, 0.0, ""

        h1_idx, h1_val = price_highs[-2]
        h2_idx, h2_val = price_highs[-1]

        if abs(h2_idx - (len(price_win) - 1)) > 3:
            return 0, 0.0, ""

        if h2_val <= h1_val * 1.002:
            return 0, 0.0, ""

        rsi_h1 = rsi_win[h1_idx]
        rsi_h2 = rsi_win[h2_idx]

        if rsi_h2 < rsi_h1 - 2:
            strength = min(1.0, (rsi_h1 - rsi_h2) / 10.0)
            if h2_val > h1_val * 1.03 and rsi_h2 < rsi_h1 - 5:
                return 3, strength, "RSI_bear_div_extended"
            return 1, strength, "RSI_bear_div"

        if h2_val < h1_val and rsi_h2 > rsi_h1 + 2:
            return 2, 0.7, "RSI_hidden_bear_div"

    return 0, 0.0, ""


def detect_ao_divergence(price: np.ndarray, ao: np.ndarray,
                         idx: int, direction: str,
                         lookback: int = 30) -> Tuple[int, float, str]:
    """
    Awesome Oscillator divergence — often leads RSI divergence by 1-3 bars.
    AO measures true momentum (not just close-close like RSI).
    """
    if idx < lookback:
        return 0, 0.0, ""

    window = slice(max(0, idx - lookback), idx + 1)
    price_win = price[window]
    ao_win = ao[window]

    if direction == 'long':
        price_lows = _find_swing_points(price_win, 3, False)
        if len(price_lows) < 2:
            return 0, 0.0, ""

        p1_idx, p1_val = price_lows[-2]
        p2_idx, p2_val = price_lows[-1]
        if abs(p2_idx - (len(price_win) - 1)) > 3:
            return 0, 0.0, ""
        if p2_val >= p1_val * 0.998:
            return 0, 0.0, ""

        ao_p1 = ao_win[p1_idx]
        ao_p2 = ao_win[p2_idx]

        # AO divergence: higher AO low while price makes lower low
        if ao_p2 > ao_p1:
            strength = min(1.0, (ao_p2 - ao_p1) / max(abs(ao_p1), 0.0001))
            return 1, strength, "AO_bull_div"

    else:
        price_highs = _find_swing_points(price_win, 3, True)
        if len(price_highs) < 2:
            return 0, 0.0, ""

        h1_idx, h1_val = price_highs[-2]
        h2_idx, h2_val = price_highs[-1]
        if abs(h2_idx - (len(price_win) - 1)) > 3:
            return 0, 0.0, ""
        if h2_val <= h1_val * 1.002:
            return 0, 0.0, ""

        ao_h1 = ao_win[h1_idx]
        ao_h2 = ao_win[h2_idx]
        if ao_h2 < ao_h1:
            strength = min(1.0, (ao_h1 - ao_h2) / max(abs(ao_h1), 0.0001))
            return 1, strength, "AO_bear_div"

    return 0, 0.0, ""


def detect_macd_divergence(macd_hist: np.ndarray, price: np.ndarray,
                           idx: int, direction: str,
                           lookback: int = 30) -> Tuple[int, float, str]:
    """MACD histogram divergence — same logic as RSI but on MACD."""
    if idx < lookback:
        return 0, 0.0, ""

    window = slice(max(0, idx - lookback), idx + 1)
    price_win = price[window]
    macd_win = macd_hist[window]

    if direction == 'long':
        price_lows = _find_swing_points(price_win, 3, False)
        if len(price_lows) < 2:
            return 0, 0.0, ""

        p1_idx, p1_val = price_lows[-2]
        p2_idx, p2_val = price_lows[-1]
        if abs(p2_idx - (len(price_win) - 1)) > 3:
            return 0, 0.0, ""
        if p2_val >= p1_val * 0.998:
            return 0, 0.0, ""

        if macd_win[p2_idx] > macd_win[p1_idx]:
            strength = min(1.0, abs(macd_win[p2_idx] - macd_win[p1_idx]))
            return 1, strength, "MACD_bull_div"

    else:
        price_highs = _find_swing_points(price_win, 3, True)
        if len(price_highs) < 2:
            return 0, 0.0, ""

        h1_idx, h1_val = price_highs[-2]
        h2_idx, h2_val = price_highs[-1]
        if abs(h2_idx - (len(price_win) - 1)) > 3:
            return 0, 0.0, ""
        if h2_val <= h1_val * 1.002:
            return 0, 0.0, ""

        if macd_win[h2_idx] < macd_win[h1_idx]:
            strength = min(1.0, abs(macd_win[h2_idx] - macd_win[h1_idx]))
            return 1, strength, "MACD_bear_div"

    return 0, 0.0, ""


def divergence_score(price: np.ndarray, rsi: np.ndarray, ao: np.ndarray,
                     macd_hist: np.ndarray, idx: int,
                     direction: str) -> dict:
    """
    Aggregate divergence score across all momentum oscillators.

    Returns dict with:
      - rsi_div_type, rsi_div_strength, rsi_div_label
      - ao_div_type, ao_div_strength, ao_div_label
      - macd_div_type, macd_div_strength, macd_div_label
      - composite_div_count (how many oscillators agree)
      - composite_div_strength (weighted average)
    """
    rsi_type, rsi_strength, rsi_label = detect_rsi_divergence(
        price, rsi, idx, direction)
    ao_type, ao_strength, ao_label = detect_ao_divergence(
        price, ao, idx, direction)
    macd_type, macd_strength, macd_label = detect_macd_divergence(
        macd_hist, price, idx, direction)

    types = [rsi_type, ao_type, macd_type]
    strengths = [rsi_strength, ao_strength, macd_strength]
    active = [t > 0 for t in types]

    return {
        'rsi_div_type': rsi_type, 'rsi_div_strength': rsi_strength,
        'rsi_div_label': rsi_label,
        'ao_div_type': ao_type, 'ao_div_strength': ao_strength,
        'ao_div_label': ao_label,
        'macd_div_type': macd_type, 'macd_div_strength': macd_strength,
        'macd_div_label': macd_label,
        'composite_div_count': sum(active),
        'composite_div_strength': (sum(s for s, a in zip(strengths, active) if a) /
                                   max(1, sum(active))),
        'any_divergence': int(any(active)),
        'triple_divergence': int(all(active)),
    }
