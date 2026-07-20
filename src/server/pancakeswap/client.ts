import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20Token, Native, CurrencyAmount, TradeType, Percent } from "@pancakeswap/sdk";
import { SmartRouter } from "@pancakeswap/smart-router/evm";
import { PancakeSwapUniversalRouter, getUniversalRouterAddress } from "@pancakeswap/universal-router-sdk";
import { getPancakeswapConfig } from "./config";
import type { PancakeswapPermitSingle } from "./types";

/**
 * Minimal local Permit2 ABI (allowance/permit only — this codebase never needs
 * SignatureTransfer or batch permits). Declared locally rather than importing
 * @pancakeswap/permit2-sdk's Permit2ABI because that package bundles its own
 * viem type instantiation, which produces spurious structural mismatches
 * against this app's viem client generics even after dependency de-duplication.
 */
const PERMIT2_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "address" },
      { name: "", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  {
    type: "function",
    name: "permit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      {
        name: "permitSingle",
        type: "tuple",
        components: [
          {
            name: "details",
            type: "tuple",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint160" },
              { name: "expiration", type: "uint48" },
              { name: "nonce", type: "uint48" },
            ],
          },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export function getPublicClient() {
  return createPublicClient({ chain: bsc, transport: http(getPancakeswapConfig().rpcUrl) });
}

export function getExecutorWalletClient() {
  const config = getPancakeswapConfig();
  if (!config.executorPrivateKey) throw new Error("PANCAKESWAP_EXECUTOR_NOT_CONFIGURED");
  const account = privateKeyToAccount(config.executorPrivateKey as `0x${string}`);
  return createWalletClient({ account, chain: bsc, transport: http(config.rpcUrl) });
}

/** Reads the current Permit2 allowance/nonce for (owner, token, spender) — the nonce
 *  must be included in any new PermitSingle the owner signs. */
export async function readPermit2Allowance(input: { owner: `0x${string}`; token: `0x${string}`; spender: `0x${string}` }) {
  const config = getPancakeswapConfig();
  const client = getPublicClient();
  const [amount, expiration, nonce] = await client.readContract({
    address: config.permit2Address,
    abi: PERMIT2_ABI,
    functionName: "allowance",
    args: [input.owner, input.token, input.spender],
    authorizationList: undefined,
  });
  return { amount, expiration, nonce };
}

/** Submits the user-signed PermitSingle to Permit2, activating the capped allowance
 *  on-chain. Paid for by the executor account, not the user. */
export async function submitPermit2Permit(input: {
  owner: `0x${string}`;
  permit: PancakeswapPermitSingle;
  signature: Hex;
}): Promise<Hex> {
  const config = getPancakeswapConfig();
  const walletClient = getExecutorWalletClient();
  const publicClient = getPublicClient();

  const hash = await walletClient.writeContract({
    address: config.permit2Address,
    abi: PERMIT2_ABI,
    functionName: "permit",
    chain: bsc,
    account: walletClient.account,
    args: [
      input.owner,
      {
        details: {
          token: input.permit.details.token as `0x${string}`,
          amount: BigInt(input.permit.details.amount),
          expiration: input.permit.details.expiration,
          nonce: input.permit.details.nonce,
        },
        spender: input.permit.spender as `0x${string}`,
        sigDeadline: BigInt(input.permit.sigDeadline),
      },
      input.signature,
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

const BSC_CHAIN_ID = bsc.id;

/**
 * Curated BSC token list for quoting. Deliberately scoped to the same tokens
 * tracked by useWalletAssets.ts — V3 on-chain pool discovery only (no
 * subgraph dependency), which keeps this path testable without an unverified
 * external endpoint. Wider pair coverage is a documented follow-up.
 */
const BSC_TOKENS: Record<string, ERC20Token> = {
  USDT: new ERC20Token(BSC_CHAIN_ID, "0x55d398326f99059fF775485246999027B3197955", 18, "USDT"),
  USDC: new ERC20Token(BSC_CHAIN_ID, "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18, "USDC"),
};

function resolveCurrency(symbol: string) {
  if (symbol === "BNB") return Native.onChain(BSC_CHAIN_ID);
  const token = BSC_TOKENS[symbol];
  if (!token) throw new Error(`PANCAKESWAP_UNSUPPORTED_TOKEN:${symbol}`);
  return token;
}

export type PancakeswapQuote = {
  trade: Awaited<ReturnType<typeof SmartRouter.getBestTrade>>;
  amountOut: string;
};

/** Quotes a swap via PancakeSwap's V3 pools discovered directly on-chain (no subgraph). */
export async function getSwapQuote(input: {
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amountInRaw: bigint;
}): Promise<PancakeswapQuote> {
  const client = getPublicClient();
  const currencyIn = resolveCurrency(input.tokenInSymbol);
  const currencyOut = resolveCurrency(input.tokenOutSymbol);
  const amount = CurrencyAmount.fromRawAmount(currencyIn, input.amountInRaw.toString());

  // NOTE: cast needed — an unrelated global viem module augmentation (from the
  // `porto` wallet-connector package, pulled in transitively via wagmi) alters
  // viem's inferred default Account generic project-wide, which makes this
  // plain (account-less) PublicClient structurally mismatch SmartRouter's
  // third-party OnChainProvider type even though it's functionally identical.
  const onChainProvider = () => client as any;

  const v3Pools = await SmartRouter.getV3CandidatePools({
    currencyA: currencyIn,
    currencyB: currencyOut,
    onChainProvider,
  });

  const quoteProvider = SmartRouter.createQuoteProvider({ onChainProvider });
  const poolProvider = SmartRouter.createStaticPoolProvider(v3Pools);

  const trade = await SmartRouter.getBestTrade(amount, currencyOut, TradeType.EXACT_INPUT, {
    gasPriceWei: () => client.getGasPrice(),
    maxHops: 2,
    maxSplits: 2,
    poolProvider,
    quoteProvider,
  });

  if (!trade) throw new Error("PANCAKESWAP_NO_ROUTE_FOUND");
  return { trade, amountOut: trade.outputAmount.quotient.toString() };
}

/**
 * Builds atomic swap calldata using the Universal Router's native Permit2
 * support (`inputTokenPermit`) — the router itself calls permit2.permit() +
 * pulls from the SIGNER (recovered from the signature, not msg.sender) +
 * swaps + delivers to `recipient`, all in one transaction submitted by the
 * executor. This avoids any separate pull-then-swap custody window.
 */
export function buildSwapCalldata(input: {
  trade: NonNullable<Awaited<ReturnType<typeof getSwapQuote>>["trade"]>;
  recipient: `0x${string}`;
  permit: PancakeswapPermitSingle;
  signature: Hex;
  slippageToleranceBps?: number;
}) {
  return PancakeSwapUniversalRouter.swapERC20CallParameters(input.trade, {
    recipient: input.recipient,
    slippageTolerance: new Percent(input.slippageToleranceBps ?? 100, 10_000),
    inputTokenPermit: {
      details: input.permit.details,
      spender: input.permit.spender,
      sigDeadline: input.permit.sigDeadline,
      signature: input.signature,
    },
    payerIsUser: true,
  });
}

export function getPancakeswapUniversalRouterAddress() {
  return getUniversalRouterAddress(BSC_CHAIN_ID);
}
