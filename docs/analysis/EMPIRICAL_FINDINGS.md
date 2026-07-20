# ICR Engine — Empirical Findings & Calibrated Config

## Release status — not validated for capital deployment (2026-07-19)

This document records research configuration and historical observations. It is
**not** evidence that an ICR strategy is profitable or suitable for automated
DEX execution.

- The historical parameter sweeps below must not be used as a release gate:
  selecting or narrating favourable settings from the same corpus is not
  out-of-sample validation.
- The production engine and paper lane now evaluate only the just-closed candle
  (`findLatestSignals`). Replaying a full historical window on each cron is
  invalid and must never be used to calculate signal counts or performance.
- As of this update, the retained 4h corpus covers roughly 24 symbols from
  2026-05-27 through 2026-07-18. The corrected fixed-configuration evaluation
  produced only four qualified observations and -4R; that sample is far too
  small to establish an edge, and it does not pass a release gate.
- The paper book has no recorded entries or evaluated outcomes yet. Automated
  dispatch must remain disabled until a predeclared rule path completes the
  required paper/testnet window with documented fees, slippage, and drawdown.

Do not claim user profitability, enable automated signal dispatch, or turn on
live order submission based on the older aggregate figures in this file.

## Bottom-confluence hypothesis (WaveTrend + Equal Lows + Discount zone) — negative (2026-07-19)

Tested a specific, user-proposed hypothesis (Market Cipher B WaveTrend +
LuxAlgo Equal Lows/Highs + Premium/Discount zones as a dedicated
reversal-entry filter) across long and short, two timeframes (4h, 1h), three
symbol-selection criteria (general alts, thin-CEX-orderbook-liquidity coins,
verified CEX-volume/DEX-liquidity mismatch coins), and two exit models (fixed
2R, and this repo's own proven wide-trail exit). No configuration cleared the
project's +1R minimum-edge bar (`CLAUDE.md`); the largest-sample results (1h,
n=141 and n=180) were clearly negative, not marginal. Full pre-registered
methodology, per-test results table, and honest conclusion in
`scripts/research/bottom-confluence/README.md`. Caught and fixed a real
lookahead bug mid-investigation (inflated an early result from +0.38R to a
non-reproducible +0.73R) — documented there so the inflated number is never
re-cited.

## CRITICAL: Do Not Change These Without Re-Backtesting

These parameters were found through 30-symbol, 6-month sweeps with 655+ signal outcomes. They are NOT arbitrary.

## Current DEFAULT_ICR_CONFIG

```typescript
export const DEFAULT_ICR_CONFIG: IcrConfig = {
  fastMa: 7, midMa: 25, slowMa: 99,
  atrLength: 14, volumeMaLength: 20,
  maSlopeLookback: 5, lookbackStructure: 50,

  // Altcoin-relaxed impulse gates
  minImpulseBars: 2,        // 3 on majors → too few signals on alts
  maxImpulseBars: 14,       // 12 → missed longer altcoin impulses
  minPullbackBars: 2,       // 3 lost too many valid setups
  compressionLookback: 8,   // 10 → too slow for altcoin compression
  maxSignalAgeAfterImpulse: 35, // 28 → lost old but valid setups

  // Altcoin-relaxed multipliers
  impulseAtrMult: 1.2,         // 1.5 gates out most alts (need lower bar)
  impulseVolumeMult: 1.0,
  pullbackVolumeMaxRatio: 1.15,
  compressionRangeRatio: 0.95,
  compressionAtrRatio: 0.99,
  nearMaAtrMult: 1.5,
  maSeparationAtrMult: 0.03,  // 0.05 → too tight for alts
  candleClosePositionThreshold: 0.55, // 0.60 → too strict for alts

  // Empirical thresholds (from 655-outcome sweeps)
  scoreThreshold: 65,  // 75 → too high, lost valid signals
  minRr: 1.5,          // 2.5 → too high, RR naturally high on altcoin impulse setups

  stopAtrBuffer: 0.1,

  // Coil gate: OFF for alts (proven net-negative)
  enableCoilGate: false,  // was true — blocks all altcoin signals
  minCoilScore: 60,       // was 72 — coils on alts naturally score ~46 median

  bonferroniAdjust: true,
  bollingerLength: 20, bollingerStd: 2,

  // Tier thresholds (calibrated from backtest)
  tierAThreshold: 80,  // AVERAGE R > 1.5, WR ~35%
  tierBThreshold: 65,  // AVERAGE R ~0.5, WR ~20%
  // C < 65:              AVERAGE R < 0 (LOSING — skip/paper only)

  // Entry quality filter (proven +17.9R gain over pure runner)
  entryRsiMax: 70,   // reject long if RSI14 >= 70 (chasing extension)
  entryRsiMin: 30,   // reject short if RSI14 <= 30 (chasing extension)
};
```

