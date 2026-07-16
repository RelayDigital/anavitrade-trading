# Findings & Decisions

## Beta State (2026-07-16) — Live at anavitrade-trading.erhazeariel.workers.dev

### Working in Production ✅
- Worker deployed, cron running every 60s
- 2,347 Coinlegs signals in D1
- 1,000+ 4h klines seeded (11 symbols, 100 bars each)
- VPS at 5.161.229.209: execution poll loop running (testnet mode)
- 8 CEX exchange clients (Binance, Bitunix, Bybit, OKX, Kraken, KuCoin, Gate.io, Coinbase)
- Aster DEX v3 client (OTOCO protective orders, agent approval gates, fee-rate validation)
- Internal API for VPS↔Worker (pending-intents, active-connections, kill-state, report-execution)
- Dashboard: 9 components, 3 hooks, dark theme
- Unified balance aggregation (DEX + CEX sum)
- tRPC API: 24 endpoints + REST: 18 admin endpoints
- ADMIN_API_KEY working (set via wrangler secret put)
- TradingView Desktop connected via CDP (port :9222)
- TradingView MCP installed at ~/tradingview-mcp/

### Blocking 🟡
- Signal pipeline: 0 analysis_signals, 0 execution_jobs — analysis engine needs more kline data
  - Root cause 1: Worker can't fetch klines (Cloudflare 50-subrequest cap)
  - Root cause 2: ICR detection requires MA99 warmup + full SMC patterns (100 bars = bare minimum)
  - Fix: seed-klines.mjs running locally for 15 pairs × 300 bars (4h + 1h timeframes)
- Cloudflare subrequest cap: analysis engine can't run properly from Worker
  - Kline fetching, derivatives, and signal spotting need to move to VPS

### Known Production Gaps
- **Error reporting:** No Sentry/DataDog
- **Fee collection:** Engine tracks but no payment provider integration
- **Alerting:** No Slack/webhook for cron failures
- **Live order execution:** VPS needs exchange API keys configured for real trading

### Aster Live Submission Gate
- Keep `ASTER_LIVE_ORDER_SUBMISSION_ENABLED=true` is currently SET in wrangler.toml vars
  - This means live orders WILL be attempted — verify with testnet first
- 2026-07-14 audit: Aster uses Futures V3 `/fapi/v3/order`, form-urlencoded params,
  microsecond nonce, and `AsterSignTransaction` signing
- 2026-07-14 audit: Activation requires wallet-signed `registerAndApproveAgent` message
- Remaining production proof: run a testnet wallet trade, verify order status/fill sync/NAV reconciliation

### Infrastructure Notes
- VPS runs 5 containers: execution, redis, prometheus, grafana, node-exporter
- Docker compose pulls images from Docker Hub (large Grafana image ~340MB)
- .env on VPS contains INTERNAL_SECRET, ENCRYPTION_KEY (matching Worker secrets)
- Port 9090: execution health/metrics, Port 3000: Grafana, Port 9091: Prometheus

### ML Pipeline (Meta-v6)
- 62 features per bar across 4h/1h/15m timeframes
- LightGBM + isotonic calibration + KMeans regimes + adversarial risk model
- AUC 0.59, calibrated threshold 0.682 (1.1% pass rate at 89% WR)
- SMC patterns are feature AMPLIFIERS, not entry requisites
- Next: retrain on full 40K MTF dataset (50 pairs in klines-mtf.json)
- Key: NO arbitrary scoring — the calibrated probability IS the decision threshold

### Next Steps (After Kline Seeding)
1. Trigger analysis engine → expect signalsGenerated > 0
2. Verify signal → TradeIntent → execution_jobs end-to-end
3. Watch VPS logs: should see pending intents being picked up
4. Seed 1h klines (SMC patterns fire 4x more)
5. Retrain metacognitive model on full MTF data
6. TradingView backtest with new model
