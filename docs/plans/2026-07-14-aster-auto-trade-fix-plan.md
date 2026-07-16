# Aster Auto-Trade Fix Plan

**Status:** Draft implementation plan  
**Scope:** Make Aster auto-trade work through the existing onboarding/dashboard surfaces. UI polish or replacement is out of scope unless explicitly requested.

## Goal

Enable reliable Aster auto-trade without replacing the UI by fixing the official Aster Code activation flow, backend request payload/signing, execution dispatch, risk gates, verification, and rollout controls.

## Current Context

- Aster execution is the active DEX path; keep Hyperliquid/Binance UI replacement work out of this plan.
- `ASTER_LIVE_ORDER_SUBMISSION_ENABLED` must remain false in production until non-production live-order proof is complete.
- Existing implementation areas: `src/server/aster/*`, `src/server/execution/*`, `src/pages/AsterOnboarding.tsx`, `src/components/dashboard/AsterExecutionPanel.tsx`, `src/drizzle/schema.ts`.
- Official Aster Code references:
  - `https://docs.asterdex.com/program-and-rewards/aster-code`
  - `https://asterdex.github.io/aster-api-website/asterCode/integration-flow/`
  - `https://asterdex.github.io/aster-api-website/asterCode/authentication/`
  - `https://asterdex.github.io/aster-api-website/asterCode/endpoints/`

## Phase 1: Activation Contract Alignment

1. Treat activation as Aster Code management authorization, not local-only status mutation.
2. Use official management endpoints and typed-data shapes:
   - `POST /fapi/v3/approveAgent` with `primaryType=ApproveAgent`.
   - `POST /fapi/v3/approveBuilder` with `primaryType=ApproveBuilder`, unless bundled with Agent approval and confirmed by the API response.
3. Verify params and storage match Aster's current contract:
   - `user`, `nonce`, `signature`, `agentName`, `agentAddress`, `ipWhitelist`, `expired`, `canSpotTrade`, `canPerpTrade`, `canWithdraw`, `builder`, `maxFeeRate`, `builderName`.
   - Expiry is milliseconds; nonce is microseconds-style.
   - Withdraw permission must remain false.
   - Perps enabled; spot disabled unless a product requirement changes.
4. Do not mark `aster_agent_accounts.status=active` until Aster accepts Agent authorization and Builder authorization is confirmed or explicitly known to be included.
5. Add or verify an Agent/Builder validation read after activation:
   - `GET /fapi/v3/agent`
   - `GET /fapi/v3/builder`
   - Persist `agentStatus`, `builderStatus`, `lastValidatedAt`, and rejection reason.

## Phase 2: Backend Payload And Signing Fixes

1. Split signing paths clearly:
   - Management endpoints: dynamic EIP-712 primary type such as `ApproveAgent` or `ApproveBuilder`, signed by the user's main wallet.
   - Trading endpoints: fixed `Message` type where `msg` is the exact final querystring excluding `signature`, signed by the Agent signer.
2. Make querystring construction deterministic and shared:
   - Preserve parameter ordering from signing through request body.
   - Use `application/x-www-form-urlencoded`.
   - Never rebuild, sort differently, or JSON-encode the signed payload after signing.
3. Confirm chain/domain config by environment:
   - Aster Code EIP-712 domain: `name=AsterSignTransaction`, `version=1`, zero verifying contract.
   - Use the correct chain ID for management and trading in production/testnet. Do not hardcode incompatible chain IDs across both modes.
4. Ensure order payloads include required Aster Code fields:
   - `user`, `signer`, `nonce`, `signature`, `symbol`, `type`, `side`, `quantity`, `builder`, `feeRate`.
   - LIMIT orders include `price` and `timeInForce`.
   - `feeRate` must be less than or equal to the user's approved `maxFeeRate`.
5. Keep leverage setting explicit through `/fapi/v3/leverage` before order submission, with signed payload verification and audit events.
6. Add enough structured error capture to distinguish:
   - signature mismatch,
   - missing Agent,
   - missing Builder approval,
   - rejected order payload,
   - live-order gate disabled.

## Phase 3: Dispatch And Risk Gate Fixes

1. Aster fan-out must only select accounts with:
   - `aster_agent_accounts.status=active`,
   - `agentStatus=approved`,
   - `builderStatus=approved`,
   - non-expired `approvalExpiresAt`,
   - matching builder address and fee cap.
2. Feed Aster accounts through the same provider-neutral risk engine, but ensure it has usable equity:
   - If `live_accounts` lacks equity, sync/refresh before sizing.
   - If equity is still unavailable, reject with `no_equity_snapshot` rather than falling back to arbitrary quantity.
3. Replace price fallback sizing for market orders with a provider price source or a staged/rejected job. Do not size live Aster orders using a hardcoded price.
4. Keep idempotency per `(user, intent, provider)` and serialize by Aster Agent signer.
5. Include staged, queued, submitted, filled, rejected, cancelled, and error transitions in `execution_jobs` and `order_events`.
6. Keep `ASTER_LIVE_ORDER_SUBMISSION_ENABLED=false` behavior as staging, not failure.
7. Ensure global kill switch, account kill switch, leverage cap, max position size, max total exposure, and daily loss limit all apply before Aster submission.

## Phase 4: Verification

1. Static checks:
   - `pnpm check`
   - `pnpm build`
   - server typecheck if separate from the main check.
2. Unit or integration coverage:
   - management typed-data payload generation,
   - exact querystring signing for trading requests,
   - Agent/Builder status validation,
   - live-order gate staging,
   - risk rejections for expired approval, missing equity, kill switch, and fee cap violations.
3. Safe API smoke tests:
   - `/fapi/v3/ping`
   - `/fapi/v3/time`
   - signed order with throwaway signer should reach Aster auth path and fail safely with missing Agent.
4. Non-production live proof:
   - connect a testnet or non-production funded wallet,
   - approve Agent and Builder,
   - verify Agent/Builder readback,
   - enable live submission outside production,
   - submit a tiny LIMIT order,
   - query order status/fill events,
   - cancel/cleanup if unfilled,
   - verify `execution_jobs`, `order_events`, audit logs, NAV snapshot, and fee-ledger inputs.

## Phase 5: Rollout And Live-Order Gating

1. Production default:
   - `ASTER_LIVE_ORDER_SUBMISSION_ENABLED=false`.
   - Aster jobs may stage, but cannot submit live orders.
2. Pre-production gate:
   - static egress IP available for Agent IP whitelist,
   - signer key storage reviewed beyond app-JWT-only protection,
   - Agent expiry and rotation workflow documented,
   - rollback path tested by disabling live submission and revoking Agent/Builder approvals.
3. Limited production gate:
   - enable live submission for a single internal account only,
   - max notional and leverage capped below normal user defaults,
   - alert on every submitted/rejected order,
   - require manual review of first fills and NAV reconciliation.
4. General availability gate:
   - successful internal runbook completion,
   - repeated tiny-order proofs,
   - no unexplained signature/order rejects,
   - order lifecycle and NAV reconciliation stable,
   - fee crystallization validated against reconciled NAV, not raw Aster builder fees.

## Non-Goals

- Replacing the dashboard or onboarding UI.
- Adding broad UI polish beyond copy/state updates needed to expose backend truth.
- Implementing CEX execution changes except where shared dispatch/risk contracts must stay provider-neutral.
- Treating Aster builder fees as Anavitrade's 2-and-20 fee model.
