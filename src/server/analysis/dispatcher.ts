import { getDb, getDbEnv } from "../db";
import { tradeIntents, analysisSignals } from "../../drizzle/schema";
import { eq, desc, and, gte, inArray } from "drizzle-orm";
import type { UnifiedSignal } from "./types";
import { validateStructure } from "../smc/validator";
import { createExecutionJobsForIntent } from "../execution/dispatch";

export interface DispatchResult {
  intentId: number | null;
  jobsCreated: number;
  smcPassed: boolean;
  smcScore: number;
  duplicate?: boolean;
  error?: string;
}

const DEFAULT_STOP_ATR_BUFFER = 0.02; // 2% default stop distance

/**
 * A candidate can be recorded without being made executable. Production is
 * deny-by-default, while testnet requires an explicit opt-in only after the
 * strategy and exchange proof gates have passed.
 */
export function isAutomatedSignalDispatchEnabled(env: {
  APP_ENVIRONMENT?: string;
  AUTOMATED_SIGNAL_DISPATCH_ENABLED?: string;
}): boolean {
  if (env.AUTOMATED_SIGNAL_DISPATCH_ENABLED === "false") return false;
  if (env.APP_ENVIRONMENT === "production") return env.AUTOMATED_SIGNAL_DISPATCH_ENABLED === "true";
  return env.AUTOMATED_SIGNAL_DISPATCH_ENABLED === "true";
}

/**
 * Build an idempotency key from a signal's identifying tuple.
 *
 * Format: `source:symbol:timeframe:direction:candleOpenTime`
 * This prevents the same signal from being dispatched twice.
 */
export function idempotencyKey(signal: UnifiedSignal, candleOpenTime?: number): string {
  const ts = candleOpenTime ?? signal.timestamp;
  return `${signal.source}:${signal.symbol}:${signal.timeframe}:${signal.direction}:${ts}`;
}

/**
 * Dispatch a single UnifiedSignal through the SMC validator and into the execution pipeline.
 *
 * - Checks for existing dispatched signals with the same idempotency key (dedup)
 * - Computes ATR-based stop loss from signal.entry * stopAtrBuffer
 * - Validates signal with SMC structural gates
 * - Creates TradeIntent row (insert -> re-read for auto-generated id)
 * - Fans out to CEX execution jobs via createExecutionJobsForIntent
 * - Records analysis_signals row (dispatched=1 on success, 0 on SMC reject)
 */
