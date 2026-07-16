import { getEnv } from "../_core/env";

const DEFAULT_ASTER_API_BASE_URL = "https://fapi.asterdex.com";
const DEFAULT_ASTER_FEE_RATE = "0";

function parseSigningChainId(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getAsterConfig() {
  const env = getEnv();
  const environment = env.ASTER_ENVIRONMENT ?? "production";
  const defaultSigningChainId = environment === "testnet" ? 714 : 1666;
  return {
    apiBaseUrl: env.ASTER_API_BASE_URL ?? DEFAULT_ASTER_API_BASE_URL,
    builderAddress: env.ASTER_BUILDER_ADDRESS ?? "",
    defaultFeeRate: env.ASTER_DEFAULT_FEE_RATE ?? DEFAULT_ASTER_FEE_RATE,
    environment,
    asterChain: env.ASTER_CHAIN ?? (environment === "testnet" ? "Testnet" : "Mainnet"),
    codeSigningChainId: parseSigningChainId(env.ASTER_CODE_SIGNING_CHAIN_ID, defaultSigningChainId),
    includeCompatParams: env.ASTER_INCLUDE_COMPAT_PARAMS === "true",
    liveOrderSubmissionEnabled: env.ASTER_LIVE_ORDER_SUBMISSION_ENABLED === "true",
  };
}
