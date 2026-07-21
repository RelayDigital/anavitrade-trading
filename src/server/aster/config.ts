import { getEnv } from "../_core/env";

const DEFAULT_ASTER_API_BASE_URL = "https://fapi.asterdex.com";
const DEFAULT_ASTER_TESTNET_API_BASE_URL = "https://fapi.asterdex-testnet.com";
const DEFAULT_ASTER_FEE_RATE = "0";
export const DEFAULT_ASTER_MAX_ORDER_NOTIONAL_USD = 100;

function parseSigningChainId(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseAsterMaxOrderNotionalUsd(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ASTER_MAX_ORDER_NOTIONAL_USD;
}

export function resolveAsterRegistrationSigningChainId(
  environment: string,
  agentOnlyEnabled: boolean,
  codeSigningChainId: number,
): number {
  return environment === "testnet" || agentOnlyEnabled ? 56 : codeSigningChainId;
}

export function getAsterConfig() {
  const env = getEnv();
  const environment = env.ASTER_ENVIRONMENT ?? "production";
  const defaultSigningChainId = environment === "testnet" ? 714 : 1666;
  const agentOnlyEnabled = env.ASTER_AGENT_ONLY_ENABLED === "true";
  const codeSigningChainId = parseSigningChainId(env.ASTER_CODE_SIGNING_CHAIN_ID, defaultSigningChainId);
  return {
    apiBaseUrl: env.ASTER_API_BASE_URL ?? (environment === "testnet"
      ? DEFAULT_ASTER_TESTNET_API_BASE_URL
      : DEFAULT_ASTER_API_BASE_URL),
    builderAddress: env.ASTER_BUILDER_ADDRESS ?? "",
    agentOnlyEnabled,
    defaultFeeRate: env.ASTER_DEFAULT_FEE_RATE ?? DEFAULT_ASTER_FEE_RATE,
    environment,
    asterChain: env.ASTER_CHAIN ?? (environment === "testnet" ? "Testnet" : "Mainnet"),
    // Aster Code management domain: 1666 production, 714 testnet.
    codeSigningChainId,
    registrationSigningChainId: resolveAsterRegistrationSigningChainId(
      environment,
      agentOnlyEnabled,
      codeSigningChainId,
    ),
    includeCompatParams: env.ASTER_INCLUDE_COMPAT_PARAMS === "true",
    liveOrderSubmissionEnabled: env.ASTER_LIVE_ORDER_SUBMISSION_ENABLED === "true",
    maxOrderNotionalUsd: parseAsterMaxOrderNotionalUsd(env.ASTER_MAX_ORDER_NOTIONAL_USD),
  };
}
