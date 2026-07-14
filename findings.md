# Findings & Decisions

## Beta State (2026-07-14) — Live at anavitrade-trading.erhazeariel.workers.dev

### Working in Production ✅
- Coinlegs scraper: ~1,400 signals, cron inserts every 60s
- 8 CEX exchange clients (Binance, Bitunix, Bybit, OKX, Kraken, KuCoin, Gate.io, Coinbase)
- CEX connection management with encrypted key storage
- Aster DEX activation flow (EIP-712 signing via viem)
- Dashboard: 9 components, 3 hooks, 1285→220 lines
- Unified balance aggregation (DEX + CEX sum)
- tRPC API: 24 endpoints covering auth, live, demo, signals, exec, CEX, Aster
- REST API: 18 admin endpoints for backtest, analysis, mirror, scraper, fee
- Outcome validator: tracks 1,400+ signals for claimed-vs-actual accuracy
- Fee engine: 2&20 model, quarterly periods, NAV-snapshot based
- Auth header bypass: Binance 451 geo-block solved with X-MBX-APIKEY
- D1 Date serialization: fixed with raw D1 binding + `number` mode
- D1 100-variable limit: fixed with chunked inArray (80 IDs per query)
- Cron throttle: D1-persisted counter survives Worker restarts
- SMC dispatch: active, validates Tier-A signals before TradeIntent creation
- analysis_signals bridge: re-enabled, raw D1 insert bypasses Date bug

### Blocked by Cloudflare 50-Subrequest Cap 🟡
- Analysis engine: completes with status="completed" but klines table empty
- Klines insert: 500-row batch exceeds D1 999-variable limit
- Max per analysis run: ~15 pairs under 50-subrequest cap (1 fetch + 1 insert each)
- Signal spotting API and kline warehouse require VPS upgrade

### Known Production Gaps
- **Error reporting:** No Sentry/DataDog
- **Fee collection:** Engine tracks but no payment provider integration
- **Alerting:** No Slack/webhook for cron failures
- **Live order execution:** Needs static egress IP for exchange whitelisting
- **Analysis engine:** 0 signals until klines table is populated

### Aster Live Submission Gate
- Keep `ASTER_LIVE_ORDER_SUBMISSION_ENABLED=false` until Aster request signing, exact order payload fields, and fill sync are verified end-to-end.
- Before enabling live submission, verify staged/submitted/filled/rejected transitions in `execution_jobs`, `order_events`, audit logs, and NAV snapshots.
- Use testnet or a non-production wallet first; do not depend on fee crystallization from Aster fills until NAV reconciliation is proven.
- 2026-07-14 follow-up: `execution_jobs`, `order_events`, and `nav_snapshots` are shared by Aster and CEX; CEX dispatch timestamp writes were audited and corrected to epoch milliseconds where they target numeric columns.

### Next Steps (When Infrastructure Upgrades)
- Apply PRDs in `docs/plans/2026-07-14-*-prd.md`
- Deploy VPS with Node.js backend and static egress IP
- Phase 1: Seed klines (1-2 hours)
- Phase 2: Backtest parameter sweep (4-8 hours)
- Phase 3: Signal spotting API
- Phase 4: Dynamic watchlist from signal activity
