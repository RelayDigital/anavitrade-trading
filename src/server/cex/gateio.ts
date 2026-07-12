import { hmacSha512Hex } from "./signing";
import type {
  CexBalance, CexClient, CexCredentials, CexOrderRequest, CexOrderResult,
  CexPermissionCheck, CexPosition,
} from "./clientTypes";

const BASE = "https://api.gateio.ws";
const API_PREFIX = "/api/v4";

/**
 * Gate.io Futures client. Uses HMAC-SHA512 header-based signing with
 * KEY, Timestamp, and SIGN headers. No passphrase needed.
 */
export class GateioFuturesClient implements CexClient {
  private readonly key: string;
  private readonly secret: string;

  constructor(creds: CexCredentials) {
    this.key = creds.apiKey;
    this.secret = creds.apiSecret;
  }

  private async signedRequest(method: "GET" | "POST", path: string, body: unknown = null) {
    const prefix = "/api/v4" + (path.startsWith("/api") ? path.replace("/api/v4", "") : path);
    const url = `${BASE}${API_PREFIX}${path}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyStr = body ? JSON.stringify(body) : "";
    const signStr = [method, prefix, body ? JSON.stringify(body) : "", timestamp].join("\n");
    const signature = await hmacSha512Hex(this.secret, signStr);

    const headers: Record<string, string> = {
      KEY: this.key,
      Timestamp: timestamp,
      SIGN: signature,
    };
    if (method === "POST" || body) headers["Content-Type"] = "application/json";

    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`GATEIO_${res.status}:${text.slice(0, 300)}`);

    try { return JSON.parse(text); } catch { return text; }
  }

  async validateAndReadBalance(): Promise<CexBalance> {
    const data = await this.signedRequest("GET", "/futures/usdt/accounts");
    const equityUsd = parseFloat(data.total ?? data.amount ?? 0);
    const availableUsd = parseFloat(data.available ?? 0);
    return { equityUsd, availableUsd };
  }

  async verifyTradeOnly(): Promise<CexPermissionCheck> {
    return {
      withdrawalDisabledVerified: false,
      permissionsVerified: false,
      note: "Gate.io does not expose key permissions via API. Trade-only is user-attested.",
    };
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.signedRequest("POST", `/futures/usdt/positions/${symbol}/leverage`, { leverage: String(leverage) });
  }

  async placeOrder(req: CexOrderRequest): Promise<CexOrderResult> {
    if (req.leverage) {
      try { await this.setLeverage(req.symbol, req.leverage); } catch { /* non-fatal */ }
    }
    const body: Record<string, unknown> = {
      contract: req.symbol,
      size: parseInt(req.quantity, 10) * (req.side === "SELL" ? -1 : 1),
      price: req.type === "LIMIT" ? req.price : "0",
      tif: req.type === "LIMIT" ? "gtc" : "ioc",
    };
    if (req.clientOrderId) body.text = req.clientOrderId;
    if (req.stopLossPrice) body.stp_id = "stop-loss";
    if (req.takeProfitPrice) body.stp_id = "take-profit";

    const data = await this.signedRequest("POST", "/futures/usdt/orders", body);
    return {
      orderId: String(data.id ?? ""),
      status: data.status === "filled" ? "filled" : "accepted",
      raw: data,
    };
  }

  async getPositions(symbol?: string): Promise<CexPosition[]> {
    const path = symbol
      ? `/futures/usdt/positions?contract=${symbol}`
      : "/futures/usdt/positions";
    const data = await this.signedRequest("GET", path);
    const arr = Array.isArray(data) ? data : [];
    return arr
      .filter((p: any) => parseFloat(p.size ?? "0") !== 0)
      .map((p: any) => ({
        symbol: p.contract ?? p.symbol ?? "",
        sizeSigned: parseFloat(p.size ?? 0),
        entryPrice: parseFloat(p.entry_price ?? 0),
        leverage: parseFloat(p.leverage ?? "1"),
        unrealizedPnlUsd: parseFloat(p.unrealised_pnl ?? p.unrealizedPnl ?? 0),
      }));
  }
}
