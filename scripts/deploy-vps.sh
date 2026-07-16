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
    echo "  rsync -avz --exclude '__pycache__/' --exclude '*.pkl' --exclude '*.pyc' --exclude '*.json' \\"
    echo "        scripts/ml/ $VPS_USER@$VPS_IP:$VPS_DIR/scripts/ml/"
else
    rsync -avz --exclude '__pycache__/' --exclude '*.pkl' --exclude '*.pyc' --exclude '*.json' \
        scripts/ml/ "$VPS_USER@$VPS_IP:$VPS_DIR/scripts/ml/"
fi

# ── 2. Sync the fetch-klines scripts ──
echo "[2/3] Syncing fetch scripts..."
if $DRY_RUN; then
    echo "  rsync -avz scripts/fetch-klines-mtf.mjs scripts/fetch-klines.mjs \\"
    echo "        $VPS_USER@$VPS_IP:$VPS_DIR/scripts/"
else
    rsync -avz scripts/fetch-klines-mtf.mjs scripts/fetch-klines.mjs \
        "$VPS_USER@$VPS_IP:$VPS_DIR/scripts/"
fi

# ── 3. Set up cron job (runs every 6 hours) ──
#    Removes any old vps-train cron entries before adding the current one
echo "[3/3] Setting up cron job..."
CRON_JOB="0 */6 * * * cd $VPS_DIR && bash scripts/ml/vps-train.sh >> /var/log/anavitrade-train.log 2>&1"
if $DRY_RUN; then
    echo "  Would add: $CRON_JOB"
else
    ssh "$VPS_USER@$VPS_IP" "crontab -l 2>/dev/null | grep -v 'vps-train' | { cat; echo '$CRON_JOB'; } | crontab -"
    echo "  Cron job installed (every 6 hours)"
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
