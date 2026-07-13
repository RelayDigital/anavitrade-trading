/**
 * Unified outcome analyzer — validates ANY dispatched signal against actual
 * subsequent Binance klines, writing the result into analysisSignals.metadataJson.
 *
 * For each signal:
 *   1. Fetch klines from signal.createdAt to createdAt + trackWindow
 *   2. Walk forward: did price hit stopLoss first? takeProfit first? neither?
 *   3. Compute: outcomeR, outcomePct, win/loss, maxFavorableExcursion
 *   4. Write result into analysisSignals.metadataJson.outcome
 *
 * Handles BOTH long and short signals.
 */

import { eq, and, lte, isNull } from "drizzle-orm";
import { analysisSignals } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { AnalysisSignal } from "../../../drizzle/schema";

/* ─── Types ─────────────────────────────────────────────────────────── */

export interface OutcomeResult {
  outcomeR: number;
  outcomePct: number;
  win: boolean;
  exitReason: "stop" | "tp" | "time";
  maxFavorableR: number;
  maxAdverseR: number;
  hitStopFirst: boolean;
  hitTpFirst: boolean;
  barsHeld: number;
  validatedAt: number;
}

export interface OutcomeSummary {
  validated: number;
  winners: number;
  losers: number;
  avgR: number;
  winRate: number;
  totalSignals: number;
  errors: number;
  bySource: Record<string, { validated: number; winRate: number; avgR: number }>;
}

/* ─── Helpers ───────────────────────────────────────────────────────── */

function periodToInterval(p: string): string {
  const m: Record<string, string> = { "5m":"5m","15m":"15m","30m":"30m","1h":"1h","2h":"1h","4h":"4h","1d":"1d","1w":"1w" };
  return m[p.toLowerCase()] ?? "1h";
}

