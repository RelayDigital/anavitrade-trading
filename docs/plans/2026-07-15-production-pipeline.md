# Anavitrade Production Pipeline — Master Plan

**Date:** 2026-07-15
**Status:** ACTIVE
**Author:** Claude Opus 4.8 + Ariel

## North Star

> SMC/ICT entry detection on HTF (4h) + BBAWE confirmation + NN-scored parameters + co-located execution = production-grade automated trading with Sharpe > 5 and MaxDD < 15%.

---

## Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PHASE 0: MARKET INTELLIGENCE                     │
│  5 PRDs covering: server providers, ML inference, competitors,          │
│  exchange rate limits, exchange prioritization                          │
│  → docs/market-research/01-05-*.md                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     PHASE 1: ALGORITHM RECONSTRUCTION                    │
│  Replace failed ICR gates with SMC + BBAWE entry detection              │
│  Target: PF > 1.5 on TV Strategy Tester (4h, 10+ symbols)               │
│  → scripts/icr-smc-engine-v5.pine                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     PHASE 2: PARAMETER OPTIMIZATION                      │
│  ML-driven grid search over all Pine Script thresholds                  │
│  SHAP-weighted optimization targeting high win-probability regions      │
│  → scripts/ml/optimize-params.py                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  PHASE 3: NN SCORING ENGINE (ITERATION 2)                │
│  Retrain LightGBM on v5.0 features + SMC pattern features               │
│  Target: AUC > 0.75, Brier < 0.18                                       │
│  TypeScript inference wrapper for real-time scoring                     │
│  → src/server/analysis/ml/inference.ts                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    PHASE 4: PRODUCTION COLOCATION                        │
│  Execution server with static IP, Redis order lock, Prometheus +        │
│  Grafana monitoring, Telegram alerts, kill switches                     │
│  → src/server/execution/production/                                     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 0: Market Intelligence (RESEARCHING)

### PRDs to deliver
| # | Document | Status |
|---|----------|--------|
| 1 | Execution Server Providers | 🔄 In research |
| 2 | ML Inference at the Edge | 🔄 In research |
| 3 | Crypto Trading Bot Competitive Landscape | 🔄 In research |
| 4 | Exchange API Rate Limits & Colocation | 🔄 In research |
| 5 | Exchange Market Share & Adapter Prioritization | 🔄 In research |

### Decision gates
- [ ] Select VPS provider (static IP mandatory, <$100/mo)
- [ ] Select ML inference strategy (CPU vs GPU vs Workers AI)
- [ ] Confirm Anavitrade's competitive moat (SMC/ICT on HTF + Aster on-chain)
- [ ] Select primary + secondary exchanges for adapter development
- [ ] Set deployment region based on exchange latency requirements

---

## Phase 1: Algorithm Reconstruction (BUILDING)

### Problem
Current ICR gates (v3.0/v4.0) calibrated on Coinlegs proxy variables produce PF 0.5-0.8 on raw OHLCV. 1,406 trades at 0.15% WR on v3.0. The impulse/pullback/compression pipeline doesn't detect actual market structure.

### Solution: SMC + BBAWE Entry Detection

**Smart Money Concepts (SMC)** on 4h detects institutional footprints:
- **Order Blocks (OB):** Last opposing candle before strong impulse — 25-30 pts
- **Breaker Blocks:** Mitigated OB becomes support/resistance — 20-25 pts
- **Fair Value Gaps (FVG):** Price imbalance zones that attract retracement — 15-20 pts
- **Liquidity Sweeps:** Stop hunts at swing points — 20-25 pts
- **Market Structure Shifts (CHoCH):** Trend change confirmation — 15-20 pts

**Bollinger Band + Awesome Oscillator (BBAWE)** confirms timing:
- BB squeeze → expansion: volatility breakout signal
- AO zero-line cross: momentum shift
- AO saucer/twin peaks: trend change/continuation

**Score fusion:** SMC (0-30) + BBAWE (0-20) + Trend (0-20) + RR (0-30) = 100 max
- Tier A: ≥ 75 → full size
- Tier B: 60-74 → half size
- Tier C: < 60 → skip

### Target metrics (TV Strategy Tester, 4h, 10+ altcoins)
| Metric | Current v4.0 | Target v5.0 |
|--------|-------------|-------------|
| Avg PF | 0.51 | > 1.5 |
| Avg WR | 17.7% | > 35% |
| Sharpe | negative | > 3.0 |
| MaxDD | 12% | < 15% |
| Avg trades/symbol | 26 | > 40 |

