# Anavitrade Production Infrastructure & Execution Server Plan

**Date:** 2026-07-15 | **Status:** DRAFT | **Dependencies:** Market research PRDs (complete), Production pipeline master plan

---

## Overview

This plan covers the provisioning, deployment, security, and monitoring of a dedicated execution server on a VPS with a static IPv4 address. This solves the fundamental production blocker: Cloudflare Workers share egress IPs, making exchange API key IP whitelisting impossible. The execution code moves to the VPS; signal generation, the dashboard API, and D1 remain on the Worker.

## Architecture: Worker + VPS Split

```
                    ┌──────────────────────────────┐
                    │   Cloudflare Worker (Edge)    │
                    │  • Dashboard API (tRPC)       │
                    │  • Coinlegs scraper + mirror  │
                    │  • Signal detection + ICR     │
                    │  • SMC validation             │
                    │  • TradeIntent creation       │
                    │  • D1 database (source of     │
                    │    truth)                     │
                    │  • NEW: /api/internal/        │
                    │    (connections + kill-state  │
                    │    + report-execution)        │
                    └────────────┬─────────────────┘
                                 │  HTTPS (x-internal-secret header auth)
                                 ▼
                    ┌──────────────────────────────┐
                    │  Execution Server (Hetzner    │
                    │  Ashburn CPX31, static IPv4)  │
                    │  • Polls Worker for intents   │
                    │  • Decrypts creds locally     │
                    │  • CEX + Aster order fan-out  │
                    │  • Risk engine (pre-trade)    │
                    │  • Reports fills to Worker    │
                    │  • ML inference (ONNX, CPU)   │
                    │  • Prometheus + Grafana       │
                    │  • Telegram alerts            │
                    └────────────┬─────────────────┘
                                 │  Static IPv4
                                 ▼
                       Exchange APIs (Binance,
                       Bybit, OKX, Kraken, KuCoin,
                       Gate.io, Coinbase, Bitunix,
                       Aster DEX)
```

### What Moves vs What Stays

| Component | Stays on Worker | Moves to VPS | Notes |
|-----------|:---:|:---:|-------|
| D1 database | X | | VPS reads via Worker API |
| Coinlegs scraper | X | | External API calls, Worker-appropriate |
| Signal detection (ICR/SMC) | X | | Compute-bound, stays close to DB |
| TradeIntent creation | X | | Writes to D1 |
| Execution fan-out | | X | Needs static egress IP |
| CEX client code (binance.ts, etc.) | | X | Uses `fetch()` + `crypto.subtle`, portable to Node 18+ |
| Signing helpers (signing.ts) | Shared | Shared | Pure Web Crypto, works in both runtimes |
| Risk engine (riskEngine.ts) | Shared | Shared | VPS runs pre-trade; Worker also checks |
| Credential decryption | | X | VPS has ENCRYPTION_KEY, decrypts locally |
| Dashboard API (tRPC) | X | | Remains on Worker |
| Kill switches | X (DB) | X (syncs) | VPS polls kill state before each cycle |
| ML inference | | X | ONNX Runtime CPU, $0 marginal cost |
| Prometheus/Grafana | | X | VPS only |
| NAV snapshots | X (D1) | X (reports) | VPS reports fills, Worker writes D1 |

---

## Phase 1: VPS Provisioning

### Provider: Hetzner CPX31 (Ashburn, VA)

**Justification**: Hetzner's Ashburn data center is colocated with AWS us-east-1 (Binance's primary region), delivering 1-3ms latency. At ~$15/month for 4 vCPU / 8 GB / 160 GB NVMe, it leaves 85% of the $100/month budget. Free always-on DDoS protection.

**Note**: Verify exact pricing before provisioning. Hetzner restructured CCX/CPX lines in June 2026 with some configs rising 176%.

### 1.1 Provision the Server

```bash
# Install Hetzner CLI
brew install hcloud  # macOS

# Create API token at https://console.hetzner.cloud/ → Security → API Tokens
hcloud context create anavitrade-prod

# Provision CPX31 in Ashburn, VA
hcloud server create \
  --name anavitrade-exec-01 \
  --type cpx31 \
  --image ubuntu-24.04 \
  --location ash \
  --ssh-key ~/.ssh/id_ed25519_anavitrade \
  --label env=production \
  --label role=execution-server

# Note the static IP
hcloud server describe anavitrade-exec-01 -o json | jq '.public_net.ipv4.ip'
```

