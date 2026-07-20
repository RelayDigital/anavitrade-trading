import { getEnv } from "../_core/env";

const DEFAULT_RPC_URL = "https://bsc-dataseed.binance.org";

/**
 * PancakeSwap's OWN Permit2 and Universal Router deployments on BSC — NOT the
 * same addresses as Uniswap's canonical Permit2. Pulled from PancakeSwap's
 * official docs repo; re-verify on BscScan (verified contract, "PancakeSwap"
 * label) before ever enabling live order submission with these defaults.
 */
const DEFAULT_PERMIT2_ADDRESS = "0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768";
const DEFAULT_UNIVERSAL_ROUTER_ADDRESS = "0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB";

export function getPancakeswapConfig() {
  const env = getEnv();
  const environment = env.PANCAKESWAP_ENVIRONMENT ?? "production";
  return {
    rpcUrl: env.PANCAKESWAP_RPC_URL ?? DEFAULT_RPC_URL,
    permit2Address: (env.PANCAKESWAP_PERMIT2_ADDRESS ?? DEFAULT_PERMIT2_ADDRESS) as `0x${string}`,
    universalRouterAddress: (env.PANCAKESWAP_UNIVERSAL_ROUTER_ADDRESS ?? DEFAULT_UNIVERSAL_ROUTER_ADDRESS) as `0x${string}`,
    executorAddress: (env.PANCAKESWAP_EXECUTOR_ADDRESS ?? "") as `0x${string}`,
    executorPrivateKey: env.PANCAKESWAP_EXECUTOR_PRIVATE_KEY ?? "",
    environment,
    liveOrderSubmissionEnabled: env.PANCAKESWAP_LIVE_ORDER_SUBMISSION_ENABLED === "true",
    configured: Boolean(env.PANCAKESWAP_EXECUTOR_ADDRESS),
  };
}
