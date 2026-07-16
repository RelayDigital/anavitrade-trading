import { and, desc, eq } from "drizzle-orm";
import { asterAgentAccounts, executionJobs, liveAccounts, orderEvents, tradeIntents } from "../../drizzle/schema";
import { getDb, writeAuditLog } from "../db";
import { AsterExecutionAdapter } from "./adapter";
import { AsterApiClient } from "./client";
import { getAsterConfig } from "./config";
import { syncAsterFuturesBalance } from "./store";

type LiveProofInput = {
  confirm: string;
  account: string;
  symbol: string;
  maxNotionalUsd: number;
  limitOffsetBps: number;
  side?: "BUY" | "SELL";
};

const CONFIRM = "PLACE_REAL_ASTER_LIMIT_ORDER_AND_CANCEL";

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function fixed(value: number, decimals: number): string {
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

export async function runAsterLiveProof(input: LiveProofInput) {
  if (input.confirm !== CONFIRM) throw new Error("ASTER_LIVE_PROOF_CONFIRM_REQUIRED");
  const config = getAsterConfig();
  if (!config.liveOrderSubmissionEnabled) throw new Error("ASTER_LIVE_ORDER_SUBMISSION_DISABLED");
  if (!input.account || !input.account.startsWith("0x")) throw new Error("ASTER_LIVE_PROOF_ACCOUNT_REQUIRED");
  if (!input.symbol || input.symbol.length < 3) throw new Error("ASTER_LIVE_PROOF_SYMBOL_REQUIRED");
  if (!Number.isFinite(input.maxNotionalUsd) || input.maxNotionalUsd <= 0 || input.maxNotionalUsd > 5) {
    throw new Error("ASTER_LIVE_PROOF_MAX_NOTIONAL_OUT_OF_RANGE");
  }
  if (!Number.isFinite(input.limitOffsetBps) || input.limitOffsetBps < 1000) {
    throw new Error("ASTER_LIVE_PROOF_OFFSET_TOO_SMALL");
  }

  const db = getDb();
  const [agent] = await db.select().from(asterAgentAccounts)
    .where(and(eq(asterAgentAccounts.status, "active"), eq(asterAgentAccounts.asterAccountAddress, normalizeAddress(input.account))))
    .orderBy(desc(asterAgentAccounts.createdAt))
    .limit(1);
  if (!agent) throw new Error("ASTER_LIVE_PROOF_AGENT_NOT_FOUND");
  if (agent.agentStatus !== "approved" || agent.builderStatus !== "approved") throw new Error("ASTER_APPROVAL_NOT_CONFIRMED");
  if (agent.approvalExpiresAt != null && agent.approvalExpiresAt <= Date.now()) throw new Error("ASTER_AGENT_EXPIRED");

  const [account] = await db.select().from(liveAccounts).where(eq(liveAccounts.userId, agent.userId)).limit(1);
  if (!account || account.status !== "active") throw new Error("ASTER_LIVE_ACCOUNT_NOT_ACTIVE");
  if (account.killSwitchActive) throw new Error("ASTER_ACCOUNT_KILL_SWITCH_ACTIVE");

  const balance = await syncAsterFuturesBalance(agent.userId);
  const ticker = await new AsterApiClient().getTickerPrice(input.symbol);
  const side = input.side ?? "BUY";
  const offset = input.limitOffsetBps / 10_000;
  const limitPrice = side === "BUY" ? ticker * (1 - offset) : ticker * (1 + offset);
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) throw new Error("ASTER_LIVE_PROOF_INVALID_LIMIT_PRICE");
  const quantity = input.maxNotionalUsd / limitPrice;
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("ASTER_LIVE_PROOF_INVALID_QUANTITY");

  const now = Date.now();
  const [intent] = await db.insert(tradeIntents).values({
    source: "aster-live-proof",
    externalSignalId: `proof:${now}`,
    symbol: input.symbol,
    side: side.toLowerCase(),
    orderType: "limit",
    requestedNotionalUsd: input.maxNotionalUsd.toFixed(2),
    targetLeverage: 1,
    limitPrice: fixed(limitPrice, 2),
    status: "created",
    createdBy: "admin:aster-live-proof",
  } as any).returning();
  if (!intent) throw new Error("ASTER_LIVE_PROOF_INTENT_NOT_CREATED");

  const idempotencyKey = `aster-live-proof:${agent.userId}:${intent.id}`.slice(0, 64);
  const [job] = await db.insert(executionJobs).values({
    tradeIntentId: intent.id,
    userId: agent.userId,
    asterAgentAccountId: agent.id,
    provider: "aster",
    symbol: input.symbol,
    side,
    orderType: "LIMIT",
    notionalUsd: input.maxNotionalUsd.toFixed(2),
    quantity: fixed(quantity, 6),
    leverage: 1,
    limitPrice: fixed(limitPrice, 2),
    status: "queued",
    idempotencyKey,
    queuedAt: now,
    updatedAt: now,
  } as any).returning();
  if (!job) throw new Error("ASTER_LIVE_PROOF_JOB_NOT_CREATED");

  await writeAuditLog(agent.userId, "ASTER_LIVE_PROOF_STARTED", `intent:${intent.id}; job:${job.id}; symbol:${input.symbol}; notional:${input.maxNotionalUsd}`);
  const adapter = new AsterExecutionAdapter(agent.id);
  const submitReceipt = await adapter.submitOrder(job.id, {
    symbol: input.symbol,
    side,
    type: "LIMIT",
    quantity: fixed(quantity, 6),
    price: fixed(limitPrice, 2),
    timeInForce: "GTC",
    newClientOrderId: idempotencyKey.slice(0, 32),
    leverage: 1,
  });

  await db.update(executionJobs).set({
    status: submitReceipt.status === "filled" ? "filled" : submitReceipt.status === "rejected" ? "rejected" : "submitted",
    orderId: submitReceipt.orderId,
    submittedAt: Date.now(),
    ...(submitReceipt.status === "filled" ? { filledAt: Date.now() } : {}),
    updatedAt: Date.now(),
  } as any).where(eq(executionJobs.id, job.id));
  await db.insert(orderEvents).values({
    executionJobId: job.id,
    provider: "aster",
    eventType: submitReceipt.status,
    payloadJson: JSON.stringify({ ticker, limitPrice, quantity, balance, raw: submitReceipt.raw ?? {} }),
    occurredAt: Date.now(),
  } as any);

  const syncReceipt = await adapter.queryOrder(input.symbol, submitReceipt.orderId).catch((error) => ({ error: String(error?.message ?? error) }));
  let cancelReceipt: unknown = null;
  if (submitReceipt.status !== "filled" && submitReceipt.status !== "rejected") {
    cancelReceipt = await adapter.cancelOrder(submitReceipt.orderId, input.symbol).catch((error) => ({ error: String(error?.message ?? error) }));
    await db.update(executionJobs).set({ status: "cancelled", cancelledAt: Date.now(), updatedAt: Date.now() } as any)
      .where(eq(executionJobs.id, job.id));
    await db.insert(orderEvents).values({
      executionJobId: job.id,
      provider: "aster",
      eventType: "cancelled",
      payloadJson: JSON.stringify({ raw: cancelReceipt }),
      occurredAt: Date.now(),
    } as any);
  }

  await syncAsterFuturesBalance(agent.userId).catch(() => null);
  await writeAuditLog(agent.userId, "ASTER_LIVE_PROOF_COMPLETED", `intent:${intent.id}; job:${job.id}; order:${submitReceipt.orderId}`);
  return {
    intentId: intent.id,
    jobId: job.id,
    account: agent.asterAccountAddress,
    symbol: input.symbol,
    side,
    ticker,
    limitPrice,
    quantity,
    submitReceipt,
    syncReceipt,
    cancelReceipt,
  };
}
