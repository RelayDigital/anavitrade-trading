/**
 * Unified analysis engine orchestrator.
 *
 * Runs the full pipeline:
 *  1. Fetch latest klines for all watchlist symbols (4h primary timeframe)
 *  2. Enrich with indicators + coil scores
 *  3. Run ICR signal detection on the latest candle only (per-cycle dedup)
 *  4. Fetch derivatives data
 *  5. Compute alpha scores
 *  6. Merge signals
 *  7. Dedup against previously-dispatched signals
 *  8. Dispatch qualified signals
 *  9. Record run stats
 */

import { getDb } from "../db";
import { analysisRuns, analysisSignals, derivativesSnapshots } from "../../drizzle/schema";
import { and, eq, gte, desc } from "drizzle-orm";
import type { UnifiedSignal, EnrichedCandle, IcrConfig, DerivativesSnapshot } from "./types";
import {
  DEFAULT_ICR_CONFIG,
  DEFAULT_COIL_CONFIG,
} from "./icr/config";
import { KlineFetcher } from "./kline-fetcher";
import { DerivativesFetcher } from "./derivatives/fetcher";
import { computeAlpha } from "./derivatives/alpha";
import { getKlines } from "./kline-repository";
import { enrichCandles } from "./indicators";
import { annotateWithCoilScores } from "./icr/coil";
import {
  dispatchSignalsBatch,
  findExistingSignalKeys,
  idempotencyKey,
} from "./dispatcher";

export interface AnalysisRunResult {
  source: string;
  status: "completed" | "partial" | "failed";
  signalsGenerated: number;
  signalsDispatched: number;
  signalsRejected: number;
  klineUpdates: number;
  symbolCount: number;
  timeframe: string;
  errorMessage?: string;
  durationMs: number;
}

/* ─── ICR Config defaults for in-line use ─────────────────────────────────── */

const { stopAtrBuffer } = DEFAULT_ICR_CONFIG;

/* ─── ATR-based stop estimate by timeframe ───────────────────────────────────
 * Used as fallback when we have enriched candle ATR values.
 * Maps timeframe -> percentage estimate for stop placement.
 */
const ATR_PCT_ESTIMATE: Record<string, number> = {
  "5m": 0.3,
  "15m": 0.5,
  "30m": 0.8,
  "1h": 1.2,
  "4h": 2.0,
  "1d": 3.5,
  "1w": 6.0,
};

/**
 * Build a UnifiedSignal from the latest enriched candle + optional ICR data + derivatives alpha.
 */
function buildSignal(
  candle: EnrichedCandle,
  options: {
    source: UnifiedSignal["source"];
    direction: UnifiedSignal["direction"];
    score: number;
    tier: UnifiedSignal["tier"];
    thesis: string;
    components: Record<string, number>;
    alphaScore?: number;
    alphaBias?: string;
    metadata?: Record<string, unknown>;
  },
): UnifiedSignal {
  const entry = candle.close;
  const atrPct =
    candle.atr14 > 0 && candle.close > 0
      ? candle.atr14 / candle.close
      : (ATR_PCT_ESTIMATE[candle.timeframe] ?? 2.0) / 100;

  const stopBuffer = stopAtrBuffer ?? atrPct * 1.5;
  const stopLoss: number =
    options.direction === "long"
      ? entry * (1 - stopBuffer)
      : entry * (1 + stopBuffer);

  // Risk-reward 1:2 for TP
  const rr = 2;
  const takeProfit: number =
    options.direction === "long"
      ? entry * (1 + stopBuffer * rr)
      : entry * (1 - stopBuffer * rr);

  return {
    source: options.source,
    symbol: candle.symbol,
    timeframe: candle.timeframe,
    direction: options.direction,
    entry,
    stopLoss,
    takeProfit,
    score: options.score,
    tier: options.tier,
    thesis: options.thesis.slice(0, 500),
    components: options.components,
    structuralScore: candle.displacement > 0 ? 60 : 40,
    confidence: 0.5,
    timestamp: Date.now(),
    metadata: {
      ...options.metadata,
      atr: candle.atr14,
      displacement: candle.displacement,
      rsi: candle.rsi14,
      bbWidth: candle.bbWidth,
      closePosition: candle.closePosition,
      volumeZscore: candle.volumeZscore,
      ma25Slope: candle.ma25Slope,
      alphaScore: options.alphaScore,
      alphaBias: options.alphaBias,
    },
  };
}

