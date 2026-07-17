# PRD: Production Safety Remediation

**Status:** Code complete; operator gates pending
**Date:** 2026-07-17
**Priority:** Release blocker
**Owner:** Platform Engineering
**Target branch:** `feat/production-hardening-remediation`

## Executive Summary

Anavitrade must remain out of production execution until its environment routing,
protective-order behavior, database schema, risk controls, authentication, and
infrastructure defaults fail closed. The current system can label an execution as
testnet while using production exchange endpoints, can approve trades without the
NAV data needed to enforce exposure limits, and can accept entries whose protective
orders were rejected or modeled incorrectly.

This PRD defines one production-safety program covering every finding from the
2026-07-17 full audit. It deliberately separates code-complete from release-ready:
no live deployment, production migration, firewall change, credential rotation, or
mainnet enablement is complete until the operator gates in this document are signed
off with evidence.

## Problem Statement

The platform currently lacks a reliable boundary between simulation and live
execution. Several controls are present in the data model or UI but are not enforced
end to end. Operational telemetry is incomplete, shared services are publicly
reachable, and account-security flows do not meet the standard required for a
service that stores exchange API credentials.

The required outcome is not merely passing builds. A release candidate must prove:

1. An order cannot reach a production exchange endpoint while the platform is in
   testnet or disabled mode.
2. An entry cannot be reported as protected unless all required protective orders
   are accepted and durably recorded.
3. A trade cannot be approved when NAV, exposure, connection state, or schema state
   is absent or stale.
4. A queued execution job has one active lease owner and safe retry semantics.
5. Authentication and public endpoints resist credential stuffing, CSRF, token
   leakage, and write amplification.
6. Operational services are private by default and expose useful health and metrics.
7. Public claims and performance displays are derived from verifiable data.

## Scope

### In Scope

- CEX environment capability metadata and fail-closed adapter routing.
- Per-exchange protective-order contracts and contract tests.
- D1 migration integrity and schema verification.
- Atomic execution-job leasing, expiry, reporting, and reconciliation.
- NAV freshness, sizing, exposure, drawdown, and circuit-breaker enforcement.
- Account verification, password reset delivery abstraction, session hardening,
  abuse controls, CORS, CSRF defenses, and security headers.
- Redis, Prometheus, Grafana, Worker configuration, health, and metrics defaults.
- Zero-data ingestion behavior, error redaction, and constant-time secret checks.
- Demo/public mutation controls and transactionally consistent synchronization.
- Truthful product claims, signal-result rendering, and deployment documentation.
- Dependency upgrades needed to remove known production vulnerabilities.

### Out of Scope

- Enabling live funds or mainnet execution.
- Adding a new exchange provider.
- Replacing D1 or the existing frontend framework.
- Redesigning the visual system.
- Promising profitability, win rate, or execution latency.
- Operator actions involving production secrets, exchange credentials, DNS, or
  firewall mutation. These remain documented release gates.

## Safety Invariants

### SI-1: Environment Isolation

Each adapter declares supported environments. In `testnet`, an adapter without an
explicit testnet base URL is unavailable. There is no fallback to production. The
executor validates platform mode, adapter capability, and resolved endpoint before
credential decryption or order submission.

### SI-2: Protected Entry Atomicity

The platform distinguishes `entry accepted`, `protection pending`, `protected`, and
`protection failed`. An adapter may use a native bracket order or a documented
multi-order strategy. If protection cannot be guaranteed, the adapter is disabled
for automated execution. A child-order failure must never be swallowed.

### SI-3: Risk Data Is Required

Missing, non-positive, or stale NAV denies execution. Position sizing is computed
once by the risk engine; dispatch cannot replace a zero notional with a larger
account-level default. Exposure and drawdown calculations include leased and open
jobs. Circuit-breaker state is persisted from order outcomes.

### SI-4: One Job, One Lease

Polling atomically transitions eligible jobs from `queued` to `leased` with an owner,
lease token, and expiry. Reports require the active token. Expired leases may be
reclaimed with bounded attempts. Idempotency keys remain stable across retries.

