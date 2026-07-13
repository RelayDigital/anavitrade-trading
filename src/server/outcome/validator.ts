import { eq, and, lte, sql } from "drizzle-orm";
import { coinlegsSignals } from "../../drizzle/schema";
import { getDb } from "../db";

interface Kline {
  openTime: number; open: number; high: number; low: number; close: number;
  volume: number; closeTime: number;
}

function parseKline(raw: (string | number)[]): Kline {
  return {
    openTime: Number(raw[0]), open: Number(raw[1]), high: Number(raw[2]),
    low: Number(raw[3]), close: Number(raw[4]), volume: Number(raw[5]),
    closeTime: Number(raw[6]),
  };
}

function durMs(d: string | null | undefined): number {
  if (!d) return 24 * 60 * 60 * 1000;
  const s = d.toLowerCase().trim();
  const v = parseFloat(s.split(/\s+/)[0]);
  if (isNaN(v)) return 24 * 60 * 60 * 1000;
  if (s.includes("day")) return v * 24 * 60 * 60 * 1000;
  if (s.includes("hour") || s.includes("hr")) return v * 60 * 60 * 1000;
  if (s.includes("min")) return v * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function periodToInterval(period: string): string {
  const p = period.toLowerCase().trim();
  switch (p) { case "5m": return "5m"; case "15m": return "15m";
    case "30m": return "30m"; case "1h": return "1h"; case "4h": return "4h";
    case "1d": return "1d"; case "1w": return "1w"; default: return "1h"; }
}

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
  const cleanSymbol = symbol.replace("/", "").toUpperCase();
  const url = `https://api.binance.com/api/v3/klines?symbol=${cleanSymbol}&interval=${interval}&limit=${limit}`;
  const headers: Record<string, string> = {};
  try {
    const { getEnv } = await import("../_core/env");
    const key = getEnv().BINANCE_API_KEY;
    if (key) headers["X-MBX-APIKEY"] = key;
  } catch { /* env not available */ }
  const res = await fetch(url, { headers });
  if (res.status === 451) return [];
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const data = await res.json() as (string | number)[][];
  if (!Array.isArray(data)) return [];
  return data.map(parseKline);
}

export interface OutcomeValidationSummary {
  status: "success" | "error" | "partial";
  signalsValidated: number; avgActualProfit: number; avgClaimedProfit: number;
  accuracyPct: number; warnings: number; errors: number;
  errorMessages: string[]; durationMs: number;
}

