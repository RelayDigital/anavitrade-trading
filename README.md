# Anavitrade Trading

Standalone React/Vite trading platform reconstructed from the Manus export.

This project is intentionally separate from `/home/ariel/anavi-project/anavi`.

## Commands

```bash
pnpm install
pnpm check
pnpm build
pnpm dev
```

Local dev URL:

```text
http://localhost:5174/
```

## WalletConnect

Injected wallets, MetaMask, Coinbase Wallet, and Ledger direct connection are wired through Wagmi.

WalletConnect QR flows require a Reown/WalletConnect project ID:

```bash
cp .env.example .env
```

Then set:

```text
VITE_WALLETCONNECT_PROJECT_ID=your_project_id
```

Without this value, the app still runs and browser wallets can connect, but WalletConnect QR is unavailable.

## Local Data

The Manus backend dependency is replaced with a local front-end compatibility shim in `src/lib/trpc.ts`.

- Auth state is stored in `localStorage`.
- Web3 wallet session state is stored in `localStorage`.
- Coinlegs signal data comes from the live Cloudflare Worker:
  `https://coinlegs-worker.erhazeariel.workers.dev/latest`
- TradingView widgets are embedded in `src/components/TradingViewMiniWidgets.tsx`.


## Aster DEX Execution

The onchain DEX flow is Aster-only. The app prepares one user-specific Aster Agent signer, records Agent/Builder approval state, and keeps live order submission gated until Aster request signing and fill sync are verified.

Required backend environment values:

```text
ASTER_API_BASE_URL=https://fapi.asterdex.com
ASTER_BUILDER_ADDRESS=0xYourRegisteredAsterBuilderAddress
ASTER_DEFAULT_FEE_RATE=0
ASTER_ENVIRONMENT=production
ASTER_LIVE_ORDER_SUBMISSION_ENABLED=false
```

Architecture docs live in `docs/architecture/2026-07-09-aster-dex-flow.md` and `docs/architecture/2026-07-09-claude-cex-handoff.md`.
