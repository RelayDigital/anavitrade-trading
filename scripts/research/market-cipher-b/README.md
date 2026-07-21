# Market Cipher B — Standalone Confluence Strategy (Pre-Registered)

**Status: RUN, REJECTED on adequate sample size.** This section is written before any
backtest executes. Results, when they exist, get appended below under
"Results" — this document is never edited to make the pre-registration read
better in hindsight.

## Why this test, and why it's different from prior WaveTrend findings

`docs/analysis/EMPIRICAL_FINDINGS.md` records two prior negative WaveTrend
results in this repo:

1. WaveTrend-as-ICR-entry-filter — rejected (0/49 pairs fired; ICR is a
   continuation engine, WaveTrend measures the reversal extreme itself, the
   two fire at structurally incompatible times).
2. WaveTrend + LuxAlgo Equal Highs/Lows + Premium/Discount zone as a
   standalone strategy (`scripts/research/bottom-confluence/README.md`) —
   decisively rejected, pooled -0.01R across 56 symbols/114 trades.

Neither tested genuine Market Cipher B methodology. (1) grafted WaveTrend
onto an unrelated engine's gate sequence. (2) mixed WaveTrend with SMC/ICT
concepts (equal highs/lows, premium/discount zones) that aren't part of
Market Cipher B at all. This test uses the actual, self-contained Market
Cipher B confluence system — WaveTrend + Money Flow + Stochastic RSI +
MACD-oscillator divergence, scored by mutual confluence — as designed, with
no other system's rules mixed in.

## Implementation under test

`src/server/signals/market-cipher.ts::detectMarketCipher` — already exists
in this codebase (ported from the WeloTrades PineScript implementation),
wired into the live signal generator (`src/server/signals/generator.ts:211`)
but never independently backtested. **Zero MCB-tagged signals have ever
fired in production** (checked: 0 of 426 `analysis_signals` rows have
`mcb_type` in metadata as of 2026-07-20) — there is no live track record to
lean on, and no shortcuts available.

This test adds one thing to the existing file before running: a
`mcb_confluence_sell` short-side signal, mirroring the long-side
`mcb_confluence_buy` logic exactly (component-for-component: `wtTopSignal`
mirrors `wtBottomSignal`, `wtBearCross && wtDeepOb` mirrors
`wtBullCross && wtDeepOs`, `mfBearRegime` mirrors `mfBullRegime`, `stochOb`
mirrors `stochOs`, `regularBearDiv` mirrors `regularBullDiv` — same weights,
35/20/15/15/15, same `confluenceCount >= 2` threshold). This is a mechanical
mirror of already-existing, already-shipped logic, not new tuning.

## Pre-registered entry rule

**Long**: `mcb_confluence_buy` — confluence score >= 2 of 5 components:
- WaveTrend bottom divergence (price lower low, WT1 higher low): +35
- WaveTrend bull cross (WT1 crosses above WT2) while WT1 <= -60 (deep
  oversold): +20
- Money Flow bull regime change (both fast(9) and slow(10) MFI cross from
  <=0 to >0): +15
- Stochastic RSI oversold (K <= 20): +15
- Regular bullish divergence on the MACD-style oscillator (price lower low,
  oscillator higher low, oscillator < 0): +15

**Short**: `mcb_confluence_sell` — exact mirror, confluence score >= 2 of 5:
WT top divergence, WT bear cross at WT1 >= 60, Money Flow bear regime
change, StochRSI overbought (K >= 80), regular bearish MACD-oscillator
divergence.

No other filter, no score threshold beyond `>= 2`, no symbol-specific
tuning. This is the confluence rule as it already exists in the shipped
code, run standalone.

## Pre-registered exit rule

`simulateSmartExit` with `DEFAULT_EXIT_CONFIG`, unchanged
(`src/server/analysis/exits/exit-engine.ts`) — this repo's own validated
wide-trail exit (5x ATR trail, armed at +4R, no early breakeven,
exhaustion-detection cutoff at 0.7, `useFibTargets: false`). Same exit model
already proven for ICR's SMC entries, reused here to isolate entry-signal
quality from exit-model quality — same discipline the bottom-confluence test
used.

**Stop-loss / swing reference** (MCB has no built-in swing concept the way
ICR's impulse-gate does): 10-bar rolling swing extreme at the signal bar,
buffered by 0.5x ATR14 — `stop = swingLow - 0.5*atr14` for longs,
`swingHigh + 0.5*atr14` for shorts. Same convention bottom-confluence used
("sweep-bar extreme ± 0.5×ATR"). `impulseSwingLow`/`impulseSwingHigh`
parameters passed to `simulateSmartExit` are inert here since
`useFibTargets: false` in the exit config — they exist only to satisfy the
function signature.

## Pre-registered data and split

- **Universe**: `scripts/data/klines-mtf-extended.json` — 49 symbols, 4h
  (720 bars/symbol) and 1h (2,877 bars/symbol), same corpus already used for
  the ML locked-gate work.
- **Split**: purged/embargoed 70/15/15 chronological (train/validation/test),
  matching `scripts/ml/pipeline/validation.py::purged_chronological_split` —
  embargo = `DEFAULT_EXIT_CONFIG.maxBars` (60 bars), boundary rows dropped
  rather than leaked across the split.
- **Warm-up**: first 100 bars of each symbol excluded (indicator warm-up:
  WT's 21-period EMA chain, StochRSI's nested 14+14-period windows, MACD-osc
  divergence pivot lookback of 10+10).
- Long and short tested separately; 4h and 1h tested separately. No
  combining/cherry-picking across configurations before reporting.

## Decision rule (stated before results, per `CLAUDE.md`'s +1R bar)

- Compute expectancy (R-multiple) on the **validation** partition per
  configuration (long/short × 4h/1h = 4 configurations).
- A configuration must clear **+1R minimum expectancy on validation** to
  proceed further.
- Any configuration clearing that bar gets scored on **test** exactly once —
  no re-tuning after seeing test results.
- Any configuration clearing the bar on test gets replicated on a **disjoint
  symbol set** (same technique as bottom-confluence's decisive step) before
  being called a real edge. Without that replication, a result is
  "unconfirmed," not "validated" — regardless of how good it looks on the
  original universe.
- Every configuration's result gets reported below, including negative ones.
  This document is never edited to remove or soften a negative result after
  the fact.

## Bug caught during harness construction (fixed before any real run)

`swingStop()`'s 10-bar lookback window originally included the entry/signal
bar itself. MCB signals fire AT local extremes by definition (that's what WT
top/bottom divergence means), so the entry bar's own low/high was often the
computed swing extreme — placing the stop right at the entry bar's own
range. `simulateSmartExit`'s exit loop starts at the entry bar and checks the
stop against it on the first iteration, so this produced same-bar stop-outs
on a meaningful fraction of signals. Caught via a 3-symbol dry run showing
*uniform* exactly-(-1.000R) results across entire buckets (23/23 trades,
39/39 trades) — a red flag, since real stop-outs mixed with real winners
should never be perfectly uniform at that sample size. Fixed by excluding
the entry bar from the swing window (`slice(start, idx)` not
`slice(start, idx + 1)`) — same class of forward-only discipline this
repo's other backtests already enforce elsewhere, just missed here on first
pass. Both pre- and post-fix numbers are noted here so neither is silently
lost; only the post-fix harness is used for the real run below.

## Results

*(Not yet run — this section will be filled in after Phase 3 completes, one
configuration at a time, in the order tested.)*