## What the Backtest Proves

### Tier Quality is Real
- **Tier A (≥80)**: 615 outcomes, +128.85R, avgR +0.21 (PROFITABLE — trade these)
- **Tier B (65-79)**: 40 outcomes, -8.52R, avgR -0.21 (LOSING — paper/skip only)
- The boundary cleanly separates winners from losers. Not random.

### Edge is on Alts, Not Majors
- **ADA**: +60.22R (PF 4.54, Sharpe 1.99)
- **AAVE**: +37.05R (PF 3.47, Sharpe 1.61)
- **SOL**: +32.32R (PF 3.02, Sharpe 1.32)
- **BTC**: -3.12R (negative — market too efficient)
- **BNB**: -26.00R (negative — low ATR, no ICR patterns)
- **ETH**: -4.03R (negative)
- **Rule**: ICR is a volatility-arbitrage strategy. Needs 2-4%+ 4h ATR to trigger impulse gates frequently enough. Majors are 1-2% — too tight.

### Direction Split (Bear Market Context)
- Short signals: 486 outcomes, +204.98R
- Long signals: 169 outcomes, -84.65R
- The engine caught the June 2026 selloff perfectly on shorts. Longs need a bull market to validate.
- **Next enhancement**: Regime/trend filter for direction bias (not implemented, not a blocker).

### Exit Engine: The Tail is Sacred

**CRITICAL FINDING**: On a low-win-rate fat-tailed system like ICR on alts (~19% win rate, avg win ~+8R, max +24R):

| Exit Strategy | TotalR | Sharpe | MaxWin |
|--------------|--------|--------|--------|
| Naive (fixed stop + window close) | +265.9R | 3.32 | 24.4R |
| Fib scale-outs + tight trail + HA flip | -117R | NEGATIVE | CAPPED |
| Wide trail (5ATR, arm@+4R, NO early BE) | +274.8R | 3.47 | 23.4R |

**EVERYTHING that touches the exit caps the tail. The pure runner with wide trail wins.**

- **DO NOT** add early breakeven stops (breakevenAtR=2.0 gave -48% vs naive)
- **DO NOT** add partial scale-outs (20% partial dropped MaxWin 24.4R → 19.4R)
- **DO NOT** add HTF regime exits (HA flip dropped totalR)
- **DO** add exhaustion detection (used at threshold 0.7, only at extremes)
- **DO** keep the wide ratchet trail (5ATR, activate at +4R, never tighten)

### RSI Entry Filter (Proven Gain)

`entryRsiMax:70` / `entryRsiMin:30` raised TotalR 274.8 → 292.7 (+6.5%), Sharpe 3.47 → 3.79:
- Before: 326 trades, WR 20.9%, avgR 0.84, TotalR 274.8, Sharpe 3.47
- After:  273 trades, WR 22.7%, avgR 1.07, TotalR 292.7, Sharpe 3.79
- **Mechanism**: Filters out trades chasing already-extended moves. More trades reach the tail, fewer hit the stop.
- Tighter thresholds (65/35, 60/40) raise WR further but shed too many trades → total R falls.

### Money Flow Direction Filter (Historical-Sweep Candidate, Opt-In — Not a Release Gate)

**Historical replay test** (`scripts/icr-wavetrend-experiment.ts`, 49-pair /
120-day corpus, 4h+1h, chronological 60/40 split, `simulateSmartExit`
untouched) — same historical-sweep methodology as the RSI filter above, and
subject to the same disclaimer at the top of this file: this is NOT
out-of-sample validation and NOT a release gate on its own. A Market Cipher B
Money-Flow oscillator was ported from `scripts/ml/pipeline/features.py` to
`src/server/analysis/indicators.ts::moneyFlow`. Probed against 113 baseline
ICR signals first: 98.6% of shorts already had `moneyFlow < 0`, 76.7% of longs
already had `moneyFlow >= 0` — direction and money flow already agree most of
the time. A single-bar confirmation gate (`enableMoneyFlowFilter`, opt-in,
`IcrConfig`) rejects the minority where they disagree:

| Split | Metric | Baseline | +MoneyFlow filter |
|---|---|---|---|
| Validation | Trades | 369 | 296 (-19.8%) |
| Validation | Win Rate | 48.2% | 49.0% |
| Validation | Profit Factor | 1.71 | 1.75 |
| Validation | Sharpe | 3.68 | 3.82 |
| Validation | Max Drawdown | 44.8% | 24.5% |
| Walk-forward | | PASS | PASS |

