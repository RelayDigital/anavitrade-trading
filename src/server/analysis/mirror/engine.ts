/**
 * Coinlegs Mirror Engine.
 *
 * Runs the same indicator-based detection locally on Binance klines.
 * Goals:
 *   1. Detect signals at candle close (BEFORE Coinlegs publishes them)
 *   2. Produce signals when Coinlegs is down or rate-limited
 *   3. Compare our detections against actual Coinlegs signals for accuracy
 *   4. Store mirror detections in analysis_signals for comparison tracking
 */

import { getDb } from "../../db";
import { coinlegsSignals, analysisSignals } from "../../../drizzle/schema";
import { gte, and, lte, eq, sql } from "drizzle-orm";
import type { UnifiedSignal } from "../types";
import { dispatchSignal } from "../dispatcher";
import { KlineFetcher } from "../kline-fetcher";
import { getKlines } from "../kline-repository";
import { detectCoinlegsSignals } from "./detector";
import { scoreMirrorDetection } from "./scorer";
import type { CoinlegsDetection } from "./detector";
import type { MirrorScoreResult } from "./scorer";

/* ─── Constants ────────────────────────────────────────────────────────────── */

const COINLEGS_TIMEFRAMES = ["5m", "15m", "30m", "1h", "4h", "1d", "1w"];

/** Minimum candles needed for reliable indicator computation */
const MIN_CANDLES = 100;

/** Mirror signal source identifier for analysis_signals */
const MIRROR_SOURCE = "coinlegs_mirror";

/* ─── Timeframe-to-ms mapping for candle duration ──────────────────────────── */

const CANDLE_DURATION_MS: Record<string, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
};

/* ─── Public types ─────────────────────────────────────────────────────────── */

export interface MirrorRunResult {
  symbol: string;
  timeframe: string;
  timestamp: number;
  detections: CoinlegsDetection[];
  scoredDetections: Array<CoinlegsDetection & { score: MirrorScoreResult }>;
  matchRate?: number;
  leadTimeMs?: number;
  /** Number of detections stored in analysis_signals */
  stored: number;
  /** Error message if kline fetch/processing failed for this symbol+timeframe */
  error?: string;
}

export interface MirrorComparisonResult {
  precision: number;
  recall: number;
  f1: number;
  avgLeadTimeMs: number;
  /** Positive = we detected first, negative = Coinlegs was first */
  medianLeadTimeMs: number;
  ourOnly: CoinlegsDetection[];
  coinlegsOnly: string[];
  matched: Array<{
    ours: CoinlegsDetection;
    theirs: string;
    leadTimeMs: number;
  }>;
}

/* ─── Helpers ──────────────────────────────────────────────────────────────── */

/**
 * Normalize a Coinlegs MarketName (e.g. "BTC/USDT") to a Binance symbol
 * (e.g. "BTCUSDT").  Also handles "BTCUSDT" -> "BTCUSDT" passthrough.
 */
function normalizeSymbol(raw: string): string {
  return raw.replace("/", "").toUpperCase();
}

/**
 * Normalize timeframe strings for comparison. Coinlegs uses lowercase
 * (e.g. "15m") but we also accept uppercase ("15M").
 */
function normalizeTimeframe(tf: string): string {
  return tf.toLowerCase();
}

/**
 * Map Coinlegs indicator display names to our detector typeIds and names.
 */
function mapCoinlegsIndicatorToType(name: string): number | null {
  const n = name.toLowerCase();
  if (n.includes("macd")) return 47;
  if (n.includes("stoch")) return 9;
  if (n.includes("cci")) return 8;
  if (n.includes("ichimoku") || n.includes("ichi")) return 46;
  if (n.includes("trend") || n.includes("reversal")) return 7;
  return null;
}

/**
 * Build a signature key for matching: "symbol|timeframe|typeId"
 */
function signalKey(symbol: string, timeframe: string, typeId: number): string {
  return `${symbol}|${timeframe}|${typeId}`;
}

/**
 * Build an idempotency key for mirror detections stored in analysis_signals.
 * Format: mirror:{symbol}:{timeframe}:{typeId}:{candleTimestamp}
 */
