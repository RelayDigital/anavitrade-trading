#!/bin/bash
# ═══ VPS HONEST TESTING PIPELINE — replaces vps-train.sh's cron slot ═══
#
# Why this exists: vps-train.sh (the previous cron job, every 6h) called the
# leaky scripts/ml/train.py path (threshold selected on the test set itself —
# see docs/prd/2026-07-17-honest-ml-validation-gate.md) and then blind-`cp`'d
# EVERY scripts/data/models/meta-v*/ directory into production with no
# pass/fail gating at all. This script replaces that with the one honest,
# purged/embargoed methodology already built and validated this session:
# scripts/ml/locked-walkforward-backtest.py. It deploys a model ONLY when
# that gate's own acceptance criteria pass (>=200 test trades, PF>1, etc.).
#
# On failure: the existing champion/ is left untouched and the failure is
# logged to the ledger, never to a paging exit code — a bad cron run should
# not alarm anyone; the ledger is the source of truth (same philosophy as
# scripts/cortex/modules/metacognitive-train.js, which this supersedes for
# the meta-v22 lineage).
#
# Continuous coverage, not continuous re-fetching: rather than refreshing
# candles for the same fixed pair list forever, each run pulls a fresh batch
# of ALTCOINS NOT YET TESTED via select-untested-pairs.py (state tracked in
# scripts/cortex/memory/tested-pairs.json) and tests those. Deliberately
# biased toward smaller-liquidity alts, not top-volume names -- the edge has
# repeatedly shown up on smaller/lesser-known alts (EMPIRICAL_FINDINGS.md),
# not mega-caps. Once the whole universe has been tested once, it cycles.
#
# Usage:
#   bash scripts/ml/vps-locked-gate.sh                # normal run
#   bash scripts/ml/vps-locked-gate.sh --dry-run       # fetch + gate, no deploy
#
# Cron (daily — this corpus does not need 6h freshness; the live rule-engine
# signal path has its own 5-min D1 refresh via kline-cron.ts, kept separate):
#   0 3 * * * cd /opt/anavitrade && bash scripts/ml/vps-locked-gate.sh >> /var/log/anavitrade-locked-gate.log 2>&1

set -uo pipefail  # deliberately no -e: a failed step must still reach the ledger write

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
export PYTHONPATH="$REPO_ROOT"

# cron runs with a minimal environment -- load .env the same way it'd be
# available in an interactive shell (other scripts in this pipeline read
# vars from it). NOTE: select-untested-pairs.py no longer needs a live
# Binance call at all -- fapi.binance.com is geo-blocked from this VPS at
# the IP level, and BINANCE_API_KEY does NOT bypass it (confirmed
# empirically 2026-07-19). It reads a static, periodically-refreshed
# snapshot instead (scripts/data/pairs/altcoin-universe-snapshot.json,
# regenerated via --refresh-snapshot from a non-blocked environment).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
  esac
done

DATE=$(date +%Y%m%d)
# binance_archive.py only serves COMPLETED monthly archives (data.binance.vision has
# no current-month endpoint) -- the current in-progress month 404s. End the window at
# the last day of the most recently completed month, not "today".
END=$(date -d "$(date +%Y-%m-01) -1 day" +%Y-%m-%d 2>/dev/null || date -v-1d -v1d +%Y-%m-%d)
START=$(date -d "$END -120 days" +%Y-%m-%d 2>/dev/null || date -jf %Y-%m-%d -v-120d "$END" +%Y-%m-%d)
BATCH_SIZE=20
PAIRS_FILE="scripts/data/pairs/locked-gate-batch-${DATE}.json"
TESTED_STATE="scripts/cortex/memory/tested-pairs.json"
CORPUS="scripts/data/klines-locked-gate-${DATE}.json"
OUTPUT_DIR="scripts/data/models/locked-gate-${DATE}"
CHAMPION_DIR="/opt/anavitrade/models/champion"
LEDGER="scripts/cortex/memory/locked-gate.jsonl"

mkdir -p "$(dirname "$LEDGER")"

echo "=== VPS locked-gate run — ${DATE} (window ${START}..${END}) ==="

echo "[1/4] Selecting today's untested-altcoin batch..."
python3 scripts/ml/select-untested-pairs.py \
  --batch-size "$BATCH_SIZE" \
  --output "$PAIRS_FILE" \
  --state "$TESTED_STATE"