### SI-5: Verified Account Before Privilege

Registration does not create an authenticated trading session. Login requires a
verified email. Verification and reset secrets are never returned by production API
responses. Delivery is abstracted and fails closed when no provider is configured.

### SI-6: Private Infrastructure by Default

Redis has no host-published port in the default Compose profile and requires
authentication where network access exists. Prometheus and Grafana bind to loopback
unless an authenticated reverse proxy is explicitly configured.

### SI-7: Evidence-Based Claims

Marketing and dashboard values must come from a named, auditable data source.
Unavailable metrics display as unavailable, not zero or a fabricated value. Static
claims about latency, exchange coverage, signal volume, or returns require measured
release evidence.

## Functional Requirements

### FR-1: Exchange Execution Safety

- Define adapter capabilities: environments, supported order types, native bracket
  support, separate protection support, and position-mode requirements.
- Reject unsupported adapter/environment combinations before key decryption.
- Disable automated execution for adapters whose protective-order contract is not
  fully implemented and tested.
- Correct supported request payloads against current official exchange contracts.
- Persist each entry and child-order identifier independently.
- Surface partial protection as a hard execution incident.
- Add deterministic request-signing and payload contract tests with mocked transport.
- Never call live exchange hosts from automated tests.

### FR-2: Schema and Migration Integrity

- Add a forward-only migration for all fields used by execution and risk code,
  including `riskApproved`, circuit-breaker state, high-water mark, and lease fields.
- Add indexes for claim eligibility and lease expiry.
- Replace the broken migration script with an ordered migration command.
- Add a schema smoke test that applies all migrations to a fresh local D1 database
  and verifies required columns.
- Worker startup/health reports schema compatibility without leaking SQL details.

### FR-3: Job Lifecycle and Reconciliation

- Add statuses `queued`, `leased`, `submitted`, `filled`, `protection_pending`,
  `protected`, `failed`, and `cancelled` where compatible with existing consumers.
- Claim jobs atomically and cap delivery attempts.
- Require lease ownership for job reports.
- Reconcile by exchange client-order ID and exchange order ID, never merely by a
  nonzero symbol position.
- Persist sanitized failure codes and retain detailed diagnostics in server logs.

### FR-4: Risk and Account State

- Require fresh NAV before approval; default maximum age is configurable and bounded.
- Remove dispatch-level emergency sizing.
- Persist NAV for every supported CEX balance refresh.
- Update consecutive losses, circuit-breaker expiry, and high-water mark from
  authoritative outcomes/NAV.
- Deny malformed prices, non-positive sizing, stale signals, unsupported leverage,
  and exposure-limit breaches.
- Add boundary tests for missing NAV, stale NAV, daily loss, exposure, drawdown,
  circuit-breaker, and zero/NaN values.

### FR-5: Authentication and Abuse Controls

- Registration returns a generic success response and starts verification delivery.
- Login requires verified email and uses generic credential errors.
- Verification and reset tokens are one-time, hashed at rest, and short lived.
- Add a provider-neutral mail interface with a test adapter and production fail-closed
  configuration.
- Apply per-IP and per-account rate limits to auth, public signals, demo mutations,
  admin, and internal endpoints.
- Use constant-time comparison for admin/internal bearer secrets.
- Correct cookie lifetime units; use secure, HTTP-only, host-scoped cookies.
- Add origin/CSRF validation for cookie-authenticated mutations.
- Add CSP, HSTS, frame, content-type, referrer, and permissions headers.

### FR-6: Infrastructure and Observability

- Remove public Redis exposure and require an authenticated connection string.
- Bind monitoring ports to loopback by default.
- Implement Prometheus `/metrics` for poll latency, claim count, submission count,
  failures, stale leases, and last successful cycle.
- Make `/health` report dependency readiness without returning sensitive errors.
- Skip downstream analysis when ingestion fetches zero records and record the reason.
- Add Worker observability configuration and generated binding types.
- Bring the execution server into the production TypeScript check.
- Upgrade vulnerable runtime dependencies with compatibility tests.

