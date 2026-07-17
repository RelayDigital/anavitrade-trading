import { and, eq } from "drizzle-orm";
import {
  cexConnections, asterAgentAccounts, executionJobs, orderEvents,
  tradeIntents, coinlegsSignals, mlInferences,
} from "../../drizzle/schema";
import { getDb, writeAuditLog } from "../db";
import { sha256Hex } from "../cex/signing";
import { decryptCexCredentials, refreshCexNavSnapshot } from "../cex/store";
import { createCexClient } from "../cex/factory";
import { getKlines } from "../analysis/kline-repository";
import { runInference, type Candle } from "../ml/inference-router";
import {
  evaluateDispatchGate, GATE_CONFIG, ML_THRESHOLD,
  computeAtrPct, computeRsi14, isBullRegime,
  type GateDecision, type GateDirection,
} from "../signals/unified-engine";
import { assertAutomatedExecutionSupported } from "../cex/registry";
import type { ExchangeEnvironment } from "../cex/clientTypes";
/* CexExecutionAdapter no longer imported — Worker no longer submits CEX orders.
 * The VPS execution server polls risk-approved jobs and submits orders from its
 * static-IP machine. */
import { AsterExecutionAdapter } from "../aster/adapter";
import { AsterApiClient } from "../aster/client";
import { getAsterConfig } from "../aster/config";
import { syncAsterFuturesBalance } from "../aster/store";
import { decideExecution, prefetchUserData, type RiskDecision, type TradeIntentInput } from "./riskEngine";

type ApprovedRiskDecision = Extract<RiskDecision, { approved: true }>;

type CexDispatchConnection = Pick<typeof cexConnections.$inferSelect, "userId" | "exchange">;

export type CexNavDispatchReadiness = {
  readyUserIds: Set<number>;
  failures: Map<number, string>;
};

export type CexNavDispatchDependencies = {
  assertAutomatedExecution?: (exchange: string, environment: ExchangeEnvironment) => void;
  refreshNav?: (userId: number) => Promise<unknown>;
};

function refreshFailureReason(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}

/**
 * Prepare fresh CEX NAV once per user before risk data is prefetched. A failed
 * user is intentionally absent from `readyUserIds`, so no job can be queued.
 */
export async function refreshCexNavBeforeAutomatedDispatch(
  connections: CexDispatchConnection[],
  dependencies: CexNavDispatchDependencies = {},
): Promise<CexNavDispatchReadiness> {
  const environment: ExchangeEnvironment = "production";
  const assertAutomatedExecution = dependencies.assertAutomatedExecution ?? assertAutomatedExecutionSupported;
  const refreshNav = dependencies.refreshNav ?? ((userId: number) => refreshCexNavSnapshot(userId, {
    environment,
    requireAutomatedExecution: true,
  }));
  const byUser = new Map<number, CexDispatchConnection[]>();
  for (const connection of connections) {
    const group = byUser.get(connection.userId) ?? [];
    group.push(connection);
    byUser.set(connection.userId, group);
  }

  const readyUserIds = new Set<number>();
  const failures = new Map<number, string>();
  for (const [userId, userConnections] of byUser) {
    try {
      // This occurs before refreshNav can decrypt credentials or create a client.
      for (const connection of userConnections) {
        assertAutomatedExecution(connection.exchange, environment);
      }
      await refreshNav(userId);
      readyUserIds.add(userId);
    } catch (error) {
      failures.set(userId, refreshFailureReason(error));
    }
  }
  return { readyUserIds, failures };
}

/**
 * The risk engine is the sole sizing authority. Any non-positive or invalid
 * decision is treated as a denial before persistence or provider access.
 */
export function requireAuthoritativeRiskDecision(decision: RiskDecision): ApprovedRiskDecision | null {
  if (!decision.approved || !Number.isFinite(decision.notionalUsd) || decision.notionalUsd <= 0) return null;
  return decision;
}

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
 * DISPATCH GATE (PRD R1.1 / R1.3) – the single ordered decision layer
 * every intent must clear BEFORE any per-connection fan-out / risk engine.
 *
 * Order: universe → tier → rsi extension → regime → ml. The existing
 * decideExecution() risk engine still runs last, per-connection, unchanged.
 * Scoring is mandatory: if inference (or the market data needed to score) is
 * unreachable, the gate fails closed (gate_result='ml_unreachable').
 * ═══════════════════════════════════════════════════════════════════ */

