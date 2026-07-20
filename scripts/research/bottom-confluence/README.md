# Bottom-Confluence Hypothesis — WaveTrend + Equal Lows + Discount Zone

**Status: NEGATIVE / UNCONFIRMED. Not a validated edge. Preserved for the record, not as a template to build on without new data or a new mechanism.**

## What this tests

A specific, user-proposed hypothesis: the TradingView indicators shared this
session (Market Cipher B's WaveTrend, LuxAlgo's Equal Highs/Lows and
Premium/Discount zones) should be dedicated bottom/top-calling reversal
filters, tested standalone on real klines — not folded anonymously into an ML
feature vector (which had already failed for unrelated reasons before these
features could matter) and not compared against a different rule engine's own
pattern detectors (ICR's SMC/ICT logic, which is a different mechanism).

`test_bottom_confluence.py` implements, pre-registered before any result was
seen:
- **LONG** (`run_symbol`): entry on a liquidity sweep of an "Equal Lows" pair
  (two swing lows within 0.25×ATR of each other) while in a Discount zone
  (close in bottom 30% of a rolling 50-bar range), confirmed by WaveTrend
  oversold (<-60) or bullish WT divergence at the swing pair.
- **SHORT** (`run_symbol_short`): the exact mirror — Equal Highs sweep,
  Premium zone, WaveTrend overbought/bearish divergence.
- **Fixed exit** (both above): stop = sweep-bar extreme ± 0.5×ATR, target =
  2R, 30-bar timeout.
- **Wide-trail exit** (`run_symbol_wide_trail`): same entries, but the fixed
  2R target is replaced with `EMPIRICAL_FINDINGS.md`'s already-validated exit
  principle (5×ATR trailing stop, armed at +4R, ratchet only, no early
  breakeven) — borrowed from a different, separately-validated system (ICR's
  SMC entries), applied here to see if it transfers.

Swing-low/high confirmation is lookahead-safe: a pivot at bar `s` is only
usable once `i >= s + SWING_LOOKBACK` (an earlier version of this script had
a real lookahead bug here — using swing lows before they were confirmable,
which inflated the sample from n=31 to n=76 and expectancy from +0.38R to
+0.73R. Caught and fixed same-session; both numbers are preserved below so
the inflated one is never re-cited as real.)

## Results (project bar: minimum +1R expectancy to call something "edge", per `CLAUDE.md`)

| Test | Data | n | Expectancy | PF | Clears +1R? |
|---|---|---|---|---|---|
| Long, buggy (pre-fix, DO NOT CITE) | 4h, 20 alts, 2024-2026 | 76 | +0.734R | 2.92 | — invalid, superseded |
| Long, fixed | 4h, 20 alts, 2024-2026 | 31 | +0.381R | 1.73 | No |
| Long, fixed, discovery half | 4h, first 60% chronologically | 12 | +0.817R | 3.34 | marginal, tiny n |
| Long, fixed, holdout half | 4h, last 40% chronologically | 19 | +0.105R | 1.17 | No — statistically ~0 at this n |
| Long, thin-CEX-orderbook-liquidity alts | 4h, 20 different alts | 44 | -0.090R | 0.87 | No |
| Long, verified CEX-vol/DEX-liquidity mismatch alts | 4h, 7 alts (BANK/ACE/TLM/AKE/HOME/LAB/ALLO) | 11 | -0.182R | 0.75 | No |
| Short (mirror) | 4h, 20 alts | 28 | -0.100R | 0.85 | No |
| Long | 1h, 19 alts | 141 | -0.263R | 0.63 | No |
| Short (mirror) | 1h, 19 alts | 180 | -0.097R | 0.86 | No |
| Long, wide-trail exit | 4h, 20 alts | 28 | -0.291R | 0.59 | No |
| Long, wide-trail exit | 1h, 19 alts | 136 | -0.390R | 0.56 | No |

## Honest conclusion

No configuration tested clears the +1R bar. The two largest-sample results
(1h, n=141 and n=180) are clearly negative, not marginal — this weakens
confidence in the original 4h result rather than confirming it. Borrowing
this repo's own proven wide-trail exit (validated for ICR's SMC-based
entries) made results *worse* here, suggesting this entry signal behaves
like a short-term mean-reversion bounce rather than a trend-continuation
setup — a different character than the system that exit was built for.

The CEX-volume/DEX-liquidity mismatch angle was investigated properly: an
initial naive ticker-based DEX search returned wrong tokens (ticker
collisions with impersonator/scam projects — e.g. a "ZEC" match showing
$3.2B liquidity against $200 of volume, obviously not the real asset).
Rebuilt via CoinGecko's verified symbol → market-cap-ranked-id → contract-address
mapping, cross-referenced against all 524 Binance USDT perps, then queried
DexScreener by verified contract address. This found real, confirmed extreme
mismatches (BANKUSDT: $1.7B 24h volume vs. ~$127K on-chain liquidity;
ACEUSDT: $65M vs. ~$0; AKEUSDT: $415M vs. ~$1M, ratio ~406×) — a genuine
market-structure phenomenon, just one that didn't produce the predicted
backtested edge as tested here.

## What would change this assessment

Per the Fable Plan agent's review of this work: more data (more symbols, a
longer window than 2024-2026, ideally a disjoint symbol set — see its plan
in this session's history for the specific 38-symbol disjoint universe it
identified) is the honest next step before drawing a firmer conclusion
either way, given every sample size here is still fairly small. Any future
work on this hypothesis should start from this file's pre-registered rules
and the numbers above, not from a fresh, unanchored re-test.