export async function dispatchSignal(
  signal: UnifiedSignal,
  stopAtrBuffer: number = DEFAULT_STOP_ATR_BUFFER,
): Promise<DispatchResult> {
  const db = getDb();

  try {
    // --- 0. Idempotency check ---
    const dedupKey = idempotencyKey(signal);
    const [existing] = await db
      .select()
      .from(analysisSignals)
      .where(eq(analysisSignals.externalSignalId, dedupKey))
      .limit(1);

    if (existing && existing.dispatched === 1) {
      return {
        intentId: null,
        jobsCreated: 0,
        smcPassed: false,
        smcScore: 0,
        duplicate: true,
      };
    }

    // If there's a previously rejected signal with the same key, skip
    // (SMC will likely reject again). Allow a stale rejected record older
    // than 7 days in case market conditions changed.
    if (existing && existing.dispatched === 0) {
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (existing.createdAt > Date.now() - sevenDays) {
        return {
          intentId: null,
          jobsCreated: 0,
          smcPassed: false,
          smcScore: 0,
          duplicate: true,
          error: "Previously rejected within 7 days",
        };
      }
    }

    const direction = signal.direction;
    const entry = signal.entry;

    // 1. Compute stop loss and take profit
    // Use the signal's own carefully-computed values if present and positive;
    // fall back to ATR-based formula when the signal does not carry them.
    const stopLoss: number =
      signal.stopLoss > 0
        ? signal.stopLoss
        : direction === "long"
          ? entry * (1 - stopAtrBuffer)
          : entry * (1 + stopAtrBuffer);

    const rrMultiplier = 2; // minimum 1:2 risk-reward
    const takeProfit: number =
      signal.takeProfit > 0
        ? signal.takeProfit
        : direction === "long"
          ? entry * (1 + stopAtrBuffer * rrMultiplier)
          : entry * (1 - stopAtrBuffer * rrMultiplier);

    // 2. Run SMC validation
    const pct24 =
      typeof signal.metadata?.pct24 === "number" ? signal.metadata.pct24 : 0;
    const maxProfit =
      typeof signal.metadata?.maxProfit === "number"
        ? signal.metadata.maxProfit
        : 0;
    // ICR signals use SMC structural detection — different from Coinlegs indicators
    const indicatorName =
      signal.source === "icr"
        ? "smc_structure"
        : typeof signal.metadata?.indicatorName === "string"
          ? signal.metadata.indicatorName
          : "analysis_engine";

    const structuralResult = validateStructure({
      period: signal.timeframe,
      price: entry,
      pct24,
      maxProfit,
      maxProfitDuration:
        signal.timeframe === "4h"
          ? "4 hours"
          : signal.timeframe === "1d"
            ? "1 day"
            : "1 hour",
      indicatorName,
      confluenceCount: 1,
      marketName: signal.symbol,
    });

    const confidence = Math.round((structuralResult.score / 100) * 100) / 100;

    // Common fields shared between success and rejection signal records
    const signalRecord = {
      source: signal.source,
      externalSignalId: dedupKey,
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      direction,
      entry: String(entry),
      stopLoss: String(stopLoss),
      takeProfit: String(takeProfit),
      score: signal.score,
      tier: signal.tier,
      thesis: signal.thesis?.slice(0, 500) ?? null,
      componentsJson: JSON.stringify(signal.components),
      structuralScore: structuralResult.score,
      structuralConfidence: String(confidence),
      metadataJson: JSON.stringify(signal.metadata),
      createdAt: Date.now(),
    };

    // SMC composite score gate: reject below 40 regardless of mandatory pass
    const smcScore = structuralResult.score;
    if (!structuralResult.pass || smcScore < 40) {
      // Record rejected signal for tracking
      await db
        .insert(analysisSignals)
        .values({ ...signalRecord, dispatched: 0 } as any);

      const rejectedGates = Object.values(structuralResult.gates)
        .filter(g => !g.pass)
        .map(g => g.reason);
      const scoreReason =
        smcScore < 40
          ? [`composite_score_below_40:${smcScore}`]
          : [];
      const reasons = [...rejectedGates, ...scoreReason].join(", ");

      // Log Tier A SMC rejections prominently for monitoring
      if (signal.tier === "A") {
        console.warn(
          `[dispatcher] SMC REJECTED Tier A: ${signal.symbol} ${signal.timeframe} ${signal.direction}` +
          ` | ICR:${signal.score} SMC:${smcScore} | ${reasons}`,
        );
      }

      return {
        intentId: null,
        jobsCreated: 0,
        smcPassed: false,
        smcScore,
        error: `SMC rejected: ${reasons}`,
      };
    }

    // Keep all candidate evidence, but do not create an executable intent
    // unless the release operator has explicitly enabled automated dispatch.
    // This prevents testnet research traffic from accumulating as VPS work.
    if (!isAutomatedSignalDispatchEnabled(getDbEnv())) {
      await db.insert(analysisSignals).values({
        ...signalRecord,
        dispatched: 0,
        metadataJson: JSON.stringify({
          ...(signal.metadata ?? {}),
          executionSuppressed: true,
          suppressionReason: "automated_signal_dispatch_disabled",
        }),
      } as any).onConflictDoNothing();
      return {
        intentId: null,
        jobsCreated: 0,
        smcPassed: true,
        smcScore,
        error: "Automated signal dispatch is disabled.",
      };
    }

    // 3. Create TradeIntent
    const side = direction === "long" ? "buy" : "sell";

    const [intent] = await db
      .insert(tradeIntents)
      .values({
        source: signal.source,
        externalSignalId: dedupKey,
        symbol: signal.symbol,
        side,
        orderType: "market",
        limitPrice: String(entry),
        stopLossPrice: String(stopLoss),
        takeProfitPrice: String(takeProfit),
        thesis: signal.thesis?.slice(0, 1000) ?? null,
        status: "created",
        createdBy: "analysis-engine",
        sourceSignal: signal.source,
      } as any)
      .returning();

    if (!intent) {
      throw new Error("Failed to create trade intent");
    }

    // 4. Fan out to CEX execution jobs
    let jobsCreated = 0;
    try {
      const execResult = await createExecutionJobsForIntent(intent.id);
      // Only count jobs that actually progressed past staging/skipping.
      jobsCreated = execResult.jobs.filter(j => j.status !== "skipped").length;
    } catch (e: any) {
      console.warn("[dispatcher] createExecutionJobsForIntent:", e?.message);
    }

    // Do not leave an unowned intent in the VPS polling queue. It is still
    // useful audit history, but it must not be treated as executable work or
    // recreated on every five-minute analysis cycle.
    if (jobsCreated === 0) {
      await db.update(tradeIntents).set({
        status: "unassigned",
        updatedAt: Date.now(),
      } as any).where(eq(tradeIntents.id, intent.id));
    }

    // 5. Record dispatched analysis signal ONLY when at least one job was created.
    //    If fan-out produced zero executable jobs (all skipped/staged/errored), don't
    //    mark the signal as dispatched — it can be retried on the next cron cycle.
    if (jobsCreated > 0) {
    try {
      await db
        .insert(analysisSignals)
        .values({
          ...signalRecord,
          dispatched: 1,
          dispatchedAt: Date.now(),
        } as any);
    } catch (e: any) {
      // Unique constraint violation = already exists (race). Tolerate.
      if (!e?.message?.includes("UNIQUE")) {
        throw e;
      }
    }
    }

    return {
      intentId: intent.id,
      jobsCreated,
      smcPassed: true,
      smcScore: structuralResult.score,
    };
  } catch (e: any) {
    return {
      intentId: null,
      jobsCreated: 0,
      smcPassed: false,
      smcScore: 0,
      error: e?.message ?? String(e),
    };
  }
}

