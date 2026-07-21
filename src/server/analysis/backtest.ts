/**
 * Backtest harness for the unified analysis engine.
 *
 * Feeds historical Binance candle data through the same indicator enrichment
 * and ICR signal detection pipeline, then simulates outcomes against actual
 * subsequent price data.
 *
 * This validates the TS engine produces the same signals as the Python ICR
 * would, and measures actual signal quality before live dispatch.
 */

import type { Kline, EnrichedCandle, UnifiedSignal } from "./types";
import type { IcrConfig } from "./types";
import { getKlines } from "./kline-repository";
import { enrichCandles } from "./indicators";
import { findLatestSignals } from "./icr/signals";
import { DEFAULT_ICR_CONFIG } from "./icr/config";
import { simulateSmartExit, DEFAULT_EXIT_CONFIG } from "./exits/exit-engine";

/* ─── Types ─────────────────────────────────────────────────────────── */

export interface BacktestConfig {
  symbol: string;
  timeframe: string;
  lookbackBars: number;        // how many candles to analyze
  minScore: number;            // minimum signal score to count
  forwardBars: number;         // how far forward to check outcomes
  stopAtrMult: number;         // stop loss = entry - stopAtrMult * ATR
  tpRMultiples: number[];      // take-profit R-multiples to test
  useSmartExit?: boolean;      // use the validated tail-preserving exit engine
                               // (trail + exhaustion) instead of naive fixed-TP/
                               // window-close. Empirically +281R vs +261R Tier-A.
}

export interface SignalOutcome {
  signal: UnifiedSignal;
  entryCandleIndex: number;
  entryPrice: number;
  stopPrice: number;
  maxFavorableExcursion: number;    // best R achieved
  maxAdverseExcursion: number;      // worst R hit
  hitStop: boolean;
  hitTp1: boolean;    // hit first TP level
  hitTp2: boolean;    // hit second TP level
  finalR: number;     // R at exit (or at forwardBars end)
  barsHeld: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  signalsGenerated: number;
  signalsQualified: number;
  outcomes: SignalOutcome[];
  summary: {
    totalSignals: number;
    winRate: number;         // % that ended positive R
    avgR: number;            // average R per trade
    totalR: number;          // sum of all R
    profitFactor: number;    // gross profit / gross loss
    maxDrawdownR: number;    // max R drawdown
    sharpeApprox: number;    // approximate Sharpe (mean(R)/std(R))
    expectancyR: number;     // average R per trade
    bestSignal: { symbol: string; score: number; r: number };
    worstSignal: { symbol: string; score: number; r: number };
  };
}

/* ─── Default config ─────────────────────────────────────────────────── */

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  symbol: "BTCUSDT",
  timeframe: "4h",
  lookbackBars: 500,
  minScore: 75,
  forwardBars: 48,       // 48 * 4h = 8 days
  stopAtrMult: 1.0,
  tpRMultiples: [2.0, 3.0],
};

/* ─── Helpers ────────────────────────────────────────────────────────── */

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return sum(arr) / arr.length;
}

function stdDev(arr: number[], avg?: number): number {
  if (arr.length < 2) return 0;
  const m = avg ?? mean(arr);
  const sqDiffs = arr.map((v) => (v - m) ** 2);
  return Math.sqrt(sum(sqDiffs) / (arr.length - 1));
}

/**
 * Simulate the outcome of a single signal by scanning forward candles.
 * Returns a SignalOutcome with full excursion tracking.
 *
 * Entry is at candle[i+1].open (next bar's open, with a small slippage
 * penalty). Stop is computed from the signal's ATR at trigger time.
 */
