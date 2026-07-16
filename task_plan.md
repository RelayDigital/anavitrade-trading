# Task Plan: Anavitrade — Current State (2026-07-16)

## Status: BETA (operational with known gaps)

### Working ✅
- Worker deployed at anavitrade-trading.erhazeariel.workers.dev
- 2,347 Coinlegs signals in D1
- Cron firing every 60s (native signals, scraper, demo sync, outcome, fee, analysis)
- 8 CEX exchange clients (Binance, Bybit, OKX, Kraken, KuCoin, Gate, Coinbase, Bitunix)
- Aster DEX v3 client (OTOCO orders, agent approval gates, fee-rate validation)
- Internal API for VPS↔Worker (pending-intents, active-connections, kill-state, report-execution)
- VPS at 5.161.229.209 running execution poll loop (testnet mode)
- TradingView Desktop connected via CDP (port 9222)
- TradingView MCP installed and configured
- Meta-v6 ML model trained (LightGBM + isotonic cal + KMeans + adversarial)
- 62-feature ML pipeline with multi-TF training data

### Blocking 🟡
- **klines table: 1 row** — analysis engine generates 0 signals because no OHLCV data
- Analysis engine runs but can't compute indicators → 0 analysis_signals → 0 trade_intents
- Root cause: Cloudflare 50-subrequest cap prevents kline fetching from Worker

### In Progress
- [~] Seed klines into D1 (scripts/seed-klines.mjs running)
- [~] Rebuild VPS Docker container with updated execution server

### Immediate Next Steps
1. Seed 10 pairs × 100 bars of 4h klines → trigger analysis engine
2. After klines populate: analysis engine produces signals → intents flow to VPS
3. Seed 1h klines for SMC patterns (4x more signals than 4h)
4. Switch EXECUTION_MODE=production after 48h validation

### ML Next Steps
1. Retrain metacognitive model on full 40K MTF rows (scripts/data/klines-mtf.json has 50 pairs)
2. Add 1h SMC pattern features as amplifiers (not prerequisites)
3. Run backtest via TradingView CDP (TV Desktop running at :9222)
4. Target: 3+ PF from calibrated model (no arbitrary scoring)

### Demo Mode
- Demo portfolio should start from 0 trades at user registration
- Live/Demo toggle should show different dashboards without gating order submission

### Infrastructure
- [ ] Upgrade wrangler: `npm install --save-dev wrangler@4`
- [ ] Set up Redis-backed rate limiting on VPS
- [ ] Add Prometheus alerts for execution failures
- [ ] Wire Grafana dashboards to Prometheus

## Recent Commits (since July 12)
- 199dcad: Aster v3 + internal API + UI polish (current HEAD)
- 0681b2b: fix aster activation flow
- 2fc9c4c: fix klines inserts — chunked at 90 rows
- 607363b: fix align aster execution with futures v3
- fdbf722: remove Coinlegs brand from frontend

## Recovery Next Steps
```bash
# Check kline seed
npx wrangler d1 execute anavitrade-db --remote --command "SELECT COUNT(*) FROM klines"

# Trigger analysis after klines exist
curl -s -H "x-admin-api-key: anavitrade-admin-key-2026-secure" -X POST \
  "https://anavitrade-trading.erhazeariel.workers.dev/api/analysis/run"

# Check VPS execution server
curl http://5.161.229.209:9090/health

# Seed 1h klines (SMC patterns fire 4x more)
node scripts/seed-klines.mjs --pairs 10 --bars 300 --timeframe 1h
```
