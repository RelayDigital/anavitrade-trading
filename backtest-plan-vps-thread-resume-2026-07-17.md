# Task Plan: Resume Research Threads and Run VPS Backtests

## Goal
Recover the active ML/backtest threads, run the current non-circular production backtests on the Hetzner VPS, preserve reproducible artifacts, and report evidence-backed results without changing live execution mode.

## Current Phase
Phase 1

## Phases

### Phase 1: Recover Threads and Inspect State
- [x] Read repository recovery notes (`task_plan.md`, `progress.md`, `findings.md`)
- [x] Identify current production backtest harness and anti-lookahead constraints
- [ ] Inspect VPS checkout, data, dependencies, processes, and free resources
- **Status:** in_progress

### Phase 2: Select Reproducible Campaign
- [ ] Confirm the VPS checkout contains the current `production-backtest.py` and meta-v20 artifacts
- [ ] Prefer raw OHLCV chronological evaluation; do not treat the Coinlegs corpus as validation
- [ ] Record exact revision, data timestamps/counts, parameters, and commands
- **Status:** pending

### Phase 3: Execute VPS Backtests
- [ ] Run a quick smoke backtest
- [ ] Run the full 50-pair production backtest
- [ ] Run the gated backtest if its prerequisites are present
- [ ] Save timestamped stdout/stderr and generated JSON/CSV artifacts on the VPS
- **Status:** pending

### Phase 4: Verify and Synthesize
- [ ] Check process exit codes and artifact integrity
- [ ] Extract trades, win rate, profit factor, Sharpe, drawdown, thresholds, and split dates
- [ ] Compare results to the recorded baseline and flag leakage/circularity risks
- **Status:** pending

### Phase 5: Handoff
- [ ] Update `progress.md` and `findings.md` with durable results
- [ ] Provide VPS artifact paths and the next highest-leverage experiment
- **Status:** pending

## Campaign Record

| Field | Value |
|---|---|
| VPS | `root@5.161.229.209` |
| Intended corpus | Fresh/cached raw Binance OHLCV in `scripts/data/klines-mtf.json` |
| Primary harness | `scripts/ml/production-backtest.py` |
| Secondary harness | `scripts/ml/backtest-gated.py` when compatible |
| Model | `scripts/data/models/meta-v20-mtf-context` |
| Safety constraint | Do not change `EXECUTION_MODE`; no live orders; no service restarts unless required and explicitly in scope |
| Validation constraint | `scripts/backtest-prioritized.json` is pattern-extraction-only, not proof of generalization |

## Decisions Made

| Decision | Rationale |
|---|---|
| Resume the six consolidated threads from repository checkpoints | “Threads” maps to the recovered session-unification record; the ML/backtest thread is the relevant unfinished workstream |
| Run CLI ML backtests on the VPS | The VPS has no TradingView GUI/CDP; repo operations explicitly prescribe the ML pipeline there |
| Start with read-only inspection and a quick smoke run | Confirms compatibility before spending CPU on the full campaign |

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` while running session catch-up/combined diagnostics | 1 | Continue with direct repository reads and isolated commands; do not repeat the same wrapper-dependent call |

## Notes
- Existing uncommitted source/test changes belong to the user and must be preserved.
- TradingView sweeps remain a local desktop task; this VPS campaign tests the ML/raw-OHLCV path.