function simulateOutcome(
  candles: EnrichedCandle[],
  rawCandles: Kline[],
  signalIdx: number,
  signal: UnifiedSignal,
  config: BacktestConfig,
): SignalOutcome {
  const trigger = candles[signalIdx];
  const atr = trigger?.atr14 ?? 0;

  // Entry: next candle's open with 0.05% slippage
  const entryIdx = signalIdx + 1;
  if (entryIdx >= rawCandles.length) {
    return {
      signal,
      entryCandleIndex: signalIdx,
      entryPrice: signal.entry,
      stopPrice: signal.stopLoss,
      maxFavorableExcursion: 0,
      maxAdverseExcursion: 0,
      hitStop: false,
      hitTp1: false,
      hitTp2: false,
      finalR: 0,
      barsHeld: 0,
    };
  }

  const isShort = signal.direction === "short";
  const slippageMult = isShort ? 0.9995 : 1.0005; // 0.05% slippage in trade direction
  const entryPrice = rawCandles[entryIdx].open * slippageMult;
  const stopDistance = config.stopAtrMult * (atr > 0 ? atr : entryPrice * 0.02);
  const stopPrice = isShort ? entryPrice + stopDistance : entryPrice - stopDistance;
  const risk = isShort ? stopPrice - entryPrice : entryPrice - stopPrice;
  if (risk <= 0) {
    return {
      signal,
      entryCandleIndex: signalIdx,
      entryPrice,
      stopPrice,
      maxFavorableExcursion: 0,
      maxAdverseExcursion: 0,
      hitStop: false,
      hitTp1: false,
      hitTp2: false,
      finalR: 0,
      barsHeld: 0,
    };
  }

  const tp1Price = isShort
    ? entryPrice - config.tpRMultiples[0] * risk
    : entryPrice + config.tpRMultiples[0] * risk;
  const tp2Price = config.tpRMultiples.length > 1
    ? (isShort ? entryPrice - config.tpRMultiples[1] * risk : entryPrice + config.tpRMultiples[1] * risk)
    : (isShort ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);

  let maxFavorableExcursion = 0;
  let maxAdverseExcursion = 0;
  let hitStop = false;
  let hitTp1 = false;
  let hitTp2 = false;
  let barsHeld = 0;
  let finalExitPrice = entryPrice;

  const endIdx = Math.min(entryIdx + config.forwardBars, rawCandles.length);

  for (let j = entryIdx; j < endIdx; j++) {
    const candle = rawCandles[j];
    barsHeld = j - entryIdx;

    // Direction-aware R calculations
    const lowR = isShort ? (entryPrice - candle.high) / risk : (candle.low - entryPrice) / risk;
    const highR = isShort ? (entryPrice - candle.low) / risk : (candle.high - entryPrice) / risk;

    if (lowR < maxAdverseExcursion) maxAdverseExcursion = lowR;
    if (highR > maxFavorableExcursion) maxFavorableExcursion = highR;

    // Check stop: short = high >= stop, long = low <= stop
    if (!hitStop && (isShort ? candle.high >= stopPrice : candle.low <= stopPrice)) {
      hitStop = true;
      finalExitPrice = stopPrice;
      break;
    }

    // Check TP1: short = low <= tp1, long = high >= tp1
    if (!hitTp1 && (isShort ? candle.low <= tp1Price : candle.high >= tp1Price)) {
      hitTp1 = true;
    }

    // Check TP2
    if (!hitTp2 && (isShort ? candle.low <= tp2Price : candle.high >= tp2Price)) {
      hitTp2 = true;
      finalExitPrice = tp2Price;
      break;
    }
  }

  // If not stopped out, exit at the last candle's close
  if (!hitStop && !hitTp2) {
    const lastIdx = endIdx - 1;
    if (lastIdx >= 0 && lastIdx < rawCandles.length) {
      finalExitPrice = rawCandles[lastIdx].close;
    }
  }

  const finalR = isShort ? (entryPrice - finalExitPrice) / risk : (finalExitPrice - entryPrice) / risk;

  return {
    signal,
    entryCandleIndex: signalIdx,
    entryPrice,
    stopPrice,
    maxFavorableExcursion,
    maxAdverseExcursion,
    hitStop,
    hitTp1,
    hitTp2,
    finalR,
    barsHeld,
  };
}

