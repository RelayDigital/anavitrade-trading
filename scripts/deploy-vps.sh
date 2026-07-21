#!/bin/bash
# ═══ VPS Deployment Script ═══
# Syncs ML pipeline files to Hetzner VPS and sets up cron.
#
# Usage:
#   bash scripts/deploy-vps.sh          # Full deploy
#   bash scripts/deploy-vps.sh --dry    # Dry run (no SSH)
#
# Prerequisites:
#   - SSH key-based auth to root@5.161.229.209
#   - VPS has /opt/anavitrade/ directory with git clone

set -e

VPS_IP="5.161.229.209"
VPS_USER="root"
VPS_DIR="/opt/anavitrade"

DRY_RUN=false
if [[ "$1" == "--dry" ]]; then
    DRY_RUN=true
    echo "=== DRY RUN MODE ==="
fi

echo "=== Deploy Anavitrade ML Pipeline to VPS ==="
echo "  VPS: $VPS_USER@$VPS_IP:$VPS_DIR"
echo ""

# ── 1. Sync the scripts/ml directory (excluding large/generated files) ──
echo "[1/3] Syncing scripts/ml/..."
if $DRY_RUN; then
    echo "  rsync -avz --exclude 'venv/' --exclude '__pycache__/' --exclude '*.pkl' --exclude '*.pyc' --exclude '*.json' scripts/ml/ $VPS_USER@$VPS_IP:$VPS_DIR/scripts/ml/"
else
    rsync -avz --exclude 'venv/' --exclude '__pycache__/' --exclude '*.pkl' --exclude '*.pyc' --exclude '*.json' \
        scripts/ml/ "$VPS_USER@$VPS_IP:$VPS_DIR/scripts/ml/"
fi

# ── 2. Sync the fetch and canonical Worker-sync scripts ──
echo "[2/3] Syncing fetch scripts..."
if $DRY_RUN; then
    echo "  rsync -avz scripts/fetch-klines-mtf.mjs scripts/fetch-klines.mjs $VPS_USER@$VPS_IP:$VPS_DIR/scripts/"
    echo "  rsync -avz src/server/analysis/kline-cron.ts $VPS_USER@$VPS_IP:$VPS_DIR/src/server/analysis/"
else
    rsync -avz scripts/fetch-klines-mtf.mjs scripts/fetch-klines.mjs \
        "$VPS_USER@$VPS_IP:$VPS_DIR/scripts/"
    rsync -avz src/server/analysis/kline-cron.ts \
        "$VPS_USER@$VPS_IP:$VPS_DIR/src/server/analysis/"
    ssh "$VPS_USER@$VPS_IP" "cd $VPS_DIR && docker compose build execution >/var/log/anavitrade-execution-build.log 2>&1 && docker compose up -d execution"
fi

# ── 3. Set up cron jobs ──
#    Removes any old vps-train cron entries before adding the current one
echo "[3/3] Setting up cron job..."
TRAIN_CRON="0 */6 * * * cd $VPS_DIR && bash scripts/ml/vps-train.sh >> /var/log/anavitrade-train.log 2>&1"
KLINE_CRON="*/5 * * * * docker exec -e KLINE_FETCH_LIMIT=5 anavitrade-execution pnpm exec tsx /app/src/server/analysis/kline-cron.ts >> /var/log/anavitrade-kline-sync.log 2>&1"
if $DRY_RUN; then
    echo "  Would add: $TRAIN_CRON"
    echo "  Would add: $KLINE_CRON"
else
    ssh "$VPS_USER@$VPS_IP" "crontab -l 2>/dev/null | grep -v 'vps-train' | grep -v 'kline-cron' | grep -v 'sync-klines-to-worker' | { cat; echo '$TRAIN_CRON'; echo '$KLINE_CRON'; } | crontab -"
    echo "  Training cron installed (every 6 hours)"
    echo "  Kline sync cron installed (every 5 minutes)"
fi

echo ""
echo "=== Deployment complete ==="
echo ""
echo "Verify with:"
echo "  ssh $VPS_USER@$VPS_IP 'ls -la $VPS_DIR/scripts/ml/'"
echo "  ssh $VPS_USER@$VPS_IP 'crontab -l'"
echo ""
echo "Run training manually:"
echo "  ssh $VPS_USER@$VPS_IP 'cd $VPS_DIR && bash scripts/ml/vps-train.sh'"
echo ""
echo "Monitor logs:"
echo "  ssh $VPS_USER@$VPS_IP 'tail -f /var/log/anavitrade-train.log'"
echo "  ssh $VPS_USER@$VPS_IP 'tail -f /var/log/anavitrade-kline-sync.log'"
echo ""
echo "Initial warmup (run once after setting WORKER_URL and INTERNAL_SECRET):"
echo "  ssh $VPS_USER@$VPS_IP 'docker exec -e KLINE_FETCH_LIMIT=300 anavitrade-execution pnpm exec tsx /app/src/server/analysis/kline-cron.ts'"
