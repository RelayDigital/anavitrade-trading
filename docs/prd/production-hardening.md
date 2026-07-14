# PRD: Production Hardening & Platform Upgrade

**Status:** Draft — for next sprint
**Priority:** High
**Depends on:** Static egress VPS or Neon/Turso PostgreSQL

## Problem

The Cloudflare Workers deployment hits hard limits that block key features:

| Limit | Impact |
|-------|--------|
| 50 subrequests per invocation | Analysis engine can't batch-fetch klines |
| D1 999-variable bind limit | Kline bulk inserts fail |
| Shared egress IPs | Exchange API-key whitelisting impossible |
| No cron observability | Fee crystallization, outcome validation silent failures |
| No error reporting | Production issues invisible |

## Requirements

### Phase 1 — VPS Deployment
- Move analysis engine + kline warehouse to a VPS with static egress IP.
- Keep auth, dashboard, REST API on Cloudflare Workers (stateless).
- Proxy write-heavy analysis to the VPS backend.

### Phase 2 — Observability
- Wire Sentry or equivalent for frontend + backend error tracking.
- Add Slack/email webhook on cron failure (50th fire check).
- Health endpoint monitors: cron counter increment, DB connectivity.

### Phase 3 — Live Execution
- Static egress IP for Binance Futures API-key whitelisting.
- Fee collection integration (payment provider).
- Aster live submission enablement (after testnet verification).

### Phase 4 — Backtest Infrastructure
- Kline warehouse on PostgreSQL (Neon/Turso).
- Parameter sweep runner with D1 migration for results.
- Signal spotting API.
- Dynamic watchlist from signal activity.

## Success Criteria

- [ ] Analysis engine inserts klines and produces signals.
- [ ] Parameter sweep runs end-to-end on 100+ pairs.
- [ ] Error alerts fire on cron failure.
- [ ] Live order submission works against Binance Futures.
- [ ] `npx tsc --noEmit && npx vite build` passes.
