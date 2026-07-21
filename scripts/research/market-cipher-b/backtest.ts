/**
 * Market Cipher B — honest standalone backtest.
 *
 * Pre-registered rules in README.md, unchanged here. Reuses:
 *   - detectMarketCipher (src/server/signals/market-cipher.ts) for entry signals
 *   - enrichCandles (src/server/analysis/indicators.ts) for exit-engine inputs
 *     (atr14/rsi14/bbUpper/bbLower/volumeMa20/volumeZscore/bodyRatio) — a
 *     generic indicator step, not ICR trading logic; DEFAULT_ICR_CONFIG here
 *     only supplies indicator *parameters* (lengths), never gate logic.
 *   - simulateSmartExit + DEFAULT_EXIT_CONFIG (exit-engine.ts), unchanged —
 *     this repo's own validated wide-trail exit.
 *   - purgedChronologicalSplit — TS port of
 *     scripts/ml/pipeline/validation.py::purged_chronological_split, same
 *     70/15/15 ratios and embargo semantics.
 *
 * Test partition is scored once. No re-tuning after seeing test results.
 */
import { readFileSync } from "fs";
import { detectMarketCipher, type MarketCipherSignal } from "../../../src/server/signals/market-cipher";
import { atr, enrichCandles } from "../../../src/server/analysis/indicators";
import { DEFAULT_ICR_CONFIG } from "../../../src/server/analysis/icr/config";
import { simulateSmartExit, DEFAULT_EXIT_CONFIG } from "../../../src/server/analysis/exits/exit-engine";
import type { ExitConfig } from "../../../src/server/analysis/exits/exit-engine";
import type { Kline } from "../../../src/server/analysis/types";

// ─── Config ──────────────────────────────────────────────────────────────

const DATA_PATH = "/home/ariel/anavitrade-trading/scripts/data/klines-mtf-extended.json";
const TARGET_TFS = ["4h", "1h"];
const WARMUP_BARS = 100;
// Trailing window fed to detectMarketCipher at each bar, instead of the full
// growing history — comfortably larger than the longest internal lookback
// (wtDivergenceLen=28), verified to produce identical signal counts to an
// unbounded window on a full-history smoke test, ~39x faster.
const REPLAY_WINDOW = 200;
const SWING_LOOKBACK = 10;
const STOP_ATR_BUFFER = 0.5;
const EMBARGO_BARS = DEFAULT_EXIT_CONFIG.maxBars; // 60
const MIN_TOTAL_BARS = WARMUP_BARS + SWING_LOOKBACK + 50;

interface KlinesDataItem {
  symbol: string;
  klines: Record<string, Kline[]>;
}

interface TradeRecord {
  r: number;
  direction: "long" | "short";
  symbol: string;
  timeframe: string;
  signalType: MarketCipherSignal["type"];
  partition: "train" | "validation" | "test";
}

// ─── Purged chronological split (port of validation.py) ────────────────────

function purgedChronologicalSplit(
  timestamps: number[],
  trainRatio = 0.70,
  validationRatio = 0.15,
  embargoMs = 0,
): { train: Set<number>; validation: Set<number>; test: Set<number> } {
  const unique = [...new Set(timestamps)].sort((a, b) => a - b);
  const trainEnd = Math.floor(unique.length * trainRatio);
  const validationEnd = Math.floor(unique.length * (trainRatio + validationRatio));
  if (trainEnd <= 0 || validationEnd <= trainEnd || validationEnd >= unique.length) {
    return { train: new Set(), validation: new Set(), test: new Set() };
  }
  const validationStartTs = unique[trainEnd];
  const testStartTs = unique[validationEnd];
  const train = new Set(unique.slice(0, trainEnd).filter((ts) => ts + embargoMs < validationStartTs));
  const validation = new Set(
    unique.slice(trainEnd, validationEnd).filter((ts) => ts + embargoMs < testStartTs),
  );
  const test = new Set(unique.slice(validationEnd));
  return { train, validation, test };
}

function partitionOf(
  ts: number,
  split: { train: Set<number>; validation: Set<number>; test: Set<number> },
): "train" | "validation" | "test" | null {
  if (split.train.has(ts)) return "train";
  if (split.validation.has(ts)) return "validation";
  if (split.test.has(ts)) return "test";
  return null; // purged (embargo boundary)
}

// ─── Swing-based stop-loss (10-bar rolling extreme ± 0.5x ATR14) ──────────