export async function validateSignalOutcomes(): Promise<OutcomeValidationSummary> {
  const db = getDb();
  const startedAt = Date.now();
  const errors: string[] = [];
  let signalsValidated = 0, warnings = 0;
  let totalActualProfit = 0, totalClaimedProfit = 0, accuracySum = 0;

  const cutoff = Date.now() - 60 * 60 * 1000;
  const pending = await db.select().from(coinlegsSignals).where(
    and(eq(coinlegsSignals.outcomeValidated, 0), eq(coinlegsSignals.signal, 1),
        lte(coinlegsSignals.scrapedAt, cutoff as any))
  ).limit(50).all();

  if (pending.length === 0) return { status: "success", signalsValidated: 0,
    avgActualProfit: 0, avgClaimedProfit: 0, accuracyPct: 100, warnings: 0,
    errors: 0, errorMessages: [], durationMs: Date.now() - startedAt };

  for (const signal of pending) {
    try {
      const claimedProfit = parseFloat(signal.maxProfit ?? "0");
      const durationMs = durMs(signal.maxProfitDuration);
      const interval = periodToInterval(signal.period);
      const klines = await fetchKlines(signal.marketName, interval, 50);
      if (klines.length === 0) { errors.push(`${signal.marketName}: no klines`); continue; }

      const signalTs = Number(signal.signalDate);
      const windowEnd = signalTs + durationMs;
      let entryCandle = klines[0], minDist = Infinity;
      for (const k of klines) {
        const d = Math.abs(k.openTime - signalTs);
        if (d < minDist) { minDist = d; entryCandle = k; }
      }
      const entryPrice = entryCandle.close;
      let maxHigh = entryPrice, minLow = entryPrice;
      for (const k of klines) {
        if ((k.openTime >= signalTs && k.openTime <= windowEnd) ||
            (k.closeTime >= signalTs && k.openTime <= windowEnd)) {
          if (k.high > maxHigh) maxHigh = k.high;
          if (k.low < minLow) minLow = k.low;
        }
      }
      const hasData = maxHigh !== entryPrice || minLow !== entryPrice;
      const actualMaxProfitPct = hasData ? ((maxHigh - entryPrice) / entryPrice) * 100 : 0;
      const actualDrawdownPct = hasData ? ((entryPrice - minLow) / entryPrice) * 100 : 0;
      let outcomeWarning = 0;
      if (claimedProfit > 0 && actualMaxProfitPct > 0) {
        if (Math.abs(actualMaxProfitPct - claimedProfit) / claimedProfit > 0.2) { warnings++; outcomeWarning = 1; }
      } else if (claimedProfit > 0 && actualMaxProfitPct <= 0) { warnings++; outcomeWarning = 1; }

      await db.update(coinlegsSignals).set({
        outcomeValidated: 1, actualMaxProfitPct: actualMaxProfitPct.toFixed(4),
        actualDrawdownPct: actualDrawdownPct.toFixed(4), outcomeWarning,
      } as any).where(eq(coinlegsSignals.id, signal.id));

      signalsValidated++;
      totalActualProfit += actualMaxProfitPct;
      totalClaimedProfit += claimedProfit;
      accuracySum += claimedProfit > 0 ? Math.min(actualMaxProfitPct, claimedProfit) / Math.max(actualMaxProfitPct, claimedProfit) : 1;
    } catch (e: any) { errors.push(`${signal.marketName} ${signal.period}: ${e?.message}`); }
  }

  return { status: errors.length > 0 ? "partial" : "success", signalsValidated,
    avgActualProfit: signalsValidated > 0 ? +(totalActualProfit / signalsValidated).toFixed(2) : 0,
    avgClaimedProfit: signalsValidated > 0 ? +(totalClaimedProfit / signalsValidated).toFixed(2) : 0,
    accuracyPct: signalsValidated > 0 ? +(accuracySum / signalsValidated * 100).toFixed(2) : 100,
    warnings, errors: errors.length, errorMessages: errors.slice(0, 10),
    durationMs: Date.now() - startedAt };
}

export interface OutcomeStats {
  totalSignals: number; validatedCount: number; validatedPct: number;
  avgActualProfit: number; avgClaimedProfit: number; accuracyPct: number;
  warningCount: number; warningPct: number;
}

export async function getOutcomeStats(): Promise<OutcomeStats> {
  const db = getDb();
  const ts = await db.select({ v: sql<number>`count(*)` }).from(coinlegsSignals).where(eq(coinlegsSignals.signal, 1)).then(r => Number(r[0].v));
  const vc = await db.select({ v: sql<number>`count(*)` }).from(coinlegsSignals).where(and(eq(coinlegsSignals.signal, 1), eq(coinlegsSignals.outcomeValidated, 1))).then(r => Number(r[0].v));
  const wc = await db.select({ v: sql<number>`count(*)` }).from(coinlegsSignals).where(and(eq(coinlegsSignals.signal, 1), eq(coinlegsSignals.outcomeWarning, 1))).then(r => Number(r[0].v));
  return { totalSignals: ts, validatedCount: vc, validatedPct: ts > 0 ? +(vc / ts * 100).toFixed(2) : 0,
    avgActualProfit: 0, avgClaimedProfit: 0, accuracyPct: 100,
    warningCount: wc, warningPct: vc > 0 ? +(wc / vc * 100).toFixed(2) : 0 };
}
