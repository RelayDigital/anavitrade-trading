# CLAUDE.md

## Project

Standalone Anavitrade trading platform reconstructed from a Manus export.

Important: this project is separate from `/home/ariel/anavi-project/anavi`. Do not merge changes into the ANAVI core repo unless explicitly asked.

## Commands

```bash
pnpm install
pnpm check
pnpm build
pnpm dev
pnpm smoke:wallet
```

Local dev runs on:

```text
http://localhost:5174/
```

## Environment

WalletConnect/Reown project ID is configured in `.env`:

```text
VITE_WALLETCONNECT_PROJECT_ID=05dcea0e853d0ee47e980c540ec55494
```

The encryption key for API credentials at rest uses `ENCRYPTION_KEY`. In local dev,
set it in `wrangler.toml [vars]` or `.env`. For production, set it as a Worker
secret. It must NOT match `JWT_SECRET`.

If any env var value changes, restart Vite because `import.meta.env` is read at startup.

## Architecture Notes

- Aster DEX foundation is the active onchain execution path. Read `docs/architecture/2026-07-09-aster-dex-flow.md` before changing execution/onboarding.
- Claude CEX work must share `TradeIntent -> ExecutionJob -> OrderEvent -> NavSnapshot -> FeeAccrual`; read `docs/architecture/2026-07-09-claude-cex-handoff.md`.

- `src/lib/wagmi.ts` owns Wagmi chains, connectors, and WalletConnect metadata.
- `src/components/WalletConnectModal.tsx` owns the wallet modal flow:
  - Ledger direct USB/Bluetooth via `@ledgerhq/connect-kit-loader`
  - Ledger QR fallback through WalletConnect
  - WalletConnect mobile QR
  - MetaMask
  - Coinbase Wallet
- `src/lib/trpc.ts` is a local compatibility shim replacing the missing Manus backend.
- Coinlegs data comes from the live Cloudflare Worker:
  `https://coinlegs-worker.erhazeariel.workers.dev/latest`
- TradingView mini widgets live in `src/components/TradingViewMiniWidgets.tsx`.

## Agent Handoff Notes

- UI upgrade production caveats are tracked in `docs/ops/2026-07-13-ui-prod-caveats-audit.md`. Read it before deployment, UI/UX continuation, API routing/CORS changes, Vercel work, Cloudflare Worker release work, or authenticated dashboard QA.

## Verification Status

Last verified on 2026-07-07:

```bash
pnpm check
pnpm build
pnpm smoke:wallet
```

The smoke test verifies the dashboard wallet button, the WalletConnect/Reown popup, and Ledger Nano USB / WalletConnect QR choices. The build may warn about large Wagmi/WalletConnect chunks. That is expected for now.

## Production Hardening — Pre-Mainnet

- **Static egress IP**: Cloudflare Workers share egress IPs, so exchange API-key IP whitelisting is
  impractical from the Worker itself. Before live funds, route order signing/submission through a
  dedicated execution service with a static egress address.
- **Encryption key**: `ENCRYPTION_KEY` is the Worker secret used as the AES-256 key for
  `encryptKey`/`decryptKey`. In production, set it via
  `npx wrangler secret put ENCRYPTION_KEY`. For local dev, set it in `wrangler.toml [vars]`.
  The JWT session secret and the data-at-rest key must NOT be the same value —
  the code now throws if `ENCRYPTION_KEY` is missing.
- **Per-connection kill switch**: Set via `cex.toggleKillSwitch` or manually in D1
  (`cex_connections.killSwitchActive`). The risk engine (`decideExecution()`) denies any job
  when active. Global kill: `exec.setGlobalKill`.
- **Dispatch is auto-wired**: `runCoinlegsScraper()` now emits a `TradeIntent` for every new
  Tier A/B buy signal and fans it to all active CEX connections. Idempotency is per (user, intent).