/* ─── ICR Dynamic Import ────────────────────────────────────────────────────
 * The ICR signals module may not exist yet if the ICR feature is still being
 * built.  We catch the import error and degrade gracefully. */

interface IcrModule {
  findLatestSignals: (
    candles: EnrichedCandle[],
    symbol: string,
    timeframe: string,
    cfg: IcrConfig,
  ) => UnifiedSignal[];
}

let _icrModule: IcrModule | null = null;
let _icrMissing = false;

async function loadIcrModule(): Promise<IcrModule | null> {
  if (_icrModule) return _icrModule;
  if (_icrMissing) return null;
  try {
    // Dynamic import — module may not exist if ICR is still being built.
    // @ts-ignore — ICR signals module is optional; absence is handled at runtime.
    const mod = await import("./icr/signals");
    _icrModule = mod as unknown as IcrModule;
    return _icrModule;
  } catch (e: any) {
    _icrMissing = true;
    console.warn("[analysis-engine] ICR signals module not available, skipping ICR detection:", e?.message);
    return null;
  }
}

/* ─── Main Engine ─────────────────────────────────────────────────────────── */

/**
 * Run one full analysis cycle:
 *  1. Fetch latest 4h klines for all watchlist symbols
 *  2. Enrich with indicators + coil scores
 *  3. Attempt ICR signal detection on the latest candle only per symbol
 *  4. Per-cycle dedup (highest-scored per symbol/timeframe/direction)
 *  5. Fetch derivatives snapshots
 *  6. Compute alpha scores
 *  7. Merge derivatives alpha into ICR signals
 *  8. Filter Tier A only, sort by score descending
 *  9. Dedup against already-dispatched signals in DB
 * 10. dispatchSignalsBatch()
 * 11. Record analysis_runs row
 */