/**
 * Simulate a signal outcome using the validated tail-preserving smart-exit engine
 * (wide/late trail + extreme-only exhaustion). Forward-only. Maps the exit
 * engine's blended-R result into the standard SignalOutcome shape.
 */
function simulateOutcomeSmart(
  candles: EnrichedCandle[],
  rawCandles: Kline[],
  signalIdx: number,
  signal: UnifiedSignal,
  config: BacktestConfig,
): SignalOutcome {
  const trigger = candles[signalIdx];
  const atr = trigger?.atr14 ?? 0;
  const entryIdx = signalIdx + 1;

  if (entryIdx >= rawCandles.length) {
    return {
      signal, entryCandleIndex: signalIdx, entryPrice: signal.entry,
      stopPrice: signal.stopLoss, maxFavorableExcursion: 0, maxAdverseExcursion: 0,
      hitStop: false, hitTp1: false, hitTp2: false, finalR: 0, barsHeld: 0,
    };
  }

  const isShort = signal.direction === "short";
  const entryPrice = rawCandles[entryIdx].open * (isShort ? 0.9995 : 1.0005);
  const stopDistance = config.stopAtrMult * (atr > 0 ? atr : entryPrice * 0.02);
  const initialStop = isShort ? entryPrice + stopDistance : entryPrice - stopDistance;

  // Impulse swing levels for fib targets (stored on the signal by findSignals)
  const swingLow = typeof signal.metadata?.impulseSwingLow === "number"
    ? signal.metadata.impulseSwingLow : entryPrice - stopDistance * 3;
  const swingHigh = typeof signal.metadata?.impulseSwingHigh === "number"
    ? signal.metadata.impulseSwingHigh : entryPrice + stopDistance * 3;

  const exitCfg = { ...DEFAULT_EXIT_CONFIG, maxBars: config.forwardBars };
  const result = simulateSmartExit(
    rawCandles, candles, entryIdx, entryPrice, initialStop,
    signal.direction, swingLow, swingHigh, exitCfg,
  );

  return {
    signal,
    entryCandleIndex: signalIdx,
    entryPrice,
    stopPrice: initialStop,
    maxFavorableExcursion: result.maxFavorableR,
    maxAdverseExcursion: result.maxAdverseR,
    hitStop: result.exitReason === "stop",
    hitTp1: result.maxFavorableR >= (config.tpRMultiples[0] ?? 2),
    hitTp2: result.exitReason === "fib_final" || result.maxFavorableR >= (config.tpRMultiples[1] ?? 3),
    finalR: result.finalR,
    barsHeld: result.barsHeld,
  };
}

/**
 * Build a summary from a list of outcomes.
 */