- **Order mutex**: `execution/dispatch.ts` serializes order submission per `cexConnectionId` so a
  signer never has two in-flight orders. `ExecutionJob.idempotencyKey` prevents duplicate mirrors.

## Planning Workflow (planning-with-files)

This project uses **[planning-with-files](https://github.com/OthmanAdi/planning-with-files)** (v3.4.1)
for persistent, Manus-style file-based planning. The skill is installed at
`.claude/skills/planning-with-files/` and auto-loads on session start.

### How It Works

Three files in your project directory manage plan state across sessions and `/clear`:

| File | Purpose |
|------|---------|
| `task_plan.md` | Master plan — phases, status, goals |
| `progress.md` | Running log — what was done each step |
| `findings.md` | Technical findings, decisions, trade-offs |

The agent reads these files at the start of each turn and writes progress after
each phase. The optional **completion gate** (`--gated` mode) holds the agent
until the plan is actually done.

### Quick Start (for any complex task)

1. Create planning files (manually or via template):
   ```
   cp .claude/skills/planning-with-files/templates/task_plan.md .
   cp .claude/skills/planning-with-files/templates/progress.md .
   cp .claude/skills/planning-with-files/templates/findings.md .
   ```
2. Edit `task_plan.md` with your phases, goals, and acceptance criteria.
3. Work normally — the agent maintains the files automatically.
4. After `/clear` or restart, the agent auto-detects existing planning files
   and runs `session-catchup.py` to restore context.

### After a Crash or /clear

The Restore Context hook runs automatically. If it doesn't fire:

```bash
python3 .claude/skills/planning-with-files/scripts/session-catchup.py "$(pwd)"
git diff --stat
```

Then re-read the planning files — context is restored.

### Session Recovery Snapshot

At the end of an ICR/backtest session, the agent appends a `SESSION RECOVERY`
block to `task_plan.md` with:
- Last active phase
- What changed (files modified, outputs generated)
- What comes next
- Key numbers (win rates, Sharpe ratios, totals)
- Next-step command suggestion

### Composing with Codex Orchestration

For large multi-lens review/decomposition tasks, first create a task plan, then
use `/codex:orchestrate` or `/codex:swarm review` to fan out across agents.
The planning files keep both Claude and Codex aligned on the shared goal.

### Backtest-Specific Planning

For any new backtest campaign:
1. `cp .claude/skills/planning-with-files/templates/task_plan.md backtest-plan-<name>.md`
2. Record: corpus used, strategies tested, parameter sweeps, walk-forward results
3. Save key findings to `findings.md`
4. Append results to `docs/analysis/EMPIRICAL_FINDINGS.md`

## Guardrails

- Keep this project standalone.
- Do not delete `_manus`; it is the original source export reference.
- Use `apply_patch` for manual edits.
- Preserve the current dark trading UI unless a redesign is explicitly requested.

## Trading Engine — Quick Start

Read `docs/ops/SYSTEM_OPERATIONS.md` for the full operations guide. Quick commands:

```bash
# Backtest on TradingView (requires TV Desktop running with --remote-debugging-port=9222)
node scripts/tv-deploy-v6.mjs                              # Inject Pine Script + compile
node scripts/tv-sweep-v4.mjs --tf 4h --symbols "SUIUSDT,MAVUSDT,..."  # Sweep symbols

# ML pipeline
node scripts/fetch-klines-mtf.mjs --pairs 50 --bars 500    # Fetch 4h/1h/15m klines
pnpm exec tsx scripts/ml/build-training-data-mtf.ts --input scripts/data/klines-mtf.json --output scripts/data/training-data-mtf-v4.json
python3 scripts/ml/metacognitive.py train --data scripts/data/training-data-mtf-v4.json --model-dir scripts/data/models/meta-v6
```

### Architecture (2026-07-16)
- **Pine Script v6.2**: Runs on TradingView. 1h SMC patterns (OB, FVG, sweep, CHoCH). BB/AO continuous on every bar. NO arbitrary scoring — pure measurement instrument.
- **ML Pipeline**: 62 features per bar across 4h/1h/15m. LightGBM + isotonic calibration + KMeans regimes + adversarial risk model. AUC 0.59, calibrated threshold 0.682 (1.1% pass rate at 89% WR).
- **Production**: Hetzner CPX31 ($15/mo) for execution. Cloudflare Worker for dashboard. Static IP 5.161.229.209 for exchange IP whitelisting.
- **CORTEX**: Health-gated training supervisor at `scripts/cortex/`. Verifies AUC improvement, detects silent no-ops.
- **Key finding**: No arbitrary scoring. BB width + FVG distance + MA separation are top SHAP features. SMC on 1h fires 4x more than on 4h. The model IS the edge — not hand-tuned gates.

### TradingView Backtest — Known Good Pairs (lesser-known Coinlegs alts, 4h)
PLUMEUSDT (PF 1.42), OPNUSDT (PF 1.36), XPLUSDT (PF 1.22), WCTUSDT (PF 1.18), HEIUSDT (PF 1.02)

## Backtest Corpus

The backtest corpus lives in `scripts/backtest-prioritized.json` (1,265 trades,
345 pairs, 5 timeframes). ALL scoring functions must use ONLY pre-entry data:
indicator, period, pair, entry, stop, tp, tier, and Coinlegs score.

**Never** use pnlPct, maxPct, ddPct, win, or outcome in entry decisions —
those are lookahead bias.

Key backtest scripts:

| Script | Purpose |
|--------|---------|
| `scripts/unified-backtest.mjs` | 8-strategy comparison including RR-First Sniper v3 |
| `scripts/tv-backtest-runner.mjs` | CDP-driven TradingView backtest automation |
| `scripts/fetch-klines-mtf.mjs` | Binance → JSON: 4h/1h/15m for 50 pairs |

Best live configuration was **ICT Sniper (Rule-Based)** — 694 trades, 68% WR,
Sharpe 7.00, walk-forward PASS (corpus-derived; does NOT generalize to raw OHLCV).

Current ML approach supersedes rule-based — see `docs/ops/SYSTEM_OPERATIONS.md`.

## Codex + Claude Multi-Agent Orchestration

The OpenAI Codex plugin (`codex@openai-codex`) is installed and enabled. Use it proactively for:

| Capability | Command | When |
|---|---|---|
| **Single review** | `/codex:review` | Quick review of current changes |
| **Adversarial review** | `/codex:adversarial-review` | Challenge design/approach before shipping |
| **Delegation** | `/codex:rescue` | Codex investigates/fixes something independently |
| **Multi-lens review** | `/codex:swarm review` | Parallel security + correctness + perf + adversarial review |
| **Task decomposition** | `/codex:swarm task --decompose` | Split complex work across N Codex workers |
| **Full orchestration** | `/codex:orchestrate` | Auto-detect optimal pattern across Codex + Claude agents |
| **Synthesize results** | `node "$CLAUDE_PLUGIN_ROOT/scripts/codex-synth.mjs" <job-id>` | Cross-lens dedup and priority ranking |

### Orchestration Decision Rules

- **Small changes (<5 files)**: Single `/codex:review` or nothing needed
- **Medium changes (5-15 files)**: Use `/codex:swarm review` for multi-lens coverage
- **Large features**: Use `/codex:orchestrate` which auto-decomposes across Codex + Claude agents
- **Bug investigation**: `/codex:rescue --background` + parallel Claude subagent exploration
- **Security audit**: `/codex:swarm review --lenses security,adversarial` + Claude `security-reviewer` agent
- **Codex handles**: Code review, debugging, research, straightforward implementation
- **Claude agents handle**: Architecture, security analysis, test design, synthesis

Always decompose large work across both systems. Run independent work in parallel. Synthesize at the end.
