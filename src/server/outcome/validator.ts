import { eq, and, lte, sql } from "drizzle-orm";
import { coinlegsSignals } from "../../drizzle/schema";

interface Kline {
  openTime: number; open: number; high: number; low: number; close: number;
  volume: number; closeTime: number;
}

interface KlineRequest {
  symbol: string;
  interval: string;
  startTime: number;
  endTime: number;
}

interface ParsedPeriod {
  interval: string;
  durationMs: number;
}

function parseKline(raw: (string | number)[]): Kline {
  return {
    openTime: Number(raw[0]), open: Number(raw[1]), high: Number(raw[2]),
    low: Number(raw[3]), close: Number(raw[4]), volume: Number(raw[5]),
    closeTime: Number(raw[6]),
  };
}

function parseDurationMs(raw: unknown): number {
  if (typeof raw !== "string") throw new Error("invalid duration");
  const match = raw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(m(?:in(?:ute)?s?)?|h(?:r|our)?s?|d(?:ay)?s?)$/i);
  if (!match) throw new Error("invalid duration");
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("d") ? 24 * 60 * 60 * 1000
    : unit.startsWith("h") ? 60 * 60 * 1000 : 60 * 1000;
  const durationMs = value * multiplier;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isSafeInteger(durationMs)) {
    throw new Error("invalid duration");
  }
  return durationMs;
}

function periodToInterval(period: unknown): ParsedPeriod {
  if (typeof period !== "string") throw new Error("unsupported period");
  const p = period.trim().toLowerCase();
  switch (p) {
    case "1m": return { interval: "1m", durationMs: 60_000 };
    case "5m": return { interval: "5m", durationMs: 5 * 60_000 };
    case "15m": return { interval: "15m", durationMs: 15 * 60_000 };
    case "30m": return { interval: "30m", durationMs: 30 * 60_000 };
    case "1h": return { interval: "1h", durationMs: 60 * 60_000 };
    case "4h": return { interval: "4h", durationMs: 4 * 60 * 60_000 };
    case "1d": return { interval: "1d", durationMs: 24 * 60 * 60_000 };
    case "1w": return { interval: "1w", durationMs: 7 * 24 * 60 * 60_000 };
    default: throw new Error("unsupported period");
  }
}

function supportsBinanceProvenance(exchg: unknown): boolean {
  return String(exchg ?? "").trim().toLowerCase() === "binance";
}

