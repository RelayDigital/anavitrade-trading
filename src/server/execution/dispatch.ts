import { and, eq } from "drizzle-orm";
import {
  cexConnections, asterAgentAccounts, executionJobs, orderEvents,
  tradeIntents, liveAccounts,
} from "../../drizzle/schema";
import { getDb, writeAuditLog } from "../db";
import { sha256Hex } from "../cex/signing";
import { decryptCexCredentials } from "../cex/store";
import { createCexClient } from "../cex/factory";
/* CexExecutionAdapter no longer imported — Worker no longer submits CEX orders.
 * The VPS execution server polls risk-approved jobs and submits orders from its
 * static-IP machine. */
import { AsterExecutionAdapter } from "../aster/adapter";
import { AsterApiClient } from "../aster/client";
import { getAsterConfig } from "../aster/config";
import { syncAsterFuturesBalance } from "../aster/store";
import { decideExecution, prefetchUserData, sizeNotionalFromEquity, type TradeIntentInput } from "./riskEngine";

/** Deterministic idempotency key per (user, intent). Prevents duplicate mirrors. */
async function idempotencyKey(userId: number, intentId: number, prefix = "cex"): Promise<string> {
  return (await sha256Hex(`${prefix}:${userId}:${intentId}`)).slice(0, 32);
}

/**
 * Serialize execution per connection so a signer never has two in-flight orders.
 *
 * NOTE: This is an in-memory mutex — it does NOT survive Worker restarts or
 * span multiple Worker instances. For full distributed-safety the VPS execution
 * server should use a Redis or D1-backed advisory lock.  The idempotencyKey
 * + ON CONFLICT DO NOTHING on executionJobs insertion provides DB-level
 * deduplication for the create path; the pre-submit status check below guards
 * against double-submission after a restart.
 * TODO: Replace with Redis-backed distributed mutex once the VPS execution
 * server is wired for real order submission.
 */