async function fetchKlines(symbol: string, interval: string, limit: number, startTime?: number): Promise<any[]> {
  const cleanSymbol = symbol.replace("/", "").toUpperCase();
  const params = new URLSearchParams({ symbol: cleanSymbol, interval, limit: String(limit) });
  if (startTime) params.set("startTime", String(startTime));
  const url = `https://api.binance.com/api/v3/klines?${params}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return (await res.json()) as any[];
}

/* ─── Core Validator ────────────────────────────────────────────────── */

export async function validateSingleSignal(
  signal: { id: number; symbol: string; timeframe: string; direction: string; entry: number; stopLoss: number; takeProfit: number; createdAt: number },
  trackHours: number = 48,
): Promise<OutcomeResult | null> {
  const interval = periodToInterval(signal.timeframe);
  const limit = Math.ceil((trackHours * 60 * 60 * 1000) / (msPerCandle(interval) || 3600000));
  const klines = await fetchKlines(signal.symbol, interval, Math.min(limit + 5, 500), signal.createdAt);
  if (klines.length < 3) return null;

  let maxFavorableR = 0;
  let maxAdverseR = 0;
  let hitStopFirst = false;
  let hitTpFirst = false;
  let barsHeld = 0;
  const risk = Math.abs(signal.entry - signal.stopLoss);
  if (risk <= 0) return null;

  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    barsHeld = i + 1;

    if (signal.direction === "long") {
      const favorableR = (high - signal.entry) / risk;
      const adverseR = (signal.entry - low) / risk;
      if (favorableR > maxFavorableR) maxFavorableR = favorableR;
      if (adverseR > maxAdverseR) maxAdverseR = adverseR;

      if (low <= signal.stopLoss && !hitTpFirst) { hitStopFirst = true; break; }
      if (high >= signal.takeProfit && !hitStopFirst) { hitTpFirst = true; break; }
    } else {
      const favorableR = (signal.entry - low) / risk;
      const adverseR = (high - signal.entry) / risk;
      if (favorableR > maxFavorableR) maxFavorableR = favorableR;
      if (adverseR > maxAdverseR) maxAdverseR = adverseR;

      if (high >= signal.stopLoss && !hitTpFirst) { hitStopFirst = true; break; }
      if (low <= signal.takeProfit && !hitStopFirst) { hitTpFirst = true; break; }
    }
  }

  const exitReason: "stop" | "tp" | "time" = hitStopFirst ? "stop" : hitTpFirst ? "tp" : "time";

  let finalR: number;
  if (exitReason === "stop") {
    finalR = -1;
  } else if (exitReason === "tp") {
    finalR = Math.abs(signal.takeProfit - signal.entry) / risk;
  } else {
    // Time exit — use the last close
    const lastClose = parseFloat(klines[klines.length - 1][4]);
    finalR = signal.direction === "long"
      ? (lastClose - signal.entry) / risk
      : (signal.entry - lastClose) / risk;
  }

  // Penalize adverse excursion: if max adverse > 50% of favorable cap, reduce R
  if (finalR > 0 && maxAdverseR > 0.5 * Math.abs(finalR)) {
    finalR = finalR * 0.5;
  }

  return {
    outcomeR: Math.round(finalR * 100) / 100,
    outcomePct: Math.round((risk * finalR / signal.entry) * 10000) / 100,
    win: finalR > 0,
    exitReason,
    maxFavorableR: Math.round(maxFavorableR * 100) / 100,
    maxAdverseR: Math.round(maxAdverseR * 100) / 100,
    hitStopFirst,
    hitTpFirst,
    barsHeld,
    validatedAt: Date.now(),
  };
}

function msPerCandle(interval: string): number {
  const m: Record<string, number> = { "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000, "1w": 604800000 };
  return m[interval] ?? 3600000;
}

/* ─── Batch Validator ───────────────────────────────────────────────── */

export async function validateAllSignalOutcomes(
  batchSize: number = 50,
  trackHours: number = 48,
): Promise<OutcomeSummary> {
  const db = getDb();
  const cutoff = Date.now() - trackHours * 60 * 60 * 1000;

  // Select signals that have not been outcome-validated yet
  const pending = await db.select().from(analysisSignals)
    .where(
      and(
        lte(analysisSignals.createdAt, cutoff),
        isNull(analysisSignals.metadataJson),
      ),
    )
    .limit(batchSize);

  if (pending.length === 0) {
    return { validated: 0, winners: 0, losers: 0, avgR: 0, winRate: 0, totalSignals: 0, errors: 0, bySource: {} };
  }

  let validated = 0, winners = 0, totalR = 0;
  let errors = 0;
  const bySource: Record<string, { validated: number; winRate: number; avgR: number; wins: number; totalR: number }> = {};

  for (const signal of pending) {
    try {
      const entry = parseFloat(signal.entry ?? "0");
      const stopLoss = parseFloat(signal.stopLoss ?? "0");
      const takeProfit = parseFloat(signal.takeProfit ?? "0");
      if (!entry || !stopLoss || !takeProfit) { errors++; continue; }

      // Check if metadataJson already has an outcome
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(signal.metadataJson ?? "{}"); } catch { meta = {}; }
      if (meta.outcome) continue; // already validated

      const result = await validateSingleSignal(
        {
          id: signal.id,
          symbol: signal.symbol,
          timeframe: signal.timeframe,
          direction: signal.direction,
          entry,
          stopLoss,
          takeProfit,
          createdAt: signal.createdAt,
        },
        trackHours,
      );

      if (!result) { errors++; continue; }

      // Write outcome into metadataJson
      meta.outcome = result;
      await db.update(analysisSignals)
        .set({ metadataJson: JSON.stringify(meta) } as any)
        .where(eq(analysisSignals.id, signal.id));

      validated++;
      if (result.win) winners++;
      totalR += result.outcomeR;

      const src = signal.source || "unknown";
      if (!bySource[src]) bySource[src] = { validated: 0, wins: 0, totalR: 0, winRate: 0, avgR: 0 };
      bySource[src].validated++;
      if (result.win) bySource[src].wins++;
      bySource[src].totalR += result.outcomeR;
    } catch {
      errors++;
    }
  }

  // Compute summary stats per source
  for (const [src, d] of Object.entries(bySource)) {
    d.winRate = d.validated > 0 ? Math.round((d.wins / d.validated) * 10000) / 100 : 0;
    d.avgR = d.validated > 0 ? Math.round((d.totalR / d.validated) * 100) / 100 : 0;
  }

  return {
    validated,
    winners,
    losers: validated - winners,
    avgR: validated > 0 ? Math.round((totalR / validated) * 100) / 100 : 0,
    winRate: validated > 0 ? Math.round((winners / validated) * 10000) / 100 : 0,
    totalSignals: pending.length,
    errors,
    bySource,
  };
}
