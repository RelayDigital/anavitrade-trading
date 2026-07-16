#!/bin/bash
# ═══ HETZNER TRAINING PIPELINE ═══
# Run this on the VPS (5.161.229.209) to:
#   1. Fetch fresh klines from Binance (VPS has static IP — no geo-block)
#   2. Build training data with structural reward labels
#   3. Train the metacognitive model
#   4. Save model to /opt/anavitrade/models/
#
# Usage:
#   ssh root@5.161.229.209 'bash /opt/anavitrade/scripts/ml/vps-train.sh'
#   # Or as cron: 0 */6 * * * bash /opt/anavitrade/scripts/ml/vps-train.sh >> /var/log/anavitrade-train.log 2>&1

set -e

cd /opt/anavitrade
export PYTHONPATH=/opt/anavitrade/scripts/ml
DATE=$(date +%Y%m%d-%H%M)

echo "=== Anavitrade Training Pipeline — $DATE ==="

# 1. Fetch klines from Binance (VPS has static IP — may be geo-blocked; handle gracefully)
echo "[1/4] Fetching klines from Binance (safe — continues on failure)..."
if node scripts/fetch-klines-mtf.mjs --pairs 20 --bars 300; then
  echo "  Klines fetched successfully"
else
  echo "  ⚠ Fetch failed (geo-blocked or rate-limited) — using existing cached data"
fi

# 2. Fetch macro context (graceful — data may already exist)
echo "[2/4] Fetching macro context..."
if python3 scripts/ml/fetch-macro.py --update; then
  echo "  Macro context updated"
else
  echo "  ⚠ Macro fetch failed — using existing cached data"
fi

# 3. Build training data + train model
echo "[3/4] Building training data + training..."
python3 scripts/ml/train.py --tf 1h

# 4. Copy model to production location
echo "[4/4] Deploying model..."
MODEL_DIR=$(ls -td scripts/data/models/meta-v*/ 2>/dev/null | head -1)
if [ -n "$MODEL_DIR" ]; then
    cp "$MODEL_DIR"/*.pkl "$MODEL_DIR"/*.txt "$MODEL_DIR"/*.json /opt/anavitrade/models/ 2>/dev/null || true
    echo "  Model deployed from $MODEL_DIR"
fi

echo "=== Training complete — $DATE ==="