function mirrorIdempotencyKey(
  symbol: string,
  timeframe: string,
  typeId: number,
  candleTimestamp: number,
): string {
  return `mirror:${symbol}:${timeframe}:${typeId}:${candleTimestamp}`;
}

/* ─── Core: run mirror on latest candles ───────────────────────────────────── */

/**
 * Run the mirror on the latest candle for all symbols and timeframes.
 *
 * For each (symbol, timeframe) pair:
 *   1. Fetch latest klines from DB (or Binance if data is stale)
 *   2. Run detection on the latest completed candle
 *   3. Store each detection in analysis_signals with idempotency key
 *   4. Estimate lead time vs expected Coinlegs publication
 *
 * @param symbols  Optional subset of symbols. Defaults to full watchlist.
 * @param timeframes  Optional subset of timeframes. Defaults to all 7.
 */
export async function runMirror(
  symbols?: string[],
  timeframes?: string[],
): Promise<MirrorRunResult[]> {
  const db = getDb();
  const fetcher = new KlineFetcher();
  const watchlist = symbols ?? (await fetcher.getWatchlist());
  const tfs = timeframes ?? COINLEGS_TIMEFRAMES;
  const results: MirrorRunResult[] = [];
  const startedAt = Date.now();

  for (const symbol of watchlist) {
    for (const tf of tfs) {
      try {
        // 1. Attempt to update klines from Binance (non-blocking if offline)
        try {
          await fetcher.updateSymbol(symbol, tf);
        } catch (updateErr: any) {
          // Kline fetch failed — proceed with cached data if available
          console.warn(
            `[mirror-engine] kline update failed for ${symbol} ${tf}:`,
            updateErr?.message,
          );
        }

        // 2. Get klines from DB (cached data)
        const klines = await getKlines(symbol, tf, 200);

        if (klines.length < MIN_CANDLES) {
          results.push({
            symbol,
            timeframe: tf,
            timestamp: startedAt,
            detections: [],
            scoredDetections: [],
            stored: 0,
            error: `Insufficient data: ${klines.length} candles (need ${MIN_CANDLES})`,
          });
          continue;
        }

        // 3. Run detection on the full candle history (detector looks at latest candle)
        const detections = detectCoinlegsSignals(symbol, tf, klines);

        if (detections.length === 0) {
          results.push({
            symbol,
            timeframe: tf,
            timestamp: startedAt,
            detections: [],
            scoredDetections: [],
            stored: 0,
          });
          continue;
        }

        // 4. Score each detection
        const scoredDetections = detections.map((d) => ({
          ...d,
          score: scoreMirrorDetection(d, detections),
        }));

        // 5. Store each detection in analysis_signals with idempotency key
        let stored = 0;
        for (const d of scoredDetections) {
          try {
            const extId = mirrorIdempotencyKey(
              d.symbol,
              d.timeframe,
              d.typeId,
              d.candleTimestamp,
            );
            const score = d.score;

            await db
              .insert(analysisSignals)
              .values({
                source: MIRROR_SOURCE,
                externalSignalId: extId,
                symbol: d.symbol,
                timeframe: d.timeframe,
                direction: "long",
                entry: String(d.price),
                stopLoss: null,
                takeProfit: null,
                score: score.score,
                tier: score.tier,
                thesis: d.thesis?.slice(0, 500) ?? null,
                componentsJson: JSON.stringify(score.components),
                structuralScore: d.confidence,
                structuralConfidence: String(d.confidence / 100),
                metadataJson: JSON.stringify({
                  indicatorName: d.indicatorName,
                  indicatorShortName: d.indicatorShortName,
                  typeId: d.typeId,
                  candleTimestamp: d.candleTimestamp,
                  leadTimeEstimate: estimateLeadTime(d.candleTimestamp, d.timeframe),
                  mirrorVersion: "1.0.0",
                }),
                dispatched: 0, // Mirror never dispatches directly — comparison only
                createdAt: Date.now(),
              } as any)
              .onConflictDoNothing();
            stored++;
          } catch (insertErr: any) {
            // Idempotency key conflict is expected — ignore
            if (!String(insertErr?.message ?? "").includes("UNIQUE")) {
              console.warn(
                `[mirror-engine] failed to store detection for ${d.symbol} ${d.timeframe} ${d.typeId}:`,
                insertErr?.message,
              );
            }
          }
        }

        results.push({
          symbol,
          timeframe: tf,
          timestamp: startedAt,
          detections,
          scoredDetections,
          stored,
        });
      } catch (e: any) {
        console.warn(
          `[mirror-engine] error for ${symbol} ${tf}:`,
          e?.message,
        );
        results.push({
          symbol,
          timeframe: tf,
          timestamp: startedAt,
          detections: [],
          scoredDetections: [],
          stored: 0,
          error: e?.message,
        });
      }
    }
  }

  return results;
}

