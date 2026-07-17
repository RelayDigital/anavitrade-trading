import assert from "node:assert/strict";
import test from "node:test";
import { BinanceFuturesClient } from "./binance";
import { CexProtectionError } from "./clientTypes";

const credentials = {
  apiKey: "test-api-key",
  apiSecret: "test-api-secret",
  environment: "testnet" as const,
};

const order = {
  symbol: "BTCUSDT",
  side: "BUY" as const,
  type: "MARKET" as const,
  quantity: "1",
  stopLossPrice: "90",
  takeProfitPrice: "110",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Binance returns identifiers for entry and both protection orders", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    jsonResponse({ orderId: 101, status: "NEW" }),
    jsonResponse({ orderId: 102, status: "NEW" }),
    jsonResponse({ orderId: 103, status: "NEW" }),
  ];
  const client = new BinanceFuturesClient(credentials, async (input, init) => {
    requests.push({ url: String(input), init });
    return responses.shift() ?? jsonResponse({}, 500);
  });

  const result = await client.placeOrder(order);

  assert.equal(result.orderId, "101");
  assert.deepEqual(result.protection, {
    status: "protected",
    strategy: "separate-orders",
    stopLossOrderId: "102",
    takeProfitOrderId: "103",
  });
  assert.equal(requests.length, 3);
  assert.match(requests[0].url, /^https:\/\/testnet\.binancefuture\.com\/fapi\/v1\/order\?/);
  assert.match(requests[1].url, /type=STOP_MARKET/);
  assert.match(requests[1].url, /closePosition=true/);
  assert.match(requests[2].url, /type=TAKE_PROFIT_MARKET/);
  assert.match(requests[2].url, /closePosition=true/);
});

test("Binance protection rejection is a hard failure with compensation state", async () => {
  const requests: string[] = [];
  let calls = 0;
  const client = new BinanceFuturesClient(credentials, async (input) => {
    requests.push(String(input));
    calls += 1;
    if (calls === 1) return jsonResponse({ orderId: 201, status: "NEW" });
    if (calls === 2) return jsonResponse({ code: -2021, msg: "Order would immediately trigger." }, 400);
    return jsonResponse({ orderId: 202, status: "FILLED" });
  });

  await assert.rejects(
    client.placeOrder(order),
    (error: unknown) => {
      assert.ok(error instanceof CexProtectionError);
      assert.equal(error.code, "CEX_PROTECTION_FAILED");
      assert.deepEqual(error.outcome, {
        entryOrderId: "201",
        status: "protection_failed",
        protection: {
          strategy: "separate-orders",
          stopLoss: {
            status: "failed",
            error: "BINANCE_400:{\"code\":-2021,\"msg\":\"Order would immediately trigger.\"}",
          },
          takeProfit: { status: "not_attempted" },
        },
        compensation: {
          state: "completed",
          reason: "entry_accepted_without_complete_protection",
          emergencyClose: { status: "accepted", orderId: "202" },
          protectionCleanup: { status: "not_attempted" },
        },
      });
      return true;
    },
  );
  assert.equal(calls, 3);
  assert.match(requests[2], /type=MARKET/);
  assert.match(requests[2], /reduceOnly=true/);
});

test("Binance flattens the entry and cancels an accepted stop when take profit fails", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const responses = [
    jsonResponse({ orderId: 301, status: "FILLED" }),
    jsonResponse({ orderId: 302, status: "NEW" }),
    jsonResponse({ code: -2021, msg: "TP rejected" }, 400),
    jsonResponse({ orderId: 303, status: "FILLED" }),
    jsonResponse({ orderId: 302, status: "CANCELED" }),
  ];
  const client = new BinanceFuturesClient(credentials, async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return responses.shift()!;
  });

  await assert.rejects(client.placeOrder(order), (error: unknown) => {
    assert.ok(error instanceof CexProtectionError);
    assert.deepEqual(error.outcome.compensation, {
      state: "completed",
      reason: "entry_accepted_without_complete_protection",
      emergencyClose: { status: "accepted", orderId: "303" },
      protectionCleanup: { status: "accepted", orderId: "302" },
    });
    return true;
  });
  assert.equal(requests.length, 5);
  assert.match(requests[3].url, /reduceOnly=true/);
  assert.equal(requests[4].method, "DELETE");
  assert.match(requests[4].url, /orderId=302/);
});

test("Binance exposes failed emergency compensation as a hard incident", async () => {
  let calls = 0;
  const client = new BinanceFuturesClient(credentials, async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ orderId: 401, status: "FILLED" });
    return jsonResponse({ code: -1, msg: calls === 2 ? "stop rejected" : "close rejected" }, 400);
  });

  await assert.rejects(client.placeOrder(order), (error: unknown) => {
    assert.ok(error instanceof CexProtectionError);
    assert.equal(error.outcome.compensation.state, "failed");
    assert.equal(error.outcome.compensation.emergencyClose.status, "failed");
    return true;
  });
});

test("Binance validates an order before making a request", async () => {
  let calls = 0;
  const client = new BinanceFuturesClient(credentials, async () => {
    calls += 1;
    return jsonResponse({});
  });

  await assert.rejects(client.placeOrder({ ...order, quantity: "NaN" }));
  assert.equal(calls, 0);
});

test("Binance exact reconciliation queries by exchange and client order identifiers", async () => {
  const requests: string[] = [];
  const client = new BinanceFuturesClient(credentials, async (input) => {
    requests.push(String(input));
    return jsonResponse({ orderId: 501, clientOrderId: "client-501", status: "FILLED" });
  });

  assert.equal((await client.getOrderById("BTCUSDT", "501"))?.status, "FILLED");
  assert.equal((await client.getOrderByClientId("BTCUSDT", "client-501"))?.orderId, "501");
  assert.match(requests[0], /orderId=501/);
  assert.match(requests[1], /origClientOrderId=client-501/);
});