/** Fetch candles for a timeframe: D1 first, then Binance futures as fallback.
 *  Returns [] when neither source yields data (→ gate fails closed). */
async function fetchGateCandles(
  symbol: string,
  timeframe: string,
  limit: number,
): Promise<Candle[]> {
  try {
    const rows = await getKlines(symbol, timeframe, limit);
    if (rows.length > 0) {
      return rows.map((k) => ({
        open: k.open, high: k.high, low: k.low,
        close: k.close, volume: k.volume, time: k.timestamp,
      }));
    }
  } catch { /* fall through to network fallback */ }

  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${timeframe}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const raw = (await res.json()) as any[];
    if (!Array.isArray(raw)) return [];
    return raw.map((k: any[]) => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
  } catch {
    return [];
  }
}

interface GateEvaluation {
  decision: GateDecision;
  mlScore: number | null;
  mlRegime: string;
  tierScore: number;
  atrPct4h: number;
  rsi14: number;
  bullRegime: boolean;
}

/** Map an entry timeframe to the candle series used for the RSI gate. */
function pickRsiCandles(
  period: string,
  k15: Candle[], k1h: Candle[], k4h: Candle[],
): Candle[] {
  if (period === "4h" || period === "1d" || period === "1w") return k4h;
  if (period === "1h" || period === "2h") return k1h;
  if (period === "15m" || period === "30m" || period === "5m") return k15;
  return k4h;
}

/**
 * Gather the scalars the pure gate needs (tier, ATR%, RSI, regime, ML score)
 * and run the ordered gate. All IO is confined here; the decision logic itself
 * lives in the pure evaluateDispatchGate() (unified-engine.ts / dispatch-gate.ts).
 */
async function runDispatchGate(
  intentId: number,
  intent: TradeIntentInput,
): Promise<GateEvaluation> {
  const db = getDb();
  const direction: GateDirection = intent.side === "SELL" ? "short" : "long";

  // ── Tier + entry timeframe from the originating coinlegs signal ──
  let tierScore = 0;
  let entryTf = "4h";
  const [row] = await db.select().from(tradeIntents)
    .where(eq(tradeIntents.id, intentId)).limit(1);
  if (row?.source === "coinlegs" && row.externalSignalId) {
    const sid = Number(row.externalSignalId);
    if (Number.isFinite(sid) && sid !== 0) {
      const [cs] = await db.select().from(coinlegsSignals)
        .where(eq(coinlegsSignals.signalId, sid)).limit(1);
      if (cs) {
        tierScore = cs.qualityScore ?? 0;
        entryTf = cs.period || "4h";
      }
    }
    // The scraper only creates intents for Tier A signals; if the score row is
    // unresolvable (e.g. synthetic dedup id), treat as Tier A by construction.
    if (tierScore === 0) tierScore = GATE_CONFIG.tierAScore;
  }

  // ── Market data (D1 → Binance fallback) ──
  const [k15, k1h, k4h, k4hExt] = await Promise.all([
    fetchGateCandles(intent.symbol, "15m", 200),
    fetchGateCandles(intent.symbol, "1h", 200),
    fetchGateCandles(intent.symbol, "4h", 200),
    fetchGateCandles(intent.symbol, "4h", 260),
  ]);

  // Enough 4h bars for ATR is the minimum bar to evaluate the universe gate.
  const marketDataAvailable = k4h.length >= 15;

  const atrPct4h = computeAtrPct(
    k4h.map((c) => c.high), k4h.map((c) => c.low), k4h.map((c) => c.close),
  );
  const rsiCandles = pickRsiCandles(entryTf, k15, k1h, k4h);
  const rsi14 = computeRsi14(rsiCandles.map((c) => c.close));
  const bullRegime = isBullRegime((k4hExt.length >= k4h.length ? k4hExt : k4h).map((c) => c.close));

  // ── ML score (mandatory; fail closed on any failure — R1.3) ──
  let mlScore: number | null = null;
  let mlRegime = "UNKNOWN";
  let mlUnreachable = false;
  try {
    if (!marketDataAvailable) {
      mlUnreachable = true;
    } else {
      const result = runInference({
        symbol: intent.symbol,
        direction,
        klines15m: k15,
        klines1h: k1h,
        klines4h: k4h,
      });
      mlScore = result.proba;
      mlRegime = result.regime;
    }
  } catch (e: any) {
    mlUnreachable = true;
    console.warn(`[dispatch-gate] inference unreachable for intent ${intentId} (${intent.symbol}): ${String(e?.message).slice(0, 160)}`);
  }

  const decision = evaluateDispatchGate({
    symbol: intent.symbol,
    direction,
    tierScore,
    atrPct4h,
    rsi14,
    bullRegime,
    mlScore,
    mlThreshold: ML_THRESHOLD,
    mlUnreachable,
    marketDataAvailable,
  });

  return { decision, mlScore, mlRegime, tierScore, atrPct4h, rsi14, bullRegime };
}