function buildSummary(
  outcomes: SignalOutcome[],
  config: BacktestConfig,
): BacktestResult["summary"] {
  if (outcomes.length === 0) {
    return {
      totalSignals: 0,
      winRate: 0,
      avgR: 0,
      totalR: 0,
      profitFactor: 0,
      maxDrawdownR: 0,
      sharpeApprox: 0,
      expectancyR: 0,
      bestSignal: { symbol: config.symbol, score: 0, r: 0 },
      worstSignal: { symbol: config.symbol, score: 0, r: 0 },
    };
  }

  const rValues = outcomes.map((o) => o.finalR);
  const wins = outcomes.filter((o) => o.finalR > 0);
  const losses = outcomes.filter((o) => o.finalR < 0);

  const totalR = sum(rValues);
  const avgR = mean(rValues);
  const winRate = outcomes.length > 0 ? wins.length / outcomes.length : 0;
  const rStd = stdDev(rValues, avgR);
  const sharpeApprox = rStd > 0 ? (avgR / rStd) * Math.sqrt(outcomes.length) : 0;

  const grossProfit = sum(wins.map((o) => o.finalR));
  const grossLoss = Math.abs(sum(losses.map((o) => o.finalR)));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0;

  // Max R drawdown from cumulative R
  let cumulativeR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  for (const r of rValues) {
    cumulativeR += r;
    if (cumulativeR > peakR) peakR = cumulativeR;
    const drawdown = peakR - cumulativeR;
    if (drawdown > maxDrawdownR) maxDrawdownR = drawdown;
  }

  let bestSignal: BacktestResult["summary"]["bestSignal"] = {
    symbol: config.symbol,
    score: 0,
    r: -Infinity,
  };
  let worstSignal: BacktestResult["summary"]["worstSignal"] = {
    symbol: config.symbol,
    score: 0,
    r: Infinity,
  };

  for (const o of outcomes) {
    if (o.finalR > bestSignal.r) {
      bestSignal = { symbol: o.signal.symbol, score: o.signal.score, r: o.finalR };
    }
    if (o.finalR < worstSignal.r) {
      worstSignal = { symbol: o.signal.symbol, score: o.signal.score, r: o.finalR };
    }
  }

  return {
    totalSignals: outcomes.length,
    winRate,
    avgR,
    totalR,
    profitFactor,
    maxDrawdownR,
    sharpeApprox,
    expectancyR: avgR,
    bestSignal,
    worstSignal,
  };
}

/* ─── Public API ─────────────────────────────────────────────────────── */

/**
 * Run a backtest: fetch historical klines, enrich, generate signals,
 * then simulate outcomes by looking at subsequent price data.
 *
 * Stateless — reads klines from DB, computes everything in-memory.
 * No DB writes.
 */
export async function runBacktest(
  config: BacktestConfig,
  icrConfig: IcrConfig = DEFAULT_ICR_CONFIG,
): Promise<BacktestResult> {
  // 1. Fetch klines — need extra room for warmup + forward bars
  const totalBars = config.lookbackBars + config.forwardBars + icrConfig.slowMa + 50;
  const rawKlines = await getKlines(config.symbol, config.timeframe, totalBars);

  if (rawKlines.length < icrConfig.slowMa + 50) {
    return {
      config,
      signalsGenerated: 0,
      signalsQualified: 0,
      outcomes: [],
      summary: {
        totalSignals: 0,
        winRate: 0,
        avgR: 0,
        totalR: 0,
        profitFactor: 0,
        maxDrawdownR: 0,
        sharpeApprox: 0,
        expectancyR: 0,
        bestSignal: { symbol: config.symbol, score: 0, r: 0 },
        worstSignal: { symbol: config.symbol, score: 0, r: 0 },
      },
    };
  }

  // 2. Enrich all candles
  const enriched = enrichCandles(rawKlines, icrConfig);

  // 3. Scan for signals and simulate outcomes
  const startIdx = icrConfig.slowMa; // ensure MA99 is warm
  const lastSignalIdx = enriched.length - config.forwardBars - 1;
  const outcomes: SignalOutcome[] = [];
  let signalsGenerated = 0;

  for (let i = startIdx; i <= lastSignalIdx; i++) {
    // Evaluate only the just-closed candle. Scanning the whole prefix here
    // replays previously found signals once for every later candle and makes
    // the performance report mathematically invalid.
    const windowEnriched = enriched.slice(0, i + 1);
    const signals = findLatestSignals(windowEnriched, config.symbol, config.timeframe, icrConfig);
    signalsGenerated += signals.length;

    for (const signal of signals) {
      if (signal.score >= config.minScore) {
        const outcome = config.useSmartExit
          ? simulateOutcomeSmart(enriched, rawKlines, i, signal, config)
          : simulateOutcome(enriched, rawKlines, i, signal, config);
        outcomes.push(outcome);
      }
    }
  }

  const qualified = outcomes.length;

  return {
    config,
    signalsGenerated,
    signalsQualified: qualified,
    outcomes,
    summary: buildSummary(outcomes, config),
  };
}

