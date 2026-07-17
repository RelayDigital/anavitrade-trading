import {
  type CexClient,
  type CexCredentials,
  type CexTransport,
  type ExchangeEnvironment,
  validateCexOrderRequest,
} from "./clientTypes";
import { BinanceFuturesClient } from "./binance";
import { BitunixFuturesClient } from "./bitunix";
import { BybitFuturesClient } from "./bybit";
import { OkxFuturesClient } from "./okx";
import { KrakenFuturesClient } from "./kraken";
import { KuCoinFuturesClient } from "./kucoin";
import { GateioFuturesClient } from "./gateio";
import { CoinbaseFuturesClient } from "./coinbase";
import {
  assertAutomatedExecutionSupported,
  isLiveExchange,
  resolveExchangeEndpoint,
} from "./registry";

export { UnsupportedCexCapabilityError } from "./registry";

export type CexClientFactoryOptions = {
  transport?: CexTransport;
};

function resolveCredentialEnvironment(creds: CexCredentials): ExchangeEnvironment {
  const explicit = creds.environment as unknown;
  if (explicit !== undefined && explicit !== "production" && explicit !== "testnet") {
    return explicit as ExchangeEnvironment;
  }
  if (explicit && creds.testnet !== undefined && creds.testnet !== (explicit === "testnet")) {
    return "unknown" as ExchangeEnvironment;
  }
  return (explicit as ExchangeEnvironment | undefined) ?? (creds.testnet ? "testnet" : "production");
}

function guardAutomatedMethods(
  exchange: string,
  environment: ExchangeEnvironment,
  client: CexClient,
): CexClient {
  return {
    validateAndReadBalance: () => client.validateAndReadBalance(),
    verifyTradeOnly: () => client.verifyTradeOnly(),
    setLeverage: async (symbol, leverage) => {
      assertAutomatedExecutionSupported(exchange, environment);
      return client.setLeverage(symbol, leverage);
    },
    placeOrder: async (request) => {
      assertAutomatedExecutionSupported(exchange, environment);
      return client.placeOrder(validateCexOrderRequest(request));
    },
    getPositions: (symbol) => client.getPositions(symbol),
    ...(client.getOrderById
      ? { getOrderById: (symbol: string, orderId: string) => client.getOrderById!(symbol, orderId) }
      : {}),
    ...(client.getOrderByClientId
      ? { getOrderByClientId: (symbol: string, clientOrderId: string) => client.getOrderByClientId!(symbol, clientOrderId) }
      : {}),
  };
}

/** Build the right CEX client for an exchange id. Throws for non-live exchanges. */
export function createCexClient(
  exchange: string,
  creds: CexCredentials,
  options: CexClientFactoryOptions = {},
): CexClient {
  if (!isLiveExchange(exchange)) {
    throw new Error(`EXCHANGE_NOT_LIVE:${exchange}`);
  }
  const environment = resolveCredentialEnvironment(creds);
  const endpoint = resolveExchangeEndpoint(exchange, environment);
  let client: CexClient;
  switch (exchange) {
    case "binance":
      client = new BinanceFuturesClient({ ...creds, environment }, options.transport, endpoint);
      break;
    case "bitunix":
      client = new BitunixFuturesClient(creds);
      break;
    case "bybit":
      client = new BybitFuturesClient(creds);
      break;
    case "okx":
      client = new OkxFuturesClient(creds);
      break;
    case "kraken":
      client = new KrakenFuturesClient(creds);
      break;
    case "kucoin":
      client = new KuCoinFuturesClient(creds);
      break;
    case "gateio":
      client = new GateioFuturesClient(creds);
      break;
    case "coinbase":
      client = new CoinbaseFuturesClient(creds);
      break;
    default:
      throw new Error(`EXCHANGE_UNSUPPORTED:${exchange}`);
  }
  return guardAutomatedMethods(exchange, environment, client);
}
