<!-- DEPRECATED: Historical audit record from the initial ICR strategy research phase (2026-07-08).
     The active ML pipeline (scripts/ml/pipeline/) supersedes this rule-based approach. -->
# ICR Strategy — Comprehensive Quant Audit

**Date**: 2026-07-08
**Source**: ivantradesofficial (YouTube) — v7 "Real Edge" handoff
**Strategy**: Impulse Compression Reclaim (ICR) + HTF Coiling Pump + Coinlegs Fusion
**Target**: Binance altcoin USDT pairs, 4h/1d, long-biased

---

## Executive Summary

The ICR strategy is a **well-structured, well-documented research scaffold with strong safety guardrails**. The code quality is above average for retail quant research, with clean immutability patterns, proper next-candle execution, conservative stop-first intrabar handling, and explicit no-live-trading guards.

However, the strategy **does not have proven edge**, and the current methodology **cannot reliably distinguish between real alpha and overfitting**. The core problems are:

1. **Severe overfitting risk**: ~125 tunable parameters against an expected 100-300 trades
2. **No overfitting controls**: No deflated Sharpe ratio, PBO, or multiple-testing correction
3. **Most audit questions are hardcoded**: 147/200 audit questions answered by static claims, not runtime verification
4. **Coinlegs temporal misalignment**: Snapshot data from 2026 applied to 2023-2024 candles (lookahead bias)

**Verdict**: Continue research. Do not trade live. Fix the statistical framework before attempting edge validation.

---

## 1. Strategy Architecture Review

### 1.1 Signal Pipeline

```
Trend Gate → Impulse Detection → Pullback Validation → Compression Detection → Trigger Confirmation → Composite Score → RR Gate
                                                                                      ↑
                                                              ICT ± Div ± MTF ± Coinlegs ± Coil Bonus
```

**Assessment**: The pipeline logic is sound. Each gate is strictly sequential (fail one, signal rejected). The additive scoring model, however, conflates correlated information sources (see §6.2).

### 1.2 Key Parameters (StrategyConfig)

| Parameter | Default | Justification |
|-----------|---------|---------------|
| fast_ma (7) | 7 | Standard short-term MA |
| mid_ma (25) | 25 | ~1 month of daily bars |
| slow_ma (99) | 99 | ~4 months of daily bars |
| score_threshold | 75 | **Arbitrary round number** |
| min_rr | 2.5 | Standard for trend following |
| move_to_be_after_r | 1.5 | **Arbitrary** |
| stop_atr_buffer | 0.10 | Reasonable |
| tp1/tp2/runner fractions | 40/30/30 | Standard partial exit ladder |
| impulse_atr_mult | 1.5 | Aggressive — favors clean impulses |
| compression_range_ratio | 0.92 | Tight — requires significant contraction |

### 1.3 HTF Coil Score Components

The 11-factor coil score is the most sophisticated part of the system:

| Component | Weight | What it measures |
|-----------|--------|-----------------|
| Range contraction | 16% | Recent range vs. long-term median |
| ATR contraction | 14% | Current ATR percentile rank |
| BB squeeze | 14% | Bollinger bandwidth percentile rank |
| Volume dry-up | 12% | Recent volume vs. long-term median |
| Higher lows | 12% | Rising lows during compression |
| High pressure | 8% | Flat/capped highs |
| MA context | 10% | MA7/MA25/MA99 alignment quality |
| MA squeeze | 5% | MA7-MA25 convergence |
| Near MA25 | 4% | Proximity to MA25 |
| Liquidity overhead | 3% | Distance to prior liquidity high |
| Reclaim readiness | 2% | How close price is to reclaiming compression high |

**Assessment**: This is well-designed in concept. The weights (0.16/0.14/0.14/0.12/...) sum to 1.0 and are intuitively reasonable. The liquidity overhead formula uses a specific distance range (1-22% from prior high) which appears derived from empirical observation rather than optimization.

### 1.4 Order of Operations Verified

The backtester (`_resolve_trade`) evaluates events in this order per candle:
1. Stop hit → close immediately (conservative)
2. TP1 hit → close 40%
3. TP2 hit → close 30%
4. TP3 hit → close remainder
5. After candle close: upgrade stop (breakeven, MA25 trail)

This is correct and conservative. No intrabar path hallucination.

---

## 2. Lookahead Bias Audit

### 2.1 PASS — Core Indicators