/**
 * Dispatch multiple signals, handling them sequentially per-symbol to avoid races.
 * Score-filtered: only dispatches Tier A signals with score >= 60.
 *
 * Returns aggregate counts and per-signal results.
 */
export async function dispatchSignalsBatch(
  signals: UnifiedSignal[],
): Promise<{
  results: DispatchResult[];
  dispatched: number;
  rejected: number;
  errors: number;
  duplicates: number;
}> {
  // Score-filter: allow Tier A, B, or C with minimum score for initial pipeline priming.
  // Tighten to Tier A only after at least 100 dispatched signals in production.
  const qualifies = (s: UnifiedSignal) =>
    (typeof s.score === "number" && s.score >= 55);
  const candidates = signals.filter(qualifies);
  candidates.sort((a, b) => b.score - a.score);

  const results: DispatchResult[] = [];
  let dispatched = 0;
  let rejected = 0;
  let errors = 0;
  let duplicates = 0;

  // Group by symbol and process sequentially per symbol to avoid races
  const bySymbol = new Map<string, UnifiedSignal[]>();
  for (const s of candidates) {
    const group = bySymbol.get(s.symbol) ?? [];
    group.push(s);
    bySymbol.set(s.symbol, group);
  }

  for (const symSignals of bySymbol.values()) {
    for (const signal of symSignals) {
      try {
        const r = await dispatchSignal(signal);
        results.push(r);
        if (r.duplicate) {
          duplicates++;
        } else if (r.intentId !== null && r.jobsCreated > 0) {
          dispatched++;
        } else if (
          r.smcPassed === false &&
          r.error?.includes("SMC")
        ) {
          rejected++;
        } else {
          errors++;
        }
      } catch (e: any) {
        results.push({
          intentId: null,
          jobsCreated: 0,
          smcPassed: false,
          smcScore: 0,
          error: e?.message ?? String(e),
        });
        errors++;
      }
    }
  }

  return { results, dispatched, rejected, errors, duplicates };
}

/**
 * Query the database for signals that have already been dispatched
 * in recent runs, matching the given signal keys.
 *
 * Used by the engine to filter out duplicates before dispatching.
 */
export async function findExistingSignalKeys(
  keys: string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();

  const db = getDb();

  try {
    // Query for any matching externalSignalIds that have been dispatched
    const recent = Date.now() - 7 * 24 * 60 * 60 * 1000; // last 7 days
    const [rows, intentRows] = await Promise.all([
      db
      .select({ externalSignalId: analysisSignals.externalSignalId })
      .from(analysisSignals)
      .where(
        and(
          gte(analysisSignals.createdAt, recent),
          eq(analysisSignals.dispatched, 1),
        ),
      ),
      // An intent can be intentionally unassigned when no user is connected.
      // It still needs idempotency so the same closed candle is not recreated.
      db.select({ externalSignalId: tradeIntents.externalSignalId })
        .from(tradeIntents)
        .where(inArray(tradeIntents.externalSignalId, keys)),
    ]);

    const existingIds = new Set(
      rows
        .filter((r) => r.externalSignalId !== null)
        .map((r) => r.externalSignalId!),
    );
    for (const row of intentRows) {
      if (row.externalSignalId) existingIds.add(row.externalSignalId);
    }

    // Intersect with our keys
    const result = new Set<string>();
    for (const key of keys) {
      if (existingIds.has(key)) {
        result.add(key);
      }
    }

    return result;
  } catch {
    return new Set();
  }
}