SELECT_STATUS=$?

if [ $SELECT_STATUS -ne 0 ] || [ ! -f "$PAIRS_FILE" ]; then
  echo "[1/4] FAILED — pair selection error, aborting without touching champion/"
  python3 -c "
import json, datetime
entry = {'ts': datetime.datetime.utcnow().isoformat()+'Z', 'status': 'error',
         'stage': 'select_pairs', 'passed': False}
with open('$LEDGER', 'a') as f: f.write(json.dumps(entry) + '\n')
"
  exit 0
fi

echo "[2/4] Fetching checksum-verified corpus (${PAIRS_FILE})..."
python3 scripts/ml/binance_archive.py \
  --pairs-file "$PAIRS_FILE" \
  --start "$START" --end "$END" \
  --output "$CORPUS" \
  --verify-checksums
FETCH_STATUS=$?

if [ $FETCH_STATUS -ne 0 ] || [ ! -f "$CORPUS" ]; then
  echo "[2/4] FAILED — corpus fetch error, aborting without touching champion/"
  python3 -c "
import json, datetime
entry = {'ts': datetime.datetime.utcnow().isoformat()+'Z', 'status': 'error',
         'stage': 'fetch', 'passed': False}
with open('$LEDGER', 'a') as f: f.write(json.dumps(entry) + '\n')
"
  exit 0
fi

echo "[3/4] Running locked-walkforward-backtest.py..."
python3 scripts/ml/locked-walkforward-backtest.py \
  --input "$CORPUS" \
  --output-dir "$OUTPUT_DIR"
GATE_STATUS=$?

REPORT="$OUTPUT_DIR/report.json"
if [ $GATE_STATUS -ne 0 ] || [ ! -f "$REPORT" ]; then
  echo "[3/4] FAILED — locked-walkforward-backtest.py error, aborting without touching champion/"
  python3 -c "
import json, datetime
entry = {'ts': datetime.datetime.utcnow().isoformat()+'Z', 'status': 'error',
         'stage': 'gate', 'passed': False}
with open('$LEDGER', 'a') as f: f.write(json.dumps(entry) + '\n')
"
  exit 0
fi

echo "[4/4] Evaluating gate result and (conditionally) deploying..."
python3 -c "
import json, datetime, shutil, os, sys

report = json.load(open('$REPORT'))
test = report.get('test', {})
metrics = test.get('metrics', {})
acceptance = test.get('acceptance', {})
passed = bool(acceptance.get('passed'))

entry = {
    'ts': datetime.datetime.utcnow().isoformat() + 'Z',
    'status': 'trained',
    'stage': 'evaluated',
    'pairs_file': '$PAIRS_FILE',
    'symbols': report.get('input', {}).get('symbols'),
    'corpus': '$CORPUS',
    'output_dir': '$OUTPUT_DIR',
    'input_sha256': report.get('input', {}).get('sha256'),
    'trades': metrics.get('trades'),
    'winRate': metrics.get('winRate'),
    'profitFactor': metrics.get('profitFactor'),
    'maxDrawdownPct': metrics.get('maxDrawdownPct'),
    'acceptance': acceptance,
    'passed': passed,
    'dry_run': $( [ "$DRY_RUN" = true ] && echo True || echo False ),
}

with open('$LEDGER', 'a') as f:
    f.write(json.dumps(entry) + '\n')

if not passed:
    print(f'[4/4] GATE FAILED — trades={metrics.get(\"trades\")}, '
          f'winRate={metrics.get(\"winRate\")}, profitFactor={metrics.get(\"profitFactor\")}. '
          f'champion/ left untouched.')
    sys.exit(0)

if $( [ "$DRY_RUN" = true ] && echo True || echo False ):
    print('[4/4] GATE PASSED but --dry-run set — not deploying to champion/')
    sys.exit(0)

model_dir = os.path.join('$OUTPUT_DIR', 'model')
os.makedirs('$CHAMPION_DIR', exist_ok=True)
for name in ('classifier.txt', 'model_card.json'):
    src = os.path.join(model_dir, name)
    if os.path.exists(src):
        shutil.copy2(src, os.path.join('$CHAMPION_DIR', name))
print(f'[4/4] GATE PASSED — deployed {model_dir} to $CHAMPION_DIR')
"

echo "=== VPS locked-gate run complete — ${DATE} ==="
exit 0
