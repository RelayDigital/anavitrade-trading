# PRD: Remove Coinlegs Dependency

**Status:** Backlog
**Priority:** Medium
**Target:** Self-hosted signal pipeline

## Problem

The Anavitrade platform depends on the external Coinlegs API for signal sourcing.
This creates several risks:
- **Single point of failure**: If coinlegs.com goes down, signal generation stops.
- **User perception**: The UI currently brands signals as coming from Coinlegs, which
  undermines Anavitrade's own analysis value proposition.
- **Rate limits & egress IP issues**: The Coinlegs API has rate limits and CF Workers
  share egress IPs, complicating exchange API-key whitelisting.
- **Opsec**: Users can see "coinlegs.com" in the dashboard, revealing the signal source.

## Scope

A full removal requires:

### 1. Server-Side Cleanup
- [ ] Remove `src/server/coinlegs-scraper.ts` — the cron-based scraper that fetches
      signals from the Coinlegs API every 60s.
- [ ] Remove `src/server/outcome/validator.ts` — outcome validation that queries
      coinlegs_signals table.
- [ ] Remove `src/server/analysis/bridge.ts` — bridges coinlegs signals into the
      unified analysis_signals table.
- [ ] Re-point or remove `src/server/analysis/mirror/engine.ts` — the mirror engine
      was designed to replicate Coinlegs' logic locally; rename/refactor to be
      self-standing.
- [ ] Remove `src/server/analysis/mirror/scorer.ts` — scoring algorithm that references
      coinlegs-scraper.
- [ ] Remove `src/server/analysis/mirror/detector.ts` — renaming from "Coinlegs Mirror
      Detector" to a generic local detector.
- [ ] Remove `src/server/analysis/query.ts` `compareSources()` — the side-by-side
      Coinlegs vs ICR comparison endpoint.
- [ ] Simplify `src/server/worker.ts` — remove scraper endpoints, outcome validator
      endpoints, mirror/compare endpoints, and the coinlegs scrape/backfill cron jobs.
- [ ] Simplify `src/server/routers.ts` — remove `signals` trpc router (list, stats,
      topBangers, performance, julyResults) and `getRecentSignals` from demo router.
- [ ] Simplify `src/server/db.ts` — stub out `getSignals`, `getTopBangers`,
      `getSignalStats`, `getPerformance`, `getScraperStatus`, `getJulyResults`.
      Remove `coinlegsSignals` import. Update `getPublicDemoStats` to not query
      coinlegs_signals. Update `syncSignalsToDemoAccounts` to use analysis_signals
      instead of coinlegs_signals.
- [ ] Clean comments in `src/server/smc/validator.ts`, `src/server/signals/generator.ts`,
      `src/server/brain/config.ts`, `src/server/analysis/types.ts`,
      `src/server/analysis/scoring.ts`.
- [ ] Optionally remove `coinlegsSignals` table and indexes from
      `src/drizzle/schema.ts`.
- [ ] Remove `scraperRuns` table and related code if no longer needed.
- [ ] Update CLAUDE.md to remove coinlegs references.

### 2. Database Migration
- [ ] `syncSignalsToDemoAccounts()` currently queries `coinlegs_signals` — must be
      rewired to `analysis_signals`.
- [ ] The `analysis_signals.source` column uses `"coinlegs"` — this value must be
      replaced with `"anavitrade-native"` for signals that come from the local
      generator.
- [ ] Demo trade signal data depends on `coinlegs_signals` fields (`maxProfit`,
      `qualityTier`, etc.) — need a migration path.

### 3. Testing
- [ ] Verify the native generator (`generateSignals()`) produces Tier A signals
      consistently before removing Coinlegs fallback.
- [ ] Ideally run both in parallel for 48h to compare signal quality.
- [ ] Ensure demo account sync still works after rewiring to analysis_signals.

### 4. Rollback Plan
- Keep coinlegs-scraper.ts and related files but remove their entry points in
  worker.ts. If the native generator underperforms, re-enable is a single
  `git revert` away.

## Success Criteria

- [ ] Zero references to "coinlegs" in any user-visible UI string.
- [ ] Zero `coinlegs_signals` queries in production code paths.
- [ ] All cron jobs run without errors and produce signals.
- [ ] Demo account sync populates trades from analysis_signals.
- [ ] `pnpm build` and `pnpm check` pass.
