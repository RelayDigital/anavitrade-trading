# RR-First Trading Engine — Multi-Stage PRD

**Date:** 2026-07-15
**Status:** DRAFT
**Author:** Claude Opus 4.8 + Ariel

## Problem Statement

The current ICR engine has three structural weaknesses:

1. **Circular backtesting** — The backtest corpus (`backtest-prioritized.json`, 1,265 trades) is sourced from
   Coinlegs signals, which already embed positive expectancy. Backtesting a scoring function against
   pre-filtered signals tells us nothing about real edge on raw OHLCV.

2. **Catastrophic max drawdown** — 55.6% max DD from RR-First Sniper v3, 62.1% from RR>=1.5. These
   are account-killing numbers. The current simulator uses simplistic `0.05 / stopPct` position sizing
   with no correlation awareness, no volatility targeting, no drawdown circuit breaker.

3. **No production colocation** — The analysis engine runs in a Cloudflare Worker. For live trading with
   a neural network scoring engine, sub-100ms latency, and proper risk management, we need a dedicated
   execution service with static egress IP.

## Architecture Vision

```
┌─────────────────────────────────────────────────────────────────────┐
│                        STAGE 1: RAW BACKTEST                         │
│  Pine Script strategy() on TradingView → 50+ pairs × 6 months 4h   │
│  Strategy Tester metrics: WR, PF, Sharpe, MaxDD, AvgBars, UPI       │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     STAGE 2: RR-FIRST ALGO ENGINE                    │
│  Pine Script v4.0 with: RR-first gates, multi-TF confluence,        │
│  volatility-scaled sizing, max-DD circuit breaker, correlation cap  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    STAGE 3: NN SCORING ENGINE                        │
│  Opus-powered feature engineering → LightGBM/CatBoost → ONNX        │
│  Deployed as Cloudflare Worker AI or dedicated GPU instance         │
│  Inputs: enriched candles, ICR gate scores, derivatives alpha        │
│  Output: trade probability (0-1), expected R, confidence interval   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   STAGE 4: PRODUCTION COLOCATION                     │
│  Dedicated execution server (VPS/edge), static IP, Redis order lock │
│  Aster DEX + CEX unified, kill switches, telemetry, 24/7 monitoring │
└─────────────────────────────────────────────────────────────────────┘
```

---

## STAGE 1: RAW TRADINGVIEW BACKTEST

### Objective
Replace the Coinlegs-signal backtest loop with raw Pine Script `strategy()` backtests on
TradingView's native Strategy Tester against unfiltered OHLCV data.

### Deliverables

#### 1.1 Multi-Pair Backtest Pine Script (`rr-first-backtest-v4.pine`)
- Self-contained `strategy()` script that runs on ANY symbol/timeframe
- Implements the RR-first logic as entry conditions derived from price action:
  - Trend: MA7 > MA25 > MA99 alignment (not Coinlegs "indicator" field)
  - Impulse: ATR expansion + volume spike + structure break (real detection, not proxy)
  - Pullback: Retracement to MA25 with volume contraction
  - Compression: Range/ATR squeeze near MA25
  - Trigger: Break of compression boundary on volume
  - RR gate: Stop based on compression low/high, TP based on impulse extreme
- Exit: Wide ratchet trail (5 ATR, arm at +4R) with exhaustion detection
- Configurable: RR threshold, timeframe, indicator filters, ATR multipliers

#### 1.2 TradingView MCP Automation Script
```javascript
// scripts/tv-backtest-runner.mjs
// Uses tradingview-mcp to:
// 1. Launch TradingView with CDP
// 2. Inject the Pine Script
// 3. For each symbol in watchlist (50+ pairs on 4h):
//    a. chart_set_symbol(symbol)
//    b. Wait for Strategy Tester to compute
//    c. capture_screenshot of Strategy Tester tab
//    d. Extract metrics: Net Profit, WR%, PF, Sharpe, MaxDD, Avg # Bars
// 4. Aggregate results into backtest-report.json
```

#### 1.3 Target Symbols (50+ alts, 4h timeframe)
```
High ATR alts (2%+ 4h ATR): AVAX, SOL, AAVE, SEI, SUI, NEAR, APT, ARB,
  OP, TIA, DYDX, INJ, RUNE, FTM, EGLD, FLOW, MINA, ROSE, IMX, STX,
  CFX, MASK, BLUR, PEPE, WIF, BONK, DOGE, SHIB, ORDI, SATS,
  LDO, RNDR, FET, AGIX, OCEAN, WLD, AKT, RAY, JTO, JUP,
  PYTH, BOME, ENA, EIGEN, STRK, ZK, ZRO, ALT, MANTA, METIS
```