### 1.2 Initial Server Hardening

```bash
ssh root@<vps-ip> << 'EOF'
apt update && apt upgrade -y
apt install -y ufw fail2ban unattended-upgrades

# Firewall: deny inbound, allow SSH + metrics port
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 9090/tcp comment 'execution-server metrics'
ufw enable

# SSH hardening: key-only, no root login
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload sshd

# fail2ban
cat > /etc/fail2ban/jail.local << 'JAIL'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
[sshd]
enabled = true
port = ssh
maxretry = 3
bantime = 86400
JAIL
systemctl enable fail2ban --now

# Automatic security updates
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::Unattended-Upgrade "1";
APT
systemctl restart unattended-upgrades

# Service user
adduser --disabled-password --gecos "" anavitrade
mkdir -p /opt/anavitrade
chown anavitrade:anavitrade /opt/anavitrade
EOF
```

### 1.3 Docker vs Bare Metal: Recommendation

**Docker Compose on bare metal**, managed by systemd.

**Why**:
- Single-host workload — no Kubernetes needed.
- `node:22-alpine` guarantees consistent Node.js version across dev/prod.
- ONNX Runtime `onnxruntime-node` has native binaries — Docker guarantees the right GLIBC.
- Redis, Prometheus, Grafana are trivially Dockerized.
- Full stack rebuild on a fresh Ubuntu install takes under 5 minutes.
- No nvm/fnm fragility, no manual Redis drift.

The stack layout on disk:

```
/opt/anavitrade/
├── docker-compose.yml
├── Dockerfile
├── .env                    # chmod 600, never committed
├── src/                    # Shared source tree
├── models/                 # ONNX model files
├── prometheus.yml
├── grafana/dashboards/     # Pre-configured JSON dashboard
├── grafana/datasources.yml
└── scripts/healthcheck.js
```

---

## Phase 2: Execution Server Deployment

### 2.1 Code Extraction Strategy

The CEX signing code is already portable. It uses `fetch()` (global in Node 18+) and `crypto.subtle` (global in Node 18+). The signing helpers in `src/server/cex/signing.ts` are pure Web Crypto. **Do not fork or copy — share the source tree.**

**Extraction approach:**

Create two new files that import from the existing code:

1. **`src/server/execution/server.ts`** — Entry point for the standalone process. Starts a poll loop, loads ML model, exposes health/metrics HTTP server.

2. **`src/server/execution/executor.ts`** — Core execution logic. For each poll cycle:
   - Fetches pending intents from `GET /api/internal/pending-intents`
   - Fetches active connections with encrypted credentials from `GET /api/internal/active-connections?userId=X`
   - Decrypts credentials locally using the same `decryptKey()` function (extracted from `db.ts`)
   - Runs `decideExecution()` from the shared risk engine
   - Submits orders via existing CEX clients (binance.ts, bybit.ts, etc.)
   - Reports fills via `POST /api/internal/report-execution`

### 2.2 Credential Handling: Design Decision

**Answer**: The VPS has its own copy of `ENCRYPTION_KEY` in `.env`. It fetches the **encrypted** credential blobs from the Worker API, then decrypts them locally using `decryptKey()`.

**Why NOT have the Worker decrypt and return plaintext?** That transmits unencrypted API keys over the wire. Even with mTLS, keep plaintext keys in exactly one place at a time (VPS memory, never serialized in transit).

**Why NOT have the VPS read D1 directly?** Requires Cloudflare API token on the VPS + SDK dependency. The Worker API approach keeps a single access path to D1.

### 2.3 New Worker Endpoints Required

