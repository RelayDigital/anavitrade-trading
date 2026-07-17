/** Provider-neutral shapes shared by every CEX client. */

export type ExchangeEnvironment = "production" | "testnet";

export type CexTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type CexCredentials = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  /** Explicit environment for new call sites. */
  environment?: ExchangeEnvironment;
  /** @deprecated Use environment. Retained for existing execution consumers. */
  testnet?: boolean;
};

export type CexBalance = {
  /** Total account equity in USD/USDT. */
  equityUsd: number;
  availableUsd: number;
};

export type CexPermissionCheck = {
  /** True only if we positively confirmed withdrawals are disabled. */
  withdrawalDisabledVerified: boolean;
  /** True if the exchange exposes a permission API and we could read it. */
  permissionsVerified: boolean;
  /** Human-readable note for the audit log / UI. */
  note: string;
};

/** Neutral order request the execution adapter builds from a TradeIntent. */
export type CexOrderRequest = {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  quantity: string;
  price?: string;
  leverage?: number;
  stopLossPrice?: string;
  takeProfitPrice?: string;
  reduceOnly?: boolean;
  clientOrderId?: string;
};

export type CexOrderValidationCode =
  | "CEX_ORDER_INVALID"
  | "CEX_ORDER_SYMBOL_INVALID"
  | "CEX_ORDER_SIDE_INVALID"
  | "CEX_ORDER_TYPE_INVALID"
  | "CEX_ORDER_QUANTITY_INVALID"
  | "CEX_ORDER_LIMIT_PRICE_REQUIRED"
  | "CEX_ORDER_LIMIT_PRICE_INVALID"
  | "CEX_ORDER_STOP_LOSS_REQUIRED"
  | "CEX_ORDER_STOP_LOSS_INVALID"
  | "CEX_ORDER_TAKE_PROFIT_REQUIRED"
  | "CEX_ORDER_TAKE_PROFIT_INVALID"
  | "CEX_ORDER_PROTECTION_ORDER_INVALID";

export class CexOrderValidationError extends Error {
  readonly name = "CexOrderValidationError";

  constructor(readonly code: CexOrderValidationCode, message: string) {
    super(message);
  }
}

function positiveFinitePrice(
  value: unknown,
  missingCode: CexOrderValidationCode,
  invalidCode: CexOrderValidationCode,
  label: string,
): number {
  if (value === undefined || value === null || value === "") {
    throw new CexOrderValidationError(missingCode, `${label} is required`);
  }
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CexOrderValidationError(invalidCode, `${label} must be a positive finite number`);
  }
  return parsed;
}

/** Runtime validation at the final boundary before an automated order transport. */
export function validateCexOrderRequest(input: unknown): CexOrderRequest {
  if (!input || typeof input !== "object") {
    throw new CexOrderValidationError("CEX_ORDER_INVALID", "order must be an object");
  }
  const request = input as Record<string, unknown>;
  if (typeof request.symbol !== "string" || request.symbol.trim() === "") {
    throw new CexOrderValidationError("CEX_ORDER_SYMBOL_INVALID", "symbol is required");
  }
  if (request.side !== "BUY" && request.side !== "SELL") {
    throw new CexOrderValidationError("CEX_ORDER_SIDE_INVALID", "side must be BUY or SELL");
  }
  if (request.type !== "MARKET" && request.type !== "LIMIT") {
    throw new CexOrderValidationError("CEX_ORDER_TYPE_INVALID", "type must be MARKET or LIMIT");
  }

  const quantity = typeof request.quantity === "string" ? Number(request.quantity) : Number.NaN;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new CexOrderValidationError(
      "CEX_ORDER_QUANTITY_INVALID",
      "quantity must be a positive finite number",
    );
  }

  let entryPrice: number | undefined;
  if (request.type === "LIMIT") {
    entryPrice = positiveFinitePrice(
      request.price,
      "CEX_ORDER_LIMIT_PRICE_REQUIRED",
      "CEX_ORDER_LIMIT_PRICE_INVALID",
      "LIMIT price",
    );
  }
  const stopLoss = positiveFinitePrice(
    request.stopLossPrice,
    "CEX_ORDER_STOP_LOSS_REQUIRED",
    "CEX_ORDER_STOP_LOSS_INVALID",
    "stop-loss price",
  );
  const takeProfit = positiveFinitePrice(
    request.takeProfitPrice,
    "CEX_ORDER_TAKE_PROFIT_REQUIRED",
    "CEX_ORDER_TAKE_PROFIT_INVALID",
    "take-profit price",
  );

  const validLong = request.side === "BUY"
    && stopLoss < takeProfit
    && (entryPrice === undefined || (stopLoss < entryPrice && entryPrice < takeProfit));
  const validShort = request.side === "SELL"
    && takeProfit < stopLoss
    && (entryPrice === undefined || (takeProfit < entryPrice && entryPrice < stopLoss));
  if (!validLong && !validShort) {
    throw new CexOrderValidationError(
      "CEX_ORDER_PROTECTION_ORDER_INVALID",
      request.side === "BUY"
        ? "long orders require stopLoss < entry < takeProfit"
        : "short orders require takeProfit < entry < stopLoss",
    );
  }

  return input as CexOrderRequest;
}

export type CexProtectionResult = {
  status: "protected";
  strategy: "native-bracket" | "separate-orders";
  stopLossOrderId: string;
  takeProfitOrderId: string;
};

export type CexOrderResult = {
  orderId: string;
  status: "accepted" | "filled" | "rejected";
  protection?: CexProtectionResult;
  raw?: unknown;
};

export type CexProtectionLegOutcome =
  | { status: "accepted"; orderId: string }
  | { status: "failed"; error: string }
  | { status: "not_attempted" };

export type CexProtectionFailureOutcome = {
  entryOrderId: string;
  status: "protection_failed";
  protection: {
    strategy: "separate-orders";
    stopLoss: CexProtectionLegOutcome;
    takeProfit: CexProtectionLegOutcome;
  };
  compensation: {
    state: "completed" | "failed";
    reason: "entry_accepted_without_complete_protection";
    emergencyClose: CexProtectionLegOutcome;
    protectionCleanup: CexProtectionLegOutcome;
  };
};

export class CexProtectionError extends Error {
  readonly name = "CexProtectionError";
  readonly code = "CEX_PROTECTION_FAILED" as const;

  constructor(readonly outcome: CexProtectionFailureOutcome) {
    super(`CEX_PROTECTION_FAILED:${outcome.entryOrderId}`);
  }
}

export type CexPosition = {
  symbol: string;
  sizeSigned: number; // + long, - short
  entryPrice: number;
  leverage: number;
  unrealizedPnlUsd: number;
};

export type CexExactOrder = {
  orderId?: string;
  clientOrderId?: string;
  status?: string;
  raw?: unknown;
};

export interface CexClient {
  validateAndReadBalance(): Promise<CexBalance>;
  verifyTradeOnly(): Promise<CexPermissionCheck>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  placeOrder(req: CexOrderRequest): Promise<CexOrderResult>;
  getPositions(symbol?: string): Promise<CexPosition[]>;
  getOrderById?(symbol: string, orderId: string): Promise<CexExactOrder | null>;
  getOrderByClientId?(symbol: string, clientOrderId: string): Promise<CexExactOrder | null>;
}
