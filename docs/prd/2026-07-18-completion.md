# PRD: Anavitrade Completion — Thread Consolidation to Production

**Status:** Active
**Date:** 2026-07-18
**Owner:** Ariel
**Supersedes nothing — consolidates:**
- `docs/prd/2026-07-17-honest-ml-validation-gate.md` (Draft, diagnosis only)
- `docs/prd/2026-07-17-production-safety-remediation.md` (Code complete; operator gates pending)
- `docs/prd/2026-07-16-unified-algo-development-integration.md` (Phase 0+1 orchestration)
- Uncommitted working tree as of 2026-07-18 (auth dev-registration, train.py `--input`,
  meta-v24/v25 artifacts, `dual_regime_experiment.py`)

## Executive Summary

The platform is in BETA with five open threads, each stalled at a different point
between "code written" and "done." Nothing new needs to be invented to finish; every
thread already has its fix built and its next action known. This PRD defines "complete"
per thread, orders the work, and sets the release gates that end the project's pattern
of premature success claims.

**Definition of overall completion:** a brand-new web3 user can connect a wallet, see
assets, activate Aster, and have their executions mirrored — on a system whose ML
claims passed a locked validation gate, whose infrastructure passed the operator
safety gates, and whose working tree is clean.

## Current Verified State (2026-07-18)

| Item | State | Evidence |
|---|---|---|
| Worker + VPS | Deployed; VPS in `testnet` mode (confirmed 2026-07-19: `printenv EXECUTION_MODE` → `testnet`); all containers Up, execution+redis healthy, disk 15% used | anavitrade-trading.erhazeariel.workers.dev; 5.161.229.209 |
| Auth dev-registration flow | Code done, uncommitted; tests pass | `tests/auth-development-registration.test.ts` — 2/2 pass |
| Locked validation tooling | Built + unit-tested; VPS cron wired but **still no completed run** — latest attempt (2026-07-19T07:07Z) failed closed at `select_pairs`, `passed: false` | `scripts/cortex/memory/locked-gate.jsonl` on VPS; `/var/log/anavitrade-locked-gate.log` absent; no cached report in repo |
| meta-v24 / meta-v25 models | Trained via leaky threshold selection — numbers not citable | v24: AUC 0.531, n=54; v25-momentum: n=20; v25-oversold: WR 34.6% at n=205 |
| Production safety | Code gates done; 8 operator gates open | `2026-07-17-production-safety-remediation.md` §Release Gates |
| Aster onboarding | v3 signing path reached; full new-user proof outstanding | 2026-07-14 smoke: "No agent found" = signed auth path works; prior chainId/JSON bugs fixed |
| Signal pipeline | 0 analysis_signals — kline starvation | Worker 50-subrequest cap; seeding partial (~1,000 4h bars) |

## Thread A — Working Tree Hygiene (unblocks everything else)

The working tree holds four unrelated changes. Nothing else can be cleanly
committed or reverted until they land separately.

**A1. Commit auth dev-registration.** `src/server/auth/router.ts` returns
`developmentVerificationUrl` only when `isExplicitDevelopmentOrTestnet(ctx.env)`;
`src/pages/Register.tsx` auto-navigates to it in dev; production behavior unchanged
and covered by the "production registration never returns a verification URL" test.
- Done when: `pnpm check` passes, both tests pass, committed as
  `feat: dev-only auto-verification URL on registration`.

**A2. Commit train.py `--input` flag.** One-line CLI addition (override klines input
path). Commit as `feat: train.py --input override for klines path`.

**A3. Commit ML experiment artifacts honestly.** `dual_regime_experiment.py` plus
meta-v24/meta-v25 model dirs are the negative-result record that motivated the
validation-gate PRD. Per that PRD's commit hygiene rule, the message must state the
honest outcome, e.g.:
`chore: meta-v24/v25 dual-regime experiment — no edge found (AUC 0.52-0.53), threshold selection leaky, superseded by locked gate`.
Never cite these models' WR/PF numbers as results.

**Acceptance:** `git status` clean; three separate commits, none containing 🎯,
"GOALS MET", or "definitive".

## Thread B — Honest ML Validation Gate (adopt + run)

The 2026-07-17 PRD diagnosed the root cause (threshold selected on the test set in
`pipeline/model.py::train_chronological`) and found the fix already built. This
thread executes it.

