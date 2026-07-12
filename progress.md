# Progress Log

## Session: 2026-07-12

### Phase 1: Discover & Map Subsystems
- **Status:** in_progress
- **Started:** 2026-07-12
- Actions taken:
  - Created task plan for full project audit
  - Launched 5 parallel agents for subsystem exploration
- Files created/modified:
  - task_plan.md (created)
  - progress.md (created)
  - findings.md (created)

### Phase 1 Progress
- **Agent 1 (data/routing):** COMPLETE
  - 19 DB tables mapped, 24 tRPC routes listed
  - Key finding: Web3 `dispatchSignal` is a stub — writes audit log, no actual onchain tx
  - Key finding: 24 tables, 7 indexes, real schema
  - Key finding: Brain config (200 lines) is centralized but not referenced by all modules
- **Agent 2 (analysis/signals):** running
- **Agent 3 (execution/CEX/Aster):** COMPLETE
  - Dispatch engine: live, functional, with db-level idempotency
  - Binance + Bitunix clients: fully functional for market orders
  - Aster DEX: **scaffold only** — submitOrder() throws NOT_WIRED
  - Risk engine: 7 gates (global kill → per-connection → daily loss → exposure cap)
  - Scraper auto-dispatches Tier-A signals to all CEX connections (no human confirmation!)
  - HIGH: ENCRYPTION_KEY falls back to JWT_SECRET in dev (same key for signing + encryption)
- **Agent 4 (frontend):** COMPLETE
  - 18 routes mapped, all components used
  - HIGH: ErrorBoundary exposes stack traces in production
  - MED: LedgerOnboarding onConnected type mismatch (address never set)
  - MED: Dead theme toggle (switchable never set to true)
  - MED: Duplicate tRPC queries on home page (topBangers called twice)
  - PublicDemo.tsx is 980 lines — extract sub-components
  - LiveSignalFeed duplicated across 3 files
- **Agent 5 (scripts/docs):** COMPLETE
  - 10 scripts audited, 5 result files exist, 2 missing
  - Critical: "zoom-ml-backtest.mjs" uses trade.win in scoring (lookahead bias)
  - Critical: "mdp-zoom-train.mjs" uses pnlPct in reward function (lookahead bias)
  - Doc-script gap: EMPIRICAL_FINDINGS.md describes production ICR engine never tested by scripts
  - Most trustworthy result: ICT Sniper (Rule-Based): 694t, 68% WR, Sharpe 7.00, WF PASS
