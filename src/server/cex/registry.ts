import type { ExchangeEnvironment } from "./clientTypes";

/**
 * Exchange registry — the single source of truth for the consumer "connect an
 * exchange" dropdown. Frontend reads this via cex.listExchanges. Only exchanges
 * with `live: true` have working signing/validation this pass; the rest render
 * as "Coming soon".
 */

export type SigningScheme = "hmac-sha256" | "hmac-sha512" | "double-sha256";

export type ExchangeAdapterCapabilities = {
  environments: ExchangeEnvironment[];
  orderTypes: Array<"MARKET" | "LIMIT">;
  nativeBracket: boolean;
  separateProtectionOrders: boolean;
  positionMode: "one-way" | "hedge" | "unverified";
  automatedExecution: boolean;
};

export type UnsupportedCexCapabilityCode =
  | "CEX_EXCHANGE_UNKNOWN"
  | "CEX_ENVIRONMENT_UNKNOWN"
  | "CEX_ENVIRONMENT_UNSUPPORTED"
  | "CEX_AUTOMATED_EXECUTION_UNSUPPORTED";

export class UnsupportedCexCapabilityError extends Error {
  readonly name = "UnsupportedCexCapabilityError";

  constructor(
    readonly code: UnsupportedCexCapabilityCode,
    readonly exchange: string,
    readonly environment?: unknown,
  ) {
    super(`${code}:${exchange}${environment === undefined ? "" : `:${String(environment)}`}`);
  }
}

export type ExchangeMeta = {
  id: string;
  label: string;
  live: boolean;
  signingScheme: SigningScheme;
  baseUrl: string;
  testnetBaseUrl?: string;
  /** Whether the exchange exposes an API to verify key permissions (no-withdrawal). */
  canVerifyPermissions: boolean;
  /** Some exchanges (OKX/KuCoin/Coinbase) require a passphrase alongside key+secret. */
  needsPassphrase: boolean;
  /** Short consumer instruction blurb shown in the onboarding wizard. */
  keyHint: string;
  capabilities: ExchangeAdapterCapabilities;
};

const BINANCE_CAPABILITIES: ExchangeAdapterCapabilities = {
  environments: ["production", "testnet"],
  orderTypes: ["MARKET", "LIMIT"],
  nativeBracket: false,
  separateProtectionOrders: true,
  positionMode: "one-way",
  automatedExecution: true,
};

function unverifiedCapabilities(): ExchangeAdapterCapabilities {
  return {
    environments: ["production"],
    orderTypes: ["MARKET", "LIMIT"],
    nativeBracket: false,
    separateProtectionOrders: false,
    positionMode: "unverified",
    automatedExecution: false,
  };
}

