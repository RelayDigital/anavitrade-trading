# Anavitrade System Operations — Complete Guide

**Last updated:** 2026-07-16
**For:** Claude Opus, Claude Code, and future builders

---

## Quick Start — The 4 Commands You Need

```bash
# 1. BACKTEST: Inject Pine Script into TradingView and sweep symbols
node scripts/tv-deploy-v6.mjs                              # Inject + compile on TV
node scripts/tv-sweep-v4.mjs --tf 4h --symbols "SUIUSDT,MAVUSDT,PLUMEUSDT,..."

# 2. FETCH DATA: Pull real OHLCV from Binance for ML training
node scripts/fetch-klines-mtf.mjs --pairs 50 --bars 500    # 4h/1h/15m, 50 pairs
node scripts/fetch-klines.mjs --tf 4h --bars 500 --pairs 50 --out scripts/data/klines-4h.json

# 3. BUILD + TRAIN + EVALUATE ML
pnpm exec tsx scripts/ml/build-training-data-mtf.ts --input scripts/data/klines-mtf.json --output scripts/data/training-data-mtf-v4.json
python3 scripts/ml/metacognitive.py train --data scripts/data/training-data-mtf-v4.json --model-dir scripts/data/models/meta-v6

# 4. DEPLOY TO PRODUCTION (Hetzner)
# See "Hetzner Deployment" section below
```

---

## File Map — What Every File Does

### Pine Scripts (TradingView strategies)
| File | Lines | Purpose |
|------|-------|---------|
| `scripts/icr-sniper-mtf-v6.pine` | 1,287 | Production MTF strategy — 1h SMC + BB/AO continuous |
| `scripts/icr-smc-engine-v5.pine` | 1,434 | SMC v5.0 (deprecated gates, reference only) |
| `scripts/icr-smc-engine.pine` | 1,057 | v4.0 with risk management (baseline) |

### TradingView Automation (CDP)
| File | Lines | Purpose |
|------|-------|---------|
| `scripts/tv-deploy-v6.mjs` | ~150 | Inject Pine Script + compile via CDP |
| `scripts/tv-sweep-v4.mjs` | ~80 | Loop symbols, extract Strategy Tester metrics |
| `scripts/tv-inject-v4.mjs` | ~30 | Quick inject only |

### Data Pipeline
| File | Lines | Purpose |
|------|-------|---------|
| `scripts/fetch-klines.mjs` | ~120 | Binance → JSON (single TF) |
| `scripts/fetch-klines-mtf.mjs` | ~200 | Binance → JSON (4h/1h/15m aligned) |
| `scripts/data/klines-mtf.json` | 7.4 MB | 50 pairs × 3 TF (cached) |
| `scripts/data/training-data-mtf-v4.json` | ~15 MB | 40K labeled feature rows |

### ML Pipeline
| File | Lines | Purpose |
|------|-------|---------|
| `scripts/ml/build-training-data-mtf.ts` | 1,525 | Feature engineering — 62 features per bar |
| `scripts/ml/metacognitive.py` | ~1,040 | 6-layer metacognitive ML training |
| `scripts/ml/train_model.py` | 523 | Single-TF LightGBM training |
| `scripts/ml/optimize-params.py` | 746 | SHAP-based parameter grid search |
| `scripts/ml/intelligent-fibs.ts` | 389 | Auto-fibonacci detection |
| `src/server/analysis/ml/metacognitive-inference.ts` | 372 | TS production inference server |

### Models (trained artifacts)
| File | Description |
|------|-------------|
| `scripts/data/models/meta-v6/lgbm_base.txt` | LightGBM classifier (584 KB, 200 trees) |
| `scripts/data/models/meta-v6/calibrator.pkl` | Isotonic probability calibrator |
| `scripts/data/models/meta-v6/lgbm_adversary.txt` | Harm predictor (MAE > 2R) |
| `scripts/data/models/meta-v6/edge_matrix.json` | 6-regime KMeans edge multipliers |
| `scripts/data/models/meta-v6/shap_importance.json` | SHAP feature importance |
| `scripts/data/models/meta-v6/calibrated_threshold.json` | Decision threshold data |

---

## TradingView Backtest Workflow

