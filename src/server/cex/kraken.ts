import { hmacSha256Hex, sha256Hex } from "./signing";
import type {
  CexBalance, CexClient, CexCredentials, CexOrderRequest, CexOrderResult,
  CexPermissionCheck, CexPosition,
} from "./clientTypes";

const BASE = "https://futures.kraken.com";

/**
 * Kraken Futures client. Uses API key + signed message (HMAC-SHA256 over
 * a formatted payload string). The Kraken Futures API differs significantly
 * from the Spot API.
 */
export class KrakenFuturesClient implements CexClient {
  private readonly key: string;
  private readonly secret: string;

  constructor(creds: CexCredentials) {
    this.key = creds.apiKey;
    this.secret = creds.apiSecret;
  }

  private async signedGet(path: string, params: Record<string, string | number> = {}) {
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const url = `${BASE}${path}${query ? `?${query}` : ""}`;

    // Kraken Futures auth: Authenticate header
    const nonce = String(Date.now() * 1000);
    const endpoint = `/derivatives${path}`;
    const signPayload = nonce + endpoint + (query ? `?${query}` : "");
    const signature = await hmacSha256Hex(this.secret, signPayload);

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.key}`,
        Nonce: nonce,
        Signature: signature,
      },
    });
    const json = await res.json();
    if (json.error && json.error !== "0") {
      const msg = Array.isArray(json.error) ? json.error.join("; ") : String(json.error);
      throw new Error(`KRAKEN_${res.status}:${msg}`);
    }
    return json.result ?? json;
  }

  private async signedPost(path: string, body: Record<string, unknown> = {}) {
    const nonce = String(Date.now() * 1000);
    const bodyStr = JSON.stringify(body);
    const endpoint = `/derivatives${path}`;
    const signPayload = nonce + endpoint + bodyStr;
    const signature = await hmacSha256Hex(this.secret, signPayload);

    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        Nonce: nonce,
        Signature: signature,
        "Content-Type": "application/json",
      },
      body: bodyStr,
    });
    const json = await res.json();
    if (json.error && json.error !== "0") {
      const msg = Array.isArray(json.error) ? json.error.join("; ") : String(json.error);
      throw new Error(`KRAKEN_${res.status}:${msg}`);
    }
    return json.result ?? json;
  }

  async validateAndReadBalance(): Promise<CexBalance> {
    const acct = await this.signedGet("/api/v3/accounts");
    const eq = parseFloat(acct.equity ?? acct.totalEquity ?? 0);
    const avail = parseFloat(acct.free ?? acct.available ?? 0);
    return { equityUsd: eq, availableUsd: avail };
  }

  async verifyTradeOnly(): Promise<CexPermissionCheck> {
    return {
      withdrawalDisabledVerified: false,
      permissionsVerified: false,
      note: "Kraken Futures does not expose a key-permission API. Trade-only is user-attested.",
    };
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const pfSymbol = symbol.replace("USDT", "");
    await this.signedPost("/api/v3/leverage", { symbol: pfSymbol, leverage });
  }

  async placeOrder(req: CexOrderRequest): Promise<CexOrderResult> {
    if (req.leverage) {
      try { await this.setLeverage(req.symbol, req.leverage); } catch { /* non-fatal */ }
    }
    const pfSymbol = req.symbol.replace("USDT", "");
    const body: Record<string, unknown> = {
      symbol: pfSymbol,
      side: req.side === "SELL" ? "sell" : "buy",
      type: req.type === "LIMIT" ? "lmt" : "mkt",
      size: parseInt(req.quantity, 10),
    };
    if (req.type === "LIMIT" && req.price) body.limitPrice = req.price;
    if (req.reduceOnly) body.reduceOnly = true;
    if (req.stopLossPrice) body.stopPrice = req.stopLossPrice;
    if (req.takeProfitPrice) body.limitPrice = req.takeProfitPrice;
    if (req.clientOrderId) body.cliOrdId = req.clientOrderId;

    const data = await this.signedPost("/api/v3/sendorder", body);
    return {
      orderId: String(data.orderId ?? ""),
      status: data.status === "filled" ? "filled" : "accepted",
      raw: data,
    };
  }

  async getPositions(symbol?: string): Promise<CexPosition[]> {
    const data = await this.signedGet("/api/v3/openpositions", symbol ? { symbol: symbol.replace("USDT", "") } : {});
    const arr = Array.isArray(data) ? data : (data.positions ?? []);
    return arr
      .filter((p: any) => parseFloat(p.size ?? p.netSize ?? 0) !== 0)
      .map((p: any) => {
        const qty = parseFloat(p.size ?? p.netSize ?? 0);
        return {
          symbol: (p.symbol ?? p.market ?? "") + "USDT",
          sizeSigned: qty,
          entryPrice: parseFloat(p.price ?? p.avgPrice ?? 0),
          leverage: parseFloat(p.leverage ?? "1"),
          unrealizedPnlUsd: parseFloat(p.unrealizedPnl ?? p.unrealized ?? 0),
        };
      });
  }
}
