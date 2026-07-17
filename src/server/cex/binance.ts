import { binanceSignedQuery, hmacSha256Hex } from "./signing";
import type {
  CexBalance, CexClient, CexCredentials, CexExactOrder, CexOrderRequest, CexOrderResult,
  CexProtectionFailureOutcome,
  CexPermissionCheck, CexPosition, CexTransport, ExchangeEnvironment,
} from "./clientTypes";
import {
  CexProtectionError, type CexProtectionLegOutcome, validateCexOrderRequest,
} from "./clientTypes";
import { resolveExchangeEndpoint } from "./registry";

const SAPI_PROD = "https://api.binance.com"; // key-permission introspection lives on spot host

const RECV_WINDOW = 5000;

/**
 * Binance USDT-M Futures client. Signed requests use HMAC-SHA256 over the query
 * string with header X-MBX-APIKEY; the signature is appended last and is not
 * itself signed.
 */
export class BinanceFuturesClient implements CexClient {
  private readonly key: string;
  private readonly secret: string;
  private readonly fapi: string;
  private readonly environment: ExchangeEnvironment;
  private readonly transport: CexTransport;

  constructor(
    creds: CexCredentials,
    transport: CexTransport = fetch,
    endpoint?: string,
  ) {
    this.key = creds.apiKey;
    this.secret = creds.apiSecret;
    this.environment = creds.environment ?? (creds.testnet ? "testnet" : "production");
    this.fapi = endpoint ?? resolveExchangeEndpoint("binance", this.environment);
    this.transport = transport;
  }

  private headers() {
    return { "X-MBX-APIKEY": this.key };
  }