### Prerequisites
1. TradingView Desktop running with `--remote-debugging-port=9222`
2. Pine Script open in the editor (the deploy script opens it automatically)
3. The strategy added to chart (Ctrl+Enter from Pine Editor)

### Step-by-step backtest

```bash
# 1. Ensure TradingView is running with CDP
curl -s http://localhost:9222/json/version  # Should return JSON

# 2. Deploy the latest Pine Script
node scripts/tv-deploy-v6.mjs
# Output: "Inject: ok" → "✓ No errors!" → strategy on chart

# 3. Run a sweep on Coinlegs lesser-known pairs (4h timeframe)
node scripts/tv-sweep-v4.mjs \
  --symbols "MAVUSDT,PLUMEUSDT,WCTUSDT,XPLUSDT,OPNUSDT,HEIUSDT,SKLUSDT,LINEAUSDT,ESPUSDT,LAUSDT" \
  --tf 4h

# 4. Results appear in console as a table. Screenshots in scripts/tv-backtest-results/
```

### What the sweep measures
- Trades, Win Rate, Profit Factor, Sharpe Ratio, Max Drawdown
- Per-symbol breakdown + aggregate average
- Screenshot of Strategy Tester panel per symbol

### Current best-performing pairs (v6.2, lesser-known alts)
PLUMEUSDT (PF 1.42), OPNUSDT (PF 1.36), XPLUSDT (PF 1.22), WCTUSDT (PF 1.18)

---

## ML Pipeline Workflow

### Full retraining cycle

```bash
# STEP 1: Fetch fresh klines (if data is stale)
node scripts/fetch-klines-mtf.mjs --pairs 50 --bars 500 --out scripts/data/klines-mtf.json
# Takes ~2 minutes. 50 pairs × 3 timeframes × 500 bars = 25,000 raw candles.

# STEP 2: Build training features
cd /home/ariel/anavitrade-trading
pnpm exec tsx scripts/ml/build-training-data-mtf.ts \
  --input scripts/data/klines-mtf.json \
  --output scripts/data/training-data-mtf-v4.json
# Takes ~30 seconds. Produces 40,000 labeled rows, 62 features each.

# STEP 3: Train metacognitive model
python3 scripts/ml/metacognitive.py train \
  --data scripts/data/training-data-mtf-v4.json \
  --model-dir scripts/data/models/meta-v6
# Takes ~3 minutes. Outputs AUC, Brier, regime matrix, SHAP analysis.

# STEP 4: Check results
cat scripts/data/models/meta-v6/shap_importance.json | python3 -c \
  "import json,sys; d=json.load(sys.stdin); [print(f'{f[\"rank\"]}. {f[\"feature\"]}: {f[\"importance\"]:.4f}') for f in d['top_features'][:10]]"
```

### Current model state (meta-v6)
- AUC: 0.59 (stuck — labeling bottleneck, not feature bottleneck)
- Brier: 0.24 (post-isotonic: 0.19)
- Regimes: 6 clusters, edge 0.68x – 1.12x
- Best features: h1_fvg_size_atr, h4_bb_width_pct, h4_ma_separation_atr
- Threshold: P(win) > 0.682 → 1.1% pass rate at 89% WR

### CORTEX health-gated training
```bash
# Use the CORTEX module instead of raw training — verifies improvement
node scripts/cortex/modules/metacognitive-train.js
# Reads CORTEX_DATASET and CORTEX_MODEL_DIR env vars
# Verifies: AUC didn't degrade, Brier didn't spike, data is fresh
# Writes to: scripts/cortex/memory/metacognitive-train.jsonl
```

---

## Hetzner Deployment

### Server specs (CPX31, Ashburn VA)
- 4 vCPU, 8 GB RAM, 80 GB SSD
- $15/month
- 1-3ms latency to Binance (AWS us-east-1)
- Static IPv4 included
- Ubuntu 24.04 LTS

