import { hmacSha256Hex } from "./signing";
import type {
  CexBalance, CexClient, CexCredentials, CexOrderRequest, CexOrderResult,
  CexPermissionCheck, CexPosition,
} from "./clientTypes";

const BASE = "https://api.bybit.com";
const RECV_WINDOW = 5000;

/**
 * Bybit Unified Trading (linear futures). Signed requests use HMAC-SHA256
 * over the query string with X-BAPI-API-KEY header. Bybit's v5 API.
 */
export class BybitFuturesClient implements CexClient {
  private readonly key: string;
  private readonly secret: string;

  constructor(creds: CexCredentials) {
    this.key = creds.apiKey;
    this.secret = creds.apiSecret;
  }

  private async signedGet(path: string, params: Record<string, string | number | boolean> = {}) {
    const timestamp = String(Date.now());
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const signStr = timestamp + this.key + (query ? `&${query}` : "");
    const signature = await hmacSha256Hex(this.secret, signStr);

    const url = `${BASE}${path}${query ? `?${query}` : ""}`;
    const res = await fetch(url, {
      headers: {
        "X-BAPI-API-KEY": this.key,
        "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": String(RECV_WINDOW),
      },
    });
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`BYBIT_${json.retCode}:${json.retMsg ?? "error"}`);
    return json.result;
  }

  private async signedPost(path: string, body: Record<string, unknown> = {}) {
    const timestamp = String(Date.now());
    const bodyStr = JSON.stringify(body);
    const signStr = timestamp + this.key + RECV_WINDOW + bodyStr;
    const signature = await hmacSha256Hex(this.secret, signStr);

    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "X-BAPI-API-KEY": this.key,
        "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": String(RECV_WINDOW),
        "Content-Type": "application/json",
      },
      body: bodyStr,
    });
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`BYBIT_${json.retCode}:${json.retMsg ?? "error"}`);
    return json.result;
  }

  async validateAndReadBalance(): Promise<CexBalance> {
    const acct = await this.signedGet("/v5/account/wallet-balance", { accountType: "UNIFIED", coin: "USDT" });
    const list = acct.list?.[0] ?? {};
    const coin = (list.coin ?? []).find((c: any) => c.coin === "USDT") ?? {};
    const equityUsd = parseFloat(coin.equity ?? list.totalEquity ?? 0);
    const availableUsd = parseFloat(coin.walletBalance ?? list.totalWalletBalance ?? 0);
    return { equityUsd, availableUsd };
  }

  async verifyTradeOnly(): Promise<CexPermissionCheck> {
    // Bybit v5 has no permission introspection API for API keys.
    return {
      withdrawalDisabledVerified: false,
      permissionsVerified: false,
      note: "Bybit does not expose a key-permission API. Trade-only is user-attested.",
    };
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.signedPost("/v5/position/set-leverage", {
      category: "linear", symbol, buyLeverage: String(leverage), sellLeverage: String(leverage),
    });
  }

  async placeOrder(req: CexOrderRequest): Promise<CexOrderResult> {
    if (req.leverage) {
      try { await this.setLeverage(req.symbol, req.leverage); } catch { /* non-fatal */ }
    }
    const body: Record<string, unknown> = {
      category: "linear",
      symbol: req.symbol,
      side: req.side === "SELL" ? "Sell" : "Buy",
      orderType: req.type === "LIMIT" ? "Limit" : "Market",
      qty: req.quantity,
      timeInForce: req.type === "LIMIT" ? "GTC" : "IOC",
      ...(req.reduceOnly ? { reduceOnly: true } : {}),
      ...(req.clientOrderId ? { orderLinkId: req.clientOrderId } : {}),
    };
    if (req.type === "LIMIT" && req.price) body.price = req.price;
    const data = await this.signedPost("/v5/order/create", body);
    return {
      orderId: String(data.orderId ?? ""),
      status: data.orderStatus === "Filled" ? "filled" : "accepted",
      raw: data,
    };
  }

  async getPositions(symbol?: string): Promise<CexPosition[]> {
    const params: Record<string, string | boolean> = { category: "linear", settleCoin: "USDT" };
    if (symbol) params.symbol = symbol;
    const data = await this.signedGet("/v5/position/list", params);
    const arr = Array.isArray(data.list) ? data.list : [];
    return arr
      .filter((p: any) => parseFloat(p.size ?? "0") > 0)
      .map((p: any) => {
        const qty = parseFloat(p.size ?? "0");
        const side = String(p.side ?? "").toUpperCase();
        return {
          symbol: p.symbol,
          sizeSigned: side === "SELL" || side === "SHORT" ? -qty : qty,
          entryPrice: parseFloat(p.avgPrice ?? p.entryPrice ?? 0),
          leverage: parseFloat(p.leverage ?? "1"),
          unrealizedPnlUsd: parseFloat(p.unrealisedPnl ?? p.unRealizedPnl ?? 0),
        };
      });
  }
}
