#!/usr/bin/env python3
"""Honest, pre-registered test of the user's specific hypothesis:
WaveTrend divergence/oversold + Equal-Lows liquidity sweep + Discount-zone
confluence, as a dedicated LONG entry-at-bottoms filter -- on real klines,
not folded anonymously into an ML feature vector or compared against a
different rule engine's own pattern detectors.

Rules are fixed BEFORE looking at results (no tuning after seeing outcomes):
- WaveTrend (Market Cipher B esa/d/ci/tci, n1=9, n2=21), oversold level -60.
- Swing low: a bar whose low is the lowest of a +/-5 bar window.
- Equal Lows (EQL): two swing lows within 0.25*ATR of each other, the more
  recent one within the last 40 bars of the current bar.
- Discount zone: close is in the bottom 30% of the rolling 50-bar high-low range.
- Bullish WT divergence: at the more recent swing low, wt1 is HIGHER than wt1
  at the prior swing low, while price is LOWER (classic bullish divergence).
- Entry trigger (LONG only): on the bar where price sweeps below the older
  swing low (wicks below it) and CLOSES back above it (a liquidity sweep /
  stop hunt), AND is in the discount zone, AND either wt1 < -60 (oversold) OR
  bullish WT divergence is present at that swing pair.
- Entry: next bar open. Stop: sweep-bar low - 0.5*ATR. Target: 2R (fixed,
  pre-registered -- not optimized). Time exit: 30 bars if neither hit.
- Report per-symbol and aggregate: n, win rate, expectancy in R, whether it
  clears +1R. No cherry-picking after the fact.
"""
import glob
import numpy as np
import pandas as pd

OVERSOLD = -60.0
SWING_LOOKBACK = 5
EQL_ATR_MULT = 0.25
EQL_MAX_GAP_BARS = 40
DISCOUNT_LOOKBACK = 50
DISCOUNT_THRESHOLD = 0.30
STOP_ATR_BUFFER = 0.5
TARGET_R = 2.0
MAX_HOLD_BARS = 30


def ema(values, period):
    out = np.zeros_like(values, dtype=float)
    k = 2 / (period + 1)
    out[0] = values[0]
    for i in range(1, len(values)):
        out[i] = values[i] * k + out[i - 1] * (1 - k)
    return out


def wavetrend(close, n1=9, n2=21):
    esa = ema(close, n1)
    d = ema(np.abs(close - esa), n1)
    ci = np.where(d > 1e-12, (close - esa) / (0.015 * np.where(d > 1e-12, d, 1)), 0.0)
    tci = ema(ci, n2)
    wt1 = tci
    wt2 = np.convolve(wt1, np.ones(2) / 2, mode="full")[: len(wt1)]
    wt2[0] = wt1[0]
    return wt1, wt2


def atr(high, low, close, period=14):
    tr = np.zeros(len(high))
    tr[0] = high[0] - low[0]
    for i in range(1, len(high)):
        tr[i] = max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
    out = np.zeros(len(tr))
    for i in range(period - 1, len(tr)):
        out[i] = tr[i - period + 1 : i + 1].mean()
    return out


def swing_lows(low, lookback=SWING_LOOKBACK):
    n = len(low)
    is_swing = np.zeros(n, dtype=bool)
    for i in range(lookback, n - lookback):
        window = low[i - lookback : i + lookback + 1]
        if low[i] == window.min() and (window == low[i]).sum() == 1:
            is_swing[i] = True
    return is_swing