### Initial setup
```bash
# 1. SSH in
ssh root@<server-ip>

# 2. Install dependencies
apt update && apt install -y nodejs npm python3 python3-pip git redis-server

# 3. Install Node (via nvm for v22)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc
nvm install 22

# 4. Install Python ML packages
pip3 install --break-system-packages \
  numpy pandas scikit-learn lightgbm shap skl2onnx onnxruntime

# 5. Clone repo
git clone https://github.com/<your-user>/anavitrade-trading.git
cd anavitrade-trading
pnpm install

# 6. Set environment variables
cat > .env << 'EOF'
ENCRYPTION_KEY=<generate-32-byte-hex>
JWT_SECRET=<generate-32-byte-hex>
VITE_WALLETCONNECT_PROJECT_ID=<your-walletconnect-id>
ASTER_BUILDER_ADDRESS=<your-builder-address>
EOF

# 7. Start Redis
systemctl enable --now redis-server

# 8. Start the execution server
pm2 start src/server/execution/production/server.js --name anavitrade-execution
pm2 save
```

### Running backtests on Hetzner
```bash
# Hetzner doesn't have TradingView Desktop (no GUI).
# Use the ML pipeline for backtesting instead of TV:

# 1. Fetch fresh data
node scripts/fetch-klines-mtf.mjs --pairs 50 --bars 500

# 2. Build features
pnpm exec tsx scripts/ml/build-training-data-mtf.ts \
  --input scripts/data/klines-mtf.json \
  --output scripts/data/training-data-mtf-v4.json

# 3. Train and evaluate
python3 scripts/ml/metacognitive.py train \
  --data scripts/data/training-data-mtf-v4.json \
  --model-dir scripts/data/models/meta-$(date +%Y%m%d)

# 4. Run corpus backtest (uses pre-labeled Coinlegs signals)
node scripts/unified-backtest.mjs
```

### Running ML inference in production
```bash
# Python model serves base probabilities
python3 scripts/ml/metacognitive.py infer \
  --features <(echo '{"h4_bb_width_pct": 2.3, "h1_fvg_distance_atr": 0.5, ...}') \
  --model-dir scripts/data/models/meta-v6

# TypeScript wrapper applies metacognitive layers (regime, drift, recency)
pnpm exec tsx src/server/analysis/ml/metacognitive-inference.ts score \
  <feature-row.json>
```

### Monitoring (to be set up)
```bash
# Prometheus metrics at :9090
# Grafana dashboard at :3000
# Health check at /health
curl http://<server-ip>:3001/health
```

---

## Architecture — Signal to Execution

```
Binance REST API
    ↓ (every 5 min via cron)
KlineFetcher.updateAll()
    ↓
enrichCandles() → MA, ATR, RSI, BB, AO
    ↓
buildIcrSignal() → SMC patterns + continuous measurements
    ↓
Metacognitive inference:
  Layer 1: LightGBM → raw P(win)
  Layer 2: Isotonic calibration → calibrated P(win)
  Layer 3: Regime KMeans → edge multiplier
  Layer 4: Adversary → risk discount
  Layer 5: Drift detection → confidence ceiling
  Layer 6: Recency EMA → adaptation multiplier
    ↓
Meta-confidence > calibrated threshold (0.682)?
    ↓ YES
TradeIntent → ExecutionJob
    ↓ (parallel fan-out)
CEX adapter (Binance) + DEX adapter (Aster)
    ↓
OrderEvent → NAV snapshot → Fee accrual
    ↓
Feedback loop: actual outcome → update recency → detect drift
```

---

## Known Issues & Bottlenecks

| Issue | Impact | Fix |
|-------|--------|-----|
| AUC stuck at 0.59 | Model doesn't separate winners from losers well | Try shorter labeling windows, structural stop/TP, more pairs |
| Pine Script gates too restrictive | ~0.09 trades/symbol/day | Relax SMC proximity from 1.5 to 2.5 ATR zone width |
| Monaco CDP injection fragile | Sometimes needs manual paste into TV | Floating dialog more reliable than bottom panel |
| 1h SMC fires on only 3-30% of bars | Not enough signal for ML to learn from | Use the continuous distance/size features, not binary flags |
| Training data labeling uses fixed ATR stop/TP | Mechanical labeling may not match actual trade structure | Use SMC-zone-based stops and fib-extension-based TPs for labels |

## Claude Session Recovery

If `/clear` is used, restore context with:
```bash
cat docs/ops/SYSTEM_OPERATIONS.md | head -100   # Quick re-orientation
cat docs/plans/2026-07-15-production-pipeline.md # Master plan
ls scripts/data/models/meta-v6/                   # Latest model
```