export const EXCHANGES: ExchangeMeta[] = [
  {
    id: "binance",
    label: "Binance",
    live: true,
    signingScheme: "hmac-sha256",
    baseUrl: "https://fapi.binance.com",
    testnetBaseUrl: "https://testnet.binancefuture.com",
    canVerifyPermissions: true,
    needsPassphrase: false,
    keyHint: "API Management → Create API → enable Futures, leave Withdrawals OFF.",
    capabilities: BINANCE_CAPABILITIES,
  },
  {
    id: "bitunix",
    label: "Bitunix",
    live: true,
    signingScheme: "double-sha256",
    baseUrl: "https://fapi.bitunix.com",
    canVerifyPermissions: false,
    needsPassphrase: false,
    keyHint: "API Management → create key → grant Futures/Trade, do NOT grant Withdraw.",
    capabilities: unverifiedCapabilities(),
  },
  { id: "bybit", label: "Bybit", live: true, signingScheme: "hmac-sha256", baseUrl: "https://api.bybit.com", canVerifyPermissions: false, needsPassphrase: false, keyHint: "Bybit v5 lacks API permission introspection. Create a trade-only key and attest on connection. API Management → Create API → enable Unified Trading permissions, leave Withdrawals OFF.", capabilities: unverifiedCapabilities() },
  { id: "okx", label: "OKX", live: true, signingScheme: "hmac-sha256", baseUrl: "https://www.okx.com", canVerifyPermissions: false, needsPassphrase: true, keyHint: "API → Create API → Futures trade permission (not withdrawal). Save the passphrase — you need it here.", capabilities: unverifiedCapabilities() },
  { id: "coinbase", label: "Coinbase", live: true, signingScheme: "hmac-sha256", baseUrl: "https://api.exchange.coinbase.com", canVerifyPermissions: false, needsPassphrase: true, keyHint: "Exchange API → Create API key → Trading permission only (no withdraw). Save the passphrase.", capabilities: unverifiedCapabilities() },
  { id: "kraken", label: "Kraken", live: true, signingScheme: "hmac-sha256", baseUrl: "https://futures.kraken.com", canVerifyPermissions: false, needsPassphrase: false, keyHint: "API Keys → Generate API key → enable Futures, disable Withdrawals.", capabilities: unverifiedCapabilities() },
  { id: "kucoin", label: "KuCoin", live: true, signingScheme: "hmac-sha256", baseUrl: "https://api-futures.kucoin.com", canVerifyPermissions: false, needsPassphrase: true, keyHint: "API Management → Create API → Futures permission. Set a passphrase — you need it here.", capabilities: unverifiedCapabilities() },
  { id: "gateio", label: "Gate.io", live: true, signingScheme: "hmac-sha512", baseUrl: "https://api.gateio.ws", canVerifyPermissions: false, needsPassphrase: false, keyHint: "API → Create API key → Futures trade permission only. Supports USDT perpetuals.", capabilities: unverifiedCapabilities() },
];

export function getExchange(id: string): ExchangeMeta | undefined {
  return EXCHANGES.find((e) => e.id === id);
}

export function isLiveExchange(id: string): boolean {
  return Boolean(getExchange(id)?.live);
}

export function getExchangeCapabilities(exchange: string): ExchangeAdapterCapabilities {
  const meta = getExchange(exchange);
  if (!meta) throw new UnsupportedCexCapabilityError("CEX_EXCHANGE_UNKNOWN", exchange);
  return meta.capabilities;
}

export function resolveExchangeEndpoint(
  exchange: string,
  environment: ExchangeEnvironment,
): string {
  if (environment !== "production" && environment !== "testnet") {
    throw new UnsupportedCexCapabilityError("CEX_ENVIRONMENT_UNKNOWN", exchange, environment);
  }
  const meta = getExchange(exchange);
  if (!meta) throw new UnsupportedCexCapabilityError("CEX_EXCHANGE_UNKNOWN", exchange, environment);
  if (!meta.capabilities.environments.includes(environment)) {
    throw new UnsupportedCexCapabilityError("CEX_ENVIRONMENT_UNSUPPORTED", exchange, environment);
  }
  const endpoint = environment === "production" ? meta.baseUrl : meta.testnetBaseUrl;
  if (!endpoint) {
    throw new UnsupportedCexCapabilityError("CEX_ENVIRONMENT_UNSUPPORTED", exchange, environment);
  }
  return endpoint;
}

export function assertAutomatedExecutionSupported(
  exchange: string,
  environment: ExchangeEnvironment,
): void {
  const capabilities = getExchangeCapabilities(exchange);
  resolveExchangeEndpoint(exchange, environment);
  if (!capabilities.automatedExecution
    || (!capabilities.nativeBracket && !capabilities.separateProtectionOrders)) {
    throw new UnsupportedCexCapabilityError(
      "CEX_AUTOMATED_EXECUTION_UNSUPPORTED",
      exchange,
      environment,
    );
  }
}

/** Public projection for the frontend dropdown (no internal URLs needed there). */
export function listExchangesPublic() {
  return EXCHANGES.map((e) => ({
    id: e.id,
    label: e.label,
    live: e.live,
    needsPassphrase: e.needsPassphrase,
    canVerifyPermissions: e.canVerifyPermissions,
    automatedExecution: e.capabilities.automatedExecution,
    environments: e.capabilities.environments,
    keyHint: e.keyHint,
  }));
}