def run_symbol(path):
    df = pd.read_csv(path)
    o, h, l, c = (df[col].to_numpy(dtype=float) for col in ("open", "high", "low", "close"))
    n = len(df)
    if n < 250:
        return []

    wt1, _ = wavetrend(c)
    atr14 = atr(h, l, c)
    is_swing_low = swing_lows(l)
    swing_idxs = np.where(is_swing_low)[0]

    trades = []
    i = 60
    while i < n - MAX_HOLD_BARS - 1:
        if atr14[i] <= 0:
            i += 1
            continue

        # find the two most recent swing lows CONFIRMED by bar i (a swing low at
        # index j needs bars up to j+SWING_LOOKBACK to confirm -- using it before
        # i >= j+SWING_LOOKBACK is lookahead bias; fixed here)
        prior_swings = swing_idxs[swing_idxs + SWING_LOOKBACK <= i]
        if len(prior_swings) < 2:
            i += 1
            continue
        recent_swing_i = prior_swings[-1]
        older_swing_i = prior_swings[-2]
        if i - recent_swing_i > EQL_MAX_GAP_BARS:
            i += 1
            continue

        # Equal Lows check
        gap = abs(l[recent_swing_i] - l[older_swing_i])
        if gap > EQL_ATR_MULT * atr14[recent_swing_i]:
            i += 1
            continue

        # Bullish WT divergence: price lower low, wt1 higher low
        bullish_div = (l[recent_swing_i] < l[older_swing_i]) and (wt1[recent_swing_i] > wt1[older_swing_i])

        # Discount zone at bar i
        lo_window = l[max(0, i - DISCOUNT_LOOKBACK) : i + 1]
        hi_window = h[max(0, i - DISCOUNT_LOOKBACK) : i + 1]
        range_lo, range_hi = lo_window.min(), hi_window.max()
        if range_hi <= range_lo:
            i += 1
            continue
        position_in_range = (c[i] - range_lo) / (range_hi - range_lo)
        in_discount = position_in_range <= DISCOUNT_THRESHOLD

        # Liquidity sweep of the OLDER swing low on bar i: wick below, close above
        swept = (l[i] < l[older_swing_i]) and (c[i] > l[older_swing_i])

        oversold = wt1[i] < OVERSOLD

        if swept and in_discount and (oversold or bullish_div):
            entry_i = i + 1
            if entry_i >= n:
                break
            entry = o[entry_i]
            stop = l[i] - STOP_ATR_BUFFER * atr14[i]
            risk = entry - stop
            if risk <= 0:
                i += 1
                continue
            target = entry + TARGET_R * risk

            outcome_r = None
            for j in range(entry_i, min(entry_i + MAX_HOLD_BARS, n)):
                if l[j] <= stop:
                    outcome_r = (stop - entry) / risk
                    break
                if h[j] >= target:
                    outcome_r = (target - entry) / risk
                    break
            if outcome_r is None:
                last_j = min(entry_i + MAX_HOLD_BARS - 1, n - 1)
                outcome_r = (c[last_j] - entry) / risk

            trades.append({
                "symbol": path.split("/")[-1].replace("_4h.csv", ""),
                "entry_idx": entry_i,
                "r": outcome_r,
                "oversold": oversold,
                "bullish_div": bullish_div,
            })
            i = entry_i + MAX_HOLD_BARS  # no overlapping trades
        else:
            i += 1

    return trades


def main():
    files = sorted(glob.glob("/tmp/icr-run-2yr/binance_data/4h/*.csv"))
    all_trades = []
    for f in files:
        all_trades.extend(run_symbol(f))

    if not all_trades:
        print("NO SIGNALS FOUND -- confluence never triggered on this data.")
        return

    df = pd.DataFrame(all_trades)
    n = len(df)
    wins = (df["r"] > 0).sum()
    wr = wins / n
    expectancy = df["r"].mean()
    avg_win = df.loc[df["r"] > 0, "r"].mean() if wins > 0 else 0
    avg_loss = df.loc[df["r"] <= 0, "r"].mean() if (n - wins) > 0 else 0
    gross_win = df.loc[df["r"] > 0, "r"].sum()
    gross_loss = -df.loc[df["r"] <= 0, "r"].sum()
    pf = gross_win / gross_loss if gross_loss > 0 else float("inf")

    print(f"=== Bottom-confluence LONG test (WaveTrend + EQL sweep + Discount zone) ===")
    print(f"n={n}  win_rate={wr:.3f}  expectancy_R={expectancy:.3f}  PF={pf:.2f}")
    print(f"avg_win_R={avg_win:.3f}  avg_loss_R={avg_loss:.3f}")
    print(f"CLEARS +1R BAR: {expectancy >= 1.0}")
    print()
    print("Per-symbol breakdown:")
    print(df.groupby("symbol")["r"].agg(["count", "mean"]).sort_values("mean", ascending=False))
    print()
    print(f"Trades with oversold trigger: {df['oversold'].sum()}, mean R = {df.loc[df['oversold'], 'r'].mean() if df['oversold'].sum() else float('nan'):.3f}")
    print(f"Trades with bullish divergence trigger: {df['bullish_div'].sum()}, mean R = {df.loc[df['bullish_div'], 'r'].mean() if df['bullish_div'].sum() else float('nan'):.3f}")

    df.to_csv("/tmp/bottom-confluence-trades.csv", index=False)
    print("\nSaved trades to /tmp/bottom-confluence-trades.csv")


if __name__ == "__main__":
    main()