/* ─── Lead time estimation ─────────────────────────────────────────────────── */

/**
 * Estimate lead time: how many seconds before Coinlegs publishes
 * will our candle-close detection fire?
 *
 * Coinlegs fetches from its own API every 60 seconds. On average,
 * a signal appears 30s after the API has it, and the API typically
 * has it within 1 candle duration after close.
 *
 * Conservative estimate: Coinlegs publishes at candle_close + 1 candle_duration + 30s.
 * Our detection fires at candle_close + processing_time (~5s).
 *
 * So lead time ~= candle_duration + 30s - 5s
 * Positive = we detect first.
 */
function estimateLeadTime(
  candleTimestamp: number,
  timeframe: string,
): number {
  const candleMs = CANDLE_DURATION_MS[timeframe] ?? 3600_000;
  // Our detection fires at candle close (timestamp) + small processing delay
  // Coinlegs publishes at candle close + 1 candle duration + 30s API latency
  const coinlegsPublishDelay = candleMs + 30_000;
  const ourProcessingDelay = 5_000;
  return (coinlegsPublishDelay - ourProcessingDelay) / 1000; // seconds
}

/* ─── Comparison with Coinlegs ─────────────────────────────────────────────── */

/**
 * Compare mirror detections against actual Coinlegs signals.
 *
 * Matching rules:
 *   1. Same symbol (normalized)
 *   2. Same timeframe (normalized)
 *   3. Same indicator type (by Coinlegs DetectionId mapping)
 *   4. Coinlegs signalDate is within ±1 candle duration of our detection
 *   5. If multiple Coinlegs signals match, pick the closest in time
 *
 * Lead time = ourDetection.timestamp - coinlegsSignalDate
 *   Positive = we detected first (mirror is leading)
 *   Negative = Coinlegs detected first (mirror is lagging)
 *
 * @param since  Only compare signals fresher than this timestamp (ms).
 *               Default: last 2 hours.
 */
