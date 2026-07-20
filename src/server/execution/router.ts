import { z } from "zod";
import { desc, eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb, writeAuditLog } from "../db";
import { executionJobs, orderEvents, tradeIntents } from "../../drizzle/schema";
import { createExecutionJobsForIntent } from "./dispatch";
import { AsterExecutionAdapter } from "../aster/adapter";
import { isGlobalKill, setGlobalKill } from "./riskEngine";


function terminalJobStatus(status: string): boolean {
  return ["filled", "rejected", "cancelled", "canceled", "error", "skipped"].includes(status);
}

function mappedJobStatus(status: string): "submitted" | "filled" | "rejected" | "cancelled" {
  if (status === "filled") return "filled";
  if (status === "cancelled") return "cancelled";
  if (status === "rejected") return "rejected";
  return "submitted";
}

export const execRouter = router({
  /** Global kill switch state (admin visibility). */
  getGlobalKill: protectedProcedure.query(() => ({ active: isGlobalKill() })),

  /** Flip the global kill switch — halts ALL execution across every user. */
  setGlobalKill: adminProcedure
    .input(z.object({ active: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      await setGlobalKill(input.active);
      await writeAuditLog(ctx.user.id, input.active ? "GLOBAL_KILL_ON" : "GLOBAL_KILL_OFF");
      return { active: input.active };
    }),

  /**
   * Admin-only: emit a TradeIntent and fan it out to every eligible connected
   * user. This is the live-execution trigger. Real orders fire on real accounts,
   * gated by per-user + global kill switches and risk caps.
   */
  dispatchIntent: adminProcedure
    .input(z.object({
      symbol: z.string().min(3).max(20),
      side: z.enum(["BUY", "SELL"]),
      orderType: z.enum(["MARKET", "LIMIT"]).default("MARKET"),
      requestedNotionalUsd: z.string().optional(),
      targetLeverage: z.number().int().min(1).max(50).optional(),
      limitPrice: z.string().optional(),
      stopLossPrice: z.string().optional(),
      takeProfitPrice: z.string().optional(),
      source: z.string().default("manual"),
      externalSignalId: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [intent] = await db.insert(tradeIntents).values({
        source: input.source,
        externalSignalId: input.externalSignalId ?? null,
        symbol: input.symbol,
        side: input.side.toLowerCase(),
        orderType: input.orderType.toLowerCase(),
        requestedNotionalUsd: input.requestedNotionalUsd ?? null,
        targetLeverage: input.targetLeverage ?? null,
        limitPrice: input.limitPrice ?? null,
        stopLossPrice: input.stopLossPrice ?? null,
        takeProfitPrice: input.takeProfitPrice ?? null,
        status: "created",
        createdBy: `admin:${ctx.user.id}`,
      } as any).returning();
      if (!intent) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Intent not created." });

      const result = await createExecutionJobsForIntent(intent.id);
      await writeAuditLog(ctx.user.id, "INTENT_DISPATCHED", `intent:${intent.id}; ${input.symbol} ${input.side}`);
      return { intentId: intent.id, ...result };
    }),

  /** Re-run dispatch for an existing intent (retry). Idempotent — already-
   *  processed (user, intent) pairs are skipped, not duplicated. */
  redispatchIntent: adminProcedure
    .input(z.object({ intentId: z.number().int().positive() }))
    .mutation(async ({ input }) => createExecutionJobsForIntent(input.intentId)),

  /** Recent execution jobs for the calling user (dashboard/history). */
  myJobs: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(25) }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      return db.select().from(executionJobs)
        .where(eq(executionJobs.userId, ctx.user.id))
        .orderBy(desc(executionJobs.queuedAt))
        .limit(input.limit);
    }),

  syncAsterJob: protectedProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [job] = await db.select().from(executionJobs)
        .where(and(eq(executionJobs.id, input.jobId), eq(executionJobs.userId, ctx.user.id)))
        .limit(1);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Execution job not found." });
      if (job.provider !== "aster" || !job.asterAgentAccountId) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only Aster jobs can be synced here." });
      }
      if (!job.orderId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Aster job has no order id yet." });

      const [intent] = await db.select().from(tradeIntents)
        .where(eq(tradeIntents.id, job.tradeIntentId))
        .limit(1);
      const adapter = new AsterExecutionAdapter(job.asterAgentAccountId);
      const receipt = intent?.stopLossPrice && intent?.takeProfitPrice
        ? await adapter.queryStrategyOrder(job.orderId)
        : await adapter.queryOrder(job.symbol, job.orderId);
      const status = mappedJobStatus(receipt.status);
      const now = Date.now();
      await db.update(executionJobs).set({
        status,
        ...(status === "filled" ? { filledAt: now } : {}),
        ...(status === "cancelled" ? { cancelledAt: now } : {}),
        updatedAt: now,
      } as any).where(eq(executionJobs.id, job.id));
      await db.insert(orderEvents).values({
        executionJobId: job.id,
        provider: "aster",
        eventType: `sync:${receipt.status}`,
        payloadJson: JSON.stringify({ raw: receipt.raw ?? {} }),
        occurredAt: now,
      } as any);
      return { jobId: job.id, status, receipt };
    }),

  cancelAsterJob: protectedProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [job] = await db.select().from(executionJobs)
        .where(and(eq(executionJobs.id, input.jobId), eq(executionJobs.userId, ctx.user.id)))
        .limit(1);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Execution job not found." });
      if (job.provider !== "aster" || !job.asterAgentAccountId) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only Aster jobs can be cancelled here." });
      }
      if (!job.orderId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Aster job has no order id yet." });
      if (terminalJobStatus(job.status)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Execution job is already terminal." });
      }

      const [intent] = await db.select().from(tradeIntents)
        .where(eq(tradeIntents.id, job.tradeIntentId))
        .limit(1);
      if (intent?.stopLossPrice && intent?.takeProfitPrice) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Strategy-order cancellation is not wired; sync status and manage from Aster until provider cancel endpoint is integrated." });
      }
      const receipt = await new AsterExecutionAdapter(job.asterAgentAccountId).cancelOrder(job.orderId, job.symbol);
      const status = mappedJobStatus(receipt.status) === "filled" ? "filled" : "cancelled";
      const now = Date.now();
      await db.update(executionJobs).set({
        status,
        ...(status === "filled" ? { filledAt: now } : { cancelledAt: now }),
        updatedAt: now,
      } as any).where(eq(executionJobs.id, job.id));
      await db.insert(orderEvents).values({
        executionJobId: job.id,
        provider: "aster",
        eventType: receipt.status === "filled" ? "filled" : "cancelled",
        payloadJson: JSON.stringify({ raw: receipt.raw ?? {} }),
        occurredAt: now,
      } as any);
      return { jobId: job.id, status, receipt };
    }),

  /** Re-checks a submitted PancakeSwap job's on-chain transaction status. */
  syncPancakeswapJob: protectedProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [job] = await db.select().from(executionJobs)
        .where(and(eq(executionJobs.id, input.jobId), eq(executionJobs.userId, ctx.user.id)))
        .limit(1);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Execution job not found." });
      if (job.provider !== "pancakeswap" || !job.pancakeswapDelegationId) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only PancakeSwap jobs can be synced here." });
      }
      if (!job.orderId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PancakeSwap job has no transaction hash yet." });

      const { getPublicClient } = await import("../pancakeswap/client");
      const receipt = await getPublicClient().getTransactionReceipt({ hash: job.orderId as `0x${string}` });
      const status = receipt.status === "success" ? "filled" : "rejected";
      const now = Date.now();
      await db.update(executionJobs).set({
        status,
        ...(status === "filled" ? { filledAt: now } : {}),
        updatedAt: now,
      } as any).where(eq(executionJobs.id, job.id));
      await db.insert(orderEvents).values({
        executionJobId: job.id,
        provider: "pancakeswap",
        eventType: `sync:${status}`,
        payloadJson: JSON.stringify({ raw: receipt }),
        occurredAt: now,
      } as any);
      return { jobId: job.id, status, receipt };
    }),

  /** PancakeSwap spot swaps settle atomically on submission — there is nothing
   *  to cancel post-submission (matches PancakeswapExecutionAdapter.cancelOrder). */
  cancelPancakeswapJob: protectedProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [job] = await db.select().from(executionJobs)
        .where(and(eq(executionJobs.id, input.jobId), eq(executionJobs.userId, ctx.user.id)))
        .limit(1);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Execution job not found." });
      if (job.provider !== "pancakeswap") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only PancakeSwap jobs can be cancelled here." });
      }
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PancakeSwap spot swaps cannot be cancelled once submitted." });
    }),
});
