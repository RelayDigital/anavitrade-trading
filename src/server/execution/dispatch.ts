import { and, eq } from "drizzle-orm";
import {
  cexConnections, asterAgentAccounts, executionJobs, orderEvents, navSnapshots,
  tradeIntents, liveAccounts,
} from "../../drizzle/schema";
import { getDb, writeAuditLog } from "../db";
import { sha256Hex } from "../cex/signing";
import { decryptCexCredentials } from "../cex/store";
import { createCexClient } from "../cex/factory";
import { CexExecutionAdapter } from "../cex/adapter";
import { AsterExecutionAdapter } from "../aster/adapter";
import { getAsterConfig } from "../aster/config";
import { decideExecution, prefetchUserData, sizeNotionalFromEquity, type TradeIntentInput } from "./riskEngine";

/** Deterministic idempotency key per (user, intent). Prevents duplicate mirrors. */
async function idempotencyKey(userId: number, intentId: number, prefix = "cex"): Promise<string> {
  return (await sha256Hex(`${prefix}:${userId}:${intentId}`)).slice(0, 32);
}

/** Serialize execution per connection so a signer never has two in-flight orders. */
const connectionQueues = new Map<number, Promise<unknown>>();
function enqueue<T>(connectionId: number, task: () => Promise<T>): Promise<T> {
  const prev = connectionQueues.get(connectionId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(task);
  connectionQueues.set(connectionId, next);
  return next;
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
          const ticker = pos.length > 0 ? pos[0].entryPrice : 0;
          const fallback = ticker > 0 ? ticker : 1000;
          if (fallback > 0) quantity = (notionalUsd / fallback).toFixed(6);
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

    // Submit with retry
    await enqueue(conn.id, async () => {
      let attempts = 0;
      const maxAttempts = 3;
      const backoff = [1000, 2000, 4000];
      let lastError: Error | undefined;

      while (attempts < maxAttempts) {
        try {
          attempts++;
          const adapter = new CexExecutionAdapter(conn.id);
          const receipt = await adapter.submitOrder(job.id, {
            symbol: intent.symbol, side: intent.side, type: intent.orderType,
            quantity, price: intent.limitPrice ?? undefined,
            leverage: decision.leverage,
            stopLossPrice: intent.stopLossPrice ?? undefined,
            takeProfitPrice: intent.takeProfitPrice ?? undefined,
            clientOrderId: idem,
          });

          await db.update(executionJobs).set({
            status: receipt.status === "filled" ? "filled" : "submitted",
            orderId: receipt.orderId, submittedAt: Date.now(),
            ...(receipt.status === "filled" ? { filledAt: Date.now() } : {}),
            updatedAt: Date.now(),
          } as any).where(eq(executionJobs.id, job.id));

          await db.insert(orderEvents).values({
            executionJobId: job.id, provider: "cex", eventType: receipt.status,
            payloadJson: JSON.stringify({ raw: receipt.raw ?? {}, attempt: attempts }),
          } as any);

          // NAV snapshot best-effort
          try {
            const creds2 = await decryptCexCredentials(conn);
            const client2 = createCexClient(conn.exchange, creds2);
            const bal = await client2.validateAndReadBalance();
            await db.insert(navSnapshots).values({
              userId: conn.userId, provider: "cex",
              accountEquityUsd: bal.equityUsd.toFixed(2),
              availableBalanceUsd: bal.availableUsd.toFixed(2), source: "provider_sync",
            } as any);
          } catch { /* best-effort */ }

          await writeAuditLog(conn.userId, "EXEC_ORDER_SUBMITTED",
            `intent:${intentId}; cex:${receipt.orderId}; ${conn.exchange}; attempt:${attempts}`);
          return;
        } catch (e: any) {
          lastError = e;
          if (attempts < maxAttempts) {
            const delay = backoff[attempts - 1];
            console.warn(`[dispatch] CEX attempt ${attempts}/${maxAttempts} failed for job ${job.id}, retrying in ${delay}ms: ${e?.message}`);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }

      await db.update(executionJobs).set({
        status: "error", errorMessage: String(lastError?.message).slice(0, 300), updatedAt: Date.now(),
      } as any).where(eq(executionJobs.id, job.id));
      await db.insert(orderEvents).values({
        executionJobId: job.id, provider: "cex", eventType: "rejected",
        payloadJson: JSON.stringify({ error: String(lastError?.message).slice(0, 300), attempts }),
      } as any);
      await writeAuditLog(conn.userId, "EXEC_ORDER_FAILED",
        `intent:${intentId}; ${String(lastError?.message).slice(0, 120)}; attempts:${attempts}`);
    });

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

  const results: Array<{ userId: number; provider: string; status: string; reason?: string; jobId?: number }> = [];

  for (const agent of agents) {
    const decision = await decideExecution(intent, agent.userId, { id: agent.userId } as any, undefined);
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

    // Compute notional from the live account's unified balance
    let notionalUsd = decision.notionalUsd;
    try {
      const [account] = await db.select().from(liveAccounts)
        .where(eq(liveAccounts.userId, agent.userId)).limit(1);
      const equity = parseFloat(account?.lastTotalEquityUsd ?? "0");
      if (equity > 0 && notionalUsd <= 0) {
        const maxPct = parseFloat(account?.maxPositionSizePct ?? "10");
        notionalUsd = sizeNotionalFromEquity(equity, maxPct);
      }
    } catch { /* fall through */ }

    const priceHint = parseFloat(intent.limitPrice ?? "0");
    const quantity = priceHint > 0 ? (notionalUsd / priceHint).toFixed(6) : (notionalUsd / 1000).toFixed(6);
    if (!quantity || parseFloat(quantity) <= 0) {
      results.push({ userId: agent.userId, provider: "aster", status: "skipped", reason: "zero_quantity" });
      continue;
    }

    await db.update(executionJobs).set({
      notionalUsd: notionalUsd.toFixed(2), quantity, leverage: decision.leverage,
      limitPrice: intent.limitPrice ?? null, updatedAt: Date.now(),
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
            leverage: decision.leverage,
            stopLossPrice: intent.stopLossPrice ?? undefined,
            takeProfitPrice: intent.takeProfitPrice ?? undefined,
          });

          await db.update(executionJobs).set({
            status: receipt.status === "filled" ? "filled" : "submitted",
            orderId: receipt.orderId, submittedAt: Date.now(),
            ...(receipt.status === "filled" ? { filledAt: Date.now() } : {}),
            updatedAt: Date.now(),
          } as any).where(eq(executionJobs.id, job.id));

          await db.insert(orderEvents).values({
            executionJobId: job.id, provider: "aster", eventType: receipt.status,
            payloadJson: JSON.stringify({ raw: receipt.raw ?? {}, attempt: attempts }),
            occurredAt: Date.now(),
          } as any);

          // NAV snapshot best-effort (Aster doesn't expose balance; use unified cache)
          try {
            const [account] = await db.select().from(liveAccounts)
              .where(eq(liveAccounts.userId, agent.userId)).limit(1);
            if (account) {
              await db.insert(navSnapshots).values({
                userId: agent.userId, provider: "aster",
                accountEquityUsd: account.lastTotalEquityUsd ?? "0",
                availableBalanceUsd: account.lastAvailableUsd ?? "0",
                source: "provider_sync",
                snapshotAt: Date.now(),
              } as any);
            }
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

    results.push({ userId: agent.userId, provider: "aster", jobId: job.id, status: "queued" });
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
