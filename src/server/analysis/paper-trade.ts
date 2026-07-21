/**
 * Paper trading mode: runs the full analysis pipeline but does NOT dispatch
 * real orders. Instead, logs all signals to the analysis_signals table
 * with dispatched=0 and tracks outcomes over time.
 */

import { getDb } from "../db";
import { analysisSignals, klines } from "../../drizzle/schema";
import { eq, and, gte, lte, asc, like, sql } from "drizzle-orm";
import type { UnifiedSignal, EnrichedCandle } from "./types";
import { DEFAULT_ICR_CONFIG } from "./icr/config";
import { KlineFetcher } from "./kline-fetcher";
import { getKlines } from "./kline-repository";
import { enrichCandles } from "./indicators";
import { findLatestSignals } from "./icr/signals";

/* ─── Types ─────────────────────────────────────────────────────────── */

export interface PaperTradeConfig {
  enabled: boolean;
  /** Only simulate — never create real TradeIntents */
  maxPaperPositions: number;
  /** Minimum score to paper-trade (lower than live threshold to collect data) */
  minPaperScore: number;
  /** Tiers to paper-trade */
  paperTiers: ("A" | "B")[];
  /** Track outcomes for N hours after signal */
  outcomeTrackHours: number;
}

export const DEFAULT_PAPER_CONFIG: PaperTradeConfig = {
  enabled: true,
  maxPaperPositions: 5,
  minPaperScore: 50,  // lower than live 75
  paperTiers: ["A", "B"],
  outcomeTrackHours: 24,
};

/* ─── Helpers ────────────────────────────────────────────────────────── */

type OutcomeCandle = { openTime: number; high: number; low: number; close: number };

export type PaperOutcome = {
  status: "stop" | "target" | "time";
  outcomeR: number;
  grossOutcomeR: number;
  feeR: number;
  candlesObserved: number;
};

/**
 * Simulate a bracket using only candles completed after the signal. When a
 * candle crosses both stop and target, stop wins: this conservative ordering
 * avoids claiming a fill sequence that the OHLC data cannot prove.
 */
export function evaluatePaperOutcome(input: {
  direction: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  candles: OutcomeCandle[];
  roundTripFeeBps?: number;
}): PaperOutcome | null {
  const { entry, stopLoss, takeProfit, candles } = input;
  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(risk) || risk <= 0 ||
      !Number.isFinite(takeProfit) || takeProfit <= 0 || candles.length === 0) return null;
  const isLong = input.direction === "long";
  const targetR = Math.abs(takeProfit - entry) / risk;
  if (!Number.isFinite(targetR) || targetR <= 0) return null;
  const feeR = ((input.roundTripFeeBps ?? 6) / 10_000 * entry) / risk;

  for (const candle of candles) {
    const stopHit = isLong ? candle.low <= stopLoss : candle.high >= stopLoss;
    const targetHit = isLong ? candle.high >= takeProfit : candle.low <= takeProfit;
    if (stopHit) {
      return { status: "stop", grossOutcomeR: -1, feeR, outcomeR: -1 - feeR, candlesObserved: candles.length };
    }
    if (targetHit) {
      return { status: "target", grossOutcomeR: targetR, feeR, outcomeR: targetR - feeR, candlesObserved: candles.length };
    }
  }

  const lastClose = candles[candles.length - 1]!.close;
  const grossOutcomeR = (isLong ? lastClose - entry : entry - lastClose) / risk;
  if (!Number.isFinite(grossOutcomeR)) return null;
  return { status: "time", grossOutcomeR, feeR, outcomeR: grossOutcomeR - feeR, candlesObserved: candles.length };
}

/* ─── Public API ─────────────────────────────────────────────────────── */

/**
 * Run engine in paper-trading mode: generate signals, log them,
 * but DO NOT call dispatchSignal(). Instead, store with dispatched=0
 * and schedule outcome tracking.
 *
 * NOTE: Does NOT dispatch — only records to analysis_signals.
 */
export async function runPaperEngine(
  config: PaperTradeConfig = DEFAULT_PAPER_CONFIG,
): Promise<{
  signalsFound: number;
  qualified: UnifiedSignal[];
  skipped: number;
}> {
  const db = getDb();
  const fetcher = new KlineFetcher();
  const watchlist = await fetcher.getWatchlist();

  const qualified: UnifiedSignal[] = [];
  let signalsFound = 0;
  let skipped = 0;

  for (const symbol of watchlist) {
    try {
      // Fetch + enrich — same pipeline as live engine
      const klines = await getKlines(symbol, "4h", 200);
      if (klines.length < 100) continue;

      const enriched = enrichCandles(klines, DEFAULT_ICR_CONFIG);
      // A paper record represents an actionable, just-closed candle. Scanning
      // the whole history on every cron run would fabricate repeated samples.
      const signals = findLatestSignals(enriched, symbol, "4h", DEFAULT_ICR_CONFIG);
      signalsFound += signals.length;

      for (const sig of signals) {
        if (
          sig.score >= config.minPaperScore &&
          config.paperTiers.includes(sig.tier as "A" | "B")
        ) {
          // Record with dispatched=0 (paper only — no live order)
          try {
            const paperSignalId = `paper:${sig.source}:${sig.symbol}:${sig.timeframe}:${sig.direction}:${sig.timestamp}`;
            await db.insert(analysisSignals).values({
              source: sig.source,
              externalSignalId: paperSignalId,
              symbol: sig.symbol,
              timeframe: sig.timeframe,
              direction: sig.direction,
              entry: String(sig.entry),
              stopLoss: sig.stopLoss !== undefined ? String(sig.stopLoss) : null,
              takeProfit: sig.takeProfit !== undefined ? String(sig.takeProfit) : null,
              score: sig.score,
              tier: sig.tier,
              thesis: sig.thesis?.slice(0, 500) ?? null,
              componentsJson: JSON.stringify(sig.components),
              structuralScore: sig.structuralScore,
              structuralConfidence: String(sig.confidence),
              metadataJson: JSON.stringify({ ...sig.metadata, paperSignalTimestamp: sig.timestamp }),
              dispatched: 0, // PAPER ONLY
              createdAt: Date.now(),
            } as any).onConflictDoNothing();
            const [recorded] = await db.select({ id: analysisSignals.id }).from(analysisSignals)
              .where(eq(analysisSignals.externalSignalId, paperSignalId)).limit(1);
            if (recorded) qualified.push(sig);
          } catch {
            skipped++;
          }
        }
      }
    } catch {
      skipped++;
    }
  }

  return { signalsFound, qualified, skipped };
}

