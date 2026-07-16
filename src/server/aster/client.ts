import { getAsterConfig } from "./config";
import type {
  AsterAgentRegistrationParams,
  AsterBalanceSnapshot,
  AsterStrategyOrderRequest,
  AsterOrderLookupRequest,
  AsterOrderRequest,
  AsterRemoteAgent,
  AsterRemoteBuilder,
  ExecutionAdapterReceipt,
} from "./types";
import type { Account } from "viem/accounts";

/**
 * Aster Futures API V3 signs the URL-encoded request params as a single
 * EIP-712 string message. The provider validates the literal encoded string.
 */
const ASTER_MESSAGE_TYPES = {
  Message: [
    { name: "msg", type: "string" },
  ],
} as const;

let lastNonce = 0;

function nextNonce(): string {
  const candidate = Date.now() * 1000;
  lastNonce = candidate > lastNonce ? candidate : lastNonce + 1;
  return String(lastNonce);
}

function encodeParams(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function asterEip712Domain() {
  return {
    name: "AsterSignTransaction",
    version: "1",
    chainId: getAsterConfig().codeSigningChainId,
    verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  } as const;
}

function unwrapAsterResponse<T>(data: T & { code?: number; msg?: string; data?: unknown }): T {
  if (typeof data.code === "number" && data.code < 0) {
    throw new Error(`ASTER_REQUEST_REJECTED:${data.code}:${data.msg ?? "unknown"}`);
  }
  return (data.data && typeof data.data === "object" ? data.data : data) as T;
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapOrderStatus(raw: unknown): ExecutionAdapterReceipt["status"] {
  const status = String(raw ?? "").toLowerCase();
  if (["filled", "executed"].includes(status)) return "filled";
  if (["canceled", "cancelled"].includes(status)) return "cancelled";
  if (["rejected", "failed", "expired"].includes(status)) return "rejected";
  return "accepted";
}

export class AsterApiClient {
  constructor(private readonly baseUrl = getAsterConfig().apiBaseUrl) {}

  async getServerTime(): Promise<number> {
    const response = await fetch(`${this.baseUrl}/fapi/v3/time`);
    if (!response.ok) throw new Error(`ASTER_TIME_FAILED:${response.status}`);
    const data = (await response.json()) as { serverTime?: number };
    return Number(data.serverTime ?? Date.now());
  }

  async getTickerPrice(symbol: string): Promise<number> {
    const params = new URLSearchParams({ symbol });
    const response = await fetch(`${this.baseUrl}/fapi/v3/ticker/price?${params.toString()}`, {
      method: "GET",
      headers: { "User-Agent": "Anavitrade/1.0" },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "unknown");
      throw new Error(`ASTER_PRICE_REJECTED:${response.status}:${text.slice(0, 200)}`);
    }
    const data = (await response.json()) as { price?: string | number };
    const price = Number(data.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error("ASTER_PRICE_UNAVAILABLE");
    return price;
  }

  private async signedRequest<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string>,
    signer: Account,
  ): Promise<T> {
    const signedParams = {
      ...params,
      nonce: nextNonce(),
      signer: signer.address,
    };
    const unsignedPayload = encodeParams(signedParams);
    const signature = await signer.signTypedData({
      domain: asterEip712Domain(),
      types: ASTER_MESSAGE_TYPES,
      primaryType: "Message",
      message: { msg: unsignedPayload },
    });
    const signedPayload = `${unsignedPayload}&signature=${encodeURIComponent(signature)}`;
    const url = method === "POST" ? `${this.baseUrl}${path}` : `${this.baseUrl}${path}?${signedPayload}`;

    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Anavitrade/1.0",
      },
      ...(method === "POST" ? { body: signedPayload } : {}),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown");
      throw new Error(`ASTER_REQUEST_REJECTED:${response.status}:${text.slice(0, 200)}`);
    }

    const data = await response.json() as T & { code?: number; msg?: string; data?: unknown };
    return unwrapAsterResponse<T>(data);
  }

  private signedPost<T>(path: string, params: Record<string, string>, signer: Account): Promise<T> {
    return this.signedRequest("POST", path, params, signer);
  }

  async setLeverage(
    symbol: string,
    leverage: number,
    user: string,
    signer: Account,
  ): Promise<void> {
    const target = Math.trunc(leverage);
    if (!Number.isFinite(target) || target < 1 || target > 125) {
      throw new Error("ASTER_INVALID_LEVERAGE");
    }
    await this.signedPost("/fapi/v3/leverage", {
      user,
      symbol,
      leverage: String(target),
    }, signer);
  }

  async approveAgent(
    params: AsterAgentRegistrationParams,
    signature: string,
  ): Promise<unknown> {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) queryParams.set(key, String(value));
    }
    queryParams.set("signature", signature);
    if (getAsterConfig().includeCompatParams) {
      queryParams.set("signatureChainId", String(getAsterConfig().codeSigningChainId));
    }

    const response = await fetch(`${this.baseUrl}/fapi/v3/approveAgent?${queryParams.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Anavitrade/1.0",
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown");
      throw new Error(`ASTER_AGENT_REGISTRATION_REJECTED:${response.status}:${text.slice(0, 200)}`);
    }

    const data = await response.json() as { code?: number; msg?: string; [key: string]: unknown };
    if (typeof data.code === "number" && data.code < 0) {
      throw new Error(`ASTER_AGENT_REGISTRATION_REJECTED:${data.code}:${data.msg ?? "unknown"}`);
    }
    return data;
  }

  async getAgents(user: string, signer: Account): Promise<AsterRemoteAgent[]> {
    const data = await this.signedRequest<AsterRemoteAgent[]>("GET", "/fapi/v3/agent", { user }, signer);
    return Array.isArray(data) ? data : [];
  }

  async getBuilders(user: string, signer: Account): Promise<AsterRemoteBuilder[]> {
    const data = await this.signedRequest<AsterRemoteBuilder[]>("GET", "/fapi/v3/builder", { user }, signer);
    return Array.isArray(data) ? data : [];
  }

  async getFuturesBalance(user: string, signer: Account): Promise<AsterBalanceSnapshot> {
    try {
      const data = await this.signedRequest<{
        totalMarginBalance?: string | number;
        availableBalance?: string | number;
        totalUnrealizedProfit?: string | number;
        [key: string]: unknown;
      }>("GET", "/fapi/v3/accountWithJoinMargin", { user }, signer);
      const equity = numberValue(data.totalMarginBalance);
      const available = numberValue(data.availableBalance);
      const unrealized = numberValue(data.totalUnrealizedProfit);
      if (equity > 0 || available > 0) {
        return {
          asset: "USDT",
          equityUsd: equity,
          availableUsd: available,
          unrealizedPnlUsd: unrealized,
          raw: data,
        };
      }
    } catch {
      // Fall back to the lighter balance endpoint below.
    }

    const data = await this.signedRequest<Array<{ asset?: string; balance?: string | number; crossUnPnl?: string | number; availableBalance?: string | number }>>(
      "GET",
      "/fapi/v3/balance",
      { user },
      signer,
    );
    const balances = Array.isArray(data) ? data : [];
    const usdt = balances.find((row) => String(row.asset ?? "").toUpperCase() === "USDT") ?? balances[0];
    if (!usdt) throw new Error("ASTER_BALANCE_UNAVAILABLE");
    const wallet = numberValue(usdt.balance);
    const unrealized = numberValue(usdt.crossUnPnl);
    const available = numberValue(usdt.availableBalance);
    return {
      asset: String(usdt.asset ?? "USDT"),
      equityUsd: wallet + unrealized,
      availableUsd: available,
      unrealizedPnlUsd: unrealized,
      raw: usdt,
    };
  }

  async submitStrategyOrder(
    request: AsterStrategyOrderRequest,
    signer: Account,
  ): Promise<ExecutionAdapterReceipt> {
    const data = await this.signedPost<{
      strategyId?: string | number;
      clientStrategyId?: string;
      strategyStatus?: string;
      failureCode?: number;
      failureReason?: string;
      [key: string]: unknown;
    }>("/fapi/v3/placeStrategyOrder", {
      user: request.user,
      clientStrategyId: request.clientStrategyId,
      strategyType: request.strategyType,
      subOrderList: JSON.stringify(request.subOrderList),
      builder: request.builder,
      feeRate: request.feeRate ?? "0",
    }, signer);

    const failureCode = Number(data.failureCode ?? 0);
    const failureReason = String(data.failureReason ?? "");
    const status = failureCode !== 0 || failureReason
      ? "rejected"
      : mapOrderStatus(data.strategyStatus);
    return {
      provider: "aster",
      orderId: String(data.strategyId ?? data.clientStrategyId ?? request.clientStrategyId),
      status,
      raw: data,
    };
  }

  async queryStrategyOrder(
    user: string,
    strategyId: string,
    signer: Account,
  ): Promise<ExecutionAdapterReceipt> {
    const data = await this.signedRequest<{
      strategyId?: string | number;
      clientStrategyId?: string;
      strategyStatus?: string;
      subOrders?: Array<{ status?: string }>;
      [key: string]: unknown;
    }>("GET", "/fapi/v3/strategyOpenOrder", {
      user,
      strategyId,
      strategyType: "OTOCO",
    }, signer).catch(async () => this.signedRequest<{
      strategyId?: string | number;
      clientStrategyId?: string;
      strategyStatus?: string;
      subOrders?: Array<{ status?: string }>;
      [key: string]: unknown;
    }>("GET", "/fapi/v3/strategyHistoryOrder", {
      user,
      strategyId,
      strategyType: "OTOCO",
    }, signer));

    const subStatuses = Array.isArray(data.subOrders) ? data.subOrders.map((order) => String(order.status ?? "").toLowerCase()) : [];
    const status = subStatuses.some((value) => value === "filled") && ["expired", "finished", "completed"].includes(String(data.strategyStatus ?? "").toLowerCase())
      ? "filled"
      : mapOrderStatus(data.strategyStatus);
    return {
      provider: "aster",
      orderId: String(data.strategyId ?? data.clientStrategyId ?? strategyId),
      status,
      raw: data,
    };
  }

  async submitOrder(
    request: AsterOrderRequest,
    signer: Account,
  ): Promise<ExecutionAdapterReceipt> {
    const params: Record<string, string> = {
      user: request.user,
      symbol: request.symbol,
      type: request.type,
      side: request.side,
      quantity: request.quantity,
      builder: request.builder,
      feeRate: request.feeRate ?? "0",
    };

    if (request.type === "LIMIT") {
      if (!request.price) throw new Error("ASTER_LIMIT_PRICE_REQUIRED");
      params.timeInForce = request.timeInForce ?? "GTC";
      params.price = request.price;
    }

    if (request.type === "STOP_MARKET" || request.type === "TAKE_PROFIT_MARKET") {
      if (!request.stopPrice) throw new Error("ASTER_STOP_PRICE_REQUIRED");
      params.stopPrice = request.stopPrice;
      if (request.closePosition) params.closePosition = "true";
    }

    if (request.workingType) params.workingType = request.workingType;
    if (request.priceProtect) params.priceProtect = "TRUE";
    if (request.reduceOnly) params.reduceOnly = "true";
    if (request.newClientOrderId) params.newClientOrderId = request.newClientOrderId;

    const data = await this.signedPost<{
      orderId?: string | number;
      clientOrderId?: string;
      status?: string;
      [key: string]: unknown;
    }>("/fapi/v3/order", params, signer);

    return {
      provider: "aster",
      orderId: String(data.orderId ?? data.clientOrderId ?? request.newClientOrderId ?? "aster-unknown"),
      status: mapOrderStatus(data.status),
      raw: data,
    };
  }

  async queryOrder(
    request: AsterOrderLookupRequest,
    signer: Account,
  ): Promise<ExecutionAdapterReceipt> {
    if (!request.orderId && !request.origClientOrderId) throw new Error("ASTER_ORDER_LOOKUP_ID_REQUIRED");
    const params: Record<string, string> = { user: request.user, symbol: request.symbol };
    if (request.orderId) params.orderId = request.orderId;
    if (request.origClientOrderId) params.origClientOrderId = request.origClientOrderId;

    const data = await this.signedRequest<{
      orderId?: string | number;
      clientOrderId?: string;
      status?: string;
      [key: string]: unknown;
    }>("GET", "/fapi/v3/order", params, signer);

    return {
      provider: "aster",
      orderId: String(data.orderId ?? data.clientOrderId ?? request.orderId ?? request.origClientOrderId),
      status: mapOrderStatus(data.status),
      raw: data,
    };
  }

  async cancelOrder(
    request: AsterOrderLookupRequest,
    signer: Account,
  ): Promise<ExecutionAdapterReceipt> {
    if (!request.orderId && !request.origClientOrderId) throw new Error("ASTER_ORDER_LOOKUP_ID_REQUIRED");
    const params: Record<string, string> = { user: request.user, symbol: request.symbol };
    if (request.orderId) params.orderId = request.orderId;
    if (request.origClientOrderId) params.origClientOrderId = request.origClientOrderId;

    const data = await this.signedRequest<{
      orderId?: string | number;
      clientOrderId?: string;
      status?: string;
      [key: string]: unknown;
    }>("DELETE", "/fapi/v3/order", params, signer);

    return {
      provider: "aster",
      orderId: String(data.orderId ?? data.clientOrderId ?? request.orderId ?? request.origClientOrderId),
      status: mapOrderStatus(data.status),
      raw: data,
    };
  }
}