/**
 * Run backtests across multiple symbols and return comparative results.
 */
export async function runMultiSymbolBacktest(
  symbols: string[],
  config: Omit<BacktestConfig, "symbol">,
  icrConfig?: IcrConfig,
): Promise<Map<string, BacktestResult>> {
  const results = new Map<string, BacktestResult>();

  // Run sequentially to avoid hammering the DB
  for (const symbol of symbols) {
    const symbolConfig: BacktestConfig = { ...config, symbol };
    const result = await runBacktest(symbolConfig, icrConfig);
    results.set(symbol, result);
  }

  return results;
}

/* ─── Baseline Strategy ──────────────────────────────────────────────── */

interface BaselineTrade {
  direction: "long" | "short";
  entryIdx: number;
  entryPrice: number;
  exitIdx: number;
  exitPrice: number;
  r: number;
}

/**
 * Simple MA crossover baseline strategy:
 * - Long entry: close crosses above MA25 and MA7 > MA25
 * - Long exit: close crosses below MA25
 * - Short entry: close crosses below MA25 and MA7 < MA25
 * - Short exit: close crosses above MA25
 *
 * Returns R-multiples (positive = profit, negative = loss) using a
 * fixed R based on 2 * ATR stop distance.
 */
function runBaselineStrategy(
  candles: EnrichedCandle[],
  rawKlines: Kline[],
  forwardBars: number,
): BaselineTrade[] {
  const trades: BaselineTrade[] = [];
  let position: "none" | "long" | "short" = "none";
  let entryIdx = 0;
  let entryPrice = 0;

  const startIdx = 25; // need MA25 warm
  const endIdx = candles.length - forwardBars;

  for (let i = startIdx; i < endIdx; i++) {
    const curr = candles[i];
    const prev = i > 0 ? candles[i - 1] : curr;
    const atr = curr.atr14 > 0 ? curr.atr14 : curr.close * 0.01;

    if (position === "none") {
      // Long entry signal: close crosses above MA25 and MA7 > MA25
      if (
        prev.close <= prev.ma25 &&
        curr.close > curr.ma25 &&
        curr.ma7 > curr.ma25
      ) {
        position = "long";
        entryIdx = i;
        entryPrice = curr.close;
      }
      // Short entry signal: close crosses below MA25 and MA7 < MA25
      else if (
        prev.close >= prev.ma25 &&
        curr.close < curr.ma25 &&
        curr.ma7 < curr.ma25
      ) {
        position = "short";
        entryIdx = i;
        entryPrice = curr.close;
      }
    } else if (position === "long") {
      // Exit long when close crosses below MA25
      if (curr.close < curr.ma25) {
        const exitIdx = i;
        const exitPrice = curr.close;
        const risk = atr;
        const r = risk > 0 ? (exitPrice - entryPrice) / risk : 0;
        trades.push({
          direction: "long",
          entryIdx,
          entryPrice,
          exitIdx,
          exitPrice,
          r,
        });
        position = "none";
      }
      // Time-based exit after forwardBars
      else if (i - entryIdx >= forwardBars) {
        const exitIdx = i;
        const exitPrice = curr.close;
        const risk = atr;
        const r = risk > 0 ? (exitPrice - entryPrice) / risk : 0;
        trades.push({
          direction: "long",
          entryIdx,
          entryPrice,
          exitIdx,
          exitPrice,
          r,
        });
        position = "none";
      }
    } else if (position === "short") {
      // Exit short when close crosses above MA25
      if (curr.close > curr.ma25) {
        const exitIdx = i;
        const exitPrice = curr.close;
        const risk = atr;
        const r = risk > 0 ? (entryPrice - exitPrice) / risk : 0;
        trades.push({
          direction: "short",
          entryIdx,
          entryPrice,
          exitIdx,
          exitPrice,
          r,
        });
        position = "none";
      }
      // Time-based exit
      else if (i - entryIdx >= forwardBars) {
        const exitIdx = i;
        const exitPrice = curr.close;
        const risk = atr;
        const r = risk > 0 ? (entryPrice - exitPrice) / risk : 0;
        trades.push({
          direction: "short",
          entryIdx,
          entryPrice,
          exitIdx,
          exitPrice,
          r,
        });
        position = "none";
      }
    }
  }

  return trades;
}