def run_split():
    files = sorted(glob.glob("/tmp/icr-run-2yr/binance_data/4h/*.csv"))
    first_half_trades, second_half_trades = [], []
    for f in files:
        df = pd.read_csv(f)
        split_idx = int(len(df) * 0.6)
        first = df.iloc[:split_idx].reset_index(drop=True)
        second = df.iloc[split_idx:].reset_index(drop=True)
        first.to_csv("/tmp/_split_first.csv", index=False)
        second.to_csv("/tmp/_split_second.csv", index=False)
        t1 = run_symbol("/tmp/_split_first.csv")
        for t in t1: t["symbol"] = f.split("/")[-1].replace("_4h.csv", "")
        first_half_trades.extend(t1)
        t2 = run_symbol("/tmp/_split_second.csv")
        for t in t2: t["symbol"] = f.split("/")[-1].replace("_4h.csv", "")
        second_half_trades.extend(t2)

    for label, trades in [("FIRST 60% (discovery period)", first_half_trades), ("LAST 40% (holdout)", second_half_trades)]:
        if not trades:
            print(f"{label}: no trades")
            continue
        d = pd.DataFrame(trades)
        n = len(d)
        wr = (d["r"] > 0).mean()
        exp = d["r"].mean()
        gw = d.loc[d["r"] > 0, "r"].sum()
        gl = -d.loc[d["r"] <= 0, "r"].sum()
        pf = gw / gl if gl > 0 else float("inf")
        print(f"{label}: n={n} wr={wr:.3f} expectancy={exp:.3f} pf={pf:.2f}")


if __name__ == "__main__" and "--split" in __import__("sys").argv:
    run_split()


def swing_highs(high, lookback=SWING_LOOKBACK):
    n = len(high)
    is_swing = np.zeros(n, dtype=bool)
    for i in range(lookback, n - lookback):
        window = high[i - lookback : i + lookback + 1]
        if high[i] == window.max() and (window == high[i]).sum() == 1:
            is_swing[i] = True
    return is_swing


def run_symbol_short(path):
    """Mirror of run_symbol: SHORT entries on Equal Highs sweep + Premium zone +
    WaveTrend overbought/bearish divergence. Same pre-registered parameters,
    same lookahead-safe swing confirmation as the (fixed) long version."""
    df = pd.read_csv(path)
    o, h, l, c = (df[col].to_numpy(dtype=float) for col in ("open", "high", "low", "close"))
    n = len(df)
    if n < 250:
        return []

    wt1, _ = wavetrend(c)
    atr14 = atr(h, l, c)
    is_swing_high = swing_highs(h)
    swing_idxs = np.where(is_swing_high)[0]

    trades = []
    i = 60
    while i < n - MAX_HOLD_BARS - 1:
        if atr14[i] <= 0:
            i += 1
            continue

        prior_swings = swing_idxs[swing_idxs + SWING_LOOKBACK <= i]
        if len(prior_swings) < 2:
            i += 1
            continue
        recent_swing_i = prior_swings[-1]
        older_swing_i = prior_swings[-2]
        if i - recent_swing_i > EQL_MAX_GAP_BARS:
            i += 1
            continue

        # Equal Highs check
        gap = abs(h[recent_swing_i] - h[older_swing_i])
        if gap > EQL_ATR_MULT * atr14[recent_swing_i]:
            i += 1
            continue

        # Bearish WT divergence: price higher high, wt1 lower high
        bearish_div = (h[recent_swing_i] > h[older_swing_i]) and (wt1[recent_swing_i] < wt1[older_swing_i])

        # Premium zone at bar i
        lo_window = l[max(0, i - DISCOUNT_LOOKBACK) : i + 1]
        hi_window = h[max(0, i - DISCOUNT_LOOKBACK) : i + 1]
        range_lo, range_hi = lo_window.min(), hi_window.max()
        if range_hi <= range_lo:
            i += 1
            continue
        position_in_range = (c[i] - range_lo) / (range_hi - range_lo)
        in_premium = position_in_range >= (1 - DISCOUNT_THRESHOLD)

        # Liquidity sweep of the OLDER swing high on bar i: wick above, close below
        swept = (h[i] > h[older_swing_i]) and (c[i] < h[older_swing_i])

        overbought = wt1[i] > -OVERSOLD  # symmetric: > +60

        if swept and in_premium and (overbought or bearish_div):
            entry_i = i + 1
            if entry_i >= n:
                break
            entry = o[entry_i]
            stop = h[i] + STOP_ATR_BUFFER * atr14[i]
            risk = stop - entry
            if risk <= 0:
                i += 1
                continue
            target = entry - TARGET_R * risk

            outcome_r = None
            for j in range(entry_i, min(entry_i + MAX_HOLD_BARS, n)):
                if h[j] >= stop:
                    outcome_r = (entry - stop) / risk
                    break
                if l[j] <= target:
                    outcome_r = (entry - target) / risk
                    break
            if outcome_r is None:
                last_j = min(entry_i + MAX_HOLD_BARS - 1, n - 1)
                outcome_r = (entry - c[last_j]) / risk

            trades.append({
                "symbol": path.split("/")[-1].replace("_4h.csv", ""),
                "entry_idx": entry_i,
                "r": outcome_r,
                "overbought": overbought,
                "bearish_div": bearish_div,
            })
            i = entry_i + MAX_HOLD_BARS
        else:
            i += 1

    return trades


