# Dependency Audit - 2026-07-17

## Scope

Workstream 7 updates dependency metadata and the TypeScript test harness without
changing application code. The coordinator's existing `test`, `db:migrate`,
and `db:migrate:remote` scripts are preserved.

## Remediation

| Package | Before | After | Reason |
| --- | --- | --- | --- |
| `drizzle-orm` | `^0.38.0` (`0.38.4`) | `^0.45.2` (`0.45.2`) | Fixes GHSA-gpj5-g38j-94v9 / CVE-2026-39356. |
| `cookie` | `^0.6.0` (`0.6.0`) | `^0.7.2` (`0.7.2`) | Fixes GHSA-pxg6-pf52-xh8x / CVE-2024-47764 without a major upgrade. |
| `wrangler` | `^3.114.17` (`3.114.17`) | `^4.111.0` (`4.111.0`) | Moves to the current supported Wrangler v4 line. |
| `@cloudflare/workers-types` | `^4.20250720.0` | `^5.20260717.1` (`5.20260717.1`) | Matches Wrangler 4.111.0's current peer line and exceeds the configured `2025-07-18` compatibility date. |
| `tsx` | transitive only | `^4.23.1` (`4.23.1`) | Declares the test runner's executable directly. |

The vulnerable production `ws@8.18.0` path was:

`wagmi > @wagmi/connectors > @walletconnect/ethereum-provider > @reown/appkit > @walletconnect/universal-provider > @walletconnect/utils > viem > ws`

A range-limited pnpm override resolves `ws@>=8.0.0 <8.21.1` to `8.21.1`.
It fixes GHSA-58qx-3vcg-4xpx / CVE-2026-45736 and
GHSA-96hv-2xvq-fx4p / CVE-2026-48779 without a wallet-stack major upgrade.
The unrelated `chrome-remote-interface` path remains on patched `ws@7.5.11`.

## Verification

- `pnpm install --frozen-lockfile`: passed from a worktree-local installation.
- `pnpm test`: passed, 129 tests, 0 failures.
- `pnpm audit --prod --json`: expected nonzero exit; 0 high, 2 moderate, 0 low.
  The direct Drizzle/Cookie findings and both `ws` findings are cleared.
- `pnpm check`: passed for the client and execution server TypeScript projects.
- `pnpm build`: passed.
- `pnpm deploy:dry`: passed with D1, rate-limit, and production-origin bindings.

## Residual Advisory

GHSA-w5hq-g745-h8pq / CVE-2026-41907 remains through two `wagmi` connector
paths:

- `wagmi > @wagmi/connectors > @gemini-wallet/core > @metamask/rpc-errors > @metamask/utils > uuid@9.0.1`
- `wagmi > @wagmi/connectors > @metamask/sdk > uuid@8.3.2`

A fix requires upstream wallet packages to adopt a patched UUID line or a
separately tested UUID major-version override. Forcing a transitive UUID major
would cross wallet signing and connector compatibility boundaries.

Exception record:

- Owner: Platform Engineering
- Required approver: Release Security
- Severity: moderate; no direct application import
- Expiry: 2026-08-17
- Renewal condition: repeat the wallet connector compatibility test matrix and
  confirm no patched upstream release is available
- Removal condition: upgrade the affected connectors or adopt a tested override
- Release status: pending explicit approver sign-off; production release remains
  gated until that sign-off is recorded