#### 1.4 Acceptance Criteria
- [ ] Pine Script compiles on TradingView with zero errors
- [ ] Backtest completes on 50+ symbols on 4h (6 months minimum)
- [ ] Aggregate metrics: WR > 60%, PF > 2.0, Sharpe > 5.0
- [ ] Per-symbol max DD < 5% (single position) / < 15% (portfolio)
- [ ] Strategy Tester "Overview" tab captured for every symbol
- [ ] Results saved to `scripts/tv-backtest-results/` as JSON + screenshots

---

## STAGE 2: RR-FIRST ALGO v4.0 (Pine Script Production)

### Objective
Evolve the Pine Script from backtest to production-ready with:
- Multi-timeframe confluence scoring
- Volatility-scaled position sizing
- Max drawdown circuit breaker
- Correlation-aware exposure limits

### Deliverables

#### 2.1 Production Pine Script (`icr-smc-engine-v4.pine`)

**New Parameter Groups:**

```
// ── Position Sizing (v4.0) ──
riskPerTrade     = input.float(1.0, "% Risk Per Trade", step=0.25, group="Position Sizing")
maxPortfolioRisk = input.float(4.0, "Max Portfolio Risk %", group="Position Sizing")
accountEquity    = input.float(10000, "Account Equity", group="Position Sizing")
volTargetMultiplier = input.float(1.0, "Vol Target Multiplier", group="Position Sizing")

// ── Drawdown Protection (v4.0) ──
maxDrawdownPct    = input.float(15.0, "Max Drawdown %", group="Drawdown Protection")
ddCircuitBreaker  = input.bool(true, "DD Circuit Breaker", group="Drawdown Protection")
cooldownBars      = input.int(4, "Cooldown Bars After Loss", group="Drawdown Protection")

// ── Correlation Cap (v4.0) ──
maxCorrelatedPositions = input.int(3, "Max Correlated Positions", group="Correlation")
correlationLookback    = input.int(50, "Correlation Lookback", group="Correlation")
```

**New Logic:**
- **Volatility-scaled sizing:** `positionSize = (accountEquity * riskPerTrade/100) / (stopDistance * volatilityMultiplier)`
- **Drawdown circuit breaker:** Track peak equity, if drawdown >= maxDrawdownPct, go flat until recovery
- **Cooldown:** After a losing trade, skip N bars before next entry
- **Correlation cap:** Track open positions, if correlated (same sector/move together), cap at maxCorrelatedPositions

#### 2.2 TypeScript Analysis Engine Updates

Update `src/server/analysis/icr/config.ts` to include:
```typescript
export interface RrFirstConfig extends IcrConfig {
  // Stage 2 additions
  riskPerTrade: number;          // 1.0 = 1% risk per trade
  maxPortfolioRisk: number;       // 4.0 = 4% max simultaneous risk
  maxDrawdownPct: number;         // 15.0 = halt at 15% DD
  cooldownBarsAfterLoss: number;  // 4 bars
  maxCorrelatedPositions: number; // 3
  correlationLookback: number;    // 50 bars
  volatilityTargetMultiplier: number; // 1.0
}
```

#### 2.3 Acceptance Criteria
- [ ] Pine Script v4.0 compiles and backtests on TV with max DD < 15%
- [ ] TypeScript config updated, build passes (`pnpm build`)
- [ ] Paper trade mode validates position sizing logic
- [ ] Cooldown circuit breaker prevents revenge trading in backtest

---

## STAGE 3: NEURAL NETWORK SCORING ENGINE

### Objective
Replace/augment hand-crafted gate scoring with a neural network that:
1. Ingests enriched candle data + ICR gate outputs + derivatives alpha
2. Outputs a calibrated trade probability and expected R
3. Runs inference in < 50ms for real-time signals

### Architecture

