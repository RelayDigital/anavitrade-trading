import { hmacSha256Hex } from "./signing";
import type {
  CexBalance, CexClient, CexCredentials, CexOrderRequest, CexOrderResult,
  CexPermissionCheck, CexPosition,
} from "./clientTypes";

const BASE = "https://api.exchange.coinbase.com";

/**
 * Coinbase Advanced Trade / Exchange API client.
 * Uses CB-ACCESS-SIGN (HMAC-SHA256), CB-ACCESS-KEY, CB-ACCESS-TIMESTAMP,
 * and CB-ACCESS-PASSPHRASE headers. Requires a passphrase.
 */
export class CoinbaseFuturesClient implements CexClient {
  private readonly key: string;
  private readonly secret: string;
  private readonly passphrase: string;

  constructor(creds: CexCredentials) {
    if (!creds.passphrase) throw new Error("Coinbase requires an API passphrase");
    this.key = creds.apiKey;
    this.secret = creds.apiSecret;
    this.passphrase = creds.passphrase;
  }

  private async request(method: "GET" | "POST", path: string, body: unknown = null) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyStr = body ? JSON.stringify(body) : "";
    const signStr = timestamp + method + path + bodyStr;
    const signature = await hmacSha256Hex(this.secret, signStr);

    const headers: Record<string, string> = {
      "CB-ACCESS-KEY": this.key,
      "CB-ACCESS-SIGN": signature,
      "CB-ACCESS-TIMESTAMP": timestamp,
      "CB-ACCESS-PASSPHRASE": this.passphrase,
      "Content-Type": "application/json",
    };

    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE}${path}`, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`COINBASE_${res.status}:${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  async validateAndReadBalance(): Promise<CexBalance> {
    const accounts = await this.request("GET", "/accounts");
    const arr = Array.isArray(accounts) ? accounts : [];
    let equityUsd = 0;
    let availableUsd = 0;
    for (const acct of arr) {
      if (acct.currency === "USDT" || acct.currency === "USD" || acct.currency === "USDC") {
        equityUsd += parseFloat(acct.balance ?? 0);
        availableUsd += parseFloat(acct.available ?? 0);
      }
    }
    return { equityUsd, availableUsd };
  }

  async verifyTradeOnly(): Promise<CexPermissionCheck> {
    // Coinbase has no per-key permission introspection; all or nothing.
    return {
      withdrawalDisabledVerified: false,
      permissionsVerified: false,
      note: "Coinbase does not expose key permissions via API. Trade-only is user-attested.",
    };
  }

  async setLeverage(_symbol: string, _leverage: number): Promise<void> {
    // Coinbase Futures manages leverage at the product level; no per-order API call needed.
  }

  async placeOrder(req: CexOrderRequest): Promise<CexOrderResult> {
    const productId = req.symbol.endsWith("-USD") ? req.symbol : req.symbol.replace("USDT", "-USD");
    const body: Record<string, unknown> = {
      product_id: productId,
      side: req.side === "SELL" ? "SELL" : "BUY",
      order_configuration: {},
    };
    if (req.type === "LIMIT" && req.price) {
      body.order_configuration = {
        limit_limit_gtc: {
          base_size: req.quantity,
          limit_price: req.price,
        },
      };
    } else {
      body.order_configuration = {
        market_market_ioc: {
          quote_size: req.quantity,
        },
      };
    }
    if (req.clientOrderId) body.client_order_id = req.clientOrderId;

    const data = await this.request("POST", "/orders", body);
    return {
      orderId: String(data.order_id ?? data.id ?? ""),
      status: data.status === "FILLED" ? "filled" : "accepted",
      raw: data,
    };
  }

  async getPositions(symbol?: string): Promise<CexPosition[]> {
    const data = await this.request("GET", "/positions");
    const arr = Array.isArray(data) ? data : (data.positions ?? []);
    return arr
      .filter((p: any) => parseFloat(p.position_size ?? "0") !== 0)
      .map((p: any) => ({
        symbol: p.product_id ?? "",
        sizeSigned: parseFloat(p.position_size ?? 0) * (p.side === "SHORT" ? -1 : 1),
        entryPrice: parseFloat(p.entry_price ?? p.avg_entry_price ?? 0),
        leverage: 1,
        unrealizedPnlUsd: parseFloat(p.unrealized_pnl ?? 0),
      }));
  }
}
