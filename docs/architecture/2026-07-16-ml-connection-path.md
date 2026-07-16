# ML Connection Path — TypeScript Worker to Python Pipeline

**Date:** 2026-07-16
**Status:** DRAFT — connection is designed, not yet wired at runtime

---

## Problem

The project has two independent ML systems that are not connected at runtime:

| System | Location | Purpose | Language |
|--------|----------|---------|----------|
| Worker inference | `src/server/analysis/engine.ts` | Live signal scoring every 60s cron | TypeScript |
| Offline training | `scripts/ml/pipeline/` | Model training, feature engineering, validation | Python |

Currently, Python model outputs are manually reviewed and hardcoded into TypeScript
parameters (thresholds, weights). There is no automated runtime bridge.

---

## Target Architecture

```
┌───────────────────────────┐     ┌──────────────────────────────┐
│  Hetzner VPS (Python)     │     │  Cloudflare Worker (TS)      │
│                           │     │                              │
│  scripts/ml/train.py ─────┼─────┼──►  src/server/analysis/     │
│    ├── features.py        │     │      engine.ts               │
│    ├── model.py           │     │        │                     │
│    ├── enrichment.py      │     │        ├── reads P(win)      │
│    └── backtest.py        │     │        │   from model JSON   │
│         │                 │     │        ├── scores signals    │
│         ▼                 │     │        └── dispatches orders │
│    model.pkl +            │     │                              │
│    model-metadata.json ───┼─────┼──►  src/server/analysis/     │
│      (threshold,          │     │      scoring-config.ts       │
│       feature_importances)│     │      (reads model params)    │
└───────────────────────────┘     └──────────────────────────────┘
```

### Data Flow

1. **Python (offline, Hetzner VPS):**
   - Fetches klines from Binance (VPS has static IP, no geo-block)
   - Computes 62 features across 4h/1h/15m
   - Trains LightGBM model with isotonic calibration
   - Applies regime KMeans clustering + adversarial risk model
   - Exports TWO artifacts:
     - `model.pkl` — full model binary (not loaded by Worker)
     - `model-metadata.json` — threshold, feature importances, per-regime params

2. **Bridge (the gap):**
   - A lightweight TypeScript module (`src/server/analysis/scoring-config.ts`,
     to be built) reads `model-metadata.json` on Worker startup or cron trigger.
   - Model metadata travels from VPS to Worker via one of:
     - **Option A (recommended):** VPS POSTs metadata to `/api/internal/ml-model`
       endpoint after each training run. Worker stores in D1 `model_metadata` table.
     - **Option B (fallback):** VPS writes to a KV namespace; Worker reads on cron.
     - **Option C (current, manual):** Developer copies threshold values into code.

3. **TypeScript Worker:**
   - `engine.ts` runs on every 60s cron
   - Loads model metadata (threshold, feature weights) from D1 or KV
   - Scores incoming Coinlegs signals using the calibrated P(win) threshold
   - Only dispatches signals scoring above the model's calibrated threshold
   - Logs outcome data for the next training cycle

### Cron Cycle (Every 6h on VPS)

```
1. Fetch fresh klines from Binance (last 200 bars per symbol)
2. Append to training dataset
3. Retrain model
4. Evaluate: AUC improved vs previous model?
   ├── Yes: Deploy new model-metadata.json → POST to Worker
   └── No:  Keep previous model (CORTEX gate)
5. Log training metrics to `scripts/data/training-runs.json`
```

### Files Changed for Live Connection

| File | Change |
|------|--------|
| `src/server/worker.ts` | Add `POST /api/internal/ml-model` endpoint |
| `src/server/analysis/scoring-config.ts` | NEW — Load model metadata, expose getter for threshold |
| `src/server/analysis/engine.ts` | Import `scoring-config`, use calibrated threshold |
| `scripts/ml/vps-train.sh` | After training, POST `model-metadata.json` to Worker |
| `drizzle/schema.ts` | Add `model_metadata` table (or use existing `globalSettings`) |

---

## Current Status (2026-07-16)

- **Python pipeline** is fully built and validated: trains, saves model, exports metrics.
- **CORTEX supervisor** gates training by verifying AUC improvement.
- **Worker engine** already processes signals and dispatches orders.
- **Gap:** No `model_metadata` storage or transfer mechanism exists.
- **Workaround:** Model parameters are hardcoded in TypeScript after manual review of
  Python output. This is fragile and blocks iterative improvement.

### Immediate Next Step

Build the `POST /api/internal/ml-model` endpoint on the Worker and the corresponding
push script in `vps-train.sh`. Use D1 `globalSettings` table as the initial store
(key: `ml_model_metadata_latest`).
