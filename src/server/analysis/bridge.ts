/**
 * Coinlegs Scraper Bridge — bridges Coinlegs signal output into the unified
 * analysis_signals table so the dashboard can query all sources uniformly.
 *
 * Called by the scraper after successful signal insertion + intent dispatch,
 * and also available for one-shot historical backfill.
 */
import { getDb, getRawD1 } from "../db";
import { analysisSignals, coinlegsSignals } from "../../drizzle/schema";
import { eq, inArray, and, desc } from "drizzle-orm";
import type { UnifiedSignal, SignalSource } from "./types";

export interface BridgeConfig {
  /** Minimum tier to bridge from coinlegs to analysis_signals */
  minTier: "A" | "B" | "C";
  /** Whether to bridge historical signals (already dispatched) */
  includeHistorical: boolean;
}

const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  minTier: "B",
  includeHistorical: false,
};

/* ─── Row-to-UnifiedSignal converter ─────────────────────────────────── */

/**
 * Given a coinlegsSignals row, construct a UnifiedSignal suitable for
 * insertion into analysis_signals.
 */
export function coinlegsRowToUnifiedSignal(
  row: typeof coinlegsSignals.$inferSelect,
): UnifiedSignal {
  const price = parseFloat(row.price ?? "0");
  const maxProfitVal = row.maxProfit ? parseFloat(row.maxProfit) : 0;
  const pct24 = row.percentage24 ? parseFloat(row.percentage24) : undefined;

  // ATR-based stop estimate by timeframe (same as scraper)
  const atrEstimate: Record<string, number> = {
    "5m": 0.3, "15m": 0.5, "30m": 0.8,
    "1h": 1.2, "4h": 2.0, "1d": 3.5, "1w": 6.0,
  };
  const stopPct = (atrEstimate[row.period] ?? 2.0) / 100;
  const rrMultiplier = 2;
  const stopLoss = price > 0
    ? price * (1 - stopPct * 1.5)
    : 0;
  const takeProfit = price > 0
    ? price * (1 + stopPct * 1.5 * rrMultiplier)
    : 0;

  const thesis = [
    `Coinlegs ${row.indicatorName}`,
    `on ${row.marketName}`,
    `${row.period}`,
    `(score=${row.qualityScore}, tier=${row.qualityTier})`,
  ].join(" ");

  const components: Record<string, number> = {
    qualityScore: row.qualityScore,
    maxProfit: maxProfitVal,
  };
  if (pct24 !== undefined && !isNaN(pct24)) {
    components.pct24 = pct24;
  }

  return {
    source: "coinlegs" as SignalSource,
    symbol: row.marketName.replace("/", ""),
    timeframe: row.period,
    direction: "long",
    entry: price,
    stopLoss,
    takeProfit,
    score: row.qualityScore,
    tier: (row.qualityTier as "A" | "B" | "C") ?? "C",
    thesis: thesis.slice(0, 500),
    components,
    structuralScore: 50,
    confidence: 0.5,
    timestamp: row.signalDate,
    metadata: {
      signalId: row.signalId,
      indicatorName: row.indicatorName,
      indicatorShortName: row.indicatorShortName,
      exchg: row.exchg,
      market: row.market,
      marketName: row.marketName,
      pct24: pct24 ?? 0,
      maxProfit: maxProfitVal,
      maxProfitDuration: row.maxProfitDuration ?? null,
      outcomeValidated: row.outcomeValidated,
      actualMaxProfitPct: row.actualMaxProfitPct ?? null,
      actualDrawdownPct: row.actualDrawdownPct ?? null,
    },
  };
}

/* ─── Bridge (incremental) ────────────────────────────────────────────── */

/**
 * Bridge recent Coinlegs signals into the analysis_signals table.
 * Called by the scraper after successfully inserting signals + intents.
 * Only bridges Tier A and B signals by default.
 *
 * Uses a SELECT-before-INSERT dedup pattern on externalSignalId because
 * analysis_signals.externalSignalId does not have a UNIQUE constraint
 * (D1/SQLite migration safety).
 */
