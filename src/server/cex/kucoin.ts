import { hmacSha256Hex } from "./signing";
import type {
  CexBalance, CexClient, CexCredentials, CexOrderRequest, CexOrderResult,
  CexPermissionCheck, CexPosition,
} from "./clientTypes";

const BASE = "https://api-futures.kucoin.com";

/**
 * KuCoin Futures client. Uses header-based HMAC-SHA256 with API key, secret,
 * passphrase, and timestamp. Requires a passphrase.
 */
export class KuCoinFuturesClient implements CexClient {
  private readonly key: string;
  private readonly secret: string;
  private readonly passphrase: string;

  constructor(creds: CexCredentials) {
    if (!creds.passphrase) throw new Error("KuCoin requires an API passphrase");
    this.key = creds.apiKey;
    this.secret = creds.apiSecret;
    this.passphrase = creds.passphrase;
  }

  private async signedRequest(method: "GET" | "POST", path: string, body: unknown = null) {
    const timestamp = String(Date.now());
    const bodyStr = body ? JSON.stringify(body) : "";
    const signStr = timestamp + method + path + bodyStr;
    const signature = await hmacSha256Hex(this.secret, signStr);
    const passSig = await hmacSha256Hex(this.secret, this.passphrase);

    const headers: Record<string, string> = {
      "KC-API-KEY": this.key,
      "KC-API-SIGN": signature,
      "KC-API-TIMESTAMP": timestamp,
      "KC-API-PASSPHRASE": passSig,
      "KC-API-KEY-VERSION": "2",
    };

    const opts: RequestInit = { method, headers };
    if (method === "POST" && bodyStr) {
      headers["Content-Type"] = "application/json";
      opts.body = bodyStr;
    }

    const res = await fetch(`${BASE}${path}`, opts);
    const json = await res.json();
    if (json.code !== "200000") throw new Error(`KUCOIN_${json.code}:${json.msg ?? "error"}`);
    return json.data;
  }

  async validateAndReadBalance(): Promise<CexBalance> {
    const data = await this.signedRequest("GET", "/api/v1/account-overview?currency=USDT");
    const equityUsd = parseFloat(data.equity ?? data.accountEquity ?? 0);
    const availableUsd = parseFloat(data.availableBalance ?? data.frozenBalance ?? 0) + parseFloat(data.frozenBalance ?? 0);
    return { equityUsd, availableUsd };
  }

  async verifyTradeOnly(): Promise<CexPermissionCheck> {
    return {
      withdrawalDisabledVerified: false,
      permissionsVerified: false,
      note: "KuCoin does not expose key permissions via API. Trade-only is user-attested.",
    };
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.signedRequest("POST", "/api/v1/position/set-leverage", {
      symbol, leverage: String(leverage),
    });
  }

  async placeOrder(req: CexOrderRequest): Promise<CexOrderResult> {
    if (req.leverage) {
      try { await this.setLeverage(req.symbol, req.leverage); } catch { /* non-fatal */ }
    }
    const body: Record<string, unknown> = {
      symbol: req.symbol,
      side: req.side === "SELL" ? "sell" : "buy",
      type: req.type === "LIMIT" ? "limit" : "market",
      size: parseInt(req.quantity, 10),
      leverage: String(req.leverage ?? 1),
      marginMode: "cross",
    };
    if (req.type === "LIMIT" && req.price) body.price = req.price;
    if (req.reduceOnly) body.reduceOnly = true;
    if (req.clientOrderId) body.clientOid = req.clientOrderId;

    const data = await this.signedRequest("POST", "/api/v1/orders", body);
    return {
      orderId: String(data.orderId ?? ""),
      status: data.status === "done" ? "filled" : "accepted",
      raw: data,
    };
  }

  async getPositions(symbol?: string): Promise<CexPosition[]> {
    const path = symbol
      ? `/api/v1/positions?symbol=${symbol}`
      : "/api/v1/positions";
    const data = await this.signedRequest("GET", path);
    const arr = Array.isArray(data) ? data : [];
    return arr
      .filter((p: any) => parseFloat(p.currentQty ?? "0") !== 0)
      .map((p: any) => {
        const qty = parseFloat(p.currentQty ?? 0);
        return {
          symbol: p.symbol,
          sizeSigned: qty,
          entryPrice: parseFloat(p.avgEntryPrice ?? 0),
          leverage: parseFloat(p.leverage ?? "1"),
          unrealizedPnlUsd: parseFloat(p.unrealisedPnl ?? p.unRealizedPnl ?? 0),
        };
      });
  }
}
