import type { Env } from "./_core/env";

export type PublicReleaseStatus = {
  platformEnvironment: "development" | "testnet" | "staging" | "production" | "unknown";
  releaseLane: "development" | "testnet" | "production-platform-execution-disabled" | "production-execution-enabled" | "unknown";
  automatedSignalDispatchEnabled: boolean;
  customerCapitalExecutionEnabled: boolean;
  authenticationEmailConfigured: boolean;
  emailVerificationRequired: boolean;
  adapters: {
    aster: {
      environment: "development" | "testnet" | "production" | "unknown";
      orderSubmissionEnabled: boolean;
      configured: boolean;
      maxOrderNotionalUsd: number | null;
    };
    pancakeswap: {
      environment: "development" | "testnet" | "production" | "unknown";
      orderSubmissionEnabled: boolean;
      configured: boolean;
    };
  };
};

function knownPlatformEnvironment(value: unknown): PublicReleaseStatus["platformEnvironment"] {
  return value === "development" || value === "testnet" || value === "staging" || value === "production"
    ? value
    : "unknown";
}

function knownExecutionEnvironment(value: unknown): "development" | "testnet" | "production" | "unknown" {
  return value === "development" || value === "testnet" || value === "production" ? value : "unknown";
}

/**
 * Returns only non-secret, operator-relevant release state. A production web
 * platform can intentionally keep every customer-capital execution adapter in
 * a testnet or disabled lane while validation is in progress.
 */
export function getPublicReleaseStatus(env: Pick<Env,
  | "APP_ENVIRONMENT"
  | "AUTOMATED_SIGNAL_DISPATCH_ENABLED"
  | "ASTER_ENVIRONMENT"
  | "ASTER_LIVE_ORDER_SUBMISSION_ENABLED"
  | "ASTER_MAX_ORDER_NOTIONAL_USD"
  | "ASTER_BUILDER_ADDRESS"
  | "ASTER_AGENT_ONLY_ENABLED"
  | "PANCAKESWAP_ENVIRONMENT"
  | "PANCAKESWAP_LIVE_ORDER_SUBMISSION_ENABLED"
  | "PANCAKESWAP_EXECUTOR_ADDRESS"
  | "AUTH_EMAIL"
  | "RESEND_API_KEY"
  | "EMAIL_FROM"
  | "REQUIRE_EMAIL_VERIFICATION"
>): PublicReleaseStatus {
  const platformEnvironment = knownPlatformEnvironment(env.APP_ENVIRONMENT);
  const asterEnvironment = knownExecutionEnvironment(env.ASTER_ENVIRONMENT);
  const pancakeswapEnvironment = knownExecutionEnvironment(env.PANCAKESWAP_ENVIRONMENT);
  const asterOrderSubmissionEnabled = env.ASTER_LIVE_ORDER_SUBMISSION_ENABLED === "true";
  const configuredAsterCap = Number(env.ASTER_MAX_ORDER_NOTIONAL_USD);
  const asterMaxOrderNotionalUsd = Number.isFinite(configuredAsterCap) && configuredAsterCap > 0
    ? configuredAsterCap
    : null;
  const pancakeswapOrderSubmissionEnabled = env.PANCAKESWAP_LIVE_ORDER_SUBMISSION_ENABLED === "true";
  const automatedSignalDispatchEnabled = env.AUTOMATED_SIGNAL_DISPATCH_ENABLED === "true";
  const customerCapitalExecutionEnabled = asterOrderSubmissionEnabled || pancakeswapOrderSubmissionEnabled;
  const authenticationEmailConfigured = Boolean(
    env.EMAIL_FROM?.trim() && (env.AUTH_EMAIL || env.RESEND_API_KEY?.trim()),
  );
  const emailVerificationRequired = env.REQUIRE_EMAIL_VERIFICATION !== "false";

  const releaseLane = platformEnvironment === "production"
    ? customerCapitalExecutionEnabled
      ? "production-execution-enabled"
      : "production-platform-execution-disabled"
    : platformEnvironment === "development" || platformEnvironment === "testnet"
      ? platformEnvironment
      : "unknown";

  return {
    platformEnvironment,
    releaseLane,
    automatedSignalDispatchEnabled,
    customerCapitalExecutionEnabled,
    authenticationEmailConfigured,
    emailVerificationRequired,
    adapters: {
      aster: {
        environment: asterEnvironment,
        orderSubmissionEnabled: asterOrderSubmissionEnabled,
        configured: Boolean(env.ASTER_BUILDER_ADDRESS)
          || env.ASTER_AGENT_ONLY_ENABLED === "true"
          || asterEnvironment === "testnet",
        maxOrderNotionalUsd: asterMaxOrderNotionalUsd,
      },
      pancakeswap: {
        environment: pancakeswapEnvironment,
        orderSubmissionEnabled: pancakeswapOrderSubmissionEnabled,
        configured: Boolean(env.PANCAKESWAP_EXECUTOR_ADDRESS),
      },
    },
  };
}