/**
 * Check outcomes of paper-traded signals that have aged enough.
 * Compares signal entry price against actual subsequent Binance klines.
 *
 * Only validates signals older than outcomeTrackHours that haven't been
 * validated yet.
 */
export async function validatePaperOutcomes(
  trackHours: number = 24,
): Promise<{
  validated: number;
  avgOutcome: number;
  winners: number;
  losers: number;
  summary: Record<string, { count: number; avgR: number; winRate: number }>;
}> {
  const db = getDb();
  const cutoff = Date.now() - trackHours * 60 * 60 * 1000;

  // Only evaluate deliberately-recorded paper signals. Never mix in rejected
  // live candidates: their metadata is not an execution record.
  const pending = await db
    .select()
    .from(analysisSignals)
    .where(
      and(
        eq(analysisSignals.dispatched, 0),
        like(analysisSignals.externalSignalId, "paper:%"),
        lte(analysisSignals.createdAt, cutoff),
        sql`${analysisSignals.metadataJson} NOT LIKE '%"paperOutcomeR"%'`,
      ),
    )
    .limit(100)
    .all();

  let validated = 0;
  let totalR = 0;
  let winners = 0;
  let losers = 0;
  const summaryMap: Record<
    string,
    { totalR: number; winnerCount: number; signalCount: number }
  > = {};

  for (const paper of pending) {
    try {
      const entryPrice = parseFloat(paper.entry);
      const stopLoss = parseFloat(paper.stopLoss ?? "");
      const takeProfit = parseFloat(paper.takeProfit ?? "");
      const meta = paper.metadataJson ? JSON.parse(paper.metadataJson as string) : {};
      const enteredAt = Number(meta.paperSignalTimestamp ?? paper.createdAt);
      const rows = await db.select().from(klines).where(and(
        eq(klines.symbol, paper.symbol),
        eq(klines.timeframe, paper.timeframe),
        gte(klines.openTime, enteredAt),
        lte(klines.openTime, paper.createdAt + trackHours * 60 * 60 * 1000),
      )).orderBy(asc(klines.openTime)).limit(500);
      const outcome = evaluatePaperOutcome({
        direction: paper.direction,
        entry: entryPrice,
        stopLoss,
        takeProfit,
        candles: rows.map((row) => ({ openTime: row.openTime, high: Number(row.high), low: Number(row.low), close: Number(row.close) })),
      });
      if (!outcome) continue;

      // Persist outcome in metadata
      meta.paperOutcomeR = outcome.outcomeR;
      meta.paperOutcomeGrossR = outcome.grossOutcomeR;
      meta.paperOutcomeFeeR = outcome.feeR;
      meta.paperOutcomeStatus = outcome.status;
      meta.paperOutcomeCandles = outcome.candlesObserved;
      meta.paperOutcomeValidatedAt = Date.now();

      await db
        .update(analysisSignals)
        .set({
          metadataJson: JSON.stringify(meta),
        } as any)
        .where(eq(analysisSignals.id, paper.id));

      validated++;
      totalR += outcome.outcomeR;
      if (outcome.outcomeR > 0) winners++;
      else losers++;

      const sourceKey = paper.source ?? "unknown";
      if (!summaryMap[sourceKey]) {
        summaryMap[sourceKey] = { totalR: 0, winnerCount: 0, signalCount: 0 };
      }
      summaryMap[sourceKey].totalR += outcome.outcomeR;
      summaryMap[sourceKey].signalCount++;
      if (outcome.outcomeR > 0) summaryMap[sourceKey].winnerCount++;
    } catch {
      // best effort — skip failed validations
    }
  }

  const avgOutcome = validated > 0 ? totalR / validated : 0;

  const summary: Record<string, { count: number; avgR: number; winRate: number }> = {};
  for (const [key, data] of Object.entries(summaryMap)) {
    summary[key] = {
      count: data.signalCount,
      avgR: data.signalCount > 0 ? data.totalR / data.signalCount : 0,
      winRate: data.signalCount > 0 ? data.winnerCount / data.signalCount : 0,
    };
  }

  return { validated, avgOutcome, winners, losers, summary };
}