### Deliverable
- `scripts/icr-smc-engine-v5.pine` — self-contained strategy() with SMC + BBAWE

### Decision gate
- [ ] PF > 1.5 on 5+ out of 10 tested symbols → promote to Phase 2

---

## Phase 2: Parameter Optimization (PENDING)

### Approach
The trained LightGBM model (AUC 0.70, SHAP-validated) scores any feature vector for win probability. We use this as an oracle to find optimal Pine Script parameters:

1. Define parameter search space (30+ parameters × 3-8 values each)
2. For each combination, estimate the resulting feature vector using SHAP-based linear approximation
3. Score: `win_probability × signal_rate_factor` (both high is best)
4. Rank top 50 parameter sets
5. Cross-validate top 5 on TradingView directly

### Key parameters to optimize
- Impulse/SMC detection thresholds (ATR mult, volume mult, lookback windows)
- Compression parameters (range ratio, ATR ratio, narrow ATR mult)
- Score thresholds (tier boundaries, min RR)
- Exit trail parameters (ATR mult, arm point, max bars)
- Risk management (risk per trade, max DD %, cooldown bars)

### Deliverable
- `scripts/ml/optimize-params.py` — SHAP-based parameter optimizer
- Top 10 parameter presets as Pine Script-ready format

### Decision gate
- [ ] Best parameter set improves TV backtest PF by > 20% over v5.0 defaults

---

## Phase 3: NN Scoring Engine v2 (PENDING)

### Learnings from v1
- AUC 0.70 is real but modest — feature engineering is the bottleneck
- ICR gate scores contribute only 11% SHAP importance (mostly noise)
- RR ratio is the dominant feature (0.52 SHAP) — structural trade quality matters most
- Market structure features (BB width, ATR, MA slopes) contribute 40% — raw price action is powerful

### v2 improvements
1. **Add SMC pattern features** — OB presence (binary), FVG size, liquidity sweep depth, CHoCH recency
2. **Add BBAWE features** — BB squeeze duration, AO value, AO histogram slope, BB expansion rate
3. **Multi-timeframe features** — for each 4h bar, include 1h context features (BB squeeze on 1h, AO on 1h)
4. **Regime features** — BTC correlation, sector correlation, volatility regime, trend strength
5. **Drop noisy ICR gates** — keep only impulse_score (0.23 SHAP), drop the rest

### Target
- AUC > 0.75, Brier < 0.18 on 5-fold time-series CV
- SHAP > 0.10 importance for at least 3 SMC/BBAWE features (proving they work)

### Deliverables
- Retrained model in `scripts/data/models/`
- `src/server/analysis/ml/inference.ts` — TypeScript inference wrapper
- Fallback to rule-based scoring when model unavailable

---

## Phase 4: Production Colocation (PENDING)

### Architecture

```
Cloudflare Worker (Edge)
├── Dashboard API
├── Kline fetching + enrichment
├── Signal detection (Pine Script rules)
├── NN inference (CPU, co-located)
└── TradeIntent dispatch

        ↓ Redis pub/sub

Execution Server (VPS, Static IP)
├── Redis: order lock, position state, kill switches
├── Aster DEX adapter (EIP-712 signing)
├── CEX adapter (Binance, Bybit, OKX)
├── Risk engine (pre-trade checks)
├── Prometheus metrics + Grafana dashboard
└── Telegram alerts
```

### Monitoring
- **Real-time:** Position PnL, drawdown %, signal quality (predicted vs actual)
- **Daily:** PnL report, trade log, model drift detection (KL divergence)
- **Alerts:** Drawdown > 10%, execution failure, stale heartbeat, model AUC decay

### Hardening checklist
- [ ] Static IP configured and whitelisted on exchanges
- [ ] Redis order locking prevents double-fills
- [ ] Global + per-connection kill switches (tested)
- [ ] 24-hour soak test: zero unintended orders
- [ ] Encrypted API keys at rest (ENCRYPTION_KEY)
- [ ] Fail2ban + SSH key-only auth on VPS
- [ ] Automated daily backup of Redis state + trade logs

---

## Production Readiness Checklist