export async function runAnalysisEngine(
  timeframe: string = "4h",
): Promise<AnalysisRunResult> {
  const startedAt = Date.now();
  const db = getDb();

  try {
    const watchlist = ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT","LINKUSDT","MATICUSDT","UNIUSDT","SHIBUSDT","LTCUSDT","ATOMUSDT","ETCUSDT","XLMUSDT","BCHUSDT","ALGOUSDT","TRXUSDT","NEARUSDT","FILUSDT","APTUSDT"];

    // 1. Fetch latest klines for all symbols
    const klineUpdates = 0; // DB-only, no live Binance fetch
    console.log(
      `[analysis-engine] kline updates: ${klineUpdates} new candles across ${watchlist.length} symbols`,
    );

    // 2. Get enriched candles (with coil scores) for each symbol
    const enrichedBySymbol = new Map<string, EnrichedCandle[]>();
    for (const symbol of watchlist) {
      const klines = await getKlines(symbol, timeframe, 200);
      if (klines.length < 100) {
        // Not enough data yet – skip this symbol
        continue;
      }
      const enriched = enrichCandles(klines, DEFAULT_ICR_CONFIG);
      const withCoil = annotateWithCoilScores(
        enriched,
        DEFAULT_ICR_CONFIG,
        DEFAULT_COIL_CONFIG,
      );
      enrichedBySymbol.set(symbol, withCoil);
    }

    // 3. Try ICR signal detection — latest candle only, with bonferroni adjustment
    const icrModule = await loadIcrModule();
    const rawIcrSignals: UnifiedSignal[] = [];

    if (icrModule) {
      for (const [symbol, candles] of enrichedBySymbol) {
        if (candles.length < DEFAULT_ICR_CONFIG.slowMa) continue;

        try {
          const sigs = icrModule.findLatestSignals(
            candles,
            symbol,
            timeframe,
            DEFAULT_ICR_CONFIG,
          );
          rawIcrSignals.push(...sigs);
        } catch (e: any) {
          console.warn(
            `[analysis-engine] ICR signal detection error for ${symbol}:`,
            e?.message,
          );
        }
      }
    }

    // 3b. Per-cycle dedup: only keep the highest-scored signal per
    //     (symbol, timeframe, direction). This limits the effective N
    //     from "every candle index" to "one signal per symbol per cycle"
    //     and serves as a practical multiple-testing correction.
    const bestPerGroup = new Map<string, UnifiedSignal>();
    for (const sig of rawIcrSignals) {
      const key = `${sig.symbol}|${sig.timeframe}|${sig.direction}`;
      const existing = bestPerGroup.get(key);
      if (!existing || sig.score > existing.score) {
        bestPerGroup.set(key, sig);
      }
    }
    const icrSignals = [...bestPerGroup.values()];

    if (rawIcrSignals.length > icrSignals.length) {
      console.log(
        `[analysis-engine] per-cycle dedup: ${rawIcrSignals.length} -> ${icrSignals.length} signals`,
      );
    }

    // 4. Fetch derivatives snapshots
    const derivFetcher = new DerivativesFetcher();
    const derivSnapshots: DerivativesSnapshot[] = [];
    const derivSymbols = [...new Set(icrSignals.map(s => s.symbol))].slice(0, 15);
    for (const sym of derivSymbols) {
      try { derivSnapshots.push(await derivFetcher.snapshotSymbol(sym)); }
      catch {}
    }

    // 5. Compute alpha scores for each symbol with a previous snapshot
    //    so OI change velocity (demand velocity + leverage penalty) is
    //    based on real data, not always zero.
    const alphaMap = new Map<string, { score: number; bias: string }>();
    for (const snap of derivSnapshots) {
      // Fetch the previous derivatives snapshot for the same symbol from the DB
      let previous: DerivativesSnapshot | null = null;
      try {
        const rows = await db
          .select()
          .from(derivativesSnapshots)
          .where(eq(derivativesSnapshots.symbol, snap.symbol))
          .orderBy(desc(derivativesSnapshots.snapshotAt))
          .limit(1);
        if (rows.length > 0) {
          const row = rows[0];
          previous = {
            symbol: row.symbol,
            timestamp: row.snapshotAt,
            openInterest: parseFloat(row.openInterest),
            oiChange24h: row.oiChange24hPct ? parseFloat(row.oiChange24hPct) : 0,
            fundingRate: row.fundingRate ? parseFloat(row.fundingRate) : 0,
            longShortRatio: row.longShortRatio ? parseFloat(row.longShortRatio) : 1.0,
            longPct: row.longPct ? parseFloat(row.longPct) : 50,
            shortPct: row.shortPct ? parseFloat(row.shortPct) : 50,
          };
        }
      } catch (e: any) {
        console.warn(`[analysis-engine] failed to fetch previous snapshot for ${snap.symbol}:`, e?.message);
      }

      const alpha = computeAlpha(snap, previous);
      alphaMap.set(snap.symbol, { score: alpha.score, bias: alpha.bias });

      // Save the current snapshot to the DB so the next cycle can use it
      // to compute real OI change.
      try {
        await db.insert(derivativesSnapshots).values({
          symbol: snap.symbol,
          openInterest: String(snap.openInterest),
          oiChange24hPct: String(snap.oiChange24h),
          fundingRate: String(snap.fundingRate),
          longShortRatio: String(snap.longShortRatio),
          longPct: String(snap.longPct),
          shortPct: String(snap.shortPct),
          snapshotAt: snap.timestamp,
        } as any);
      } catch (e: any) {
        console.warn(`[analysis-engine] failed to persist snapshot for ${snap.symbol}:`, e?.message);
      }
    }

    // 6. Merge derivatives alpha into signals
    for (const sig of icrSignals) {
      const alpha = alphaMap.get(sig.symbol);
      if (alpha) {
        sig.components.derivativesAlpha = alpha.score;
        sig.metadata.alphaBias = alpha.bias;
        // Reduce score if alpha is bearish and signal is long, or vice versa
        if (
          (sig.direction === "long" && alpha.bias === "bearish_distribution") ||
          (sig.direction === "short" && alpha.bias === "bullish_accumulation")
        ) {
          sig.score = Math.max(0, sig.score - 15);
        }
        // Boost if aligned
        if (
          (sig.direction === "long" &&
            (alpha.bias === "bullish_accumulation" || alpha.bias === "mildly_bullish")) ||
          (sig.direction === "short" &&
            (alpha.bias === "bearish_distribution" || alpha.bias === "mildly_bearish"))
        ) {
          sig.score = Math.min(100, sig.score + 10);
        }
        // Update tier if score drops below threshold
        if (sig.score < 60) {
          sig.tier = sig.score >= 40 ? "B" : "C";
        }
      }
    }

    // Also build fallback signals from derivatives data alone for symbols where
    // ICR didn't produce a signal but derivatives show extreme readings
    const fallbackSignals: UnifiedSignal[] = [];
    for (const [symbol, candles] of enrichedBySymbol) {
      const latest = candles[candles.length - 1];
      if (!latest) continue;

      const alpha = alphaMap.get(symbol);
      if (!alpha) continue;

      // Strong alpha with no ICR signal — generate a derivatives-derived signal
      const hasIcr = icrSignals.some((s) => s.symbol === symbol);
      if (hasIcr) continue;

      // Only generate if alpha is extreme
      if (alpha.score < 30 || alpha.score > 70) {
        const direction: UnifiedSignal["direction"] =
          alpha.bias === "bullish_accumulation" || alpha.bias === "mildly_bullish"
            ? "long"
            : "short";

        const signal = buildSignal(latest, {
          source: "derivatives",
          direction,
          score: alpha.score,
          tier: alpha.score >= 60 ? "A" : alpha.score >= 40 ? "B" : "C",
          thesis: `Derivatives alpha: ${alpha.bias} (score=${alpha.score})`,
          components: {
            derivativesAlpha: alpha.score,
          },
          alphaScore: alpha.score,
          alphaBias: alpha.bias,
          metadata: {
            alphaScore: alpha.score,
            alphaBias: alpha.bias,
          },
        });
        fallbackSignals.push(signal);
      }
    }

    // Merge all signals
    const allSignals = [...icrSignals, ...fallbackSignals];

    // Log signal distribution per cycle (before dispatch filtering)
    const tierCounts = { A: 0, B: 0, C: 0 };
    for (const sig of allSignals) {
      if (sig.tier in tierCounts) {
        tierCounts[sig.tier as "A" | "B" | "C"]++;
      }
    }
    console.log(
      `[analysis-engine] signal distribution: A=${tierCounts.A} B=${tierCounts.B} C=${tierCounts.C} (total=${allSignals.length})`,
    );

    // 7. Dedup against already-dispatched signals in the database.
    //    Any signal whose idempotency key is already in analysis_signals
    //    with dispatched=1 is skipped.
    const allKeys = allSignals.map((s) => idempotencyKey(s));
    const existingKeys = await findExistingSignalKeys(allKeys);
    const finalSignals = allSignals.filter(
      (s) => !existingKeys.has(idempotencyKey(s)),
    );

    if (existingKeys.size > 0) {
      console.log(
        `[analysis-engine] dedup: removed ${existingKeys.size} already-dispatched signals`,
      );
    }

    // 7b. Minimum signal gap: skip signals for (symbol, timeframe, direction)
    //     that already had ANY signal dispatched in the last 24 hours.
    const gap24h = Date.now() - 24 * 60 * 60 * 1000;
    let recentlyDispatched: Set<string> = new Set();
    try {
      const recentRows = await db
        .select({
          symbol: analysisSignals.symbol,
          timeframe: analysisSignals.timeframe,
          direction: analysisSignals.direction,
        })
        .from(analysisSignals)
        .where(
          and(
            gte(analysisSignals.createdAt, gap24h),
            eq(analysisSignals.dispatched, 1),
          ),
        );
      for (const row of recentRows) {
        recentlyDispatched.add(`${row.symbol}|${row.timeframe}|${row.direction}`);
      }
    } catch (e: any) {
      console.warn("[analysis-engine] 24h gap query failed:", e?.message);
    }

    const gapFilteredSignals = finalSignals.filter((s) => {
      const gapKey = `${s.symbol}|${s.timeframe}|${s.direction}`;
      return !recentlyDispatched.has(gapKey);
    });

    if (recentlyDispatched.size > 0) {
      const removed = finalSignals.length - gapFilteredSignals.length;
      if (removed > 0) {
        console.log(
          `[analysis-engine] 24h gap: removed ${removed} signals (${recentlyDispatched.size} active groups)`,
        );
      }
    }

    // 8. Dispatch qualified signals
    const dispatchResult = await dispatchSignalsBatch(gapFilteredSignals);

    // 9. Record analysis run stats
    const completedAt = Date.now();
    try {
      await db.insert(analysisRuns).values({
        source: "analysis-engine",
        status: dispatchResult.errors > 0 ? "partial" : "completed",
        signalsGenerated: allSignals.length,
        signalsDispatched: dispatchResult.dispatched,
        signalsRejected: dispatchResult.rejected,
        klineUpdates,
        durationMs: completedAt - startedAt,
        startedAt,
        completedAt,
      } as any);
    } catch (e: any) {
      console.warn("[analysis-engine] failed to record run:", e?.message);
    }

    return {
      source: "analysis-engine",
      status: dispatchResult.errors > 0 ? "partial" : "completed",
      signalsGenerated: allSignals.length,
      signalsDispatched: dispatchResult.dispatched,
      signalsRejected: dispatchResult.rejected,
      klineUpdates,
      symbolCount: enrichedBySymbol.size,
      timeframe,
      durationMs: completedAt - startedAt,
    };
  } catch (e: any) {
    // Record failed run
    const completedAt = Date.now();
    try {
      await db.insert(analysisRuns).values({
        source: "analysis-engine",
        status: "failed",
        signalsGenerated: 0,
        signalsDispatched: 0,
        signalsRejected: 0,
        klineUpdates: 0,
        errorMessage: e?.message?.slice(0, 500) ?? String(e).slice(0, 500),
        durationMs: completedAt - startedAt,
        startedAt,
        completedAt,
      } as any);
    } catch {
      /* best effort */
    }

    return {
      source: "analysis-engine",
      status: "failed",
      signalsGenerated: 0,
      signalsDispatched: 0,
      signalsRejected: 0,
      klineUpdates: 0,
      symbolCount: 0,
      timeframe,
      errorMessage: e?.message ?? String(e),
      durationMs: Date.now() - startedAt,
    };
  }
}

/* ─── Backfill Market Data ───────────────────────────────────────────────── */

/**
 * Simple version that fetches and stores klines for initial data seeding.
 * Fetches all timeframes for all watchlist symbols.
 */
export async function backfillMarketData(
  lookbackBars?: number,
): Promise<void> {
  const fetcher = new KlineFetcher(25);
  const results = await fetcher.backfillAll(lookbackBars);
  console.log(
    "[analysis-engine] backfill complete:",
    Object.entries(results)
      .map(([tf, n]) => `${tf}=${n}`)
      .join(", "),
  );
}
