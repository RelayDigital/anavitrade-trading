/**
 * Exchange registry — the single source of truth for the consumer "connect an
 * exchange" dropdown. Frontend reads this via cex.listExchanges. Only exchanges
 * with `live: true` have working signing/validation this pass; the rest render
 * as "Coming soon".
 */

export type SigningScheme = "hmac-sha256" | "hmac-sha512" | "double-sha256";

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
};

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
  },
  { id: "bybit", label: "Bybit", live: true, signingScheme: "hmac-sha256", baseUrl: "https://api.bybit.com", canVerifyPermissions: true, needsPassphrase: false, keyHint: "API Management → Create API → enable Unified Trading permissions, leave Withdrawals OFF." },
  { id: "okx", label: "OKX", live: true, signingScheme: "hmac-sha256", baseUrl: "https://www.okx.com", canVerifyPermissions: false, needsPassphrase: true, keyHint: "API → Create API → Futures trade permission (not withdrawal). Save the passphrase — you need it here." },
  { id: "coinbase", label: "Coinbase", live: true, signingScheme: "hmac-sha256", baseUrl: "https://api.exchange.coinbase.com", canVerifyPermissions: false, needsPassphrase: true, keyHint: "Exchange API → Create API key → Trading permission only (no withdraw). Save the passphrase." },
  { id: "kraken", label: "Kraken", live: true, signingScheme: "hmac-sha256", baseUrl: "https://futures.kraken.com", canVerifyPermissions: false, needsPassphrase: false, keyHint: "API Keys → Generate API key → enable Futures, disable Withdrawals." },
  { id: "kucoin", label: "KuCoin", live: true, signingScheme: "hmac-sha256", baseUrl: "https://api-futures.kucoin.com", canVerifyPermissions: false, needsPassphrase: true, keyHint: "API Management → Create API → Futures permission. Set a passphrase — you need it here." },
  { id: "gateio", label: "Gate.io", live: true, signingScheme: "hmac-sha512", baseUrl: "https://api.gateio.ws", canVerifyPermissions: false, needsPassphrase: false, keyHint: "API → Create API key → Futures trade permission only. Supports USDT perpetuals." },
];

export function getExchange(id: string): ExchangeMeta | undefined {
  return EXCHANGES.find((e) => e.id === id);
}

export function isLiveExchange(id: string): boolean {
  return Boolean(getExchange(id)?.live);
}

/** Public projection for the frontend dropdown (no internal URLs needed there). */
export function listExchangesPublic() {
  return EXCHANGES.map((e) => ({
    id: e.id,
    label: e.label,
    live: e.live,
    needsPassphrase: e.needsPassphrase,
    canVerifyPermissions: e.canVerifyPermissions,
    keyHint: e.keyHint,
  }));
}
