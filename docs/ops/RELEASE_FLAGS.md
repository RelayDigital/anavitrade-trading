# Release Flags

This is the operational source of truth for the public release lane. It
separates the production web platform from the independent, higher-risk
customer-capital execution capability.

## Current deployed lane

| Flag / service | Deployed value | Meaning |
| --- | --- | --- |
| Worker `APP_ENVIRONMENT` | `production` | Production-origin, cookie, and security behavior for the public platform. |
| Worker `AUTOMATED_SIGNAL_DISPATCH_ENABLED` | `true` | Qualifying analysis candidates fan out to every active, explicitly authorized adapter account. |
| Worker `REQUIRE_EMAIL_VERIFICATION` | `false` | Password signups can sign in immediately; this is an explicit product policy, not an email-provider workaround. |
| Worker `ASTER_ENVIRONMENT` | `production` | Aster onboarding and agent authorization target the Aster mainnet API. |
| Worker `ASTER_AGENT_ONLY_ENABLED` | `true` | Mainnet tester onboarding uses Aster’s signed agent-only authorization flow; users still sign the authorization in their wallets. |
| Worker `ASTER_LIVE_ORDER_SUBMISSION_ENABLED` | `true` | Aster mainnet orders may be submitted only for active, user-authorized agents after risk and dispatch checks. |
| Worker `ASTER_MAX_ORDER_NOTIONAL_USD` | `100` | Absolute ceiling for every Aster mainnet order during the real-money tester pilot. |
| Worker PancakeSwap order flag | unset / `false` | PancakeSwap customer-capital execution is not configured or enabled. |
| VPS `EXECUTION_MODE` | `testnet` | The separate CEX execution worker cannot route to production exchange endpoints. |
| D1 migrations | applied through `0013_pancakeswap_execution.sql` | The additive PancakeSwap schema migration was exported, applied, and verified on 2026-07-19; it does not enable the adapter. |
| Transactional auth email | native Worker binding deployed; sender not authorized | Signups are available without verification. Password-reset delivery becomes available when a verified Cloudflare Email Sending domain and `EMAIL_FROM` are configured; Resend remains a compatible fallback. |

The public endpoint `GET /api/release-status` exposes the non-secret Worker
portion of this state. It is suitable for UI labels, support checks, and
deployment verification; it never returns credentials, addresses, or keys.

To make password recovery available, onboard the sender domain in Cloudflare
Email Sending and set `EMAIL_FROM` as a Worker secret. The deployed `AUTH_EMAIL`
binding uses that native Cloudflare service and does not require an API key. Do
not put the sender in a frontend environment variable. If Cloudflare Email
Sending is not available for the account, use the compatible Resend fallback:

```bash
pnpm exec wrangler secret put RESEND_API_KEY
pnpm exec wrangler secret put EMAIL_FROM
```

## Enabling customer-capital execution

Do not change a flag simply to make an execution control appear “live.” Every
item below must have an attached change record and evidence before the final
explicit enablement:

1. A fixed strategy passes its locked out-of-sample gate and the planned paper
   observation window with fees, slippage, and drawdown recorded.
2. A funded, approved account proves the separately authorized controlled order
   path, query/fill sync, cancellation cleanup, and NAV reconciliation end-to-end.
3. The D1 migration state has a backup and verified rollback record.
4. Production credentials are rotated and constrained to trade-only scope;
   withdrawal permissions stay disabled and egress allowlists are verified.
5. The operator changes exactly the relevant adapter environment and submission
   flag, then validates the public release-status endpoint and forced-failure
   controls before enabling automated signal dispatch. The current Aster pilot
   uses a hard $100 per-order ceiling and retains the global kill switch.

`ASTER_LIVE_ORDER_SUBMISSION_ENABLED=true`,
`PANCAKESWAP_LIVE_ORDER_SUBMISSION_ENABLED=true`, and
`AUTOMATED_SIGNAL_DISPATCH_ENABLED=true` are independent controls. The current
pilot enables Aster plus dispatch; PancakeSwap remains disabled.

## Real-money pilot telemetry

The pilot writes durable, non-secret evidence to D1 rather than relying on
ephemeral Worker logs:

- `audit_log` records agent preparation/approval, balance synchronization,
  risk skips, submission attempts, and provider failures.
- `execution_jobs` records the final capped notional, normalized quantity,
  order identifiers, lifecycle timestamps, and redacted provider errors.
- `order_events` preserves provider receipts and lifecycle transitions for a
  specific execution job.

Useful operator checks:

```bash
pnpm exec wrangler d1 execute anavitrade-db --remote --command \
  "SELECT id, userId, status, notionalUsd, symbol, orderId, errorMessage, updatedAt \
   FROM execution_jobs WHERE provider = 'aster' ORDER BY id DESC LIMIT 50;"

pnpm exec wrangler d1 execute anavitrade-db --remote --command \
  "SELECT id, userId, action, detail, createdAt \
   FROM audit_log WHERE action LIKE 'EXEC_%' OR action LIKE 'ASTER_%' \
   ORDER BY id DESC LIMIT 100;"
```

For an immediate stop, set the persisted `global_kill_switch` to `true` through
the authenticated execution control; the risk engine checks it before every
per-account decision. Do not remove the $100 cap while the pilot is gathering
evidence.
