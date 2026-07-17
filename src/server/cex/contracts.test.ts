import assert from "node:assert/strict";
import test from "node:test";
import {
  CexOrderValidationError,
  validateCexOrderRequest,
} from "./clientTypes";
import {
  UnsupportedCexCapabilityError,
  createCexClient,
} from "./factory";
import {
  EXCHANGES,
  getExchangeCapabilities,
  resolveExchangeEndpoint,
} from "./registry";

const credentials = {
  apiKey: "test-api-key",
  apiSecret: "test-api-secret",
};

test("only adapters with proven protection semantics support automated execution", () => {
  const enabled = EXCHANGES
    .filter((exchange) => exchange.capabilities.automatedExecution)
    .map((exchange) => exchange.id);

  assert.deepEqual(enabled, ["binance"]);
  assert.deepEqual(getExchangeCapabilities("binance"), {
    environments: ["production", "testnet"],
    orderTypes: ["MARKET", "LIMIT"],
    nativeBracket: false,
    separateProtectionOrders: true,
    positionMode: "one-way",
    automatedExecution: true,
  });

  for (const exchange of EXCHANGES.filter((item) => item.id !== "binance")) {
    assert.equal(exchange.capabilities.automatedExecution, false, exchange.id);
    assert.equal(exchange.capabilities.nativeBracket, false, exchange.id);
    assert.equal(exchange.capabilities.separateProtectionOrders, false, exchange.id);
    assert.equal(exchange.capabilities.positionMode, "unverified", exchange.id);
  }
});

test("endpoint resolution fails closed for unknown and unsupported environments", () => {
  assert.equal(
    resolveExchangeEndpoint("binance", "testnet"),
    "https://testnet.binancefuture.com",
  );

  assert.throws(
    () => resolveExchangeEndpoint("bybit", "testnet"),
    (error: unknown) => error instanceof UnsupportedCexCapabilityError
      && error.code === "CEX_ENVIRONMENT_UNSUPPORTED",
  );
  assert.throws(
    () => resolveExchangeEndpoint("binance", "staging" as never),
    (error: unknown) => error instanceof UnsupportedCexCapabilityError
      && error.code === "CEX_ENVIRONMENT_UNKNOWN",
  );
});

test("unsupported automated adapters reject before transport can run", async () => {
  let calls = 0;
  const client = createCexClient("bybit", credentials, {
    transport: async () => {
      calls += 1;
      throw new Error("network must not run");
    },
  });

  await assert.rejects(
    client.placeOrder({
      symbol: "BTCUSDT",
      side: "BUY",
      type: "MARKET",
      quantity: "1",
      stopLossPrice: "90",
      takeProfitPrice: "110",
    }),
    (error: unknown) => error instanceof UnsupportedCexCapabilityError
      && error.code === "CEX_AUTOMATED_EXECUTION_UNSUPPORTED",
  );
  assert.equal(calls, 0);
});

test("testnet requests cannot fall back to an adapter's production endpoint", () => {
  let calls = 0;

  assert.throws(
    () => createCexClient("bybit", { ...credentials, environment: "testnet" }, {
      transport: async () => {
        calls += 1;
        throw new Error("network must not run");
      },
    }),
    (error: unknown) => error instanceof UnsupportedCexCapabilityError
      && error.code === "CEX_ENVIRONMENT_UNSUPPORTED",
  );
  assert.equal(calls, 0);
});

test("the automated client wrapper preserves exact Binance reconciliation methods", async () => {
  const requests: string[] = [];
  const client = createCexClient("binance", credentials, {
    transport: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ orderId: 77, clientOrderId: "client-77", status: "FILLED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal((await client.getOrderById?.("BTCUSDT", "77"))?.orderId, "77");
  assert.equal((await client.getOrderByClientId?.("BTCUSDT", "client-77"))?.status, "FILLED");
  assert.match(requests[0], /orderId=77/);
  assert.match(requests[1], /origClientOrderId=client-77/);
});

test("order validation accepts a fully protected long market order", () => {
  assert.deepEqual(validateCexOrderRequest({
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quantity: "1.25",
    stopLossPrice: "90",
    takeProfitPrice: "110",
  }), {
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quantity: "1.25",
    stopLossPrice: "90",
    takeProfitPrice: "110",
  });
});

test("order validation rejects malformed or unprotected orders", () => {
  const base = {
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quantity: "1",
    stopLossPrice: "90",
    takeProfitPrice: "110",
  };
  const invalid: Array<[string, unknown, string]> = [
    ["non-finite quantity", { ...base, quantity: "Infinity" }, "CEX_ORDER_QUANTITY_INVALID"],
    ["invalid side", { ...base, side: "LONG" }, "CEX_ORDER_SIDE_INVALID"],
    ["invalid type", { ...base, type: "STOP" }, "CEX_ORDER_TYPE_INVALID"],
    ["missing limit price", { ...base, type: "LIMIT" }, "CEX_ORDER_LIMIT_PRICE_REQUIRED"],
    ["missing stop loss", { ...base, stopLossPrice: undefined }, "CEX_ORDER_STOP_LOSS_REQUIRED"],
    ["missing take profit", { ...base, takeProfitPrice: undefined }, "CEX_ORDER_TAKE_PROFIT_REQUIRED"],
    ["long ordering", { ...base, stopLossPrice: "120" }, "CEX_ORDER_PROTECTION_ORDER_INVALID"],
    ["short ordering", { ...base, side: "SELL", stopLossPrice: "90", takeProfitPrice: "110" }, "CEX_ORDER_PROTECTION_ORDER_INVALID"],
    ["limit long entry ordering", { ...base, type: "LIMIT", price: "80" }, "CEX_ORDER_PROTECTION_ORDER_INVALID"],
  ];

  for (const [name, request, code] of invalid) {
    assert.throws(
      () => validateCexOrderRequest(request),
      (error: unknown) => error instanceof CexOrderValidationError
        && error.code === code,
      name,
    );
  }
});