  private async signedGet(base: string, path: string, params: Record<string, string | number> = {}) {
    const query = await binanceSignedQuery(this.secret, {
      ...params, timestamp: Date.now(), recvWindow: RECV_WINDOW,
    });
    const res = await this.transport(`${base}${path}?${query}`, { headers: this.headers() });
    const text = await res.text();
    if (!res.ok) throw new Error(`BINANCE_${res.status}:${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  private async signedPost(path: string, params: Record<string, string | number> = {}) {
    const query = await binanceSignedQuery(this.secret, {
      ...params, timestamp: Date.now(), recvWindow: RECV_WINDOW,
    });
    const res = await this.transport(`${this.fapi}${path}?${query}`, { method: "POST", headers: this.headers() });
    const text = await res.text();
    if (!res.ok) throw new Error(`BINANCE_${res.status}:${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  private async signedDelete(path: string, params: Record<string, string | number> = {}) {
    const query = await binanceSignedQuery(this.secret, {
      ...params, timestamp: Date.now(), recvWindow: RECV_WINDOW,
    });
    const res = await this.transport(`${this.fapi}${path}?${query}`, { method: "DELETE", headers: this.headers() });
    const text = await res.text();
    if (!res.ok) throw new Error(`BINANCE_${res.status}:${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  private async compensateProtectionFailure(input: {
    order: CexOrderRequest;
    exitSide: "BUY" | "SELL";
    acceptedProtectionOrderId?: string;
  }): Promise<CexProtectionFailureOutcome["compensation"]> {
    let emergencyClose: CexProtectionLegOutcome = { status: "not_attempted" };
    let protectionCleanup: CexProtectionLegOutcome = { status: "not_attempted" };

    try {
      const response = await this.signedPost("/fapi/v1/order", {
        symbol: input.order.symbol,
        side: input.exitSide,
        type: "MARKET",
        quantity: input.order.quantity,
        reduceOnly: "true",
        newOrderRespType: "RESULT",
      });
      const orderId = String(response.orderId ?? response.clientOrderId ?? "");
      if (!orderId) throw new Error("BINANCE_COMPENSATION_ORDER_ID_MISSING");
      if (String(response.status ?? "").toUpperCase() !== "FILLED") {
        throw new Error(`BINANCE_COMPENSATION_NOT_FILLED:${String(response.status ?? "unknown").slice(0, 32)}`);
      }
      emergencyClose = { status: "accepted", orderId };
    } catch (error) {
      emergencyClose = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }

    if (input.acceptedProtectionOrderId) {
      try {
        const response = await this.signedDelete("/fapi/v1/order", {
          symbol: input.order.symbol,
          orderId: input.acceptedProtectionOrderId,
        });
        const orderId = String(response.orderId ?? response.clientOrderId ?? input.acceptedProtectionOrderId);
        protectionCleanup = { status: "accepted", orderId };
      } catch (error) {
        protectionCleanup = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    }

    const closeCompleted = emergencyClose.status === "accepted";
    const cleanupCompleted = protectionCleanup.status !== "failed";
    return {
      state: closeCompleted && cleanupCompleted ? "completed" : "failed",
      reason: "entry_accepted_without_complete_protection",
      emergencyClose,
      protectionCleanup,
    };
  }

  async validateAndReadBalance(): Promise<CexBalance> {
    const acct = await this.signedGet(this.fapi, "/fapi/v3/account");
    const equityUsd = Number(acct.totalWalletBalance ?? acct.totalMarginBalance ?? 0);
    const availableUsd = Number(acct.availableBalance ?? 0);
    return { equityUsd, availableUsd };
  }

  async verifyTradeOnly(): Promise<CexPermissionCheck> {
    // apiRestrictions lives on the SPOT host. A futures-only key may not be able
    // to call it — in that case we cannot positively verify, so we don't claim to.
    try {
      const r = await this.signedGet(SAPI_PROD, "/sapi/v1/account/apiRestrictions");
      const withdrawalDisabled = r.enableWithdrawals === false;
      return {
        withdrawalDisabledVerified: withdrawalDisabled,
        permissionsVerified: true,
        note: withdrawalDisabled
          ? "Verified: withdrawals disabled, futures enabled."
          : "REJECT: key has withdrawal permission enabled.",
      };
    } catch (e: any) {
      return {
        withdrawalDisabledVerified: false,
        permissionsVerified: false,
        note: `Could not read key permissions (${String(e?.message).slice(0, 80)}). Relying on user attestation.`,
      };
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.signedPost("/fapi/v1/leverage", { symbol, leverage });
  }

  async placeOrder(req: CexOrderRequest): Promise<CexOrderResult> {
    const order = validateCexOrderRequest(req);
    if (order.leverage) {
      try { await this.setLeverage(order.symbol, order.leverage); } catch { /* non-fatal */ }
    }
    // Entry order
    const entry = await this.signedPost("/fapi/v1/order", {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      ...(order.type === "LIMIT" ? { price: order.price ?? "", timeInForce: "GTC" } : {}),
      ...(order.reduceOnly ? { reduceOnly: "true" } : {}),
      ...(order.clientOrderId ? { newClientOrderId: order.clientOrderId } : {}),
      newOrderRespType: "RESULT",
    });

    // Reduce-only exits (separate orders — Binance can't attach SL/TP to entry)
    const entryOrderId = String(entry.orderId ?? entry.clientOrderId ?? "");
    const exitSide = order.side === "BUY" ? "SELL" : "BUY";
    let stopLoss: CexProtectionLegOutcome = { status: "not_attempted" };
    let takeProfit: CexProtectionLegOutcome = { status: "not_attempted" };
    let stopResponse: any;
    let takeProfitResponse: any;
    try {
      stopResponse = await this.signedPost("/fapi/v1/order", {
        symbol: order.symbol, side: exitSide, type: "STOP_MARKET",
        stopPrice: order.stopLossPrice!, closePosition: "true",
      });
      const orderId = String(stopResponse.orderId ?? stopResponse.clientOrderId ?? "");
      if (!orderId) throw new Error("BINANCE_PROTECTION_ORDER_ID_MISSING:stop_loss");
      stopLoss = { status: "accepted", orderId };
    } catch (error) {
      stopLoss = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      const compensation = await this.compensateProtectionFailure({ order, exitSide });
      throw new CexProtectionError({
        entryOrderId,
        status: "protection_failed",
        protection: { strategy: "separate-orders", stopLoss, takeProfit },
        compensation,
      });
    }
    try {
      takeProfitResponse = await this.signedPost("/fapi/v1/order", {
        symbol: order.symbol, side: exitSide, type: "TAKE_PROFIT_MARKET",
        stopPrice: order.takeProfitPrice!, closePosition: "true",
      });
      const orderId = String(takeProfitResponse.orderId ?? takeProfitResponse.clientOrderId ?? "");
      if (!orderId) throw new Error("BINANCE_PROTECTION_ORDER_ID_MISSING:take_profit");
      takeProfit = { status: "accepted", orderId };
    } catch (error) {
      takeProfit = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      const compensation = await this.compensateProtectionFailure({
        order,
        exitSide,
        acceptedProtectionOrderId: stopLoss.status === "accepted" ? stopLoss.orderId : undefined,
      });
      throw new CexProtectionError({
        entryOrderId,
        status: "protection_failed",
        protection: { strategy: "separate-orders", stopLoss, takeProfit },
        compensation,
      });
    }

    const status = entry.status === "FILLED" ? "filled" : "accepted";
    return {
      orderId: entryOrderId,
      status,
      protection: {
        status: "protected",
        strategy: "separate-orders",
        stopLossOrderId: stopLoss.status === "accepted" ? stopLoss.orderId : "",
        takeProfitOrderId: takeProfit.status === "accepted" ? takeProfit.orderId : "",
      },
      raw: { entry, stopLoss: stopResponse, takeProfit: takeProfitResponse },
    };
  }

  async getPositions(symbol?: string): Promise<CexPosition[]> {
    const rows = await this.signedGet(this.fapi, "/fapi/v3/positionRisk", symbol ? { symbol } : {});
    const arr = Array.isArray(rows) ? rows : [];
    return arr
      .map((p: any) => ({
        symbol: p.symbol,
        sizeSigned: Number(p.positionAmt ?? 0),
        entryPrice: Number(p.entryPrice ?? 0),
        leverage: Number(p.leverage ?? 0),
        unrealizedPnlUsd: Number(p.unRealizedProfit ?? p.unrealizedProfit ?? 0),
      }))
      .filter((p: CexPosition) => p.sizeSigned !== 0);
  }

  private exactOrder(value: any): CexExactOrder | null {
    if (!value || typeof value !== "object") return null;
    const orderId = String(value.orderId ?? "");
    const clientOrderId = String(value.clientOrderId ?? value.origClientOrderId ?? "");
    if (!orderId && !clientOrderId) return null;
    return {
      orderId: orderId || undefined,
      clientOrderId: clientOrderId || undefined,
      status: typeof value.status === "string" ? value.status.toUpperCase() : undefined,
      raw: value,
    };
  }

  async getOrderById(symbol: string, orderId: string): Promise<CexExactOrder | null> {
    return this.exactOrder(await this.signedGet(this.fapi, "/fapi/v1/order", { symbol, orderId }));
  }

  async getOrderByClientId(symbol: string, clientOrderId: string): Promise<CexExactOrder | null> {
    return this.exactOrder(await this.signedGet(this.fapi, "/fapi/v1/order", {
      symbol,
      origClientOrderId: clientOrderId,
    }));
  }
}

/** Convenience: sign an arbitrary query (used by tests / debugging). */
export const _binanceSign = hmacSha256Hex;