/** Persist every gate outcome (pass, paper, reject) to ml_inferences with the
 *  failing gate name so the funnel is auditable (PRD R1.1). */
async function persistGateInference(
  intentId: number,
  intent: TradeIntentInput,
  ev: GateEvaluation,
): Promise<void> {
  const db = getDb();
  const { decision } = ev;
  const outcome = decision.approved ? "TRADE" : decision.paperOnly ? "PAPER" : "SKIP";
  try {
    await db.insert(mlInferences).values({
      tradeIntentId: intentId,
      symbol: intent.symbol,
      direction: intent.side === "SELL" ? "short" : "long",
      proba: ev.mlScore === null ? "n/a" : ev.mlScore.toFixed(6),
      threshold: String(ML_THRESHOLD),
      decision: outcome,
      regime: ev.mlRegime,
      featureVectorJson: JSON.stringify({
        tierScore: ev.tierScore,
        atrPct4h: Number(ev.atrPct4h.toFixed(4)),
        rsi14: Number(ev.rsi14.toFixed(2)),
        bullRegime: ev.bullRegime,
        sizeFactor: decision.sizeFactor,
        reason: decision.reason,
      }),
      gateResult: decision.gateResult,
    } as any);
  } catch (e: any) {
    console.warn(`[dispatch-gate] failed to persist inference for intent ${intentId}: ${String(e?.message).slice(0, 160)}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * CEX FAN-OUT – mirrors the intent to every active CEX connection
 * ═══════════════════════════════════════════════════════════════════ */

async function fanOutCex(
  intent: TradeIntentInput,
  intentId: number,
  connections: Array<typeof cexConnections.$inferSelect>,
  preloaded: Awaited<ReturnType<typeof prefetchUserData>> | undefined,
  sizeFactor = 1,
) {
  const db = getDb();
  const results: Array<{ userId: number; exchange: string; status: string; reason?: string; jobId?: number }> = [];

  for (const conn of connections) {
    const decision = await decideExecution(intent, conn.userId, conn, preloaded);
    const approvedDecision = requireAuthoritativeRiskDecision(decision);
    if (!approvedDecision) {
      const reason = "reason" in decision ? decision.reason : "non_positive_risk_notional";
      await writeAuditLog(conn.userId, "EXEC_RISK_SKIPPED", `intent:${intentId}; cex:${conn.exchange}; reason:${reason}`);
      results.push({ userId: conn.userId, exchange: conn.exchange, status: "skipped", reason });
      continue;
    }
    const notionalUsd = approvedDecision.notionalUsd * sizeFactor;

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
      notionalUsd: notionalUsd.toFixed(2),
      leverage: approvedDecision.leverage,
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
    let quantity: string | undefined;
    try {
      const creds = await decryptCexCredentials(conn);
      const client = createCexClient(conn.exchange, creds);

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
      await skipJob(job.id, "cex", "sizing_failed", { error: String(e?.message).slice(0, 200) });
      results.push({ userId: conn.userId, exchange: conn.exchange, status: "skipped", reason: `balance_failed:${e?.message}` });
      continue;
    }

    if (!quantity || parseFloat(quantity) <= 0) {
      await skipJob(job.id, "cex", "zero_quantity", { notionalUsd });
      results.push({ userId: conn.userId, exchange: conn.exchange, status: "skipped", reason: "zero_quantity" });
      continue;
    }

    await db.update(executionJobs).set({
      notionalUsd: notionalUsd.toFixed(2), quantity, leverage: approvedDecision.leverage,
      limitPrice: intent.limitPrice ?? null, updatedAt: Date.now(),
    } as any).where(eq(executionJobs.id, job.id));

    // CEX order submission is handled by the VPS execution server.
    // The Worker only risk-approves, sizes, and queues the job.
    // The VPS polls /api/internal/risk-approved-jobs for queued+riskApproved
    // jobs and submits orders from its static-IP machine.
    await writeAuditLog(conn.userId, "EXEC_RISK_APPROVED",
      `intent:${intentId}; cex:${conn.exchange}; job:${job.id}; notional:${notionalUsd.toFixed(2)}; leverage:${approvedDecision.leverage}`);
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
  sizeFactor = 1,
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
    const approvedDecision = requireAuthoritativeRiskDecision(decision);
    if (!approvedDecision) {
      const reason = "reason" in decision ? decision.reason : "non_positive_risk_notional";
      await writeAuditLog(agent.userId, "EXEC_RISK_SKIPPED", `intent:${intentId}; aster; reason:${reason}`);
      results.push({ userId: agent.userId, provider: "aster", status: "skipped", reason });
      continue;
    }
    const notionalUsd = approvedDecision.notionalUsd * sizeFactor;

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
      riskApproved: true,
      notionalUsd: notionalUsd.toFixed(2),
      leverage: approvedDecision.leverage,
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
      notionalUsd: notionalUsd.toFixed(2), quantity, leverage: approvedDecision.leverage,
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
            leverage: approvedDecision.leverage,
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

  // ── Ordered dispatch gate (PRD R1.1 / R1.3) — runs ONCE per intent, before
  //    any per-connection fan-out. Every outcome is persisted with its gate. ──
  const gate = await runDispatchGate(intentId, intent);
  await persistGateInference(intentId, intent, gate);

  if (!gate.decision.approved) {
    const { gateResult, paperOnly, reason } = gate.decision;
    if (gateResult === "ml_unreachable") {
      console.warn(`[dispatch-gate] FAIL-CLOSED intent ${intentId} ${intent.symbol}: ${reason} — no order dispatched`);
    } else {
      console.log(`[dispatch-gate] intent ${intentId} ${intent.symbol} -> ${gateResult}${paperOnly ? " (paper)" : ""}: ${reason}`);
    }
    return { intentId, gate: gateResult, paperOnly, jobs: [] as Array<Record<string, unknown>> };
  }

  const sizeFactor = gate.decision.sizeFactor;
  const connections = await db.select().from(cexConnections)
    .where(eq(cexConnections.status, "active"));

  // A CEX NAV is an execution prerequisite. Refresh per user before risk
  // prefetch so risk sees this cycle's authoritative provider snapshot.
  const cexNavReadiness = await refreshCexNavBeforeAutomatedDispatch(connections);
  const readyConnections = connections.filter((connection) => cexNavReadiness.readyUserIds.has(connection.userId));
  const deniedConnections = connections.filter((connection) => !cexNavReadiness.readyUserIds.has(connection.userId));
  const cexUserIds = [...new Set(readyConnections.map((c) => c.userId))];
  const preloaded = cexUserIds.length > 0 ? await prefetchUserData(cexUserIds) : undefined;

  const navDeniedResults = await Promise.all(deniedConnections.map(async (connection) => {
    const refreshFailure = cexNavReadiness.failures.get(connection.userId) ?? "CEX_NAV_REFRESH_FAILED";
    const reason = `cex_nav_refresh_failed:${refreshFailure}`;
    await writeAuditLog(connection.userId, "EXEC_RISK_SKIPPED", `intent:${intentId}; cex:${connection.exchange}; reason:${reason}`);
    return { userId: connection.userId, exchange: connection.exchange, status: "skipped" as const, reason };
  }));

  // Fan out to CEX and Aster in parallel
  const [cexResults, asterResults] = await Promise.all([
    Promise.allSettled(
      readyConnections.map(async (conn) => {
        const r = await fanOutCex(intent, intentId, [conn], preloaded, sizeFactor);
        return r[0] ?? { userId: conn.userId, exchange: conn.exchange, status: "error" as const };
      }),
    ),
    (async () => {
      try {
        return await fanOutAster(intent, intentId, sizeFactor);
      } catch (e: any) {
        return [{ userId: 0, provider: "aster" as const, status: "error" as const, reason: e?.message }];
      }
    })(),
  ]);

  const allResults = [
    ...navDeniedResults,
    ...cexResults.map((r) => (r.status === "fulfilled" ? r.value : { userId: 0, exchange: "error", status: "error" as const, reason: String(r.reason) })),
    ...asterResults,
  ];

  return { intentId, jobs: allResults };
}