function baselineToResult(
  trades: BaselineTrade[],
  symbol: string,
  timeframe: string,
  config: Omit<BacktestConfig, "symbol">,
): BacktestResult {
  const rValues = trades.map((t) => t.r);
  if (rValues.length === 0) {
    return {
      config: { ...config, symbol },
      signalsGenerated: 0,
      signalsQualified: 0,
      outcomes: [],
      summary: {
        totalSignals: 0,
        winRate: 0,
        avgR: 0,
        totalR: 0,
        profitFactor: 0,
        maxDrawdownR: 0,
        sharpeApprox: 0,
        expectancyR: 0,
        bestSignal: { symbol, score: 0, r: 0 },
        worstSignal: { symbol, score: 0, r: 0 },
      },
    };
  }

  const totalR = sum(rValues);
  const avgR = mean(rValues);
  const wins = rValues.filter((r) => r > 0);
  const losses = rValues.filter((r) => r < 0);
  const winRate = wins.length / rValues.length;
  const rStd = stdDev(rValues, avgR);
  const sharpeApprox = rStd > 0 ? (avgR / rStd) * Math.sqrt(rValues.length) : 0;

  const grossProfit = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0;

  let cumulativeR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  for (const r of rValues) {
    cumulativeR += r;
    if (cumulativeR > peakR) peakR = cumulativeR;
    const drawdown = peakR - cumulativeR;
    if (drawdown > maxDrawdownR) maxDrawdownR = drawdown;
  }

  let bestR = -Infinity;
  let worstR = Infinity;
  for (const t of trades) {
    if (t.r > bestR) bestR = t.r;
    if (t.r < worstR) worstR = t.r;
  }

  return {
    config: { ...config, symbol },
    signalsGenerated: trades.length,
    signalsQualified: trades.length,
    outcomes: [],
    summary: {
      totalSignals: trades.length,
      winRate,
      avgR,
      totalR,
      profitFactor,
      maxDrawdownR,
      sharpeApprox,
      expectancyR: avgR,
      bestSignal: { symbol, score: 0, r: bestR === -Infinity ? 0 : bestR },
      worstSignal: { symbol, score: 0, r: worstR === Infinity ? 0 : worstR },
    },
  };
}

/**
 * Compare the TS ICR engine against a simple baseline strategy
 * (MA crossover: buy when close crosses above MA25 with MA7 > MA25,
 *  sell when close crosses below MA25).
 */
export async function compareToBaseline(
  symbol: string,
  timeframe: string,
  lookbackBars: number,
): Promise<{ icr: BacktestResult; baseline: BacktestResult }> {
  const totalBars = lookbackBars + 100;
  const rawKlines = await getKlines(symbol, timeframe, totalBars);

  const backtestConfig: BacktestConfig = {
    symbol,
    timeframe,
    lookbackBars,
    minScore: 75,
    forwardBars: 48,
    stopAtrMult: 1.0,
    tpRMultiples: [2.0, 3.0],
  };

  // Run ICR backtest
  const icr = await runBacktest(backtestConfig);

  // Run baseline
  const enriched = enrichCandles(rawKlines, DEFAULT_ICR_CONFIG);
  const baselineTrades = runBaselineStrategy(enriched, rawKlines, backtestConfig.forwardBars);
  const baseline = baselineToResult(baselineTrades, symbol, timeframe, backtestConfig);

  return { icr, baseline };
}
