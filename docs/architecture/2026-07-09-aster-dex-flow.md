# Aster DEX Flow

Last updated: 2026-07-09

## Decision

Anavitrade DEX execution is Aster-only. Hyperliquid language and Binance execution panels are legacy scaffolding and should be replaced as the product moves to live DEX trading.

The correct product framing is not an invisible exchange. Anavitrade is the strategy, automation, risk, reporting, and fee layer. Aster is the disclosed execution venue and liquidity layer.

## Aster Code Model

Aster Code gives Anavitrade a builder/broker-style integration path:

- Anavitrade registers a Builder address.
- Anavitrade generates one Agent signer per user.
- The user approves the Agent for limited trading permissions.
- The user approves the Builder and fee cap.
- Anavitrade submits orders to Aster using the user-specific Agent signer.
- Orders include the Anavitrade Builder address and configured `feeRate`.
- Aster handles the order book, margin, fills, funding, and liquidation.

Protocol docs:

- https://docs.asterdex.com/program-and-rewards/aster-code
- https://asterdex.github.io/aster-api-website/asterCode/integration-flow/

## Permissions

Use the minimum viable Agent permission set:

- Perps: enabled.
- Spot: disabled unless a later product requirement needs it.
- Withdraw: disabled.
- IP whitelist: enabled when execution runs from a static egress IP.
- Expiry: required for production, with rotation workflow.

Cloudflare Workers do not provide the right static egress guarantee for strict Agent IP whitelisting. Keep the dashboard/API on Cloudflare, but run order signing/submission from a small execution service with static egress before mainnet funds.

## 2 and 20 Fees

Anavitrade charges users:

- 2% annual management fee on capital, accrued daily.
- 20% performance fee on net new profits above the high-water mark.

Aster Builder `feeRate` is a per-order builder fee and must not be treated as the full 2-and-20 model. Keep 2-and-20 in Anavitrade's own fee ledger:

- `nav_snapshots` records account equity.
- `fee_periods` records management and performance accruals.
- `fee_payments` records collection.
- High-water mark prevents double-charging performance fees after drawdowns.

## Core Runtime Flow

1. User connects wallet and enters/links Aster account.
2. Backend creates one Agent signer for that user.
3. User signs Aster `approveAgent`.
4. User signs Aster `approveBuilder`.
5. Backend marks the Aster account active only after both approvals are verified.
6. Strategy emits `TradeIntent`.
7. Risk engine creates one `ExecutionJob` per eligible user.
8. Aster execution worker serializes jobs per signer.
9. Worker submits Aster order with Builder address and fee rate.
10. Fill sync records `order_events`, NAV snapshots, and fee accruals.

## Non-Negotiables

- One Agent signer per user.
- No withdrawal permission.
- Per-user kill switch.
- Global kill switch.
- Per-user leverage cap, max position size, and max daily loss.
- Idempotency key per user and trade intent.
- Serialized order queue per signer.
- Full audit log for approvals, risk decisions, order submission, fills, rejects, cancels, and fee events.
- Signer keys must not remain protected only by the app JWT secret in production.

## Current Repo Foundation

Implemented backend scaffolding:

- `src/server/aster/types.ts`
- `src/server/aster/config.ts`
- `src/server/aster/signing.ts`
- `src/server/aster/client.ts`
- `src/server/aster/store.ts`
- `src/server/aster/router.ts`

Implemented schema/migration:

- `aster_agent_accounts`
- `trade_intents`
- `execution_jobs`
- `order_events`
- `nav_snapshots`
- `fee_periods`
- `fee_payments`

Implemented product surfaces:

- `src/pages/AsterOnboarding.tsx` for Agent/Builder setup.
- `/onboarding/aster` protected route.
- Dashboard Aster execution-readiness panel.
- Settings Aster Agent management tab.
- `.env.example` Aster configuration placeholders.

Live order submission is intentionally gated. Keep `ASTER_LIVE_ORDER_SUBMISSION_ENABLED=false` until Aster request signing, the exact order payload contract, and fill sync are wired and tested. Foundation-mode approval recording is user-confirmed; production must verify `approveAgent` and `approveBuilder` against Aster before activation.