export async function compareWithCoinlegs(
  since?: number,
): Promise<MirrorComparisonResult> {
  const db = getDb();
  const cutoff = since ?? Date.now() - 2 * 60 * 60 * 1000; // default 2h

  // 1. Fetch mirror detections from analysis_signals
  const mirrorRows = await db
    .select()
    .from(analysisSignals)
    .where(
      and(
        eq(analysisSignals.source, MIRROR_SOURCE),
        gte(analysisSignals.createdAt, cutoff),
      ),
    )
    .all();

  // Parse mirror detections from analysis_signals rows
  interface MirrorRecord {
    symbol: string;
    timeframe: string;
    typeId: number;
    indicatorName: string;
    indicatorShortName: string;
    price: number;
    candleTimestamp: number;
    confidence: number;
    thesis: string;
    tier: string;
    key: string;
  }

  const mirrorRecords: MirrorRecord[] = [];
  for (const row of mirrorRows) {
    try {
      const meta = row.metadataJson ? JSON.parse(row.metadataJson as string) : {};
      const typeId = meta.typeId as number | undefined;
      if (!typeId) continue;

      const sym = normalizeSymbol(row.symbol);
      const tf = normalizeTimeframe(row.timeframe);
      const key = signalKey(sym, tf, typeId);

      mirrorRecords.push({
        symbol: sym,
        timeframe: tf,
        typeId,
        indicatorName: (meta.indicatorName as string) ?? "Unknown",
        indicatorShortName: (meta.indicatorShortName as string) ?? "Unknown",
        price: parseFloat(row.entry ?? "0"),
        candleTimestamp: (meta.candleTimestamp as number) ?? row.createdAt,
        confidence: row.structuralScore ?? 50,
        thesis: row.thesis ?? "",
        tier: row.tier ?? "C",
        key,
      });
    } catch {
      // Skip unparseable rows
    }
  }

  // Build a lookup of the earliest mirror detection per key
  const mirrorByKey = new Map<string, MirrorRecord>();
  for (const rec of mirrorRecords) {
    const existing = mirrorByKey.get(rec.key);
    if (!existing || rec.candleTimestamp < existing.candleTimestamp) {
      mirrorByKey.set(rec.key, rec);
    }
  }

  // 2. Fetch Coinlegs signals from the same window
  const cutoffDate = cutoff;
  const clRows = await db
    .select()
    .from(coinlegsSignals)
    .where(
      and(
        gte(coinlegsSignals.signalDate, cutoffDate),
        sql`${coinlegsSignals.signal} = 1`,
      ),
    )
    .all();

  // Build Coinlegs signal records with key and signalDate
  interface CoinlegsRecord {
    key: string;
    timestamp: number;
    marketName: string;
    period: string;
    indicatorName: string;
    typeId: number;
    signalDate: number;
  }

  const coinlegsRecords: CoinlegsRecord[] = [];
  for (const row of clRows) {
    const sym = normalizeSymbol(row.marketName ?? "");
    const tf = normalizeTimeframe(row.period ?? "");
    const typeId = mapCoinlegsIndicatorToType(row.indicatorName ?? "");
    if (!sym || !tf || typeId === null) continue;

    const signalDateMs = Number(row.signalDate) || Date.now();

    coinlegsRecords.push({
      key: signalKey(sym, tf, typeId),
      timestamp: signalDateMs,
      marketName: row.marketName ?? "",
      period: row.period ?? "",
      indicatorName: row.indicatorName ?? "",
      typeId,
      signalDate: signalDateMs,
    });
  }

  // Build the earliest Coinlegs signal per key
  const coinlegsByKey = new Map<string, CoinlegsRecord>();
  for (const rec of coinlegsRecords) {
    const existing = coinlegsByKey.get(rec.key);
    if (!existing || rec.signalDate < existing.signalDate) {
      coinlegsByKey.set(rec.key, rec);
    }
  }

  // 3. Match with ±1 candle tolerance
  const matched: MirrorComparisonResult["matched"] = [];
  const ourOnly: CoinlegsDetection[] = [];
  const coinlegsOnly: string[] = [];

  const usedCoinlegsKeys = new Set<string>();

  for (const [key, mirrorRec] of mirrorByKey) {
    const clRec = coinlegsByKey.get(key);

    if (clRec) {
      // Check if within ±1 candle duration tolerance
      const candleMs = CANDLE_DURATION_MS[mirrorRec.timeframe] ?? 3600_000;
      const timeDiff = Math.abs(mirrorRec.candleTimestamp - clRec.signalDate);

      if (timeDiff <= candleMs * 1.5) {
        // Within tolerance — matched
        const leadTimeMs = clRec.signalDate - mirrorRec.candleTimestamp;
        matched.push({
          ours: {
            symbol: mirrorRec.symbol,
            timeframe: mirrorRec.timeframe,
            indicatorName: mirrorRec.indicatorName,
            indicatorShortName: mirrorRec.indicatorShortName,
            typeId: mirrorRec.typeId,
            price: mirrorRec.price,
            candleTimestamp: mirrorRec.candleTimestamp,
            confidence: mirrorRec.confidence,
            thesis: mirrorRec.thesis,
          },
          theirs: `${clRec.marketName} ${clRec.period} ${clRec.indicatorName}`,
          leadTimeMs,
        });
        usedCoinlegsKeys.add(key);
      } else {
        // Same key but outside time tolerance — count as our only
        ourOnly.push({
          symbol: mirrorRec.symbol,
          timeframe: mirrorRec.timeframe,
          indicatorName: mirrorRec.indicatorName,
          indicatorShortName: mirrorRec.indicatorShortName,
          typeId: mirrorRec.typeId,
          price: mirrorRec.price,
          candleTimestamp: mirrorRec.candleTimestamp,
          confidence: mirrorRec.confidence,
          thesis: mirrorRec.thesis,
        });
      }
    } else {
      // No Coinlegs signal for this key
      ourOnly.push({
        symbol: mirrorRec.symbol,
        timeframe: mirrorRec.timeframe,
        indicatorName: mirrorRec.indicatorName,
        indicatorShortName: mirrorRec.indicatorShortName,
        typeId: mirrorRec.typeId,
        price: mirrorRec.price,
        candleTimestamp: mirrorRec.candleTimestamp,
        confidence: mirrorRec.confidence,
        thesis: mirrorRec.thesis,
      });
    }
  }

  // Coinlegs signals we missed
  for (const [key, clRec] of coinlegsByKey) {
    if (!usedCoinlegsKeys.has(key)) {
      coinlegsOnly.push(
        `${clRec.marketName} ${clRec.period} ${clRec.indicatorName} (DetectionId ${clRec.typeId})`,
      );
    }
  }

  // 4. Compute aggregate metrics
  const tp = matched.length;
  const fp = ourOnly.length;
  const fn = coinlegsOnly.length;

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;

  const avgLeadTimeMs =
    matched.length > 0
      ? matched.reduce((sum, m) => sum + m.leadTimeMs, 0) / matched.length
      : 0;

  // Median lead time (more robust than mean for outliers)
  const sortedLeadTimes = matched
    .map((m) => m.leadTimeMs)
    .sort((a, b) => a - b);
  const medianLeadTimeMs =
    sortedLeadTimes.length > 0
      ? sortedLeadTimes[Math.floor(sortedLeadTimes.length / 2)]
      : 0;

  return {
    precision,
    recall,
    f1,
    avgLeadTimeMs,
    medianLeadTimeMs,
    ourOnly,
    coinlegsOnly,
    matched,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
 * FALLBACK DISPATCH — mirrors signals to the shared dispatcher when
 * Coinlegs is unreachable. Builds UnifiedSignals from mirror detections
 * and routes them through the same dispatchSignal() the native generator
 * and ICR engine use.
 * ═══════════════════════════════════════════════════════════════════════ */

export async function dispatchMirrorDetections(
  results: MirrorRunResult[],
): Promise<{ dispatched: number; errors: number }> {
  let dispatched = 0;
  let errors = 0;

  for (const result of results) {
    for (const detection of result.scoredDetections) {
      if (detection.score.tier !== "A") continue;

      const signal: UnifiedSignal = {
        source: "mirror_fallback",
        symbol: detection.symbol,
        timeframe: detection.timeframe,
        direction: "long",
        entry: detection.price,
        stopLoss: detection.price * 0.98,
        takeProfit: detection.price * 1.04,
        score: detection.score.score,
        tier: detection.score.tier,
        thesis: `Mirror fallback: ${detection.indicatorName || detection.typeId} on ${detection.symbol} ${detection.timeframe}`,
        components: {},
        structuralScore: 50,
        confidence: 0.5,
        timestamp: detection.candleTimestamp,
        metadata: {
          mirrorTypeId: detection.typeId,
          mirrorConfidence: detection.confidence,
          mirrorThesis: detection.thesis,
          fallback: true,
        },
      };

      try {
        const dispatchResult = await dispatchSignal(signal);
        if (dispatchResult.intentId !== null) {
          dispatched++;
          console.log(`[mirror-fallback] dispatched ${detection.symbol} ${detection.timeframe} (score=${detection.score.score})`);
        }
      } catch (e: any) {
        errors++;
        console.warn(`[mirror-fallback] error dispatching ${detection.symbol}:`, e?.message);
      }
    }
  }

  return { dispatched, errors };
}