# Wide-trail exit variant: same entry logic as run_symbol (long, bottom
# confluence), but replaces the fixed 2R target with EMPIRICAL_FINDINGS.md's
# already-validated exit ("wide trail, 5ATR, arm@+4R, NO early breakeven") --
# a proven principle from a separate study, applied here, not tuned to this
# result. Pre-registered before running: TRAIL_ATR_MULT=5.0, ARM_AT_R=4.0,
# MAX_HOLD_WIDE=120 bars (20 days on 4h -- generous, to let winners run).
TRAIL_ATR_MULT = 5.0
ARM_AT_R = 4.0
MAX_HOLD_WIDE = 120


def run_symbol_wide_trail(path):
    df = pd.read_csv(path)
    o, h, l, c = (df[col].to_numpy(dtype=float) for col in ("open", "high", "low", "close"))
    n = len(df)
    if n < 250:
        return []

    wt1, _ = wavetrend(c)
    atr14 = atr(h, l, c)
    is_swing_low = swing_lows(l)
    swing_idxs = np.where(is_swing_low)[0]

    trades = []
    i = 60
    while i < n - MAX_HOLD_WIDE - 1:
        if atr14[i] <= 0:
            i += 1
            continue
        prior_swings = swing_idxs[swing_idxs + SWING_LOOKBACK <= i]
        if len(prior_swings) < 2:
            i += 1
            continue
        recent_swing_i = prior_swings[-1]
        older_swing_i = prior_swings[-2]
        if i - recent_swing_i > EQL_MAX_GAP_BARS:
            i += 1
            continue
        gap = abs(l[recent_swing_i] - l[older_swing_i])
        if gap > EQL_ATR_MULT * atr14[recent_swing_i]:
            i += 1
            continue
        bullish_div = (l[recent_swing_i] < l[older_swing_i]) and (wt1[recent_swing_i] > wt1[older_swing_i])
        lo_window = l[max(0, i - DISCOUNT_LOOKBACK) : i + 1]
        hi_window = h[max(0, i - DISCOUNT_LOOKBACK) : i + 1]
        range_lo, range_hi = lo_window.min(), hi_window.max()
        if range_hi <= range_lo:
            i += 1
            continue
        position_in_range = (c[i] - range_lo) / (range_hi - range_lo)
        in_discount = position_in_range <= DISCOUNT_THRESHOLD
        swept = (l[i] < l[older_swing_i]) and (c[i] > l[older_swing_i])
        oversold = wt1[i] < OVERSOLD

        if swept and in_discount and (oversold or bullish_div):
            entry_i = i + 1
            if entry_i >= n:
                break
            entry = o[entry_i]
            initial_stop = l[i] - STOP_ATR_BUFFER * atr14[i]
            risk = entry - initial_stop
            if risk <= 0:
                i += 1
                continue

            stop = initial_stop
            armed = False
            highest = entry
            outcome_r = None
            for j in range(entry_i, min(entry_i + MAX_HOLD_WIDE, n)):
                if l[j] <= stop:
                    outcome_r = (stop - entry) / risk
                    break
                highest = max(highest, h[j])
                current_r = (highest - entry) / risk
                if current_r >= ARM_AT_R:
                    armed = True
                if armed:
                    trail_stop = highest - TRAIL_ATR_MULT * atr14[j]
                    stop = max(stop, trail_stop)  # ratchet only, never loosen
            if outcome_r is None:
                last_j = min(entry_i + MAX_HOLD_WIDE - 1, n - 1)
                outcome_r = (c[last_j] - entry) / risk

            trades.append({
                "symbol": path.split("/")[-1].split("_")[0],
                "entry_idx": entry_i,
                "r": outcome_r,
            })
            i = entry_i + MAX_HOLD_WIDE
        else:
            i += 1

    return trades