function swingStop(
  klines: Kline[],
  atr14: (number | null)[],
  idx: number,
  direction: "long" | "short",
): { stop: number; swingLow: number; swingHigh: number } | null {
  // Excludes the signal/entry bar itself. MCB signals fire AT local extremes
  // by definition (that's what WT top/bottom divergence means), so including
  // the entry bar here would often make the entry bar's own low/high the
  // swing extreme -- placing the stop right at the entry bar's own range and
  // causing same-bar stop-outs in simulateSmartExit (its first loop
  // iteration checks the stop against the entry bar itself). Using only
  // prior, already-closed bars avoids this and matches what a live system
  // could actually know at signal time.
  const start = Math.max(0, idx - SWING_LOOKBACK);
  const window = klines.slice(start, idx);
  if (window.length === 0) return null;
  const swingLow = Math.min(...window.map((k) => k.low));
  const swingHigh = Math.max(...window.map((k) => k.high));
  const a = atr14[idx];
  if (a === null || a <= 0) return null;
  return direction === "long"
    ? { stop: swingLow - STOP_ATR_BUFFER * a, swingLow, swingHigh }
    : { stop: swingHigh + STOP_ATR_BUFFER * a, swingLow, swingHigh };
}

// ─── Metrics (same shape as icr-wavetrend-experiment.ts) ──────────────────

interface Metrics {
  label: string;
  trades: number;
  wins: number;
  wr: string;
  profitFactor: string;
  totalR: string;
  avgR: string;
  sharpe: string;
  maxDD: string;
}