```
Input Features (per signal):
┌──────────────────────────────────────────────┐
│ Market Structure (12 features)               │
│  • MA7/25/99 slopes, MA separation           │
│  • ATR(14), ATR percentile (20-bar)          │
│  • BB width, BB position                     │
│  • Volume Z-score, volume trend              │
│                                              │
│ ICR Gate Scores (7 features)                 │
│  • Trend score (0-20)                        │
│  • Impulse score (0-20)                      │
│  • Pullback score (0-15)                     │
│  • Compression score (0-15)                  │
│  • Trigger score (0-15)                      │
│  • Volume score (0-10)                       │
│  • RR score (0-20)                           │
│                                              │
│ Derivatives Alpha (5 features)               │
│  • OI delta, funding rate, L/S ratio         │
│  • Alpha composite, alpha signal             │
│                                              │
│ Trade Structure (4 features)                 │
│  • R:R ratio, stop distance (%ATR)           │
│  • Target distance (%ATR), timeframe         │
│                                              │
│ Context (6 features)                         │
│  • Hour of day, day of week                  │
│  • Recent WR (last 20 trades this pair)      │
│  • Regime: bull/bear/neutral (MA200 slope)   │
│  • Volatility regime (ATR percentile)        │
└──────────────────────────────────────────────┘

                    ▼

┌──────────────────────────────────────────────┐
│        Feature Engineering (Opus)            │
│  • Non-linear interactions                   │
│  • Feature importance (SHAP)                 │
│  • Cross-validation folds (time-series)      │
└──────────────────────────────────────────────┘

                    ▼

┌──────────────────────────────────────────────┐
│        Model Training (LightGBM/CatBoost)     │
│  • Time-series split (no lookahead)          │
│  • Objective: probability calibration        │
│  • Output: P(win), E(R), CI[low, high]       │
│  • Export to ONNX for inference              │
└──────────────────────────────────────────────┘

                    ▼

┌──────────────────────────────────────────────┐
│        Inference (Cloudflare Workers AI)      │
│  • ONNX runtime via ONNX Runtime Web         │
│  • < 50ms inference per signal               │
│  • Batch inference for efficiency            │
│  • Fallback to rule-based when NN unavailable│
└──────────────────────────────────────────────┘
```

### Deliverables

#### 3.1 Training Data Pipeline
```typescript
// scripts/ml/training-data-builder.mjs
// 1. Load all enriched klines from D1
// 2. Compute ICR gate scores for every bar (not just signals)
// 3. Compute forward outcome: did price reach TP before stop?
// 4. Output labeled dataset: features → {win: bool, maxFavorableR: float, maxAdverseR: float}
// 5. Save as Parquet/CSV for Python training
```

#### 3.2 Model Training Scripts
```python
# scripts/ml/train_rr_model.py
# 1. Load training data
# 2. Time-series cross-validation (purged k-fold)
# 3. Train LightGBM classifier + regressor
# 4. SHAP feature importance analysis
# 5. Calibrate probabilities (isotonic regression)
# 6. Export ONNX model
```

#### 3.3 TypeScript Inference Engine
```typescript
// src/server/analysis/ml/inference.ts
// 1. Load ONNX model into ONNX Runtime Web
// 2. Feature vector builder from enriched candles + ICR output
// 3. predict(signal: UnifiedSignal): MlPrediction
// 4. Caching layer for repeated feature computations
```

#### 3.4 Acceptance Criteria
- [ ] Training dataset: 100K+ labeled examples (50 symbols × 6mo × 5 timeframes)
- [ ] Model AUC > 0.65 on out-of-sample (time-series split)
- [ ] SHAP analysis confirms RR, timeframe, and trend scores are top features
- [ ] Probability calibration: Brier score < 0.20
- [ ] ONNX model size < 10MB (fits in Worker memory)
- [ ] Inference latency < 50ms on Cloudflare Worker
- [ ] Fallback to rule-based scoring when ONNX unavailable

---

## STAGE 4: PRODUCTION COLOCATION

