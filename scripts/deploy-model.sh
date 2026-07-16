#!/bin/bash
# ============================================================================
# Deploy meta-v20 MTF model to Hetzner VPS for live inference.
#
# Prerequisites:
#   1. SSH access to root@5.161.229.209 configured (key-based auth)
#   2. Python 3.12+ with lightgbm, sklearn, numpy on VPS
#
# What gets deployed:
#   /opt/anavitrade/models/classifier.pkl      (LightGBM model)
#   /opt/anavitrade/models/classifier.txt       (LightGBM text dump)
#   /opt/anavitrade/models/model_card.json      (features + threshold + metrics)
#   /opt/anavitrade/infer.py                    (inference script)
#
# Usage:
#   bash scripts/deploy-model.sh                # normal deploy
#   bash scripts/deploy-model.sh --dry-run      # show what would happen
#   bash scripts/deploy-model.sh --skip-test    # skip VPS smoke test
# ============================================================================
set -euo pipefail

VPS_IP="5.161.229.209"
VPS_USER="root"
VPS_MODEL_DIR="/opt/anavitrade/models"
VPS_SCRIPT_DIR="/opt/anavitrade"

# local paths
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_SRC="$REPO_ROOT/scripts/data/models/meta-v20-mtf-context"
SCRIPT_SRC="$REPO_ROOT/scripts/ml/infer.py"

DRY_RUN=false
SKIP_TEST=false

# -- arg parsing -------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --skip-test) SKIP_TEST=true ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# -- validate local files ----------------------------------------------------
echo "---[ meta-v20 model deploy ]---"
echo ""

if [ ! -f "$MODEL_SRC/classifier.pkl" ]; then
  echo "ERROR: classifier.pkl not found at $MODEL_SRC" >&2
  exit 1
fi
if [ ! -f "$MODEL_SRC/model_card.json" ]; then
  echo "ERROR: model_card.json not found at $MODEL_SRC" >&2
  exit 1
fi
if [ ! -f "$SCRIPT_SRC" ]; then
  echo "ERROR: infer.py not found at $SCRIPT_SRC" >&2
  exit 1
fi

echo "  Source model:     $MODEL_SRC"
echo "  Source script:    $SCRIPT_SRC"
echo "  VPS target:       $VPS_USER@$VPS_IP:$VPS_MODEL_DIR"
echo ""

# -- dry-run -----------------------------------------------------------------
if $DRY_RUN; then
  echo "---[ DRY RUN — no files copied ]---"
  echo ""
  echo "Would run:"
  echo "  ssh $VPS_USER@$VPS_IP mkdir -p $VPS_MODEL_DIR"
  echo "  scp $MODEL_SRC/classifier.pkl      $VPS_USER@$VPS_IP:$VPS_MODEL_DIR/"
  echo "  scp $MODEL_SRC/classifier.txt       $VPS_USER@$VPS_IP:$VPS_MODEL_DIR/"
  echo "  scp $MODEL_SRC/model_card.json      $VPS_USER@$VPS_IP:$VPS_MODEL_DIR/"
  echo "  scp $SCRIPT_SRC                     $VPS_USER@$VPS_IP:$VPS_SCRIPT_DIR/"
  echo ""
  exit 0
fi

# -- deploy ------------------------------------------------------------------
echo "---[ 1/4  creating remote directories ]---"
ssh "$VPS_USER@$VPS_IP" "mkdir -p $VPS_MODEL_DIR"

echo "---[ 2/4  copying model files ]---"
scp "$MODEL_SRC/classifier.pkl"  "$VPS_USER@$VPS_IP:$VPS_MODEL_DIR/"
scp "$MODEL_SRC/classifier.txt"  "$VPS_USER@$VPS_IP:$VPS_MODEL_DIR/"
echo "  classifier.pkl  OK"
echo "  classifier.txt  OK"

if [ -f "$MODEL_SRC/model_card.json" ]; then
  scp "$MODEL_SRC/model_card.json" "$VPS_USER@$VPS_IP:$VPS_MODEL_DIR/"
  echo "  model_card.json OK"
fi

echo "---[ 3/4  copying inference script ]---"
scp "$SCRIPT_SRC" "$VPS_USER@$VPS_IP:$VPS_SCRIPT_DIR/"
echo "  infer.py OK"

# -- smoke test --------------------------------------------------------------
if $SKIP_TEST; then
  echo "---[ 4/4  smoke test SKIPPED ]---"
else
  echo "---[ 4/4  smoke test on VPS ]---"
  echo ""

  # shellcheck disable=SC2087
  ssh "$VPS_USER@$VPS_IP" bash << 'REMOTE_CHECKS'
set -e
MODEL_DIR="/opt/anavitrade/models"

echo "  Python version: $(python3 --version)"

# load model + run dummy inference
python3 -c "
import pickle, json
from pathlib import Path
import numpy as np

model_dir = Path('$MODEL_DIR')
with open(model_dir / 'classifier.pkl', 'rb') as f:
    clf = pickle.load(f)
with open(model_dir / 'model_card.json') as f:
    card = json.load(f)

print(f'  Model type:       {type(clf).__name__}')
print(f'  Features:         {len(card[\"features\"])}')
print(f'  Threshold:        {card[\"threshold\"]}')
print(f'  Test WR:          {card[\"test_wr\"]}  ({card[\"test_trades\"]} trades)')
print(f'  Training rows:    {card[\"n\"]}')

# dummy zero-input (all features = 0)
dummy = np.zeros((1, 30), dtype=np.float32)
proba = float(clf.predict_proba(dummy)[0, 1])
decision = 'TRADE' if proba >= float(card['threshold']) else 'SKIP'
print(f'  Zero-input proba: {proba:.6f} → {decision}')

# random features
rng = np.random.default_rng(42)
for _ in range(3):
    x = rng.random((1, 30), dtype=np.float32)
    p = float(clf.predict_proba(x)[0, 1])
    d = 'TRADE' if p >= float(card['threshold']) else 'SKIP'
    print(f'  Random proba:     {p:.6f} → {d}')

print()
print('  OK — model loads and predicts correctly')
"

# test infer.py imports
python3 -c "
import sys
sys.path.insert(0, '/opt/anavitrade')
from infer import InferenceEngine
engine = InferenceEngine()
# Build zero vector from model's feature names
dummy = {f: 0 for f in engine.feature_names}
r = engine.predict(dummy)
print(f'  infer.py import OK — zero predict: proba={r[\"proba\"]} -> {r[\"decision\"]}')
"
REMOTE_CHECKS
fi

echo ""
echo "=== Deployment complete ==="
echo "  Model:  $VPS_USER@$VPS_IP:$VPS_MODEL_DIR"
echo "  Script: $VPS_USER@$VPS_IP:$VPS_SCRIPT_DIR/infer.py"
echo ""
echo "Quick test on VPS:"
echo "  ssh $VPS_USER@$VPS_IP 'python3 /opt/anavitrade/infer.py --features "
echo '    '\''{"h1_rsi":50,"h4_rsi":52,"m15_rsi":48,"h1_macd":0.5,...}'\'
echo "  "
