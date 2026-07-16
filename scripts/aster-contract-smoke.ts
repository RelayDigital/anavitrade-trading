import assert from "node:assert/strict";
import { setEnv } from "../src/server/_core/env";
import { AsterApiClient } from "../src/server/aster/client";
import type { AsterAgentRegistrationParams, AsterOrderRequest } from "../src/server/aster/types";

function configure(overrides: Partial<Parameters<typeof setEnv>[0]> = {}) {
  setEnv({
    DB: {} as any,
    JWT_SECRET: "test-jwt-secret",
    ENCRYPTION_KEY: "test-encryption-key",
    VITE_APP_ID: "test-app",
    ASTER_API_BASE_URL: "https://aster.test",
    ASTER_BUILDER_ADDRESS: "0x2222222222222222222222222222222222222222",
    ASTER_DEFAULT_FEE_RATE: "0.00001",
    ASTER_ENVIRONMENT: "production",
    ...overrides,
  });
}

function okResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const approvalParams: AsterAgentRegistrationParams = {
  agentName: "Anavitrade",
  agentAddress: "0x1111111111111111111111111111111111111111",
  ipWhitelist: "",
  expired: 1790000000000,
  canSpotTrade: false,
  canPerpTrade: true,
  canWithdraw: false,
  builder: "0x2222222222222222222222222222222222222222",
  maxFeeRate: "0.00001",
  builderName: "Anavitrade",
  user: "0x3333333333333333333333333333333333333333",
  nonce: 1790000000000000,
};

async function assertApproveAgentContract() {
  configure();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return okResponse({ code: 200, msg: "success" });
  };

  await new AsterApiClient().approveAgent(approvalParams, "0xapprovalsignature");

  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.origin, "https://aster.test");
  assert.equal(requestUrl.pathname, "/fapi/v3/approveAgent");
  assert.equal(calls[0].init?.method, "POST");

  const params = requestUrl.searchParams;
  assert.equal(params.get("agentName"), "Anavitrade");
  assert.equal(params.get("agentAddress"), approvalParams.agentAddress);
  assert.equal(params.get("canSpotTrade"), "false");
  assert.equal(params.get("canPerpTrade"), "true");
  assert.equal(params.get("canWithdraw"), "false");
  assert.equal(params.get("builder"), approvalParams.builder);
  assert.equal(params.get("maxFeeRate"), "0.00001");
  assert.equal(params.get("user"), approvalParams.user);
  assert.equal(params.get("nonce"), String(approvalParams.nonce));
  assert.equal(params.get("signature"), "0xapprovalsignature");
  assert.equal(params.has("signatureChainId"), false);
  assert.equal(params.has("asterChain"), false);
}

async function assertCompatApprovalParams() {
  configure({
    ASTER_ENVIRONMENT: "testnet",
    ASTER_CODE_SIGNING_CHAIN_ID: "714",
    ASTER_INCLUDE_COMPAT_PARAMS: "true",
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return okResponse({ code: 200, msg: "success" });
  };

  await new AsterApiClient().approveAgent({ ...approvalParams, asterChain: "Testnet" }, "0xapprovalsignature");

  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get("asterChain"), "Testnet");
  assert.equal(params.get("signatureChainId"), "714");
}

async function assertOrderContract() {
  configure();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let signedTypedData: any = null;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return okResponse({ code: 200, msg: "success", orderId: "order-1", status: "NEW" });
  };

  const signer = {
    address: "0x1111111111111111111111111111111111111111",
    signTypedData: async (typedData: unknown) => {
      signedTypedData = typedData;
      return "0xordersignature";
    },
  } as any;

  const order: AsterOrderRequest = {
    user: "0x3333333333333333333333333333333333333333",
    signer: signer.address,
    symbol: "BTCUSDT",
    side: "BUY",
    type: "LIMIT",
    quantity: "0.001",
    price: "65000",
    timeInForce: "GTC",
    newClientOrderId: "idem-1",
    builder: "0x2222222222222222222222222222222222222222",
    feeRate: "0.00001",
  };

  const receipt = await new AsterApiClient().submitOrder(order, signer);
  assert.equal(receipt.provider, "aster");
  assert.equal(receipt.orderId, "order-1");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://aster.test/fapi/v3/order");
  assert.equal(calls[0].init?.method, "POST");

  assert.equal(signedTypedData.domain.name, "AsterSignTransaction");
  assert.equal(signedTypedData.domain.version, "1");
  assert.equal(signedTypedData.domain.chainId, 1666);
  assert.deepEqual(signedTypedData.types, { Message: [{ name: "msg", type: "string" }] });
  assert.equal(signedTypedData.primaryType, "Message");

  const signedQuery = signedTypedData.message.msg as string;
  for (const expected of [
    "user=0x3333333333333333333333333333333333333333",
    "symbol=BTCUSDT",
    "type=LIMIT",
    "side=BUY",
    "quantity=0.001",
    "builder=0x2222222222222222222222222222222222222222",
    "feeRate=0.00001",
    "timeInForce=GTC",
    "price=65000",
    "newClientOrderId=idem-1",
    "signer=0x1111111111111111111111111111111111111111",
  ]) {
    assert.ok(signedQuery.includes(expected), "signed query missing " + expected + ": " + signedQuery);
  }

  assert.equal(calls[0].init?.body, signedQuery + "&signature=0xordersignature");
}