**B1. Run the locked gate for real.** Execute
`scripts/ml/locked-walkforward-backtest.py` against the 120-day/49-pair corpus
(and the 100-pair/365-day corpus when available). Commit the report — pass or fail —
as the first citable number the pipeline has produced.

**B2. Branch on the result — no third option:**
- **Pass** (≥200 test trades, Wilson CI lower bound > baseline WR, PF > 1.0,
  MaxDD ≤ 15%): promote that exact model artifact to paper trading on the VPS.
- **Fail:** freeze all architecture/feature/regime tuning. Reclassify the problem as
  label/feature-definition, following the ICR empirical process (large sample, one
  variable at a time, negative results recorded in
  `docs/analysis/EMPIRICAL_FINDINGS.md`).

**B3. Make the gate the default path.** Wire `select_threshold_locked` +
`purged_chronological_split` into `train.py` so the leaky path cannot be run by
accident; `train_chronological`'s self-reported test metrics become
iteration-only signal, printed with an explicit `NOT A RESULT` label.

**Acceptance:** a committed locked-gate report with `testEvaluations: 1`;
`train.py` no longer reports test-set-optimized thresholds as results; commit
hygiene rule enforced (see Release Gates).

## Thread C — Production Safety Operator Gates

Code gates in `2026-07-17-production-safety-remediation.md` are complete. The eight
operator gates remain and are copied here as the single open checklist:

- [ ] Apply and verify production D1 migrations with backup + rollback record
      — not VPS-assessable; requires `wrangler d1` access on the Cloudflare side
      (audit 2026-07-19, read-only)
- [ ] Redeploy Redis privately; rotate its credential after removing exposure
      — ✓ structurally satisfied: `docker ps` shows `anavitrade-redis` with bare
      `6379/tcp` (no host-published port) and `docker exec anavitrade-redis
      redis-cli ping` returns `NOAUTH Authentication required.` (auth enforced).
      Credential *rotation* history not remotely verifiable — needs operator
      attestation (audit 2026-07-19)
- [ ] Restrict ports 3000, 6379, 9090, 9091 at host and provider firewalls
      — ✓ host side verified: `ufw` active, `Default: deny (incoming)`, only
      22/tcp allowed; `ss -tlnp` shows 3000/9090/9091 bound to 127.0.0.1 only
      and 6379 not bound on the host at all. Hetzner provider-level firewall
      not verifiable from the host — needs console check (audit 2026-07-19)
- [ ] Configure mail provider, rate-limit bindings, monitoring auth
      — not VPS-assessable; Worker-side secrets/bindings, requires separate
      Cloudflare check (audit 2026-07-19)
- [ ] Rotate internal/admin credentials after constant-time validation ships
      — code gate confirmed (`timingSafeSecretEqual` in
      `src/server/security/requestSecurity.ts`, present locally and on the VPS);
      rotation itself requires operator attestation — no evidence found either
      way (audit 2026-07-19)
- [ ] Whitelist 5.161.229.209 on exchange API keys
      — not remotely verifiable without exchange-console access; no evidence
      found either way (audit 2026-07-19)
- [ ] Validate Binance testnet ≥48h including forced failure scenarios
      — ⚠ NOT satisfied: `EXECUTION_MODE=testnet` confirmed, but the execution
      container had been up only ~5h at audit time and the entire 48h log window
      contained 24 lines — startup banner plus repeated
      `[kline-pipeline] exchangeInfo failed ... 451` / `0 klines — skipping
      analysis`. No order flow, no forced-failure or reconciliation events
      observed. The 48h continuous clean-run record does not exist yet
      (audit 2026-07-19)
- [ ] Keep non-Binance adapters disabled unless independently certified
      — ✓ structurally satisfied in code: unsupported exchanges are denied
      before secrets are materialized (`unsupported_exchange` outcome,
      `src/server/execution/server.ts:654`; regression test
      `CEX_ENVIRONMENT_UNSUPPORTED:bybit:testnet` in `server.mode.test.ts`).
      No adapter enable flags found in non-secret config (audit 2026-07-19)

*(2026-07-19 read-only VPS audit — boxes stay unchecked per the
no-claim-without-full-evidence rule; notes above record partial/structural
evidence. Gate 8 context: `EXECUTION_MODE` is `testnet`; no evidence production
mode has ever been enabled — the approval gate is un-crossed, as intended.)*

