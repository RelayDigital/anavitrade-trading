import { hmacSha256Hex } from "./signing";
import type {
  CexBalance, CexClient, CexCredentials, CexOrderRequest, CexOrderResult,
  CexPermissionCheck, CexPosition,
} from "./clientTypes";

const BASE = "https://www.okx.com";

/**
 * OKX Unified Trading Account. Uses header-based HMAC-SHA256 signing with
 * OK-ACCESS-KEY / SIGN / TIMESTAMP / PASSPHRASE headers. Requires a passphrase.
 */
export class OkxFuturesClient implements CexClient {
  private readonly key: string;
  private readonly secret: string;
  private readonly passphrase: string;

  constructor(creds: CexCredentials) {
    if (!creds.passphrase) throw new Error("OKX requires an API passphrase");
    this.key = creds.apiKey;
    this.secret = creds.apiSecret;
    this.passphrase = creds.passphrase;
  }

  private async request(method: "GET" | "POST", path: string, body: unknown = "") {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const bodyStr = body ? JSON.stringify(body) : "";
    const signStr = timestamp + method + path + bodyStr;
    const signature = await hmacSha256Hex(this.secret, signStr);

    const headers: Record<string, string> = {
      "OK-ACCESS-KEY": this.key,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.passphrase,
    };

    const opts: RequestInit = { method, headers };
    if (method === "POST" && bodyStr) {
      headers["Content-Type"] = "application/json";
      opts.body = bodyStr;
    }

    const res = await fetch(`${BASE}${path}`, opts);
    const json = await res.json();
    if (json.code !== "0") throw new Error(`OKX_${json.code}:${json.msg ?? "error"}`);
    return json.data;
  }

  async validateAndReadBalance(): Promise<CexBalance> {
    const data = await this.request("GET", "/api/v5/account/balance?ccy=USDT");
    const acct = Array.isArray(data) ? data[0] : data;
    const details = acct.details?.[0] ?? {};
    const equityUsd = parseFloat(details.eq ?? acct.totalEq ?? 0);
    const availableUsd = parseFloat(details.availBal ?? 0);
    return { equityUsd, availableUsd };
  }

  async verifyTradeOnly(): Promise<CexPermissionCheck> {
    return {
      withdrawalDisabledVerified: false,
      permissionsVerified: false,
      note: "OKX does not expose a key-permission API. Trade-only is user-attested.",
    };
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    // OKX uses instId (e.g., BTC-USDT-SWAP)
    const instId = symbol.endsWith("-SWAP") ? symbol : symbol.replace("USDT", "-USDT-SWAP");
    await this.request("POST", "/api/v5/account/set-leverage", {
      instId, lever: String(leverage), mgnMode: "cross",
    });
  }

  async placeOrder(req: CexOrderRequest): Promise<CexOrderResult> {
    if (req.leverage) {
      try { await this.setLeverage(req.symbol, req.leverage); } catch { /* non-fatal */ }
    }
    const instId = req.symbol.endsWith("-SWAP") ? req.symbol : req.symbol.replace("USDT", "-USDT-SWAP");
    const body: Record<string, string> = {
      instId,
      tdMode: "cross",
      side: req.side === "SELL" ? "sell" : "buy",
      ordType: req.type === "LIMIT" ? "limit" : "market",
      sz: req.quantity,
    };
    if (req.type === "LIMIT" && req.price) body.px = req.price;
    if (req.reduceOnly) body.reduceOnly = "true";
    if (req.clientOrderId) body.clOrdId = req.clientOrderId;

    const data = await this.request("POST", "/api/v5/trade/order", body);
    const order = Array.isArray(data) ? data[0] : data;
    return {
      orderId: String(order.ordId ?? ""),
      status: order.state === "filled" ? "filled" : order.sCode === "0" ? "accepted" : "accepted",
      raw: data,
    };
  }

  async getPositions(symbol?: string): Promise<CexPosition[]> {
    const path = symbol
      ? `/api/v5/account/positions?instId=${symbol.endsWith("-SWAP") ? symbol : symbol.replace("USDT", "-USDT-SWAP")}`
      : "/api/v5/account/positions";
    const data = await this.request("GET", path);
    const arr = Array.isArray(data) ? data : [];
    return arr
      .filter((p: any) => parseFloat(p.pos ?? p.availPos ?? "0") !== 0)
      .map((p: any) => {
        const qty = parseFloat(p.pos ?? p.availPos ?? 0);
        return {
          symbol: p.instId,
          sizeSigned: p.posSide === "short" ? -qty : qty,
          entryPrice: parseFloat(p.avgPx ?? 0),
          leverage: parseFloat(p.lever ?? "1"),
          unrealizedPnlUsd: parseFloat(p.upl ?? 0),
        };
      });
  }
}