All SMA, EMA, ATR, RSI, Bollinger, z-score, volume MA, MA slope calculations use trailing windows only (`rolling()`, `ewm()`, `shift(n)` with n>0). No forward-looking leaks.

### 2.2 PASS — Signal Generation

- Entry occurs at `signal.index`, resolved starting at `signal.index + 1` (next candle)
- Impulse search ends at `i - min_pullback_bars` before the trigger candle
- Compression detection uses `i-1` as the last bar, looking backward

### 2.3 PASS — ICT Layer

- FVG search: backward-only scan from `i-1` through `i - fvg_max_age`
- Order block search: uses bars before `impulse.start` only
- Liquidity sweep: uses prior `sweep_lookback` bars + current trigger candle (valid — sweep is confirmed by current candle's wick + close)

### 2.4 PASS — MTF Layer

- Resample uses `df.loc[:i]` — only data up to and including the signal bar
- Timestamp filter: `higher["timestamp"] <= base_time` — prevents future HTF candle leaks

### 2.5 ⚠️ CRITICAL — Centered Fractal Pivots

`indicators.py` lines 79-80:
```python
out["pivot_high"] = out["high"].eq(out["high"].rolling(2*span+1, center=True).max())
out["pivot_low"] = out["low"].eq(out["low"].rolling(2*span+1, center=True).min())
```

The `center=True` means each row's pivot value uses `span` future bars. The divergence consumer (`_confirmed_pivots`) mitigates this by excluding the trailing span, **but the column itself is contaminated**. Any future code that reads `pivot_high`/`pivot_low` without the span guard will silently incorporate future data.

**Fix**: Either (a) use `center=False` with a lag, or (b) rename the columns to `pivot_high_centered`/`pivot_low_centered` and add a `WARNING` docstring.

### 2.6 ⚠️ CRITICAL — Coinlegs Temporal Misalignment

`attach_coinlegs_to_markets` (coinlegs_fusion.py) joins Coinlegs snapshot data to historical candle DataFrames by symbol only, with **no temporal alignment**. A Coinlegs snapshot taken on 2026-07-08 (with current OI, funding, long/short ratios) is applied to every candle from 2024-01 onward. This means:

- **2024 candles are scored using 2026 market structure data** — textbook lookahead bias
- Funding rates, OI levels, and long/short ratios from 2026 tell you nothing about whether a 2024 setup had institutional accumulation
- The Coinlegs alpha score boost/penalty on historical signals is **invalid**

**Fix**: Coinlegs snapshots must be timestamped and aligned to their nearest candle close. Historical Coinlegs data is required for historical backtesting. Without historical derivatives data, Coinlegs confluence should only be applied to forward/live scanning.

---

## 3. Overfitting Assessment

### 3.1 Parameter Count

| Category | Count | Examples |
|----------|-------|----------|
| StrategyConfig continuous params | 47 | MAs, ATR, thresholds, fractions, lookbacks |
| StrategyConfig boolean flags | 9 | enable_ict, enable_divergence, etc. |
| BacktestConfig params | 8 | equity, risk%, limits, fees, slippage |
| CoilConfig params | 10+ | threshold, lookback, scoring weights |
| ICT hardcoded scoring | 6 | FVG=3, OB=3, OTE=4, sweep=3, killzone=2, cap=10 |
| Divergence hardcoded scoring | 4 | hidden=5, regular=4, tag=2, cap=7 |
| Coinlegs fusion weights | 5 | 0.32, 0.22, 0.18, 0.16, 0.12 |
| Coinlegs thresholds | 14+ | Alpha bins, delta scores, funding/crowding boundaries |
| Signal scoring weights | 11 | trend, impulse, pullback, compression, trigger, volume, rr, ict, div, mtf, coinlegs |
| Hardcoded magic numbers | 15+ | pivot_span=2, various caps, quality bins, regime thresholds |
| **TOTAL** | **~125** | |

### 3.2 Sample Size vs. Degrees of Freedom

The quick test produced 2 trades from 3 symbols × 3 months. Extrapolating:
- 70 symbols × 30 months ≈ 140-280 trades (rough estimate)
- **125 parameters vs. ~200 trades = 1.6 trades per parameter**

The minimum quant finance standard is **20-30 trades per degree of freedom**. We need 2,500-3,750 trades for proper validation. Even optimistically, we're off by 10-20x.

### 3.3 Unjustified Thresholds

| Threshold | Value | Issue |
|-----------|-------|-------|
| `score_threshold` | 75 | Round number, no empirical basis |
| `min_coil_score` | 72 | Why 72 and not 70 or 75? |
| `move_to_be_after_r` | 1.5 | Why not 1.0, 2.0, or ATR-based? |
| `compression_range_ratio` | 0.92 | Very tight — how sensitive is this? |
| Coinlegs alpha weights | 0.32/0.22/0.18/0.16/0.12 | Sum to 1.0 — chosen for convenience, not derived |

### 3.4 Missing Overfitting Controls

- **No Deflated Sharpe Ratio (DSR)**: Standard metric to account for multiple testing
- **No Probability of Backtest Overfitting (PBO)**: Standard metric from Bailey et al. (2014)
- **No Haircut Sharpe**: Penalized Sharpe accounting for parameter uncertainty
- **No Minimum Backtest Length (MBL)**: How many trades needed for statistical significance?
- **No multiple-testing correction**: 200 audit questions, 8 ablation scenarios, 4 stress scenarios — no Bonferroni, Holm, or Benjamini-Hochberg
- **Single 60/40 walk-forward split**: No anchored windows, no purge, no multiple folds

---

## 4. Statistical Rigor

### 4.1 Edge Decision Framework

The `make_edge_decision` function uses a gate-based checklist:

```python
if hard_fails: → UNPROVEN
if trades < 100: → UNPROVEN
if coil_events < 100: → UNPROVEN
if expectancy <= 0: → UNPROVEN
if pump_rate < 0.55: → UNPROVEN
if walk_forward_exp <= 0: → UNPROVEN
else: → EDGE_CANDIDATE
```

**Problem**: A strategy with `trades=101`, `expectancy=0.001`, `pump_rate=0.551`, `walk_forward_exp=0.0001` passes ALL gates and is declared "EDGE_CANDIDATE" despite having **economically meaningless edge**. This is a checklist, not a statistical test.

### 4.2 Bootstrap CI

The bootstrap implementation (audit.py) uses 1,000 resamples with a fixed seed of 13. Adequate for a quick check, but:
- 10,000 resamples is standard for production
- Fixed seed = 13 is arbitrary
- Bootstrap CI is computed but never used in the edge decision

### 4.3 T-Statistic

The t-test assumes normally distributed R-values. Trading returns are fat-tailed and skewed. A non-parametric test (Wilcoxon signed-rank) would be more appropriate.

### 4.4 Score Monotonicity

Score bucket analysis exists but is purely descriptive (mean/mean/mean per bucket). No:
- Spearman rank correlation
- Jonckheere-Terpstra trend test
- Confidence interval on the slope
- Permutation test for score informativeness

---

## 5. Risk Model Review

### 5.1 Position Sizing ✅

Standard fixed-fractional: `risk_amount = equity × 0.01`, `size = risk_amount / stop_distance`. Correctly uses slipped entry price for sizing.

### 5.2 Daily Loss Breaker ⚠️

Uses **realized** PnL only — open positions are not counted toward the daily limit. If 3 positions are all underwater but haven't hit stops, the breaker won't fire until they close. In a portfolio crash scenario, realized losses can exceed the limit significantly.

### 5.3 Correlation Clusters ⚠️

`risk_cluster()` buckets all crypto into one `crypto_beta` cluster. BTC and SOL/USDT and PEPE/USDT all share the same cluster. In reality, altcoin correlations vary widely (0.3-0.9 with BTC). The cluster scheme prevents opening >2 positions in all of crypto simultaneously, which is simultaneously too conservative (it limits diversification across uncorrelated alts) and not conservative enough (it doesn't recognize when 3 positions are all in high-beta meme coins).

### 5.4 Stress Tests ⚠️

Current stress: fee=10bps, slippage=8bps. For crypto altcoins:
- Spot taker fee: 10bps (Binance), up to 20-60bps on smaller exchanges
- Realistic slippage on mid-cap alts: 10-50bps
- Combined worst case: 70-110bps
- **Current stress tests do not approach tail-risk levels**

### 5.5 No Unrealized Risk Tracking ⚠️

The portfolio backtester only accounts for realized PnL. There is no mark-to-market equity curve, no unrealized drawdown tracking, and no maximum adverse excursion (MAE) monitoring for open positions.

---

## 6. Confluence Layer Analysis

### 6.1 ICT Layer: Redundancy with Base ICR

| ICT Concept | ICR Equivalent | Correlation |
|-------------|----------------|-------------|
| OTE 62-79% retracement | Pullback from impulse extreme | **High** — both measure retracement depth |
| FVG proximity | Close-to-MA proximity | **Moderate** |
| Order block near impulse | Impulse origin | **High** — OB is searched near impulse start |
| Liquidity sweep | Prior low break + reclaim | Independent |
| NY killzone bonus | — | Independent (time-based) |

**Finding**: ICT OTE and order block proximity are largely redundant with the base ICR pullback and impulse detection. The ICT layer adds ~3-10 points to signals that already pass the base gate, inflating scores without adding independent information.

### 6.2 Divergence Layer: Contextual but Not Independent

RSI divergence during pullback is expected by construction — a deeper pullback creates a lower RSI reading. Hidden bullish divergence (lower RSI low + higher price low) is genuinely informative, but regular bullish divergence during a clearly trending market is common and not discriminating.

### 6.3 MTF Layer: Useful but Data-Hungry

MTF resampling requires sufficient lower-timeframe data. On 4h candles with 15m/1h resampling, this works well. On 1d candles, MTF adds little (15m resampled from daily is noisy). The MTF bonus/penalty is symmetric (±8), which is defensible.

### 6.4 Coinlegs Fusion: Theoretically Sound, Practically Broken

The concept is excellent: derivatives flow (OI, volume, funding, long/short, liquidations) provides genuinely independent information from price action. However:
- **Temporal misalignment** makes historical backtest application invalid
- **Hard thresholds** (leverage >35% → score drops to 45) create discontinuities
- **Liquidation normalization** (`liq_sum / max(volume, OI, 1.0)`) is non-standard
- Forward/live application is valid; historical backtesting with Coinlegs is not

---

## 7. Audit Module Critique

### 7.1 The 200 Questions: Substance vs. Theatre

Of the 200 audit questions:
- **~53 compute actual metrics from data** (data integrity, trade stats, bootstrap CI, stress results)
- **~147 are hardcoded claims** (always PASS or always N/A)

Examples of hardcoded assertions:
- `rolling_features_causal: True` — claimed, never verified by code inspection
- `fvg_past_only: True` — claimed, never verified
- `divergence_confirmed_only: True` — claimed, never verified
- `ict_cap_present: True` — true but meaningless as a test

### 7.2 Non-Exhaustive Mode Produces Fabricated Results

In non-exhaustive mode, all ablation scenarios (base_only, no_ict, no_divergence, etc.) reuse the same baseline numbers with different labels. The ablation report will show identical trade counts and expectancy across all scenarios, giving the illusion of robustness. This is documented in the code but the output file gives no indication that results are fabricated.

### 7.3 Walk-Forward: Minimum Viable

Single 60/40 split, no purge, no multiple windows. Bar requirements (120 train, 60 test) are too low. Calendar-year splits in `real_edge.walk_forward_by_year` are better but still process each year independently.

---

## 8. Data Integrity

### 8.1 Survivorship Bias

The default symbol list contains only currently-traded coins. Coins delisted during the backtest period (2024-2026) are absent. This creates classic survivorship bias — the backtest only sees coins that survived.

### 8.2 Volume Source Confusion

Spot volume and perpetual futures volume are treated identically. The strategy config has no distinction. Coinlegs provides perp OI/volume/liquidation data, while Binance CSVs are spot data.

### 8.3 Synthetic Data

The sample data generator builds in a known ICR setup (impulse at bar 120, pullback/compression, reclaim). Volume is artificially scaled up 2.2x during impulse and down 0.75x during compression. The strategy WILL find a signal on this data. This is fine for integration testing but worthless for edge validation.

---

## 9. Quick Test Results (3 symbols × 3 months, 4h)

### 9.1 Backtest Summary

| Metric | Value |
|--------|-------|
| Symbols | SOL, AVAX, SUI (large caps) |
| Period | Apr-Jun 2026 |
| Total trades | 2 |
| Win rate | 0% |
| Net R | -2.03 |
| Expectancy R | -1.02 |
| Avg win | N/A |
| Avg loss | -1.02R |
| Max drawdown | 101.45 USD (1.01%) |
| Skipped signals | 1 |

Both trades were stopped out:
1. **SOL/USDT**: Entry 93.64, stop 87.44. Both TP and stop hit same candle (bar 271). Per stop-first policy → stopped at -1.01R.
2. **AVAX/USDT**: Entry 10.41, stop 9.78. Stopped out at -1.02R.

### 9.2 Coil Event Study

| Bucket | Events | Pump Rate (≥12% MFE) | Avg MFE | Avg MAE |
|--------|--------|---------------------|---------|---------|
| 55-60 | 35 | 5.7% | 3.43% | -9.04% |
| 60-65 | 27 | 0% | 4.09% | -6.59% |
| 65-70 | 20 | 0% | 7.05% | -2.24% |
| 70-75 | 2 | 0% | 9.17% | -1.90% |

**Key finding**: Score monotonicity holds — higher coil scores → higher avg MFE and lower avg MAE. But the default pump threshold (12%) is too high for this market regime. At 8%, the threshold=70 bucket shows 100% pump rate (but only 2 events). At 8%, the 65-70 bucket shows 36.4% pump rate with 22 events — much more useful.

### 9.3 Threshold Sweep

The best threshold combinations from the sweep:
- **Coil ≥70, Pump ≥8%**: 2 events, 100% pump rate, edge ratio 4.83 (MFE/MAE)
- **Coil ≥65, Pump ≥8%**: 22 events, 36.4% pump rate, edge ratio 3.28
- **Coil ≥60, Pump ≥8%**: 49 events, 22.4% pump rate, edge ratio 1.19

---

## 10. Overall Verdict

### Strengths
- Well-structured, clean, immutable code
- Strong safety guardrails (no live trading, conservative fills, explicit warnings)
- Multi-layered confluence approach is intellectually sound
- HTF coil score is genuinely well-designed
- Good test coverage (33 tests, all passing)
- Proper next-candle execution with conservative stop-first intrabar policy

### Fatal Flaws
1. **Severe overfitting**: ~125 params vs. expected 100-300 trades
2. **No overfitting controls**: No DSR, PBO, or multiple-testing correction
3. **Coinlegs temporal misalignment**: Lookahead bias in historical backtests
4. **Fabricated audit results**: Non-exhaustive mode reuses baseline data across ablations
5. **Checklist-based edge decision**: No statistical framework, passes with economically meaningless edge
6. **Centered fractal pivots**: Latent lookahead risk for future code/modules

### What Would Be Required to Prove Edge

1. **Fix the parameter problem**: Either (a) reduce to 15-20 truly independent parameters through PCA/factor analysis of the scoring components, or (b) collect 3,000+ trades across multiple years/symbols
2. **Add DSR/PBO**: Compute deflated Sharpe ratio and probability of backtest overfitting
3. **Add multiple-testing correction**: Bonferroni or Holm-Bonferroni across all hypothesis tests
4. **Fix Coinlegs temporal alignment**: Only apply Coinlegs confluence to forward/live scanning; remove it from historical backtests unless historical derivatives data is available
5. **Fix centered pivots**: Use lagged pivots or rename + warn
6. **Upgrade walk-forward**: Multi-window anchored walk-forward with purge between train/test
7. **Add unrealized risk tracking**: Mark-to-market equity curve and unrealized drawdown
8. **Harden stress tests**: Test at 30bps fee + 25bps slippage + 50bps combined
9. **Fix audit non-exhaustive mode**: Don't fabricate results — output N/A or run real ablations
10. **Add statistical edge decision**: Replace checklist with joint hypothesis test + confidence intervals

### Recommended Actions

| Priority | Action | Effort |
|----------|--------|--------|
| P0 | Fix centered fractal pivots (prevent future lookahead) | 1 hour |
| P0 | Disable Coinlegs in historical backtests (temporal bias) | 1 hour |
| P0 | Add DSR and PBO computation | 1 day |
| P1 | Reduce parameter count (PCA on scoring components) | 2-3 days |
| P1 | Add multiple-testing correction | 1 day |
| P1 | Upgrade walk-forward to multi-window anchored | 1-2 days |
| P1 | Fix non-exhaustive audit to not fabricate results | 2 hours |
| P2 | Add unrealized risk tracking | 1 day |
| P2 | Harden stress tests | 2 hours |
| P2 | Add proper score monotonicity tests | 4 hours |
| P3 | Add deflated Sharpe ratio | 4 hours |
| P3 | Add non-parametric statistical tests | 1 day |

**Bottom Line**: This is one of the better retail quant research repos I've seen — but it's a research scaffold, not a proven strategy. It needs significant statistical rigor upgrades before edge can be reliably claimed. Do not trade live.