export async function bridgeCoinlegsSignals(
  coinlegsSignalIds: number[],
  config?: Partial<BridgeConfig>,
): Promise<{ bridged: number; skipped: number; errors: number }> {
  if (coinlegsSignalIds.length === 0) {
    return { bridged: 0, skipped: 0, errors: 0 };
  }

  const cfg = { ...DEFAULT_BRIDGE_CONFIG, ...config };
  const db = getDb();

  try {
    // 1. Look up the coinlegsSignals rows by signalId
    const rows = await db
      .select()
      .from(coinlegsSignals)
      .where(inArray(coinlegsSignals.signalId, coinlegsSignalIds))
      .all();

    if (rows.length === 0) {
      return { bridged: 0, skipped: coinlegsSignalIds.length, errors: 0 };
    }

    // 2. Filter: only minTier and above, only dispatched signals (signal=1)
    const tierOrder: Record<string, number> = { A: 3, B: 2, C: 1 };
    const minTierVal = tierOrder[cfg.minTier] ?? 2;
    const eligible = rows.filter(
      (r) =>
        r.signal === 1 &&
        (tierOrder[r.qualityTier ?? "C"] ?? 0) >= minTierVal,
    );

    if (eligible.length === 0) {
      return { bridged: 0, skipped: rows.length, errors: 0 };
    }

    // 3. Check which externalSignalIds already exist in analysis_signals
    const extIds = eligible.map((r) => String(r.signalId));
    const existingRows = await db
      .select({ externalSignalId: analysisSignals.externalSignalId })
      .from(analysisSignals)
      .where(
        and(
          eq(analysisSignals.source, "coinlegs"),
          inArray(analysisSignals.externalSignalId, extIds),
        ),
      )
      .all();

    const existingIds = new Set(
      (existingRows as Array<{ externalSignalId: string | null }>)
        .map((r) => r.externalSignalId)
        .filter((id): id is string => id !== null),
    );

    // 4. Convert and insert only new signals
    const toInsert = eligible.filter(
      (r) => !existingIds.has(String(r.signalId)),
    );

    if (toInsert.length === 0) {
      return { bridged: 0, skipped: eligible.length, errors: 0 };
    }

    let bridged = 0;
    let errors = 0;
    const BATCH_SIZE = 50;

    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      const values = batch.map((row) => {
        const signal = coinlegsRowToUnifiedSignal(row);
        return {
          source: signal.source,
          externalSignalId: String(row.signalId),
          symbol: signal.symbol,
          timeframe: signal.timeframe,
          direction: signal.direction,
          entry: String(signal.entry),
          stopLoss: signal.stopLoss !== undefined ? String(signal.stopLoss) : null,
          takeProfit: signal.takeProfit !== undefined ? String(signal.takeProfit) : null,
          score: signal.score,
          tier: signal.tier,
          thesis: signal.thesis ?? null,
          componentsJson: JSON.stringify(signal.components),
          structuralScore: signal.structuralScore,
          structuralConfidence: String(signal.confidence),
          metadataJson: JSON.stringify(signal.metadata),
          dispatched: 0,
          createdAt: signal.timestamp,
          updatedAt: signal.timestamp,
        };
      });

      try {
        // Use raw D1 to bypass Drizzle Date serialization
        const rawD1 = getRawD1();
        for (const row of values) {
          const r = row as Record<string, unknown>;
          const cols2 = Object.keys(r);
          const ph = cols2.map(() => "?").join(",");
          await rawD1.prepare(`INSERT OR IGNORE INTO analysis_signals ("${cols2.join('","')}") VALUES (${ph})`).bind(...cols2.map(c => r[c])).run();
        }
        bridged += batch.length;
      } catch (e: any) {
        console.warn("[bridge] batch insert error:", e?.message);
        errors += batch.length;
      }
    }

    const skipped = eligible.length - bridged - errors;
    return { bridged, skipped, errors };
  } catch (e: any) {
    console.error("[bridge] bridgeCoinlegsSignals error:", e?.message);
    return { bridged: 0, skipped: 0, errors: coinlegsSignalIds.length };
  }
}

/* ─── Backfill (one-shot) ─────────────────────────────────────────────── */

/**
 * One-shot backfill: insert all historical Tier A/B coinlegs signals
 * into analysis_signals for unified querying.
 */
export async function backfillCoinlegsToAnalysisSignals(): Promise<{
  inserted: number;
}> {
  const db = getDb();

  try {
    // Fetch all Tier A/B signals from coinlegs_signals
    const allCoinlegs = await db
      .select()
      .from(coinlegsSignals)
      .where(
        and(
          eq(coinlegsSignals.signal, 1),
          inArray(coinlegsSignals.qualityTier, ["A", "B"]),
        ),
      )
      .orderBy(desc(coinlegsSignals.signalDate))
      .all();

    if (allCoinlegs.length === 0) {
      return { inserted: 0 };
    }

    // Dedup: find which externalSignalIds already exist
    const extIds = allCoinlegs.map((r) => String(r.signalId));
    const existingRows = await db
      .select({ externalSignalId: analysisSignals.externalSignalId })
      .from(analysisSignals)
      .where(
        and(
          eq(analysisSignals.source, "coinlegs"),
          inArray(analysisSignals.externalSignalId, extIds),
        ),
      )
      .all();

    const existingIds = new Set(
      (existingRows as Array<{ externalSignalId: string | null }>)
        .map((r) => r.externalSignalId)
        .filter((id): id is string => id !== null),
    );

    const toInsert = allCoinlegs.filter(
      (r) => !existingIds.has(String(r.signalId)),
    );

    let inserted = 0;
    const BATCH_SIZE = 50;

    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      const values = batch.map((row) => {
        const signal = coinlegsRowToUnifiedSignal(row);
        return {
          source: signal.source,
          externalSignalId: String(row.signalId),
          symbol: signal.symbol,
          timeframe: signal.timeframe,
          direction: signal.direction,
          entry: String(signal.entry),
          stopLoss: signal.stopLoss !== undefined ? String(signal.stopLoss) : null,
          takeProfit: signal.takeProfit !== undefined ? String(signal.takeProfit) : null,
          score: signal.score,
          tier: signal.tier,
          thesis: signal.thesis ?? null,
          componentsJson: JSON.stringify(signal.components),
          structuralScore: signal.structuralScore,
          structuralConfidence: String(signal.confidence),
          metadataJson: JSON.stringify(signal.metadata),
          dispatched: 0,
          createdAt: signal.timestamp,
          updatedAt: signal.timestamp,
        };
      });

      const rawD2 = getRawD1();
      for (const row of values) {
        const r = row as Record<string, unknown>;
        const cols2 = Object.keys(r);
        const ph = cols2.map(() => "?").join(",");
        const qcols = cols2.map(c => `"${c}"`).join(",");
        await rawD2.prepare(`INSERT OR IGNORE INTO analysis_signals (${qcols}) VALUES (${ph})`).bind(...cols2.map(c => r[c])).run();
      }
      inserted += batch.length;
    }

    return { inserted };
  } catch (e: any) {
    console.error("[bridge] backfillCoinlegsToAnalysisSignals error:", e?.message);
    return { inserted: 0 };
  }
}