Add to `src/server/worker.ts`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/internal/pending-intents` | GET | Returns TradeIntents with status "created" |
| `/api/internal/active-connections` | GET | Returns connections with encrypted creds, kill state |
| `/api/internal/report-execution` | POST | VPS reports fill details; Worker writes to D1 |
| `/api/internal/kill-state` | GET | Returns `{globalKill, perUserKills}` |

All endpoints require `x-internal-secret` header (64-char hex, generated via `openssl rand -hex 32`). Set as both a `wrangler secret` and in the VPS `.env`.

### 2.4 Extraction of decryptKey from db.ts

The current `encryptKey`/`decryptKey` in `src/server/db.ts` depend on the global `_env` variable (Worker-specific). Create `src/server/cex/crypto.ts` with the same AES-256-GCM logic but accepting an explicit `encryptionKey` parameter. Then refactor `db.ts` to delegate to it:

```typescript
// src/server/cex/crypto.ts (NEW)
export async function decryptKey(ciphertext: string, encryptionKey: string): Promise<string> {
  const secret = encryptionKey.slice(0, 32).padEnd(32, "0");
  const raw = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const iv = raw.slice(0, 12);
  const encrypted = raw.slice(12);
  const key = await crypto.subtle.importKey("raw",
    new TextEncoder().encode(secret.padEnd(32).slice(0, 32)),
    { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}
```

Similarly refactor `src/server/cex/store.ts`'s `decryptCexCredentials()` to accept an optional explicit `encryptionKey` parameter.

### 2.5 Docker Setup

**Dockerfile:**
```dockerfile
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY src/ ./src/
COPY tsconfig.json ./
RUN pnpm exec tsx src/server/execution/build.ts
EXPOSE 9090
CMD ["node", "dist/execution-server.js"]
```

**docker-compose.yml** includes five services:
- `execution` — The Node.js execution server (build from Dockerfile, port 9090)
- `redis:7-alpine` — Rate limit tracking, idempotency key cache, order state (256 MB max, LRU eviction)
- `prom/prometheus:latest` — Metrics collection (90-day retention)
- `grafana/grafana:latest` — Dashboards (port 3000, admin password from .env)
- `prom/node-exporter:latest` — Host-level metrics (CPU, memory, disk)

### 2.6 File Changes Summary

| File | Action |
|------|--------|
| `src/server/execution/server.ts` | **NEW** - Standalone entry point |
| `src/server/execution/executor.ts` | **NEW** - Poll loop, credential fetch, dispatch |
| `src/server/cex/crypto.ts` | **NEW** - Extracted encrypt/decrypt, no Worker dependency |
| `src/server/db.ts` | **REFACTOR** - Delegate to `cex/crypto.ts` with explicit key |
| `src/server/cex/store.ts` | **REFACTOR** - `decryptCexCredentials` accepts optional key param |
| `src/server/worker.ts` | **MODIFY** - Add 4 new `/api/internal/*` endpoints |
| `src/server/cex/binance.ts` through `gateio.ts` | **UNCHANGED** - Already portable |
| `src/server/cex/signing.ts` | **UNCHANGED** - Pure Web Crypto |
| `src/server/execution/riskEngine.ts` | **UNCHANGED** - Shared logic |
| `Dockerfile`, `docker-compose.yml`, `prometheus.yml` | **NEW** - Infrastructure configs |

---

## Phase 3: Production Secrets

### 3.1 Generate Keys

```bash
# ENCRYPTION_KEY (critical -- encrypts all user API keys at rest)
openssl rand -hex 32  # 64 hex chars → 256-bit key

# INTERNAL_SECRET (VPS-to-Worker authentication)
openssl rand -hex 32

# JWT_SECRET (must differ from ENCRYPTION_KEY)
openssl rand -hex 32

# ADMIN_API_KEY (admin endpoint auth)
openssl rand -hex 32
```

Store ENCRYPTION_KEY offline (password manager, hardware key, printed copy in safe). If lost, all users must re-enter their exchange API keys — there is no recovery.

### 3.2 Set Worker Secrets

```bash
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put INTERNAL_SECRET
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_API_KEY
```

**After setting secrets, REMOVE them from `wrangler.toml [vars]`.** The `[vars]` section should only hold dev/local values. Production deploys read secrets from the Cloudflare dashboard.

### 3.3 VPS `.env` File

Create `/opt/anavitrade/.env` with `chmod 600`, containing the same `ENCRYPTION_KEY` and `INTERNAL_SECRET` values, plus `WORKER_URL`, tuning parameters, Telegram bot credentials, and Grafana admin password.

### 3.4 Key Rotation

Every 90 days (or immediately after suspected compromise):

1. Generate new `ENCRYPTION_KEY`.
2. Run `scripts/rotate-encryption-key.ts` — queries all `cex_connections`, decrypts each `encryptedApiKey`/`encryptedApiSecret`/`encryptedPassphrase` with old key, re-encrypts with new key, writes back.
3. `wrangler secret put ENCRYPTION_KEY` + update VPS `.env`.
4. Restart Worker deploy + VPS `docker compose restart`.
5. Verify with a test order.

If the key is compromised, also force all users to rotate their exchange API keys (attacker with ENCRYPTION_KEY + D1 access can decrypt stored credentials).

---

## Phase 4: ML Inference (Same VPS)

### 4.1 Architecture

The trained LightGBM model (ONNX, ~10 MB) loads in-process on the VPS at startup. Single-row inference: ~8 microseconds on AMD EPYC. At 100K inferences/day, CPU utilization is 0.001% of one core. **Zero marginal cost.**

### 4.2 Setup

Add `onnxruntime-node` to `package.json`. The Dockerfile already includes `python3 make g++` for native compilation.

Create `src/server/analysis/ml/inference.ts`:

```typescript
import * as ort from "onnxruntime-node";

let session: ort.InferenceSession | null = null;

export async function loadModel(path?: string): Promise<void> {
  session = await ort.InferenceSession.create(
    path ?? resolve(__dirname, "../../../models/signal_scorer.onnx")
  );
}

export async function scoreSignal(features: Float32Array): Promise<number> {
  if (!session) throw new Error("Model not loaded");
  const feeds = { features: new ort.Tensor("float32", features, [1, features.length]) };
  const results = await session.run(feeds);
  return (results["probabilities"].data as Float32Array)[1]; // p(win)
}
```

Model loaded at startup in `server.ts`. `executor.ts` calls `scoreSignal()` for each pending intent, using the score to adjust position sizing or skip low-confidence signals (threshold: p(win) < 0.55).

---

## Phase 5: Monitoring

### 5.1 Prometheus Metrics (port 9090)

Use the `prom-client` npm package. Key metrics:

| Metric | Type | Labels |
|--------|------|--------|
| `anavitrade_orders_total` | Counter | exchange, status |
| `anavitrade_order_latency_seconds` | Histogram | exchange |
| `anavitrade_open_positions` | Gauge | exchange, symbol |
| `anavitrade_unrealized_pnl_usd` | Gauge | exchange, symbol |
| `anavitrade_account_equity_usd` | Gauge | exchange |
| `anavitrade_daily_pnl_usd` | Gauge | exchange |
| `anavitrade_kill_switch_active` | Gauge | — |
| `anavitrade_signals_scored_total` | Counter | — |
| `anavitrade_signal_score` | Histogram | — |
| `anavitrade_poll_loop_duration_seconds` | Histogram | — |
| `anavitrade_poll_errors_total` | Counter | — |

### 5.2 Grafana Dashboard Panels

1. **Execution Overview**: Order count (per exchange), latency p50/p95, error rate.
2. **P&L Dashboard**: Realized + unrealized PnL, daily PnL bar chart, equity curve.
3. **Risk Dashboard**: Open positions, exposure %, daily loss limit utilization.
4. **ML Monitor**: Signal score distribution, inference latency, fallback rate.
5. **System Health**: CPU, memory, disk, poll loop duration, error counters.

### 5.3 Telegram Alerts

| Alert | Condition | Level |
|-------|-----------|-------|
| Kill switch activated | `killSwitchActive == 1` | Critical |
| Drawdown > 10% | Daily PnL < -10% equity | Critical |
| Drawdown > 5% | Daily PnL < -5% equity | Warning |
| Execution failure | 3 consecutive poll errors | Critical |
| Exchange connection lost | API unreachable > 30s | Warning |
| Stale heartbeat | No orders for > 24h | Info |
| Unusual volume | > 50 orders in 5 min | Critical |
| ML model drift | P(win) calibration decay | Warning |
| Disk/memory > 90% | Host-level metrics | Warning |

### 5.4 Kill Switch Integration

**Three layers**, checked before every order:

1. **Worker API kill state** (`GET /api/internal/kill-state`) — global + per-connection + per-account kill switches, cached 1s.
2. **Risk engine checks** — daily loss limit, exposure cap, copytrade enabled — same `decideExecution()` function, reused.
3. **Local emergency kill** — if file `/opt/anavitrade/EMERGENCY_KILL` exists on the VPS, the executor halts immediately (no Worker dependency needed). Resume by removing the file and restarting.

### 5.5 External Uptime Monitoring

Use UptimeRobot (free tier, 50 monitors, 5-min checks) or Better Uptime to monitor the VPS `/health` endpoint. Cloudflare's built-in analytics cover the Worker.

---

## Phase 6: Security Hardening

Already covered in Phase 1.3 (SSH, firewall, fail2ban, unattended-upgrades). Additional hardening:

### 6.1 VPS-to-Worker Auth

The `x-internal-secret` header uses constant-time comparison on the Worker side to prevent timing attacks. **Future improvement**: Mutual TLS via Cloudflare API Shield — makes the VPS the only entity that can call internal endpoints even if the secret leaks.

### 6.2 Systemd Service

```bash
cat > /etc/systemd/system/anavitrade-execution.service << 'EOF'
[Unit]
Description=Anavitrade Execution Server
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/anavitrade
ExecStart=/usr/bin/docker compose up -d --remove-orphans
ExecStop=/usr/bin/docker compose down
ExecReload=/usr/bin/docker compose restart execution
User=anavitrade
Group=docker

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable anavitrade-execution
```

### 6.3 Docker Logging

JSON-file driver with rotation: 50 MB max per file, keep 5 files. Audit events logged via structured JSON to stdout (Docker captures).

### 6.4 Security Checklist

- [ ] SSH key-only, no passwords
- [ ] UFW active (22 + 9090 only)
- [ ] fail2ban active
- [ ] Auto-updates enabled
- [ ] Service runs as `anavitrade` (not root)
- [ ] ENCRYPTION_KEY never in source code
- [ ] `.env` chmod 600
- [ ] INTERNAL_SECRET is 64+ hex chars
- [ ] Secrets set via `wrangler secret`, not `wrangler.toml`
- [ ] Kill switch functional (3 layers)
- [ ] All exchange keys verified trade-only
- [ ] Docker `userns-remap` enabled

---

## Phase 7: Rollout Sequence

### 7.1 Pre-Flight

- [ ] Market research PRDs reviewed
- [ ] Testnet keys created on all exchanges
- [ ] Production ENCRYPTION_KEY + INTERNAL_SECRET generated and stored offline
- [ ] Hetzner account active
- [ ] SSH key pair generated
- [ ] Telegram bot + chat created
- [ ] Grafana admin password generated

### 7.2 Step 1: Provision VPS

Create CPX31 in Ashburn, run hardening script, install Docker. Note the static IPv4 — this goes on every exchange API key whitelist.

### 7.3 Step 2: Deploy Code (dry-run mode)

- Set wrangler secrets (ENCRYPTION_KEY, INTERNAL_SECRET, JWT_SECRET, ADMIN_API_KEY).
- Remove secrets from `wrangler.toml [vars]`.
- Deploy Worker with new internal endpoints.
- Deploy code to VPS with Docker Compose.
- Verify the execution server starts and polls correctly (check logs: "[exec-server] Starting...").

### 7.4 Step 3: Testnet Validation (48 hours minimum)

- Create testnet API keys, add testnet connections via dashboard.
- Set `EXECUTION_MODE=testnet` in VPS `.env`.
- Create manual TradeIntent via admin API — verify the full pipeline: VPS picks it up, submits to Binance Testnet, reports fill to Worker.
- Test kill switch (global + per-connection + emergency file) — verify VPS stops within 1 second.
- Verify Telegram alerts fire. Verify Grafana populates with test metrics.
- **Gate**: Zero production orders placed, all test orders correct, kill switches functional.

### 7.5 Step 4: Credential Migration (if applicable)

Run `scripts/rotate-encryption-key.ts` to re-encrypt all stored credentials from dev key to production key. Verify one random row decrypts correctly.

### 7.6 Step 5: Production Cutover

- Set `EXECUTION_MODE=production` in VPS `.env`.
- **Whitelist VPS static IP on every exchange API key** (requires logging into each exchange).
- Set `ASTER_LIVE_ORDER_SUBMISSION_ENABLED=true` in Worker secrets.
- Restart Worker deploy + VPS execution container.
- Verify first order goes through with full audit trail.

### 7.7 Step 6: Gradual Capital Ramp-Up (14 days)

| Day | Max Position | Max Total Exposure | Capital on Exchange |
|-----|:-----------:|:-----------------:|:-------------------:|
| 1-2 | 0.25% equity | 1% | 10% of total |
| 3-4 | 0.5% equity | 2% | 25% of total |
| 5-7 | 1% equity | 4% | 50% of total |
| 8-14 | 1% equity | 4% | Full (monitoring only) |

After 14 days clean (no unexpected orders, PnL within expected range, no infrastructure incidents), the deployment is production-stable.

### 7.8 Rollback Plan

1. Activate global kill switch from dashboard/API.
2. `touch /opt/anavitrade/EMERGENCY_KILL` on VPS.
3. `docker compose stop execution`.
4. Set `EXECUTION_MODE=disabled` to queue orders without executing.
5. Un-whitelist VPS IP from exchanges (defense in depth).

---

## Implementation Order Summary

| Phase | Deliverable | Est. Effort | Risk |
|-------|------------|:---------:|:----:|
| 1 | VPS provisioned, hardened, Docker installed | 2 hours | Low |
| 2 | Extract decryptKey, Worker internal endpoints, executor, Docker stack | 2-3 days | Medium |
| 3 | Production secrets, wrangler config, VPS .env | 1 hour | Low |
| 4 | ONNX Runtime, inference wrapper, model loading | 0.5 day | Low |
| 5 | Prometheus metrics, Grafana dashboard, Telegram alerts | 1 day | Low |
| 6 | Audit logging, systemd, security checklist | 0.5 day | Low |
| 7 | Testnet soak (48h), credential migration, cutover, ramp-up | 2-3 days | High |

**Total calendar**: 1-2 weeks. **Critical path**: Phase 2 (extraction + executor). The CEX signing code is confirmed portable (pure `crypto.subtle` + `fetch()`), but the `dispatch.ts` fan-out has heavy D1 dependencies that must be replaced with Worker API calls.

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|:-------:|-----------|
| CEX signing code references Worker-specific APIs | Low | Audit confirms all signing uses `crypto.subtle` (Node 18+). `fetch()` is global. Drizzle/D1 references isolated to `dispatch.ts` and `riskEngine.ts`, which get adapted. |
| VPS-to-Worker connectivity failure | Medium | Fail-closed — no orders placed when Worker unreachable. Alert after 3 consecutive poll failures. |
| Clock skew between VPS and exchanges | Medium | systemd-timesyncd (Ubuntu default), validated in health check. |
| Double-fill (VPS + Worker both execute) | High | `idempotencyKey` prevents duplicates. Only one entity (VPS) executes — Worker only creates intents after extraction. |
| ENCRYPTION_KEY compromise | Critical | Cloudflare secret (encrypted at rest), VPS `.env` chmod 600, 90-day rotation, offline backup. |
| Hetzner Ashburn DC failure | Low | Documented failover to Vultr NJ (~$49/month, same Docker Compose stack). Daily Redis + trade log backups. |
| Exchange IP whitelist update delay | Low | Plan 12+ months on initial provider. Use Hetzner floating IPs if available (reassignable to new instance). |

---

## Success Criteria

- [ ] VPS provisioned, hardened, Docker Compose stack running
- [ ] Execution server polls Worker, decrypts credentials locally (plaintext never transmitted)
- [ ] Test orders submitted to Binance Testnet and Bybit Testnet
- [ ] Fills reported back to Worker and recorded in D1
- [ ] Kill switch stops execution within 1 second (all 3 layers)
- [ ] Prometheus metrics exported, Grafana dashboard populated
- [ ] Telegram alerts fire for critical events (tested)
- [ ] 48-hour testnet soak: zero unexpected order placements
- [ ] Credential migration script verified
- [ ] All exchange API keys IP-whitelisted to VPS static IP
- [ ] First production order with full audit trail
- [ ] 14-day capital ramp-up completed with no incidents
