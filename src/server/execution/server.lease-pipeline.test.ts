import assert from "node:assert/strict";
import test from "node:test";
import type { CexClient } from "../cex/clientTypes";
import { CexProtectionError } from "../cex/clientTypes";
import * as executionServer from "./server";

const job = (overrides: Record<string, unknown> = {}) => ({
  jobId: 41,
  tradeIntentId: 9,
  userId: 7,
  cexConnectionId: 3,
  symbol: "BTCUSDT",
  side: "BUY",
  orderType: "MARKET",
  notionalUsd: "100",
  quantity: "0.01",
  leverage: 2,
  limitPrice: null,
  idempotencyKey: "intent-9",
  connId: 3,
  connExchange: "binance",
  connEncryptedApiKey: "encrypted-key",
  connEncryptedApiSecret: "encrypted-secret",
  connEncryptedPassphrase: null,
  connKillSwitchActive: false,
  connLabel: "test",
  intentStopLossPrice: "59000",
  intentTakeProfitPrice: "62000",
  intentTargetLeverage: 2,
  leaseToken: "submit-token",
  leaseAttempt: 1,
  leaseExpiresAt: 2_000,
  leaseAction: "submit",
  ...overrides,
});

function dependencies(
  responses: Record<string, unknown[]>,
  reports: unknown[],
  client: CexClient,
) {
  return {
    mode: "testnet",
    now: () => 1_000,
    get: async <T>(path: string) => {
      const response = responses[path]?.shift() ?? (path.includes("kill-state")
        ? { globalKill: false, perConnectionKills: {} }
        : { jobs: [] });
      return response as T;
    },
    post: async (_path: string, body: unknown) => { reports.push(body); return { status: "ok" }; },
    prepareJob: async () => ({
      status: "ready" as const,
      mode: "testnet" as const,
      environment: "testnet" as const,
      apiKey: "plain-key",
      apiSecret: "plain-secret",
      passphrase: undefined,
      client,
    }),
    state: new Map(),
  };
}

test("disabled mode performs health polling without claiming jobs", async () => {
  const paths: string[] = [];
  const get = async <T>(path: string) => {
    paths.push(path);
    return (path.includes("kill-state")
      ? { globalKill: false, perConnectionKills: {} }
      : { jobs: [] }) as T;
  };

  await (executionServer as any).runExecutionPoll({
    mode: "disabled",
    get,
    post: async () => { throw new Error("disabled mode must not report"); },
    state: new Map(),
  });

  assert.deepEqual(paths, ["/api/internal/kill-state"]);
});

test("a protected submission retains lease ownership and every exchange order id", async () => {
  const client: CexClient = {
    validateAndReadBalance: async () => ({ equityUsd: 1000, availableUsd: 1000 }),
    verifyTradeOnly: async () => ({ withdrawalDisabledVerified: true, permissionsVerified: true, note: "test" }),
    setLeverage: async () => {},
    placeOrder: async () => ({
      orderId: "order-1",
      status: "filled",
      protection: {
        status: "protected",
        strategy: "separate-orders",
        stopLossOrderId: "stop-1",
        takeProfitOrderId: "take-1",
      },
    }),
    getPositions: async () => { throw new Error("positions must not be used for reconciliation"); },
  };
  const reports: any[] = [];
  const responses = {
    "/api/internal/risk-approved-jobs?action=submit": [
      { jobs: [job()] },
      { jobs: [] },
    ],
    "/api/internal/risk-approved-jobs?action=reconcile": [
      { jobs: [] },
    ],
  };
  const deps = dependencies(responses, reports, client);

  await (executionServer as any).runExecutionPoll(deps);
  assert.deepEqual(reports[0], {
    reportId: reports[0].reportId,
    jobId: 41,
    leaseToken: "submit-token",
    leaseAttempt: 1,
    status: "protected",
    orderId: "order-1",
    stopLossOrderId: "stop-1",
    takeProfitOrderId: "take-1",
  });
  assert.equal(typeof reports[0].reportId, "string");
  assert.equal(reports.length, 1);
});

test("reconciliation uses an exact exchange order id and never symbol positions", async () => {
  let exactReads = 0;
  const client: CexClient = {
    validateAndReadBalance: async () => ({ equityUsd: 1000, availableUsd: 1000 }),
    verifyTradeOnly: async () => ({ withdrawalDisabledVerified: true, permissionsVerified: true, note: "test" }),
    setLeverage: async () => {},
    placeOrder: async () => { throw new Error("submit must not run"); },
    getPositions: async () => { throw new Error("positions must not be used"); },
    getOrderById: async (_symbol, orderId) => {
      exactReads++;
      return { orderId, clientOrderId: "intent-9", status: "FILLED" };
    },
  };
  const reports: any[] = [];
  const responses = {
    "/api/internal/risk-approved-jobs?action=submit": [{ jobs: [] }],
    "/api/internal/risk-approved-jobs?action=reconcile": [{ jobs: [job({
      leaseToken: "reconcile-token",
      leaseAttempt: 2,
      leaseAction: "reconcile",
      orderId: "order-1",
    })] }],
  };

  await (executionServer as any).runExecutionPoll(dependencies(responses, reports, client));
  assert.equal(exactReads, 1);
  assert.deepEqual(reports[0], {
    reportId: reports[0].reportId,
    jobId: 41,
    leaseToken: "reconcile-token",
    leaseAttempt: 2,
    status: "filled",
    orderId: "order-1",
  });
});

test("an uncompensated protection failure is durably reported as a hard incident", async () => {
  const client: CexClient = {
    validateAndReadBalance: async () => ({ equityUsd: 1000, availableUsd: 1000 }),
    verifyTradeOnly: async () => ({ withdrawalDisabledVerified: true, permissionsVerified: true, note: "test" }),
    setLeverage: async () => {},
    placeOrder: async () => {
      throw new CexProtectionError({
        entryOrderId: "entry-unsafe",
        status: "protection_failed",
        protection: {
          strategy: "separate-orders",
          stopLoss: { status: "accepted", orderId: "stop-unsafe" },
          takeProfit: { status: "failed", error: "rejected" },
        },
        compensation: {
          state: "failed",
          reason: "entry_accepted_without_complete_protection",
          emergencyClose: { status: "failed", error: "close rejected" },
          protectionCleanup: { status: "accepted", orderId: "stop-unsafe" },
        },
      });
    },
    getPositions: async () => [],
  };
  const reports: any[] = [];
  const responses = {
    "/api/internal/risk-approved-jobs?action=submit": [{ jobs: [job()] }],
    "/api/internal/risk-approved-jobs?action=reconcile": [{ jobs: [] }],
  };

  await (executionServer as any).runExecutionPoll(dependencies(responses, reports, client));
  assert.deepEqual(reports[0], {
    reportId: reports[0].reportId,
    jobId: 41,
    leaseToken: "submit-token",
    leaseAttempt: 1,
    status: "failed",
    orderId: "entry-unsafe",
    errorCode: "protection_failed_uncompensated",
    stopLossOrderId: "stop-unsafe",
    compensationState: "failed",
  });
});
