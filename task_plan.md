# Task Plan: Full Project Review & Audit

**Goal:** Map the entire Anavitrade trading platform — architecture, all algorithm signals, backtest scripts, data flow, subsystem relationships, and gaps.

## Current Phase
Phase 1

## Phases

### Phase 1: Discover & Map Subsystems
- [ ] Map src/ file tree with sizes and purposes
- [ ] Map all scripts/*.mjs — what each does, corpus used, results
- [ ] Map src/server/analysis/ — engine, ICR, mirror, exits, derivatives
- [ ] Map src/server/signals/ — MTF matrix, swing sniper, zoom, BBAWE, Market Cipher, Wolfpack, LuxAlgo
- [ ] Map src/server/ — execution, CEX, Aster, fee, outcome, SMC
- [ ] Map frontend — pages, components, hooks, contexts
- [ ] Map data layer — db schema, drizzle, trpc
- [ ] **Status:** in_progress

### Phase 2: Cross-Reference & Tie Together
- [ ] How do signals flow from Coinlegs → analysis → dispatcher → execution?
- [ ] Which backtest scripts test which subsystems?
- [ ] What config parameters are shared vs duplicated?
- [ ] What's the actual vs documented architecture?
- [ ] **Status:** pending

### Phase 3: Gap & Inconsistency Report
- [ ] Dead code / unused exports
- [ ] Missing test coverage
- [ ] Duplicated logic across signal modules
- [ ] Security gaps (hardcoded keys, missing validation)
- [ ] Backend-frontend mismatches (tRPC routes vs what frontend calls)
- [ ] **Status:** pending

### Phase 4: Synthesis — Visual Map & Recommendations
- [ ] Compile final subsystem dependency diagram
- [ ] Ranked priority fix list
- [ ] Tie all algo scripts together in one reference
- [ ] **Status:** pending

## Key Questions
1. Are all signal generators actually wired into the engine?
2. Is the ICR engine being used or just documented?
3. Which backtest results are still valid vs stale?
4. Are there config constants duplicated across files?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Parallel agent fan-out | 6 subsystems can be explored simultaneously |
| Start from scripts + analysis core | These are the "algorithmic brain" — most complex part |
| Cross-ref with docs/analysis/ | Docs may be stale; actual code is source of truth |
