import { createConfig, http, fallback } from "wagmi";
import { mainnet, arbitrum, base, optimism, bsc } from "wagmi/chains";
import { walletConnect, metaMask, coinbaseWallet, injected } from "wagmi/connectors";

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string;

if (!projectId) {
  console.warn("[Wagmi] VITE_WALLETCONNECT_PROJECT_ID is not set — WalletConnect will not work.");
}

const siteUrl =
  typeof window !== "undefined"
    ? window.location.origin
    : "https://anavitrade.com";

const appName = "@navi";
const siteIcon = `${siteUrl}/favicon.ico`;

// Public RPC endpoints with failover — each chain gets a primary + backup transport.
// The fallback wrapper retries on the next transport if one fails.
// Public RPC endpoints with CORS support for browser-based read calls.
// When a wallet is connected, the wallet's own provider handles RPC;
// these are fallbacks for unconnected read operations (balance, chain checks).
const PUBLIC_RPCS: Record<number, string[]> = {
  [mainnet.id]: [
    "https://eth.drpc.org",
    "https://rpc.ankr.com/eth",
  ],
  [arbitrum.id]: [
    "https://arbitrum.drpc.org",
    "https://rpc.ankr.com/arbitrum",
  ],
  [base.id]: [
    "https://base.drpc.org",
    "https://rpc.ankr.com/base",
  ],
  [optimism.id]: [
    "https://optimism.drpc.org",
    "https://rpc.ankr.com/optimism",
  ],
  [bsc.id]: [
    "https://bsc-dataseed.binance.org",
    "https://rpc.ankr.com/bsc",
  ],
};

function buildTransports() {
  const transports: Record<number, ReturnType<typeof http>> = {};
  for (const [chainId, urls] of Object.entries(PUBLIC_RPCS)) {
    const id = Number(chainId);
    if (urls.length === 1) {
      transports[id] = http(urls[0], { retryCount: 3, retryDelay: 500 }) as ReturnType<typeof http>;
    } else {
      // fallback returns a different shape that wagmi accepts in createConfig transports
      transports[id] = fallback(
        urls.map((url) => http(url, { retryCount: 2, retryDelay: 400 })),
        { rank: true },
      ) as unknown as ReturnType<typeof http>;
    }
  }
  return transports;
}

export const wagmiConfig = createConfig({
  chains: [mainnet, arbitrum, base, optimism, bsc],
  connectors: [
    injected({ shimDisconnect: true }),
    metaMask({
      dappMetadata: {
        name: appName,
        url: siteUrl,
        iconUrl: siteIcon,
      },
    }),
    ...(projectId
      ? [
          walletConnect({
            projectId,
            metadata: {
              name: "@navi — Quantitative Trading",
              description: "Autonomous Quantitative Trading — Non-Custodial",
              url: siteUrl,
              icons: [siteIcon],
            },
            showQrModal: true,
          }),
        ]
      : []),
    coinbaseWallet({
      appName,
      appLogoUrl: siteIcon,
      version: "4",
      preference: {
        options: "eoaOnly",
        telemetry: false,
      },
    }),
  ],
  transports: buildTransports(),
});

export type WagmiConfig = typeof wagmiConfig;
