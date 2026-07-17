# Production Safety Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Anavitrade fail closed across exchange execution, persistence, risk, authentication, infrastructure, and public data integrity.

**Architecture:** Add explicit capability and lifecycle contracts at the boundaries where unsafe assumptions currently cross subsystems. Keep external providers behind injectable interfaces, use forward-only D1 migrations, and require durable evidence before advancing execution states. Implement in disjoint workstreams and integrate behind a disabled execution default.

**Tech Stack:** TypeScript 5.9, Hono, tRPC, Drizzle ORM, Cloudflare Workers/D1, Node execution service, Docker Compose, Prometheus, React/Vite, Node test runner.

---

## Workstream 1: Exchange Safety Contract

**Ownership:** `src/server/cex/**`, exchange contract tests, capability consumption in `src/server/execution/server.ts`.

1. Add failing tests for adapter environment support and fail-closed endpoint resolution.
2. Define `ExchangeEnvironment`, adapter capabilities, and a typed unsupported-capability error.
3. Make each adapter declare production/testnet and protective-order capabilities.
4. Reject unsupported environment or protection combinations before credentials are used.
5. Add mocked-transport payload tests for every enabled adapter.
6. Correct Binance protection handling and remove swallowed child-order failures.
7. Disable automated execution for adapters without certified bracket semantics.
8. Run focused contract tests and `pnpm check`.

## Workstream 2: Schema, Leasing, and Reconciliation

**Ownership:** `src/drizzle/schema.ts`, `migrations/**`, internal execution endpoints in `src/server/worker.ts`, execution poll/report/reconciliation code, focused tests.

1. Write migration-shape tests for required execution and risk columns.
2. Add a forward-only migration with risk and lease fields plus claim indexes.
3. Replace the broken migration script with ordered local/remote commands.
4. Add an atomic D1 claim transaction returning a lease token.
5. Require active lease ownership on reports and expire/reclaim stale leases.
6. Bound attempts and preserve stable idempotency keys.
7. Reconcile only from client/exchange order identifiers.
8. Add race, expiry, token mismatch, and retry tests.

## Workstream 3: Risk and NAV Integrity

**Ownership:** `src/server/execution/riskEngine.ts`, risk/NAV persistence helpers, risk tests. Coordinate any `dispatch.ts` edit with the user-owned changes before integration.

1. Add failing tests for absent/stale/invalid NAV and zero notional.
2. Require fresh positive NAV for automated execution.
3. Remove dispatch fallback sizing and make the risk decision authoritative.
4. Persist CEX NAV snapshots from balance refreshes.
5. Update high-water mark and drawdown from authoritative NAV.
6. Update consecutive-loss and circuit-breaker state from finalized outcomes.
7. Include leased/submitted jobs in exposure calculation.
8. Run focused tests and verify no adapter call occurs on denial.

## Workstream 4: Authentication and Abuse Prevention

**Ownership:** auth sections of `src/server/routers.ts`, auth helpers in `src/server/db.ts`, new mail/rate-limit/security modules, auth tests, Worker middleware.

1. Add tests proving registration does not authenticate or expose tokens.
2. Add hashed one-time verification/reset tokens and migration support.
3. Add a mail delivery interface, test adapter, and fail-closed production adapter.
4. Require verified email at login and correct cookie lifetime units.
5. Add rate-limit middleware for auth, public, demo, admin, and internal routes.
6. Add timing-safe secret comparison and sanitized errors.
7. Add origin/CSRF enforcement for cookie-authenticated mutations.
8. Add security headers and configurable exact-origin CORS.
9. Run auth and Worker route tests.

## Workstream 5: Infrastructure and Observability

**Ownership:** `docker-compose.yml`, `prometheus.yml`, Grafana provisioning, `wrangler.toml`, execution health/metrics modules, TypeScript configs, operations docs.

1. Add configuration assertions for private service bindings.
2. Remove the Redis host port and require authenticated Redis configuration.
3. Bind Prometheus/Grafana/execution health to loopback by default.
4. Implement Prometheus metrics and readiness-aware health responses.
5. Skip analysis on zero ingested records and emit a reason metric.
6. Enable Worker observability, current compatibility settings, and generated types.
7. Include the execution server in TypeScript checks.
8. Document firewall, credential rotation, and deployment operator gates.

## Workstream 6: Public and Demo Integrity

**Ownership:** demo/public server procedures, signal presentation components, marketing copy, CORS configuration UI consumers, focused tests.

1. Add authorization tests for every demo/public mutation.
2. Remove browser-usable shared mutation tokens and scope sync to one account/internal job.
3. Make sync idempotent with a durable operation record and retry-safe steps.
4. Advance trade-intent status from execution outcomes.
5. Fix historical backfill to persist fetched pages.
6. Render missing results as unavailable and align signal outcome sources.
7. Remove or qualify unsupported latency, volume, coverage, and return claims.
8. Run route tests, component tests, and responsive browser checks.

## Workstream 7: Dependencies and Full Verification

**Ownership:** `package.json`, lockfile, test scripts, CI/deployment checks.

1. Add a real `test` script covering TypeScript unit and contract suites.
2. Upgrade Drizzle, cookie, ws-bearing dependency chains, Wrangler, and Workers types in controlled increments.
3. Run migration smoke tests after ORM upgrades.
4. Run `pnpm audit --prod` and document only accepted residual exceptions.
5. Run `pnpm test`, `pnpm check`, `pnpm build`, and `pnpm deploy:dry`.
6. Validate Compose rendering and confirm private bindings.
7. Run independent spec-compliance and code-quality reviews.
8. Record operator-only release steps; do not deploy or enable production execution.

## Integration Order

1. Schema and lifecycle primitives.
2. Exchange capabilities and risk fail-closed behavior.
3. Authentication and public-route controls.
4. Infrastructure, observability, and dependency upgrades.
5. Public/demo corrections.
6. Full-system verification and independent review.

## Required Evidence

- Focused red/green test output for every workstream.
- Final migration schema dump showing all required fields and indexes.
- No-network adapter contract test output.
- Job-claim concurrency test showing exactly one lease owner.
- Risk tests showing no adapter invocation on missing/stale NAV.
- Auth tests showing no token leakage and enforced verification/rate limits.
- Rendered Compose ports and metrics endpoint output.
- Browser screenshots or semantic snapshots for corrected public performance states.
- Final `git diff --check`, `pnpm test`, `pnpm check`, `pnpm build`, audit, and dry-deploy results.