async function assertReadbackAndLifecycleContracts() {
  configure();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const signedMessages: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const path = new URL(String(url)).pathname;
    if (path === "/fapi/v3/ticker/price") return okResponse({ symbol: "BTCUSDT", price: "65000.5" });
    if (path === "/fapi/v3/agent") {
      return okResponse({ code: 200, data: [{ agentAddress: approvalParams.agentAddress, canPerpTrade: true, canWithdraw: false, expired: approvalParams.expired }] });
    }
    if (path === "/fapi/v3/builder") {
      return okResponse({ code: 200, data: [{ builderAddress: approvalParams.builder, maxFeeRate: approvalParams.maxFeeRate }] });
    }
    if (path === "/fapi/v3/order" && init?.method === "GET") {
      return okResponse({ code: 200, data: { orderId: "order-1", status: "FILLED" } });
    }
    if (path === "/fapi/v3/order" && init?.method === "DELETE") {
      return okResponse({ code: 200, data: { orderId: "order-1", status: "CANCELED" } });
    }
    throw new Error("unexpected request " + String(url));
  };

  const signer = {
    address: approvalParams.agentAddress,
    signTypedData: async (typedData: any) => {
      signedMessages.push(typedData.message.msg);
      return "0xlifecyclesignature";
    },
  } as any;

  const client = new AsterApiClient();
  assert.equal(await client.getTickerPrice("BTCUSDT"), 65000.5);
  const agents = await client.getAgents(approvalParams.user, signer);
  const builders = await client.getBuilders(approvalParams.user, signer);
  const queried = await client.queryOrder({ user: approvalParams.user, symbol: "BTCUSDT", orderId: "order-1" }, signer);
  const cancelled = await client.cancelOrder({ user: approvalParams.user, symbol: "BTCUSDT", orderId: "order-1" }, signer);

  assert.equal(agents[0].agentAddress, approvalParams.agentAddress);
  assert.equal(builders[0].builderAddress, approvalParams.builder);
  assert.equal(queried.status, "filled");
  assert.equal(cancelled.status, "cancelled");

  const tickerCall = calls.find((call) => new URL(call.url).pathname === "/fapi/v3/ticker/price");
  assert.equal(new URL(tickerCall!.url).searchParams.get("symbol"), "BTCUSDT");

  const agentCall = calls.find((call) => new URL(call.url).pathname === "/fapi/v3/agent");
  assert.equal(agentCall!.init?.method, "GET");
  const agentParams = new URL(agentCall!.url).searchParams;
  assert.equal(agentParams.get("user"), approvalParams.user);
  assert.equal(agentParams.get("signer"), approvalParams.agentAddress);
  assert.equal(agentParams.get("signature"), "0xlifecyclesignature");

  const cancelCall = calls.find((call) => new URL(call.url).pathname === "/fapi/v3/order" && call.init?.method === "DELETE");
  assert.equal(new URL(cancelCall!.url).searchParams.get("orderId"), "order-1");

  assert.ok(signedMessages.some((msg) => msg.includes("user=" + approvalParams.user) && msg.includes("signer=" + approvalParams.agentAddress)));
}