Directionally interesting (drawdown nearly halved on this corpus while
PF/Sharpe held flat-to-better, walk-forward passes both sides) but this is one
run on one historical corpus — the exact failure mode this file's release-status
banner warns about. **Not enabled in `DEFAULT_ICR_CONFIG`.** Before any
consideration of enabling it: run against the live paper lane's
`findLatestSignals` path (per-candle, not historical replay) for the same
predeclared window the release-status section requires, with fees/slippage/
drawdown documented, same as any other release-gate candidate.

### WaveTrend Extreme Filter (Two Variants, Both Rejected)

Same experiment also ported `waveTrend` (Market Cipher B) and tried it as an
entry-timing filter two ways — both **eliminated 100% of validation trades**
(walk-forward FAIL) on the same historical corpus, verified as a real
structural mismatch, not a bug:

- **Strict** (`enableWaveTrendExtremeFilter`): wt1 at or beyond ±60 within the
  last 5 candles, then turning back toward zero. 0/49 pairs produced a signal.
- **Simple** (`enableWaveTrendSimpleFilter`): current-candle wt1 beyond ±40,
  no lookback. Also 0/49 pairs.

Root cause, confirmed by direct inspection of wt1 at the candles where ICR
*does* already accept a signal: 0/15 sampled long signals had wt1 <= -40, and
0/34 sampled short signals had wt1 >= +40 — WaveTrend is essentially never at
an extreme when ICR's other 7 gates (impulse → pullback → compression →
trigger) all align. **DO NOT** gate ICR entries on a reversal-timing
oscillator: ICR is a continuation-pattern engine (enters after an impulse has
already started resolving through a pullback), and WaveTrend-extreme measures
the opposite thing — the initial reversal point, before ICR's structural
gates would ever fire. The two entry philosophies are close to mutually
exclusive on this engine. Both fields exist in `IcrConfig`, both are opt-in,
neither is in `DEFAULT_ICR_CONFIG`, and neither should be enabled without a
fundamentally different (reversal-based, not continuation-based) signal
source built alongside them.

### Stochastic RSI (Ported, Not Yet Tested As a Filter)

`stochRsi` was also ported (`src/server/analysis/indicators.ts`) and wired
into `EnrichedCandle.stochRsiK`/`stochRsiD`, but no filter variant has been
built or tested yet. Initial probe (113 baseline signals): longs cluster
p10=32/p50=61/p90=93, shorts p10=9/p50=26/p90=62 — much broader spread than
Money Flow's clean sign-alignment, no obvious single-bar threshold. Left as
an open item, not a finding either way.

## Locked-gate FAIL post-mortem: volatility-compression is the only real signal in the 21-feature set (2026-07-19/20)

Follow-up analysis of `8510997`'s FAILED locked walk-forward run
(`scripts/data/models/locked-gate-2026-07-18/candidates.jsonl`, 442,435
candidates — this file is 484MB and was never pushed; do not re-add it to
git, regenerate locally from the run script if needed). The gate's own
verdict was "0 qualified trades, calibrated probs cap at 0.243 vs 0.52
threshold" — technically correct but incomplete: the model has a small, real,
reproducible signal, it's just nowhere near strong enough alone.

**The model isn't blind, just badly calibrated.** Actual winners score
consistently higher raw probability than losers, in BOTH independent
partitions (not a fluke):

| | n | mean prob | median prob |
|---|---|---|---|
| validation wins | 12,433 | 0.1956 | 0.2038 |
| validation losses | 53,214 | 0.1879 | 0.1855 |
| test wins | 12,676 | 0.1957 | 0.2038 |
| test losses | 54,106 | 0.1880 | 0.1855 |

**Univariate feature diagnosis** (Cohen's d, wins vs losses, validation+test
combined, n=132,429): of all 21 features, only two have any real separation,
both volatility-compression measures — everything else (RSI, MACD, AO, trend,
Money Flow "m7s", all three timeframes) is d < 0.05, indistinguishable:

| feature | win mean | loss mean | Cohen's d |
|---|---|---|---|
| `m15_atr_pct` | 0.437 | 0.506 | **-0.26** |
| `m15_bb_w` | 1.869 | 2.188 | **-0.22** |
| `h1_bb_w` | 4.098 | 4.313 | -0.08 |
| all others | — | — | < 0.05 |

**Joint effect is much stronger than either feature alone.** Quartile-bucketing
both `m15_atr_pct` and `m15_bb_w` together and reading win rate per cell
(n=132,429, both extreme corners are large-sample, not noise):

- Both lowest quartile (tightest 15m range): **23.4%** win rate (n=21,862)
- Both highest quartile (widest 15m range): **12.5%** win rate (n=22,342)
- Overall baseline: 19.0%

