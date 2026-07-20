import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useBalance, useReadContracts } from "wagmi";
import { mainnet, arbitrum, base, optimism, bsc } from "wagmi/chains";
import { formatUnits } from "viem";

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

type TokenConfig = { symbol: string; address: `0x${string}`; decimals: number; stable: boolean };

/** Curated token list per chain — native + the stablecoins/majors we care about for the wallet asset view. */
const CHAIN_TOKENS: Record<number, { nativeSymbol: string; nativePriceSymbol: string | null; tokens: TokenConfig[] }> = {
  [bsc.id]: {
    nativeSymbol: "BNB",
    nativePriceSymbol: "BNBUSDT",
    tokens: [
      { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, stable: true },
      { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, stable: true },
    ],
  },
  [mainnet.id]: {
    nativeSymbol: "ETH",
    nativePriceSymbol: "ETHUSDT",
    tokens: [
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, stable: true },
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, stable: true },
    ],
  },
  [arbitrum.id]: {
    nativeSymbol: "ETH",
    nativePriceSymbol: "ETHUSDT",
    tokens: [
      { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, stable: true },
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, stable: true },
    ],
  },
  [base.id]: {
    nativeSymbol: "ETH",
    nativePriceSymbol: "ETHUSDT",
    tokens: [
      { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, stable: true },
    ],
  },
  [optimism.id]: {
    nativeSymbol: "ETH",
    nativePriceSymbol: "ETHUSDT",
    tokens: [
      { symbol: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6, stable: true },
      { symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, stable: true },
    ],
  },
};

export type WalletAsset = {
  symbol: string;
  balance: string;
  balanceRaw: bigint;
  valueUsd: number | null;
};

/** Fetch spot USD price from Binance's public ticker endpoint (no auth, matches the fetch pattern
 *  already used for kline data elsewhere in this codebase). Returns null on any failure. */
async function fetchSpotPriceUsd(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { price?: string };
    const price = parseFloat(data.price ?? "");
    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

/**
 * Reads on-chain balances for a wallet address. Balance reads only need a
 * valid address + chainId (served via the public-RPC fallback transports
 * already configured in wagmi.ts) — they don't require a *live* wagmi
 * connector session. Accepting an override lets the dashboard fall back to
 * the server-persisted session address (the same source WalletPanel already
 * trusts) when wagmi's own connection state didn't register — e.g. after a
 * connector error, page reload, or a connection established outside wagmi's
 * own connect() flow. Without this, the panel silently shows nothing even
 * though the wallet is genuinely connected and the server has the address.
 */
export function useWalletAssets(override?: { address?: string | null; chainId?: number | null }) {
  const wagmiAccount = useAccount();
  const address = (override?.address ?? wagmiAccount.address) as `0x${string}` | undefined;
  const chainId = override?.chainId ?? wagmiAccount.chainId;
  const isConnected = !!address;
  const chainConfig = chainId ? CHAIN_TOKENS[chainId] : undefined;

  const nativeBalance = useBalance({
    address,
    chainId,
    query: { enabled: isConnected && !!chainConfig },
  });

  const tokenContracts = useMemo(() => {
    if (!chainConfig || !address) return [];
    return chainConfig.tokens.map((token) => ({
      address: token.address,
      abi: erc20BalanceAbi,
      functionName: "balanceOf" as const,
      args: [address] as const,
      chainId,
    }));
  }, [chainConfig, address, chainId]);

  const tokenBalances = useReadContracts({
    contracts: tokenContracts,
    query: { enabled: tokenContracts.length > 0 },
  });

  const nativePriceQuery = useQuery({
    queryKey: ["wallet-asset-native-price", chainConfig?.nativePriceSymbol],
    queryFn: () => fetchSpotPriceUsd(chainConfig!.nativePriceSymbol!),
    enabled: !!chainConfig?.nativePriceSymbol,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const assets: WalletAsset[] = useMemo(() => {
    if (!isConnected || !chainConfig) return [];
    const result: WalletAsset[] = [];

    if (nativeBalance.data) {
      const balanceRaw = nativeBalance.data.value;
      const balance = nativeBalance.data.formatted;
      const price = nativePriceQuery.data ?? null;
      result.push({
        symbol: chainConfig.nativeSymbol,
        balance,
        balanceRaw,
        valueUsd: price !== null ? parseFloat(balance) * price : null,
      });
    }

    chainConfig.tokens.forEach((token, i) => {
      const entry = tokenBalances.data?.[i];
      if (!entry || entry.status !== "success") return;
      const balanceRaw = entry.result as bigint;
      const balance = formatUnits(balanceRaw, token.decimals);
      result.push({
        symbol: token.symbol,
        balance,
        balanceRaw,
        valueUsd: token.stable ? parseFloat(balance) : null,
      });
    });

    return result.filter((asset) => asset.balanceRaw > 0n);
  }, [isConnected, chainConfig, nativeBalance.data, nativePriceQuery.data, tokenBalances.data]);

  const totalValueUsd = assets.reduce((sum, asset) => sum + (asset.valueUsd ?? 0), 0);
  const isLoading = nativeBalance.isLoading || tokenBalances.isLoading;
  const unsupportedChain = isConnected && !chainConfig;

  return { assets, totalValueUsd, isLoading, isConnected, chainId, unsupportedChain };
}