function parseFiniteNonnegative(raw: unknown, label: string): number {
  if ((typeof raw !== "string" && typeof raw !== "number") ||
      (typeof raw === "string" && raw.trim() === "")) {
    throw new Error(`invalid ${label}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${label}`);
  return value;
}

function parsePositiveNumber(raw: unknown, label: string): number {
  const value = parseFiniteNonnegative(raw, label);
  if (value <= 0) throw new Error(`invalid ${label}`);
  return value;
}

function parsePositiveTimestamp(raw: unknown): number {
  const value = parsePositiveNumber(raw, "signal timestamp");
  if (!Number.isInteger(value)) throw new Error("invalid signal timestamp");
  return value;
}

function normalizeKline(raw: Kline): Kline {
  return {
    openTime: Number(raw?.openTime),
    open: Number(raw?.open),
    high: Number(raw?.high),
    low: Number(raw?.low),
    close: Number(raw?.close),
    volume: Number(raw?.volume),
    closeTime: Number(raw?.closeTime),
  };
}

function validateKline(kline: Kline): void {
  const finite = [kline.openTime, kline.open, kline.high, kline.low,
    kline.close, kline.volume, kline.closeTime].every(Number.isFinite);
  if (!finite || !Number.isInteger(kline.openTime) || !Number.isInteger(kline.closeTime) ||
      kline.openTime <= 0 || kline.closeTime <= 0 || kline.closeTime < kline.openTime ||
      kline.open <= 0 || kline.high <= 0 || kline.low <= 0 || kline.close <= 0 ||
      kline.volume < 0 || kline.low > kline.high) {
    throw new Error("invalid candle");
  }
}

function exactWindowKlines(
  rawKlines: Kline[], startTime: number, endTime: number, intervalMs: number,
): Kline[] {
  const klines = rawKlines.map(normalizeKline);
  for (const kline of klines) validateKline(kline);

  const exact: Kline[] = [];
  const seenOpenTimes = new Set<number>();
  for (const kline of klines) {
    const overlapsWindow = kline.openTime < endTime && kline.closeTime >= startTime;
    if (overlapsWindow && (kline.openTime < startTime || kline.closeTime >= endTime)) {
      throw new Error("boundary-crossing candle");
    }
    if (!overlapsWindow) continue;
    if (kline.closeTime - kline.openTime + 1 !== intervalMs) {
      throw new Error("invalid candle interval");
    }
    if (seenOpenTimes.has(kline.openTime)) {
      throw new Error("duplicate or overlapping candle data");
    }
    seenOpenTimes.add(kline.openTime);
    exact.push(kline);
  }

  exact.sort((a, b) => a.openTime - b.openTime);
  if (exact.length === 0 || exact[0].openTime !== startTime ||
      exact[exact.length - 1].closeTime !== endTime - 1) {
    throw new Error("incomplete candle coverage");
  }
  for (let index = 1; index < exact.length; index++) {
    const previous = exact[index - 1];
    const current = exact[index];
    if (current.openTime <= previous.closeTime) {
      throw new Error("duplicate or overlapping candle data");
    }
    if (current.openTime !== previous.closeTime + 1) {
      throw new Error("incomplete candle coverage");
    }
  }
  return exact;
}

async function fetchKlines(request: KlineRequest): Promise<Kline[]> {
  const cleanSymbol = request.symbol.replace("/", "").toUpperCase();
  const url = `https://api.binance.com/api/v3/klines?symbol=${cleanSymbol}&interval=${request.interval}&startTime=${request.startTime}&endTime=${request.endTime}&limit=1000`;
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

async function fetchExactWindowKlines(
  loadKlines: (request: KlineRequest) => Promise<Kline[]>,
  request: KlineRequest,
): Promise<Kline[]> {
  const klines: Kline[] = [];
  let pageStart = request.startTime;

  while (pageStart <= request.endTime) {
    const page = await loadKlines({ ...request, startTime: pageStart });
    if (page.length === 0) break;
    klines.push(...page);
    const latestCloseTime = Math.max(...page.map(kline => Number(kline?.closeTime)));
    if (!Number.isFinite(latestCloseTime) || latestCloseTime < pageStart ||
        page.length < 1000 || latestCloseTime >= request.endTime) break;
    const nextPageStart = latestCloseTime + 1;
    if (!Number.isSafeInteger(nextPageStart) || nextPageStart <= pageStart) break;
    pageStart = nextPageStart;
  }

  return klines;
}

export interface OutcomeValidationSummary {
  status: "success" | "error" | "partial";
  signalsValidated: number; avgActualProfit: number; avgClaimedProfit: number;
  accuracyPct: number; warnings: number; errors: number;
  errorMessages: string[]; durationMs: number;
}

export interface OutcomeValidatorDependencies {
  db?: any;
  fetchKlines?: (request: KlineRequest) => Promise<Kline[]>;
}

export async function validateSignalOutcomes(deps: OutcomeValidatorDependencies = {}): Promise<OutcomeValidationSummary> {
  const db = deps.db ?? (await import("../db")).getDb();
  const loadKlines = deps.fetchKlines ?? fetchKlines;
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
      if (!supportsBinanceProvenance(signal.exchg)) {
        errors.push(`${signal.marketName}: unsupported provenance: ${signal.exchg}`);
        continue;
      }
      const claimedProfit = parseFiniteNonnegative(signal.maxProfit, "claimed profit");
      const signalTs = parsePositiveTimestamp(signal.signalDate);
      const entryPrice = parsePositiveNumber(signal.price, "recorded entry price");
      const durationMs = parseDurationMs(signal.maxProfitDuration);
      const period = periodToInterval(signal.period);
      if (durationMs % period.durationMs !== 0) throw new Error("duration is not aligned to period");
      const windowEnd = signalTs + durationMs;
      if (!Number.isSafeInteger(windowEnd) || windowEnd <= signalTs) throw new Error("invalid outcome window");
      const klines = await fetchExactWindowKlines(loadKlines, {
        symbol: signal.marketName, interval: period.interval, startTime: signalTs,
        endTime: windowEnd - 1,
      });
      if (klines.length === 0) { errors.push(`${signal.marketName}: no klines`); continue; }
      const windowKlines = exactWindowKlines(klines, signalTs, windowEnd, period.durationMs);
      let maxHigh = entryPrice, minLow = entryPrice;
      for (const k of windowKlines) {
        if (k.high > maxHigh) maxHigh = k.high;
        if (k.low < minLow) minLow = k.low;
      }
      const actualMaxProfitPct = ((maxHigh - entryPrice) / entryPrice) * 100;
      const actualDrawdownPct = ((entryPrice - minLow) / entryPrice) * 100;
      if (!Number.isFinite(actualMaxProfitPct) || !Number.isFinite(actualDrawdownPct)) {
        throw new Error("invalid calculated outcome");
      }
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
  const db = (await import("../db")).getDb();
  const ts = await db.select({ v: sql<number>`count(*)` }).from(coinlegsSignals).where(eq(coinlegsSignals.signal, 1)).then(r => Number(r[0].v));
  const vc = await db.select({ v: sql<number>`count(*)` }).from(coinlegsSignals).where(and(eq(coinlegsSignals.signal, 1), eq(coinlegsSignals.outcomeValidated, 1))).then(r => Number(r[0].v));
  const wc = await db.select({ v: sql<number>`count(*)` }).from(coinlegsSignals).where(and(eq(coinlegsSignals.signal, 1), eq(coinlegsSignals.outcomeWarning, 1))).then(r => Number(r[0].v));
  return { totalSignals: ts, validatedCount: vc, validatedPct: ts > 0 ? +(vc / ts * 100).toFixed(2) : 0,
    avgActualProfit: 0, avgClaimedProfit: 0, accuracyPct: 100,
    warningCount: wc, warningPct: vc > 0 ? +(wc / vc * 100).toFixed(2) : 0 };
}