### TradingView Backtest Gate (MUST PASS)
- [ ] PF > 1.5 on ≥ 5 of 10 tested altcoins (4h)
- [ ] MaxDD < 15% per symbol (with circuit breaker)
- [ ] Positive Sharpe on aggregate portfolio
- [ ] Walk-forward: validation period WR within 10% of training period

### Paper Trading Gate (MUST PASS)
- [ ] 2-week paper run: PF > 1.3, MaxDD < 10%
- [ ] Signal dispatch delay < 2s from kline close
- [ ] Zero missed signals due to infrastructure
- [ ] Model inference adds < 50ms latency

### Live Gate (REQUIRES SIGN-OFF)
- [ ] All paper trading criteria met
- [ ] Kill switch tested (stops all orders within 1s)
- [ ] Telegram alerts configured and tested
- [ ] Maximum position size: 1% equity per trade, 4% total
- [ ] Daily loss limit: 3% of equity → halt
- [ ] Production wallet contains ≤ 10% of total capital initially

---

## Key Files Map

```
docs/
├── plans/
│   ├── 2026-07-15-rr-first-multi-stage-prd.md    ← Architecture PRD
│   └── 2026-07-15-production-pipeline.md         ← THIS FILE (master plan)
├── analysis/
│   ├── ARCHITECTURE.md                            ← Analysis engine design
│   ├── API.md                                     ← API routes
│   └── EMPIRICAL_FINDINGS.md                     ← Calibrated parameters
└── market-research/                               ← Phase 0 (in progress)
    ├── 01-execution-server-providers.md
    ├── 02-ml-inference-edge.md
    ├── 03-competitive-landscape.md
    ├── 04-exchange-rate-limits.md
    └── 05-exchange-prioritization.md

scripts/
├── icr-smc-engine.pine            ← v4.0 (risk-managed, deployed on TV)
├── icr-smc-engine-v5.pine         ← v5.0 (SMC + BBAWE, in progress)
├── fetch-klines.mjs               ← Binance → JSON kline fetcher
├── tv-backtest-runner.mjs         ← CDP-driven TV backtest automation
├── tv-sweep-v4.mjs                ← Quick symbol sweep
├── tv-inject-v4.mjs               ← Quick Pine Script injector
├── unified-backtest.mjs           ← 8-strategy comparison (corpus)
├── data/
│   ├── klines-4h.json             ← 25,000 raw candles (50 pairs)
│   ├── training-data-4h.json      ← 40,000 labeled feature rows
│   └── models/
│       ├── lgbm_classifier_final.txt  ← Trained LightGBM (584 KB)
│       ├── lgbm_classifier_final.pkl  ← Pickled model
│       ├── feature_names.json         ← 29 feature names
│       └── shap_importance.json       ← SHAP analysis
└── ml/
    ├── build-training-data.ts     ← Feature engineering pipeline
    ├── train_model.py             ← LightGBM training script
    ├── optimize-params.py         ← Parameter optimizer (in progress)
    └── README.md                  ← ML pipeline docs

src/server/analysis/
├── engine.ts                      ← Orchestrator
├── dispatcher.ts                  ← Signal → TradeIntent
├── icr/
│   ├── config.ts                  ← DEFAULT_ICR_CONFIG
│   ├── signals.ts                 ← 10-gate pipeline
│   └── structure.ts              ← Trend/impulse/pullback/compression
├── exits/
│   └── exit-engine.ts             ← Trail + exhaustion exit
└── ml/                            ← Phase 3 (planned)
    └── inference.ts               ← ONNX/LightGBM inference wrapper
```

---

## Current Blockers

1. **Signal quality:** ICR gates don't detect real market structure. v5.0 SMC rewrite is the fix.
2. **No live price feed:** Need WebSocket stream to Binance for real-time kline closes.
3. **Aster integration untested live:** Adapter exists, signing works, never used with real funds.
4. **No monitoring:** No Prometheus/Grafana, no alerting. Phase 4 prerequisite.

## Next Actions (Priority Order)

1. **Complete market research PRDs** (5 docs) → save decisions to this pipeline doc
2. **Finish SMC + BBAWE v5.0 Pine Script** → compile on TV, run 10-symbol backtest
3. **Run ML parameter optimizer** → generate top 10 parameter presets
4. **Test top 3 presets on TV** → select best, update v5.0 defaults
5. **Retrain NN on v5.0 features** → target AUC > 0.75
6. **Provision execution VPS** → deploy Redis, Prometheus, Grafana