### Objective
Move from "Cloudflare Worker does everything" to a proper execution architecture
with static IP, Redis order locking, and 24/7 monitoring.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     CLOUDFLARE WORKER (Edge)                      │
│  • Dashboard API (/api/analysis/*, /api/signals/*)               │
│  • Kline fetching + enrichment (cron: every 5 min)                │
│  • ICR + RR-First signal detection                                │
│  • NN inference (ONNX Runtime Web)                                │
│  • Signal dispatch → TradeIntent → Redis queue                    │
└──────────────────────────────────────────────────────────────────┘
                           │
                           ▼ (Redis pub/sub or HTTP)
┌──────────────────────────────────────────────────────────────────┐
│                EXECUTION SERVER (VPS, Static IP)                  │
│  • Redis: order lock, position state, kill switches               │
│  • Aster DEX adapter: onchain execution via builder address       │
│  • CEX adapter: Binance/BitUniX order submission                  │
│  • Order mutex: one in-flight order per connection                │
│  • Telemetry: Prometheus metrics, Grafana dashboard               │
│  • Health check: heartbeat every 30s, alert if stale              │
│  • Kill switch: global + per-connection                           │
└──────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     MONITORING + ALERTING                         │
│  • Position PnL dashboard (real-time)                             │
│  • Drawdown monitor with alerts (Telegram/Discord)                │
│  • Signal quality tracker (predicted vs actual outcome)           │
│  • Model drift detection (KL divergence on feature distributions)│
│  • Execution latency histogram                                    │
│  • Daily PnL report (auto-generated)                              │
└──────────────────────────────────────────────────────────────────┘
```

### Deliverables

#### 4.1 Execution Server
- **Location:** VPS with static IP (Hetzner, Vultr, or AWS EC2 + EIP)
- **Stack:** Node.js + Redis + PM2
- **Security:** IP whitelist for exchange API keys, SSH key-only auth, fail2ban

#### 4.2 Redis Schema
```
execution:lock:{connectionId}     → order mutex (SET NX EX 30)
execution:position:{pair}         → current position state
execution:kill:{connectionId}     → per-connection kill switch
execution:kill:global             → global kill switch
execution:signal:{idempotencyKey} → dedup (EX 86400)
telemetry:pnl:{date}              → daily PnL accumulator
telemetry:signals:predictions     → last 1000 predictions for drift detection
```

#### 4.3 Monitoring Stack
- **Prometheus** metrics: signal count, execution latency, position count, PnL, drawdown
- **Grafana** dashboard: real-time PnL, signal quality, model drift, system health
- **Alerts:** Telegram webhook for: drawdown > 10%, execution failure, model drift, stale heartbeat

#### 4.4 Acceptance Criteria
- [ ] Execution server deploys from `pnpm deploy:execution`
- [ ] Static IP configured and whitelisted on exchange
- [ ] Redis order locking prevents double-fills
- [ ] Kill switch stops all execution within 1 second
- [ ] Grafana dashboard shows real-time PnL + signal quality
- [ ] Telegram alert fires on drawdown breach
- [ ] 24-hour soak test: zero unintended orders, zero missed signals

---

## Implementation Sequence

| Stage | Duration | Prerequisites | Key Risk |
|-------|----------|---------------|----------|
| 1: TV Backtest | 2-3 days | TradingView MCP working, TV launched with CDP | TV Strategy Tester may be slow for 50+ symbols |
| 2: Algo v4.0 | 2-3 days | Stage 1 results validated | Over-fitting to backtest period |
| 3: NN Engine | 5-7 days | Stage 2 feature engineering complete | ONNX model size vs Worker memory limits |
| 4: Production | 4-5 days | Stages 1-3 validated, budget for VPS | Exchange API rate limits on single IP |

**Total: 13-18 days** with parallel work where possible.

---

## Immediate Next Actions

1. **Launch TradingView with CDP** — `tv_launch` via MCP, verify connection
2. **Compile current Pine Script** — Verify `icr-smc-engine.pine` compiles clean
3. **Run first 4h backtest on 5 symbols** — AVAX, SOL, AAVE, SEI, SUI
4. **Extract Strategy Tester metrics** — Via screenshot + data extraction
5. **Iterate on Pine Script** — Tune parameters based on real backtest results
6. **Scale to 50+ symbols** — Batch run via TV MCP automation

---

## Appendix A: Why the Current Backtest is Circular

The `backtest-prioritized.json` corpus contains 1,265 trades sourced from Coinlegs signals.
Every trade has:
- `indicator`: "MACD", "Stochastic", "CCI", "Trend Reversal", "Ichimoku"
- `tier`: "B" or "C"
- `score`: 14-40
- `entry`, `stop`, `tp`: Pre-computed by Coinlegs

The problem: Coinlegs already scores signals for positive expectancy. When we write a scoring
function that reads `trade.indicator`, `trade.tier`, `trade.score`, and `trade.period`, we're
essentially re-scoring Coinlegs' own filtered output. A good score on this corpus only proves
we can identify which of Coinlegs' signals were best — not that we can find edge in raw price data.

**The fix:** Pine Script on naked OHLCV. No pre-filtered signals. The script must derive entry,
stop, and TP from price action alone, then the Strategy Tester computes PnL. This is what
Stage 1 delivers.

## Appendix B: Why Max DD Must Be Contained

The RR-First Sniper v3 shows 55.6% max DD. Even ICR baseline shows 21.8%. These numbers
come from a simulator using fixed-fraction position sizing with no drawdown awareness.

In live trading:
- A 21.8% DD at 1% risk/trade means ~22 consecutive losses (possible in a fat-tail system)
- A 55.6% DD means the account is effectively dead — psychological + practical recovery impossible
- The fix is three-fold:
  1. **Volatility-scaled sizing** — smaller positions when ATR is elevated
  2. **Drawdown circuit breaker** — halt at 15% DD, resume only after recovery
  3. **Correlation cap** — no more than 3 positions in the same sector/regime

These are implemented in Stage 2's Pine Script v4.0.