That's a ~1.9x relative win-rate swing from a single joint volatility-regime
split — bigger than anything the 21-feature classifier ever found on its own.
**Actionable**: a simple rule-based pre-filter (skip entries when 15m ATR% and
15m BB width are both in the top quartile) is worth backtesting as a
standalone gate before touching the ML feature set again. This also directly
supports the run's own conclusion — reclassify as a label/feature-definition
problem, not a training problem — since the one thing that clearly matters
(volatility regime) isn't encoded as a first-class gate anywhere in the
current pipeline, it's buried as one of 21 roughly-equal-weighted inputs to a
classifier that can't tell it apart from noise features.

**No symbol-concentration artifact**: win rate across all 49 symbols sits in
a tight 13.7%–23.5% band around the 19.0% overall average (checked to rule
out one broken/mislabeled pair explaining the pattern) — the compression
effect is general, not a single-asset data issue.

25,109 raw false-negative records (actual win, `partition` validation/test,
never cleared 0.52) extracted to `/tmp/candidates-analysis/false-negatives.jsonl`
for further inspection — not committed (ephemeral, regenerate from the source
JSONL if needed).

## What To Do Next (Future Builder Agents)

### Short-term (before live dispatch):
1. **Deploy to staging**: `wrangler deploy`, test with `POST /api/analysis/run`
2. **Run 2-week paper trade**: `POST /api/paper-trade/run` every 5 min via cron
3. **Fix LogoBar.tsx**: Pre-existing TS error in `src/components/home/sections/LogoBar.tsx(14,46)`
4. **Set production secrets**: `wrangler secret put ADMIN_API_KEY`, `ENCRYPTION_KEY`, `JWT_SECRET`

### Medium-term:
5. **BitUniX adapter**: Schema already has `cex_connections` with `exchange="bitunix"`. Just needs the exchange client implementation in `src/server/cex/` following the Binance pattern.
6. **Static egress IP**: Documented in CLAUDE.md — needed for exchange API-key IP whitelisting. Route order signing through a dedicated service with static IP.
7. **Regime filter**: Add a bull/bear regime indicator (e.g., MA200 slope, ATR trend) to bias direction. Engine currently trades long and short equally — a regime filter would avoid fighting the trend.

### Long-term:
8. **Live outcome feedback**: Feed actual trade outcomes back into ICR scoring weights. If MACD on 4h consistently fails to profit on SEI, downweight it. Self-improving model.
9. **Multi-exchange**: BitUniX, Bybit, OKX adapter implementations.
10. **Derivatives alpha live-only**: Binance historical OI/funding data only goes back 30 days. Live-only entry conviction signal. Cannot be backtested on 6-month window. Documented for future calibration.

## Files a Future Agent Must Read Before Changing Anything

1. `src/server/analysis/icr/config.ts` — All tunable parameters live here
2. `docs/analysis/EMPIRICAL_FINDINGS.md` (this file) — Why each parameter is what it is
3. `src/server/analysis/icr/signals.ts` — The 7-gate pipeline + RSI filter
4. `src/server/analysis/exits/exit-engine.ts` — Smart exit simulation (don't add early BE!)
5. `docs/analysis/ARCHITECTURE.md` — Full file tree and pipeline
6. `docs/analysis/API.md` — All API routes and how they're called
7. `semantic-memory.md` in Obsidian vault — All decisions and empirical results

## Volatility-compression filter: win rate improves, R-expectancy gets worse (2026-07-20)

Follow-up on the "Locked-gate FAIL post-mortem" section above's actionable
item ("a simple rule-based pre-filter... is worth backtesting as a
standalone gate"). Tested honestly: quartile thresholds for `m15_atr_pct`
and `m15_bb_w` derived from the **train** partition only
(`m15_atr_pct <= 0.310`, `m15_bb_w <= 1.113`), then applied to validation
and test partitions, evaluated on real `netR` (fee/funding-inclusive)
economics, not win rate alone.

| Partition | Unfiltered | Filtered (both features bottom quartile) |
|---|---|---|
| Validation (n=65,647 / 7,755) | WR 18.9%, expectancy -0.257R, PF 0.64 | WR 22.8%, expectancy -0.328R, PF 0.61 |
| Test, evaluated once (n=66,782 / 12,311) | WR 19.0%, expectancy -0.299R, PF 0.60 | WR 24.0%, expectancy **-0.407R**, PF 0.57 |

**Correction to the prior note**: the win-rate improvement (19%→24%) is real
and reproduces on held-out test, but it does NOT translate to better
expectancy — average win size shrinks enough in the low-volatility regime to
make net economics worse, not better. Win rate was the wrong metric to
judge this filter by. **Not actionable as a standalone gate.** (Caveat: this
entire corpus is the failed locked-gate's candidate set — every row here is
already below the model's qualifying threshold, so the unfiltered baseline
itself is negative; this result is about whether the compression filter
improves or worsens that baseline, not about absolute profitability.)