function computeMetrics(records: TradeRecord[], label: string): Metrics {
  const n = records.length;
  if (n === 0) {
    return { label, trades: 0, wins: 0, wr: "0.0", profitFactor: "0.00", totalR: "0.0", avgR: "0.000", sharpe: "0.00", maxDD: "0.0" };
  }
  const wins = records.filter((r) => r.r > 0).length;
  const totalR = records.reduce((s, r) => s + r.r, 0);
  const avgR = totalR / n;
  const grossWin = records.filter((r) => r.r > 0).reduce((s, r) => s + r.r, 0);
  const grossLoss = Math.abs(records.filter((r) => r.r < 0).reduce((s, r) => s + r.r, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const stdR = n > 1 ? Math.sqrt(records.reduce((s, r) => s + (r.r - avgR) ** 2, 0) / (n - 1)) : 0;
  const sharpe = stdR > 0 ? (avgR / stdR) * Math.sqrt(365) : 0;
  let peak = 0, maxDD = 0, cumR = 0;
  for (const r of records) {
    cumR += r.r;
    if (cumR > peak) peak = cumR;
    const dd = peak > 0 ? (peak - cumR) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return {
    label, trades: n, wins,
    wr: ((wins / n) * 100).toFixed(1),
    profitFactor: pf === Infinity ? "∞" : pf.toFixed(2),
    totalR: totalR.toFixed(1),
    avgR: avgR.toFixed(3),
    sharpe: sharpe.toFixed(2),
    maxDD: (maxDD * 100).toFixed(1),
  };
}

// ─── Run one symbol/timeframe ──────────────────────────────────────────────

function runSymbolTimeframe(symbol: string, timeframe: string, klines: Kline[]): TradeRecord[] {
  if (klines.length < MIN_TOTAL_BARS) return [];
  const sorted = [...klines].sort((a, b) => a.timestamp - b.timestamp);
  const timestamps = sorted.map((k) => k.timestamp);
  const split = purgedChronologicalSplit(timestamps, 0.70, 0.15, EMBARGO_BARS * timeframeMs(timeframe));

  const closes = sorted.map((k) => k.close);
  const highs = sorted.map((k) => k.high);
  const lows = sorted.map((k) => k.low);
  const atr14 = atr(highs, lows, closes, 14);
  const enriched = enrichCandles(sorted, DEFAULT_ICR_CONFIG);

  const trades: TradeRecord[] = [];
  const seenSignalBars = new Set<string>(); // dedupe: one entry per (bar, signalType)

  // Every bullish signal type -> long, every bearish type -> short. Each
  // type gets its own trade record per bar (not just the confluence signal),
  // so the standalone edge of each component can be read separately from
  // the aggregate confluence score.
  const BULLISH_TYPES = new Set<MarketCipherSignal["type"]>([
    "mcb_bottom", "mcb_wt_bull_cross", "mcb_money_flow_bull",
    "mcb_regular_bull_div", "mcb_hidden_bull_div", "mcb_confluence_buy",
  ]);
  const BEARISH_TYPES = new Set<MarketCipherSignal["type"]>([
    "mcb_top", "mcb_wt_bear_cross", "mcb_money_flow_bear",
    "mcb_regular_bear_div", "mcb_hidden_bear_div", "mcb_confluence_sell",
  ]);

  for (let i = WARMUP_BARS; i < sorted.length - 1; i++) {
    const partition = partitionOf(sorted[i].timestamp, split);
    if (!partition) continue; // purged boundary bar

    // detectMarketCipher evaluates only the LAST bar of whatever slice it's
    // given — replay it with a trailing window ending at bar i, exactly how
    // generator.ts calls it in production (once per new candle, on whatever
    // finite history is fetched — never truly unbounded there either).
    const windowStart = Math.max(0, i + 1 - REPLAY_WINDOW);
    const windowClose = closes.slice(windowStart, i + 1);
    const windowHigh = highs.slice(windowStart, i + 1);
    const windowLow = lows.slice(windowStart, i + 1);
    const signals = detectMarketCipher(windowClose, windowHigh, windowLow, symbol, timeframe);

    for (const sig of signals) {
      const direction: "long" | "short" | null = BULLISH_TYPES.has(sig.type)
        ? "long"
        : BEARISH_TYPES.has(sig.type) ? "short" : null;
      if (!direction) continue;
      const dedupeKey = `${i}:${sig.type}`;
      if (seenSignalBars.has(dedupeKey)) continue;
      seenSignalBars.add(dedupeKey);

      const stopInfo = swingStop(sorted, atr14, i, direction);
      if (!stopInfo) continue;
      const entryPrice = sorted[i].close;
      const entryIdx = i;

      const result = simulateSmartExit(
        sorted,
        enriched,
        entryIdx,
        entryPrice,
        stopInfo.stop,
        direction,
        stopInfo.swingLow,
        stopInfo.swingHigh,
        DEFAULT_EXIT_CONFIG as ExitConfig,
      );

      trades.push({
        r: result.finalR,
        direction,
        symbol,
        timeframe,
        signalType: sig.type,
        partition,
      });
    }
  }
  return trades;
}

function timeframeMs(tf: string): number {
  if (tf === "4h") return 4 * 60 * 60 * 1000;
  if (tf === "1h") return 60 * 60 * 1000;
  if (tf === "15m") return 15 * 60 * 1000;
  throw new Error(`unknown timeframe: ${tf}`);
}

// ─── Main ────────────────────────────────────────────────────────────────

function main() {
  const data: KlinesDataItem[] = JSON.parse(readFileSync(DATA_PATH, "utf-8"));
  console.log(`Loaded ${data.length} symbols from ${DATA_PATH}`);

  const allTrades: TradeRecord[] = [];
  for (const item of data) {
    for (const tf of TARGET_TFS) {
      const klines = item.klines[tf];
      if (!klines) continue;
      const trades = runSymbolTimeframe(item.symbol, tf, klines);
      allTrades.push(...trades);
    }
  }

  console.log(`\nTotal trades generated: ${allTrades.length}`);

  const SEP = "=".repeat(100);
  // Primary decision metric per the pre-registered rule (README.md): the
  // confluence signal ONLY (confluence >= 2), not individual components.
  const configs: Array<{ label: string; filter: (t: TradeRecord) => boolean }> = [
    { label: "Long, 4h", filter: (t) => t.direction === "long" && t.timeframe === "4h" && t.signalType === "mcb_confluence_buy" },
    { label: "Short, 4h", filter: (t) => t.direction === "short" && t.timeframe === "4h" && t.signalType === "mcb_confluence_sell" },
    { label: "Long, 1h", filter: (t) => t.direction === "long" && t.timeframe === "1h" && t.signalType === "mcb_confluence_buy" },
    { label: "Short, 1h", filter: (t) => t.direction === "short" && t.timeframe === "1h" && t.signalType === "mcb_confluence_sell" },
  ];

  for (const cfg of configs) {
    const subset = allTrades.filter(cfg.filter);
    console.log(`\n${SEP}\n${cfg.label} — confluence >= 2 (PRE-REGISTERED PRIMARY METRIC)\n${SEP}`);
    for (const partition of ["train", "validation", "test"] as const) {
      const partitionTrades = subset.filter((t) => t.partition === partition);
      const m = computeMetrics(partitionTrades, `${cfg.label} [${partition}]`);
      console.log(
        `  ${partition.padEnd(11)} trades=${String(m.trades).padStart(5)} wr=${m.wr.padStart(6)}% ` +
        `pf=${m.profitFactor.padStart(6)} totalR=${m.totalR.padStart(9)} avgR=${m.avgR.padStart(8)} ` +
        `sharpe=${m.sharpe.padStart(6)} maxDD=${m.maxDD.padStart(6)}%`,
      );
    }
    // Per-signal-type breakdown, ALL types incl. individual components, not
    // just confluence (validation only, diagnostic — to see which component
    // is actually carrying any edge; NOT part of the pre-registered decision).
    const direction = cfg.label.startsWith("Long") ? "long" : "short";
    const timeframe = cfg.label.endsWith("4h") ? "4h" : "1h";
    const allTypesSubset = allTrades.filter((t) => t.direction === direction && t.timeframe === timeframe);
    const validationSubset = allTypesSubset.filter((t) => t.partition === "validation");
    const byType = new Map<string, TradeRecord[]>();
    for (const t of validationSubset) {
      const arr = byType.get(t.signalType) ?? [];
      arr.push(t);
      byType.set(t.signalType, arr);
    }
    if (byType.size > 0) {
      console.log(`  --- validation breakdown by signal type ---`);
      for (const [type, trades] of byType) {
        const m = computeMetrics(trades, type);
        console.log(`    ${type.padEnd(22)} trades=${String(m.trades).padStart(5)} wr=${m.wr.padStart(6)}% avgR=${m.avgR.padStart(8)}`);
      }
    }
  }

  console.log(`\n${SEP}\nDONE — see README.md for the pre-registered +1R decision rule.\n${SEP}`);
}

main();
