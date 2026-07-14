import { eq, and, desc, sql } from "drizzle-orm";
import { getDb, getRawD1 } from "../db";
import { klines } from "../../drizzle/schema";
import type { Kline } from "./types";

function toKline(row: typeof klines.$inferSelect): Kline {
  return { symbol: row.symbol, timeframe: row.timeframe, timestamp: row.openTime,
    open: parseFloat(row.open), high: parseFloat(row.high), low: parseFloat(row.low),
    close: parseFloat(row.close), volume: parseFloat(row.volume) };
}

export async function getKlines(symbol: string, timeframe: string, limit = 200): Promise<Kline[]> {
  const db = getDb();
  const rows = await db.select().from(klines)
    .where(and(eq(klines.symbol, symbol), eq(klines.timeframe, timeframe)))
    .orderBy(desc(klines.openTime)).limit(limit);
  return rows.reverse().map(toKline);
}

export async function upsertKlines(batch: Kline[]): Promise<number> {
  if (batch.length === 0) return 0;
  const rawD1 = getRawD1();
  // Build all INSERT statements
  const stmts = batch.map(k =>
    rawD1.prepare([
      "INSERT OR IGNORE INTO klines",
      "(symbol,timeframe,openTime,open,high,low,close,volume,closeTime,fetchedAt)",
      "VALUES (?,?,?,?,?,?,?,?,?,?)"
    ].join(" ")).bind(
      k.symbol, k.timeframe, k.timestamp,
      String(k.open), String(k.high), String(k.low), String(k.close), String(k.volume),
      k.timestamp, Date.now()
    )
  );
  // D1 batch: 85 rows x 10 cols = 850 vars (under 999 limit)
  try {
    const res = await rawD1.batch(stmts) as any[];
    return res.reduce((sum, r) => sum + (r?.meta?.changes ?? 0), 0);
  } catch { return 0; }
}

export async function getLatestTimestamp(symbol: string, timeframe: string): Promise<number | null> {
  const db = getDb();
  const [row] = await db.select({ maxOpenTime: sql<number>`MAX(${klines.openTime})` })
    .from(klines).where(and(eq(klines.symbol, symbol), eq(klines.timeframe, timeframe)));
  return row?.maxOpenTime ?? null;
}