async function assertBalanceAndStrategyContracts() {
  configure();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const signedMessages: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const path = new URL(String(url)).pathname;
    if (path === "/fapi/v3/accountWithJoinMargin") {
      return okResponse({ code: 200, data: { totalMarginBalance: "123.456", availableBalance: "100.20", totalUnrealizedProfit: "-1.50" } });
    }
    if (path === "/fapi/v3/placeStrategyOrder") {
      return okResponse({ code: 200, data: { strategyId: "strategy-1", strategyStatus: "NEW", failureCode: 0, failureReason: "" } });
    }
    throw new Error("unexpected request " + String(url));
  };

  const signer = {
    address: approvalParams.agentAddress,
    signTypedData: async (typedData: any) => {
      signedMessages.push(typedData.message.msg);
      return "0xstrategysignature";
    },
  } as any;

  const client = new AsterApiClient();
  const balance = await client.getFuturesBalance(approvalParams.user, signer);
  assert.equal(balance.equityUsd, 123.456);
  assert.equal(balance.availableUsd, 100.2);
  assert.equal(balance.unrealizedPnlUsd, -1.5);

  const strategy = await client.submitStrategyOrder({
    user: approvalParams.user,
    signer: signer.address,
    clientStrategyId: "idem-otoco",
    strategyType: "OTOCO",
    builder: approvalParams.builder,
    feeRate: approvalParams.maxFeeRate,
    subOrderList: [
      { strategySubId: "1", securityType: "USDT_FUTURES", symbol: "BTCUSDT", side: "BUY", positionSide: "BOTH", type: "LIMIT", quantity: "0.001", price: "65000", timeInForce: "GTC", clientOrderId: "idem-entry" },
      { strategySubId: "2", securityType: "USDT_FUTURES", symbol: "BTCUSDT", side: "SELL", positionSide: "BOTH", type: "STOP_MARKET", quantity: "0.001", stopPrice: "64000", reduceOnly: "true", workingType: "CONTRACT_PRICE", clientOrderId: "idem-sl", firstDrivenId: "1", firstDrivenOn: "FILLED", firstTrigger: "PLACE_ORDER", secondDrivenId: "3", secondDrivenOn: "FILLED", secondTrigger: "CANCEL_ORDER" },
      { strategySubId: "3", securityType: "USDT_FUTURES", symbol: "BTCUSDT", side: "SELL", positionSide: "BOTH", type: "TAKE_PROFIT_MARKET", quantity: "0.001", stopPrice: "68000", reduceOnly: "true", workingType: "CONTRACT_PRICE", clientOrderId: "idem-tp", firstDrivenId: "1", firstDrivenOn: "FILLED", firstTrigger: "PLACE_ORDER", secondDrivenId: "2", secondDrivenOn: "FILLED", secondTrigger: "CANCEL_ORDER" },
    ],
  }, signer);

  assert.equal(strategy.orderId, "strategy-1");
  assert.equal(strategy.status, "accepted");

  const balanceCall = calls.find((call) => new URL(call.url).pathname === "/fapi/v3/accountWithJoinMargin");
  const balanceParams = new URL(balanceCall!.url).searchParams;
  assert.equal(balanceCall!.init?.method, "GET");
  assert.equal(balanceParams.get("user"), approvalParams.user);
  assert.equal(balanceParams.get("signer"), signer.address);
  assert.equal(balanceParams.get("signature"), "0xstrategysignature");

  const strategyCall = calls.find((call) => new URL(call.url).pathname === "/fapi/v3/placeStrategyOrder");
  assert.equal(strategyCall!.init?.method, "POST");
  const strategyBody = String(strategyCall!.init?.body ?? "");
  const strategyParams = new URLSearchParams(strategyBody);
  assert.equal(strategyParams.get("user"), approvalParams.user);
  assert.equal(strategyParams.get("clientStrategyId"), "idem-otoco");
  assert.equal(strategyParams.get("strategyType"), "OTOCO");
  assert.equal(strategyParams.get("builder"), approvalParams.builder);
  const subOrders = JSON.parse(strategyParams.get("subOrderList") ?? "[]");
  assert.equal(subOrders.length, 3);
  assert.equal(subOrders[1].type, "STOP_MARKET");
  assert.equal(subOrders[2].type, "TAKE_PROFIT_MARKET");
  assert.ok(signedMessages.some((msg) => msg.includes("accountWithJoinMargin") === false && msg.includes("clientStrategyId=idem-otoco")));
}

await assertApproveAgentContract();
await assertCompatApprovalParams();
await assertOrderContract();
await assertReadbackAndLifecycleContracts();
await assertBalanceAndStrategyContracts();
console.log("ASTER_CONTRACT_SMOKE_PASS");