**Acceptance:** all boxes checked with evidence (command output or screenshot noted
in `progress.md`), before any consideration of `EXECUTION_MODE=production`.

## Thread D — Aster New-User Onboarding Proof

The recurring question ("can a brand-new web3 user connect their wallet, see their
assets, activate Aster, and join the chorus of trades?") has never been answered
end-to-end with a fresh wallet. Signing bugs (chainId mismatch, unexpected end of
JSON) were fixed piecemeal; the composite flow is unproven.

**D1. Scripted E2E proof with a fresh wallet:**
1. Connect wallet on the dashboard (WalletConnect/MetaMask)
2. Assets visible in dashboard
3. Sign & Activate Aster (`registerAndApproveAgent`) succeeds on the wallet's
   current chainId — no manual chain switching required
4. A TradeIntent dispatched to this connection produces an Aster v3 order
   (testnet / smallest size), with fill sync and NAV reconciliation observed

**D2. Capture as a repeatable test.** Extend the existing Aster browser harness
(see commit `d053730`) so the activation path is regression-covered, not
re-debugged every session.

**Acceptance:** one documented fresh-wallet run with order ID, fill record, and NAV
snapshot referenced in `progress.md`; harness test committed.

## Thread E — Signal Pipeline Unstarvation

The analysis engine produces 0 signals because the Worker cannot fetch klines
(50-subrequest cap) and D1 kline coverage is minimal.

**E1. Move kline ingestion to the VPS** (already the stated fix in `findings.md`):
a VPS cron fetches OHLCV and writes to D1 via the internal API, replacing ad-hoc
local seeding.
**E2. Seed to operating depth:** ≥15 pairs × 300 bars on 4h **and** 1h (MA99 warmup
+ SMC patterns; 1h fires ~4x more).
**E3. Verify flow:** analysis run yields `signalsGenerated > 0`; at least one
signal → TradeIntent → execution_job observed in VPS logs.

**Acceptance:** analysis_signals and execution_jobs non-zero from live cron, not a
manually triggered one-off.

## Ordering and Dependencies

```
A (hygiene) ──► B (locked gate run) ──► B2 branch: paper trade OR label research
      │
      ├──────► C (operator gates) ──┐
      │                             ├──► 48h testnet validation ──► EXECUTION_MODE=production
      ├──────► D (Aster E2E proof) ─┘
      └──────► E (signal pipeline)  (feeds D4's TradeIntent and the 48h validation)
```

A is immediate and mechanical. B, C/E, and D can proceed in parallel after A.
The production switch requires C, D, and E all green plus explicit approval;
it does **not** require B to pass — a failed ML gate leaves the ICR/rule-based
path as the signal source, which is already the disciplined baseline.

## Release Gates (project-wide, permanent)

1. **No performance claim outside the locked gate.** WR/PF/Sharpe numbers in commits,
   docs, or dashboards must trace to a `locked-walkforward-backtest.py` report with
   `testEvaluations: 1`. Everything else is labeled iteration signal.
2. **n and CI or it didn't happen.** Every reported WR carries sample size and Wilson
   95% CI; a pass requires the CI lower bound to beat the partition baseline.
3. **No 🎯 / "GOALS MET" / "definitive" commit language** unless gate 1 passed on that
   exact run.
4. **`EXECUTION_MODE=production` requires:** Thread C checklist complete, Thread D
   fresh-wallet proof, Thread E live signal flow, 48h clean testnet run, and explicit
   operator approval — in that order, no skipping.

## Non-Goals

- New model architectures, features, or regimes before the locked gate has produced
  its first honest verdict (Thread B explicitly freezes this on a fail).
- New exchange adapters beyond Binance certification scope.
- UI redesign (dark trading UI is preserved per guardrails).
- Changes to the ICR/rule-based engine's methodology — it is the reference standard.

## Success Metrics

- Working tree clean; zero unlabeled experiment artifacts.
- First locked-gate report committed (pass or fail) — the pipeline's first
  trustworthy number.
- Fresh-wallet Aster onboarding proof documented and regression-tested.
- All 8 operator gates evidenced.
- Either: production mode live after 48h clean testnet, or an honest, documented
  "not yet" with the specific failing gate named.