### FR-7: Public and Demo Integrity

- Remove the shared public demo write token from browser-accessible behavior.
- Scope synchronization to the authenticated account or an internal scheduled job.
- Make demo synchronization idempotent and transactionally consistent where D1
  permits; otherwise use a durable operation record and compensating retry.
- Ensure trade-intent lifecycle status advances with job outcomes.
- Fix backfill to persist the historical page it fetched.
- Replace unsupported marketing claims with measured or capability-qualified text.
- Render missing performance as unavailable and align ticker/card outcome sources.

## Non-Functional Requirements

- **Fail closed:** Ambiguous state denies execution.
- **Idempotent:** Retrying claims, reports, email requests, and synchronization does
  not duplicate durable effects.
- **Auditable:** Every execution transition records actor, timestamp, and reason.
- **Testable:** External network calls are behind injectable transports.
- **Backward compatible:** Existing queued rows can be migrated or safely cancelled.
- **Observable:** Health and metrics distinguish idle, degraded, and unavailable.
- **No secret leakage:** Logs and responses redact credentials and reset tokens.

## Release Gates

### Code Gates

- [x] All migrations apply to a fresh local D1 database and match Drizzle schema.
- [x] `pnpm check`, `pnpm build`, unit tests, contract tests, and dry deploy pass.
- [x] No high-severity production dependency advisories remain without an accepted,
      documented exception.
- [x] Every enabled adapter passes environment and protective-order contract tests.
- [x] Missing/stale NAV, lease mismatch, and child-order failure tests deny execution.
- [x] Auth rate-limit, token redaction, verification, reset, CSRF, and cookie tests pass.
- [x] Compose validation proves no public Redis/monitoring binding by default.

### Operator Gates

- [ ] Apply and verify production D1 migrations with a backup and rollback record.
- [ ] Redeploy Redis privately; rotate any Redis credential after removing exposure.
- [ ] Restrict ports 3000, 6379, 9090, and 9091 at host and provider firewalls.
- [ ] Configure mail provider, rate-limit bindings, monitoring authentication, and
      alert destinations through secrets/configuration.
- [ ] Rotate internal/admin credentials after constant-time validation ships.
- [ ] Validate Binance testnet for at least 48 hours with forced failure scenarios.
- [ ] Confirm all non-Binance adapters remain disabled unless independently certified.
- [ ] Obtain explicit production approval before setting `EXECUTION_MODE=production`.

## Acceptance Scenarios

1. With `EXECUTION_MODE=testnet`, a Bybit job is denied before secrets are decrypted
   unless the adapter declares and resolves a testnet endpoint.
2. A Binance entry whose stop order fails is marked `protection_failed`, triggers the
   incident path, and is never reported as protected.
3. A job without a fresh NAV snapshot is denied and no adapter method is invoked.
4. Two pollers racing for one job produce one valid lease token and one submission.
5. A stale lease is reclaimed once while preserving the original idempotency key.
6. An unverified user cannot log in; production registration never returns a token.
7. Repeated auth/demo requests receive deterministic rate-limit responses.
8. Default Compose exposes no Redis, Prometheus, or Grafana port publicly.
9. A zero-record ingestion cycle does not trigger analysis and increments a metric.
10. Unknown signal performance renders as unavailable and no unsupported quantitative
    claim appears on public pages.

## Rollout Strategy

1. Ship schema and code with execution disabled.
2. Apply and verify migrations.
3. Deploy private infrastructure and observability.
4. Enable Binance testnet only.
5. Run failure injection, lease concurrency, and reconciliation exercises.
6. Review evidence and security controls.
7. Enable production only under a separate, explicit change record.

## Success Metrics

- Zero production-host requests in disabled or testnet mode.
- Zero duplicate submissions under lease concurrency tests.
- 100% of approved jobs have fresh NAV and persisted risk evidence.
- 100% of enabled automated entries reach `protected` or a visible incident state.
- Zero public unauthenticated infrastructure ports in the default deployment.
- Zero verification/reset secrets returned by production APIs.
- All release gates have timestamped evidence and named approvers.
