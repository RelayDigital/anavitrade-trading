import type { CexClient, CexCredentials } from "./clientTypes";
import { BinanceFuturesClient } from "./binance";
import { BitunixFuturesClient } from "./bitunix";
import { BybitFuturesClient } from "./bybit";
import { OkxFuturesClient } from "./okx";
import { KrakenFuturesClient } from "./kraken";
import { KuCoinFuturesClient } from "./kucoin";
import { GateioFuturesClient } from "./gateio";
import { CoinbaseFuturesClient } from "./coinbase";
import { isLiveExchange } from "./registry";

/** Build the right CEX client for an exchange id. Throws for non-live exchanges. */
export function createCexClient(exchange: string, creds: CexCredentials): CexClient {
  if (!isLiveExchange(exchange)) {
    throw new Error(`EXCHANGE_NOT_LIVE:${exchange}`);
  }
  switch (exchange) {
    case "binance":
      return new BinanceFuturesClient(creds);
    case "bitunix":
      return new BitunixFuturesClient(creds);
    case "bybit":
      return new BybitFuturesClient(creds);
    case "okx":
      return new OkxFuturesClient(creds);
    case "kraken":
      return new KrakenFuturesClient(creds);
    case "kucoin":
      return new KuCoinFuturesClient(creds);
    case "gateio":
      return new GateioFuturesClient(creds);
    case "coinbase":
      return new CoinbaseFuturesClient(creds);
    default:
      throw new Error(`EXCHANGE_UNSUPPORTED:${exchange}`);
  }
}