const connectionQueues = new Map<number, Promise<unknown>>();
function enqueue<T>(connectionId: number, task: () => Promise<T>): Promise<T> {
  const prev = connectionQueues.get(connectionId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(task);
  connectionQueues.set(connectionId, next);
  return next;
}

function decimalValue(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function skipJob(
  jobId: number,
  provider: string,
  reason: string,
  payload: Record<string, unknown> = {},
) {
  const db = getDb();
  const skippedAt = Date.now();
  await db.update(executionJobs).set({
    status: "skipped",
    errorMessage: reason,
    updatedAt: skippedAt,
  } as any).where(eq(executionJobs.id, jobId));
  await db.insert(orderEvents).values({
    executionJobId: jobId,
    provider,
    eventType: "skipped",
    payloadJson: JSON.stringify({ reason, ...payload }),
    occurredAt: skippedAt,
  } as any);
}

function quantityFromNotional(notionalUsd: number, price: number): string | null {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  const quantity = (notionalUsd / price).toFixed(6);
  return Number(quantity) > 0 ? quantity : null;
}

async function resolveAsterSizingPrice(intent: TradeIntentInput): Promise<number> {
  const priceHint = parseFloat(intent.limitPrice ?? "0");
  if (Number.isFinite(priceHint) && priceHint > 0) return priceHint;
  return new AsterApiClient().getTickerPrice(intent.symbol);
}

function protectiveOrderReason(intent: TradeIntentInput, referencePrice: number): string | null {
  const hasStop = Boolean(intent.stopLossPrice);
  const hasTakeProfit = Boolean(intent.takeProfitPrice);
  if (hasStop !== hasTakeProfit) return "aster_otoco_requires_stop_loss_and_take_profit";
  if (!hasStop || !hasTakeProfit) return null;
  const stopLoss = Number(intent.stopLossPrice);
  const takeProfit = Number(intent.takeProfitPrice);
  if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) return "aster_invalid_protective_price";
  if (intent.side === "BUY" && !(stopLoss < referencePrice && referencePrice < takeProfit)) {
    return "aster_invalid_buy_protective_range";
  }
  if (intent.side === "SELL" && !(takeProfit < referencePrice && referencePrice < stopLoss)) {
    return "aster_invalid_sell_protective_range";
  }
  return null;
}

async function loadIntent(intentId: number): Promise<TradeIntentInput | null> {
  const db = getDb();
  const [row] = await db.select().from(tradeIntents).where(eq(tradeIntents.id, intentId)).limit(1);
  if (!row) return null;
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side === "sell" || row.side === "SELL" ? "SELL" : "BUY",
    orderType: row.orderType === "limit" ? "LIMIT" : "MARKET",
    requestedNotionalUsd: row.requestedNotionalUsd,
    targetLeverage: row.targetLeverage,
    limitPrice: row.limitPrice,
    stopLossPrice: row.stopLossPrice,
    takeProfitPrice: row.takeProfitPrice,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * CEX FAN-OUT – mirrors the intent to every active CEX connection
 * ═══════════════════════════════════════════════════════════════════ */

async function fanOutCex(
  intent: TradeIntentInput,
  intentId: number,
  connections: Array<typeof cexConnections.$inferSelect>,
  preloaded: Awaited<ReturnType<typeof prefetchUserData>> | undefined,
) {
  const db = getDb();
  const results: Array<{ userId: number; exchange: string; status: string; reason?: string; jobId?: number }> = [];

  for (const conn of connections) {
    const decision = await decideExecution(intent, conn.userId, conn, preloaded);
    if (decision.approved !== true) {
      const reason = "reason" in decision ? decision.reason : "unknown";
      await writeAuditLog(conn.userId, "EXEC_RISK_SKIPPED", `intent:${intentId}; cex:${conn.exchange}; reason:${reason}`);
      results.push({ userId: conn.userId, exchange: conn.exchange, status: "skipped", reason });
      continue;
    }

    const idem = await idempotencyKey(conn.userId, intentId, "cex");

    await db.insert(executionJobs).values({
      tradeIntentId: intentId,
      userId: conn.userId,
      cexConnectionId: conn.id,
      provider: "cex",
      symbol: intent.symbol,
      side: intent.side,
      orderType: intent.orderType,
      status: "queued",
      riskApproved: true,
      idempotencyKey: idem,
    } as any).onConflictDoNothing();

    const [job] = await db.select().from(executionJobs)
      .where(and(eq(executionJobs.userId, conn.userId), eq(executionJobs.idempotencyKey, idem)))
      .limit(1);
    if (!job || job.status !== "queued") {
      results.push({ userId: conn.userId, exchange: conn.exchange, status: job ? "duplicate" : "skipped" });
      continue;
    }

    // Size the order
    let notionalUsd = decision.notionalUsd;
    let quantity: string | undefined;
    try {
      const creds = await decryptCexCredentials(conn);
      const client = createCexClient(conn.exchange, creds);
      const balance = await client.validateAndReadBalance();
      const [account] = await db.select().from(liveAccounts).where(eq(liveAccounts.userId, conn.userId)).limit(1);
      const maxPct = parseFloat(account?.maxPositionSizePct ?? "10");
      if (notionalUsd <= 0) notionalUsd = sizeNotionalFromEquity(balance.availableUsd || balance.equityUsd, maxPct);

      const priceHint = parseFloat(intent.limitPrice ?? "0");
      if (priceHint > 0) {
        quantity = (notionalUsd / priceHint).toFixed(6);
      } else {
        try {
          const pos = await client.getPositions(intent.symbol);
          const entryPrice = pos.length > 0 ? pos[0].entryPrice : 0;
          if (entryPrice > 0) quantity = (notionalUsd / entryPrice).toFixed(6);
          // No hardcoded fallback — MARKET orders without an existing position
          // must have limitPrice set.  A wild guess (e.g. $1000) can massively
          // over-size orders and is never acceptable.
        } catch {
          if (intent.limitPrice) quantity = (notionalUsd / parseFloat(intent.limitPrice)).toFixed(6);
        }
      }
    } catch (e: any) {
      results.push({ userId: conn.userId, exchange: conn.exchange, status: "skipped", reason: `balance_failed:${e?.message}` });
      continue;
    }

    if (!quantity || parseFloat(quantity) <= 0) {
      results.push({ userId: conn.userId, exchange: conn.exchange, status: "skipped", reason: "zero_quantity" });
      continue;
    }

    await db.update(executionJobs).set({
      notionalUsd: notionalUsd.toFixed(2), quantity, leverage: decision.leverage,
      limitPrice: intent.limitPrice ?? null, updatedAt: Date.now(),
    } as any).where(eq(executionJobs.id, job.id));

    // CEX order submission is handled by the VPS execution server.
    // The Worker only risk-approves, sizes, and queues the job.
    // The VPS polls /api/internal/risk-approved-jobs for queued+riskApproved
    // jobs and submits orders from its static-IP machine.
    await writeAuditLog(conn.userId, "EXEC_RISK_APPROVED",
      `intent:${intentId}; cex:${conn.exchange}; job:${job.id}; notional:${notionalUsd.toFixed(2)}; leverage:${decision.leverage}`);
    results.push({ userId: conn.userId, exchange: conn.exchange, jobId: job.id, status: "queued" });
  }

  return results;
}

/* ═══════════════════════════════════════════════════════════════════
 * ASTER FAN-OUT – mirrors the intent to every active Aster agent
 * ═══════════════════════════════════════════════════════════════════ */

async function fanOutAster(
  intent: TradeIntentInput,
  intentId: number,
) {
  const db = getDb();
  const asterConfig = getAsterConfig();
  const agents = await db.select().from(asterAgentAccounts)
    .where(eq(asterAgentAccounts.status, "active"));
  const preloaded = agents.length > 0
    ? await prefetchUserData([...new Set(agents.map((agent) => agent.userId))])
    : undefined;

  const results: Array<{ userId: number; provider: string; status: string; reason?: string; jobId?: number }> = [];

  for (const agent of agents) {
    const now = Date.now();
    if (agent.agentStatus !== "approved" || agent.builderStatus !== "approved") {
      const reason = "aster_approval_not_confirmed";
      await writeAuditLog(agent.userId, "EXEC_RISK_SKIPPED", `intent:${intentId}; aster; reason:${reason}`);
      results.push({ userId: agent.userId, provider: "aster", status: "skipped", reason });
      continue;
    }
    if (agent.approvalExpiresAt != null && agent.approvalExpiresAt <= now) {
      await db.update(asterAgentAccounts).set({ status: "paused", agentStatus: "expired", updatedAt: now } as any)
        .where(eq(asterAgentAccounts.id, agent.id));
      const reason = "aster_agent_expired";
      await writeAuditLog(agent.userId, "EXEC_RISK_SKIPPED", `intent:${intentId}; aster; reason:${reason}`);
      results.push({ userId: agent.userId, provider: "aster", status: "skipped", reason });
      continue;
    }

    const decision = await decideExecution(intent, agent.userId, {
      id: 0, // Aster agents do not have a cexConnection
      status: "active",
      copytradeEnabled: true,
      killSwitchActive: false,
      consecutiveLosses: 0,
      circuitBreakerUntil: null,
      highWaterMark: null,
    }, preloaded);
    if (decision.approved !== true) {
      const reason = "reason" in decision ? decision.reason : "unknown";
      await writeAuditLog(agent.userId, "EXEC_RISK_SKIPPED", `intent:${intentId}; aster; reason:${reason}`);
      results.push({ userId: agent.userId, provider: "aster", status: "skipped", reason });
      continue;
    }

    const idem = await idempotencyKey(agent.userId, intentId, "aster");
    const queuedAt = Date.now();

    await db.insert(executionJobs).values({
      tradeIntentId: intentId,
      userId: agent.userId,
      asterAgentAccountId: agent.id,
      provider: "aster",
      symbol: intent.symbol,
      side: intent.side,
      orderType: intent.orderType,
      status: "queued",
      idempotencyKey: idem,
      queuedAt,
      updatedAt: queuedAt,
    } as any).onConflictDoNothing();

    const [job] = await db.select().from(executionJobs)
      .where(and(eq(executionJobs.userId, agent.userId), eq(executionJobs.idempotencyKey, idem)))
      .limit(1);
    if (!job || job.status !== "queued") {
      results.push({ userId: agent.userId, provider: "aster", status: job ? "duplicate" : "skipped" });
      continue;
    }

    const feeRate = decimalValue(agent.feeRate);
    const maxFeeRate = decimalValue(agent.maxFeeRate ?? agent.feeRate);
    if (!Number.isFinite(feeRate) || !Number.isFinite(maxFeeRate) || feeRate > maxFeeRate) {
      const reason = "fee_rate_exceeds_approved_max";
      await skipJob(job.id, "aster", reason, { feeRate: agent.feeRate, maxFeeRate: agent.maxFeeRate });
      await writeAuditLog(agent.userId, "EXEC_RISK_SKIPPED", `intent:${intentId}; aster; reason:${reason}`);
      results.push({ userId: agent.userId, provider: "aster", jobId: job.id, status: "skipped", reason });
      continue;
    }

    let notionalUsd = decision.notionalUsd;
    let account: typeof liveAccounts.$inferSelect | undefined;
    try {
      const [row] = await db.select().from(liveAccounts)
        .where(eq(liveAccounts.userId, agent.userId)).limit(1);
      account = row;
      let equity = parseFloat(account?.lastTotalEquityUsd ?? "0");
      if (equity <= 0) {
        try {
          const synced = await syncAsterFuturesBalance(agent.userId);
          equity = synced.equityUsd;
        } catch { /* keep existing zero-equity handling below */ }
      }
      if (equity > 0 && notionalUsd <= 0) {
        const maxPct = parseFloat(account?.maxPositionSizePct ?? "10");
        notionalUsd = sizeNotionalFromEquity(equity, maxPct);
      }
    } catch { /* fall through */ }

    if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
      const reason = "no_requested_notional_or_equity_snapshot";
      await skipJob(job.id, "aster", reason, {
        lastTotalEquityUsd: account?.lastTotalEquityUsd ?? null,
      });
      results.push({ userId: agent.userId, provider: "aster", jobId: job.id, status: "skipped", reason });
      continue;
    }

    let sizingPrice: number;
    try {
      sizingPrice = await resolveAsterSizingPrice(intent);
    } catch (e: any) {
      const reason = "price_unavailable";
      await skipJob(job.id, "aster", reason, { error: String(e?.message).slice(0, 200) });
      results.push({ userId: agent.userId, provider: "aster", jobId: job.id, status: "skipped", reason });
      continue;
    }

    const protectiveReason = protectiveOrderReason(intent, sizingPrice);
    if (protectiveReason) {
      await skipJob(job.id, "aster", protectiveReason, {
        stopLossPrice: intent.stopLossPrice,
        takeProfitPrice: intent.takeProfitPrice,
        referencePrice: sizingPrice,
      });
      await writeAuditLog(agent.userId, "EXEC_RISK_SKIPPED", `intent:${intentId}; aster; reason:${protectiveReason}`);
      results.push({ userId: agent.userId, provider: "aster", jobId: job.id, status: "skipped", reason: protectiveReason });
      continue;
    }

    const quantity = quantityFromNotional(notionalUsd, sizingPrice);
    if (!quantity) {
      const reason = "zero_quantity";
      await skipJob(job.id, "aster", reason, { notionalUsd, sizingPrice });
      results.push({ userId: agent.userId, provider: "aster", jobId: job.id, status: "skipped", reason });
      continue;
    }

    await db.update(executionJobs).set({
      notionalUsd: notionalUsd.toFixed(2), quantity, leverage: decision.leverage,
      limitPrice: String(sizingPrice), updatedAt: Date.now(),
    } as any).where(eq(executionJobs.id, job.id));

    if (!asterConfig.liveOrderSubmissionEnabled) {
      const stagedAt = Date.now();
      await db.update(executionJobs).set({
        status: "staged",
        errorMessage: null,
        updatedAt: stagedAt,
      } as any).where(eq(executionJobs.id, job.id));
      await db.insert(orderEvents).values({
        executionJobId: job.id,
        provider: "aster",
        eventType: "staged",
        payloadJson: JSON.stringify({
          reason: "live_order_submission_disabled",
          environment: asterConfig.environment,
        }),
        occurredAt: stagedAt,
      } as any);
      await writeAuditLog(agent.userId, "EXEC_ORDER_STAGED",
        `intent:${intentId}; aster; live_order_submission_disabled`);
      results.push({
        userId: agent.userId,
        provider: "aster",
        jobId: job.id,
        status: "staged",
        reason: "live_order_submission_disabled",
      });
      continue;
    }

    // Submit via Aster adapter with retry
    let finalStatus: "submitted" | "filled" | "rejected" | "error" = "submitted";
    await enqueue(agent.id, async () => {
      let attempts = 0;
      const maxAttempts = 3;
      const backoff = [1000, 2000, 4000];
      let lastError: Error | undefined;

      while (attempts < maxAttempts) {
        try {
          attempts++;
          const adapter = new AsterExecutionAdapter(agent.id);
          const receipt = await adapter.submitOrder(job.id, {
            symbol: intent.symbol, side: intent.side, type: intent.orderType,
            quantity, price: intent.limitPrice ?? undefined,
            newClientOrderId: idem,
            leverage: decision.leverage,
            stopLossPrice: intent.stopLossPrice ?? undefined,
            takeProfitPrice: intent.takeProfitPrice ?? undefined,
          });

          finalStatus = receipt.status === "filled" ? "filled" : receipt.status === "rejected" ? "rejected" : "submitted";
          await db.update(executionJobs).set({
            status: finalStatus,
            orderId: receipt.orderId,
            submittedAt: Date.now(),
            ...(receipt.status === "filled" ? { filledAt: Date.now() } : {}),
            ...(receipt.status === "rejected" ? { errorMessage: "aster_order_rejected" } : {}),
            updatedAt: Date.now(),
          } as any).where(eq(executionJobs.id, job.id));

          await db.insert(orderEvents).values({
            executionJobId: job.id, provider: "aster", eventType: receipt.status,
            payloadJson: JSON.stringify({ raw: receipt.raw ?? {}, attempt: attempts }),
            occurredAt: Date.now(),
          } as any);

          try {
            await syncAsterFuturesBalance(agent.userId);
          } catch { /* best-effort */ }

          await writeAuditLog(agent.userId, "EXEC_ORDER_SUBMITTED",
            `intent:${intentId}; aster:${receipt.orderId}; attempt:${attempts}`);
          return;
        } catch (e: any) {
          lastError = e;
          if (attempts < maxAttempts) {
            const delay = backoff[attempts - 1];
            console.warn(`[dispatch] Aster attempt ${attempts}/${maxAttempts} failed for job ${job.id}, retrying in ${delay}ms: ${e?.message}`);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }

      finalStatus = "error";
      await db.update(executionJobs).set({
        status: "error", errorMessage: String(lastError?.message).slice(0, 300), updatedAt: Date.now(),
      } as any).where(eq(executionJobs.id, job.id));
      await db.insert(orderEvents).values({
        executionJobId: job.id, provider: "aster", eventType: "rejected",
        payloadJson: JSON.stringify({ error: String(lastError?.message).slice(0, 300), attempts }),
        occurredAt: Date.now(),
      } as any);
      await writeAuditLog(agent.userId, "EXEC_ORDER_FAILED",
        `intent:${intentId}; aster; ${String(lastError?.message).slice(0, 120)}; attempts:${attempts}`);
    });

    results.push({ userId: agent.userId, provider: "aster", jobId: job.id, status: finalStatus });
  }

  return results;
}

/* ═══════════════════════════════════════════════════════════════════
 * MAIN ENTRY POINT
 * Fans out a TradeIntent to BOTH active CEX connections AND active
 * Aster agents. Each provider path is independent.
 * ═══════════════════════════════════════════════════════════════════ */

export async function createExecutionJobsForIntent(intentId: number) {
  const db = getDb();
  const intent = await loadIntent(intentId);
  if (!intent) throw new Error("TRADE_INTENT_NOT_FOUND");

  const connections = await db.select().from(cexConnections)
    .where(eq(cexConnections.status, "active"));

  // Pre-fetch CEX risk data
  const cexUserIds = [...new Set(connections.map((c) => c.userId))];
  const preloaded = cexUserIds.length > 0 ? await prefetchUserData(cexUserIds) : undefined;

  // Fan out to CEX and Aster in parallel
  const [cexResults, asterResults] = await Promise.all([
    Promise.allSettled(
      connections.map(async (conn) => {
        const r = await fanOutCex(intent, intentId, [conn], preloaded);
        return r[0] ?? { userId: conn.userId, exchange: conn.exchange, status: "error" as const };
      }),
    ),
    (async () => {
      try {
        return await fanOutAster(intent, intentId);
      } catch (e: any) {
        return [{ userId: 0, provider: "aster" as const, status: "error" as const, reason: e?.message }];
      }
    })(),
  ]);

  const allResults = [
    ...cexResults.map((r) => (r.status === "fulfilled" ? r.value : { userId: 0, exchange: "error", status: "error" as const, reason: String(r.reason) })),
    ...asterResults,
  ];

  return { intentId, jobs: allResults };
}
