#!/usr/bin/env npx tsx
/**
 * Training Data Builder for NN Scoring Engine (Stage 3).
 *
 * Reads OHLCV klines, computes ICR gate scores and market-structure features
 * for every bar (NO lookahead), then labels each bar with forward outcomes:
 * did price reach TP before stop?  What were MFE and MAE?
 *
 * Usage:
 *   npx tsx scripts/ml/build-training-data.ts \
 *     --input klines.json \
 *     --output training-data.json
 *
 *   npx tsx scripts/ml/build-training-data.ts \
 *     --input klines.json \
 *     --output training-data.csv \
 *     --format csv
 *
 * Input format (JSON):
 *   [
 *     {
 *       "symbol": "BTCUSDT",
 *       "timeframe": "4h",
 *       "klines": [
 *         { "timestamp": 1720000000000, "open": 50000, "high": 51000,
 *           "low": 49500, "close": 50500, "volume": 1234.5 },
 *         ...
 *       ]
 *     },
 *     ...
 *   ]
 *
 * All features are computable WITHOUT lookahead.  The label is the ONLY
 * forward-looking component.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface Kline {
  symbol: string;
  timeframe: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface InputGroup {
  symbol: string;
  timeframe: string;
  klines: Kline[];
}

interface EnrichedCandle {
  symbol: string;
  timeframe: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma7: number;
  ma25: number;
  ma99: number;
  atr14: number;
  volumeMa20: number;
  volumeZscore: number;
  range: number;
  body: number;
  bodyRatio: number;
  closePosition: number;
  ma25Slope: number;
  rsi14: number;
  bbMid: number;
  bbUpper: number;
  bbLower: number;
  bbWidth: number;
  displacement: number;
}

interface GateScores {
  trend: number;       // 0 or 20
  impulse: number;     // 0-20
  pullback: number;    // 0-15
  compression: number; // 0-15
  trigger: number;     // 0-15
  volume: number;      // 0, 6, 8, 10
  rr: number;          // 0, 3, 4, 5
}

interface ForwardOutcome {
  hitTP: boolean;
  hitStop: boolean;
  maxFavorableR: number;
  maxAdverseR: number;
  pnlR: number;
  barsToOutcome: number;
}

interface FeatureRow {
  // Identifiers
  symbol: string;
  timeframe: string;
  timestamp: number;
  direction: "long" | "short";

  // Market Structure (12)
  ma7_slope: number;
  ma25_slope: number;
  ma99_slope: number;
  ma_separation: number;   // (ma7 - ma25) / atr14
  atr14: number;
  atr_percentile: number;  // 20-bar percentile
  bb_width: number;
  bb_position: number;     // (close - bbLower) / (bbUpper - bbLower)
  volume_zscore: number;
  volume_trend: number;    // volume MA20 slope
  rsi14: number;
  displacement: number;    // (close - ma7) / atr14

  // ICR Gate Scores (7)
  trend_score: number;
  impulse_score: number;
  pullback_score: number;
  compression_score: number;
  trigger_score: number;
  volume_score: number;
  rr_score: number;

  // Trade Structure (4)
  rr_ratio: number;
  stop_dist_atr: number;
  target_dist_atr: number;
  timeframe_encoded: number;

  // Context (6)
  hour_of_day: number;
  day_of_week: number;
  ma_regime: number;       // -1 bear, 0 neutral, 1 bull (MA99 slope)
  vol_regime: number;      // ATR percentile rank
  pair_encoded: number;
  direction_encoded: number; // 1 long, 0 short

  // Labels
  hitTP: boolean;
  hitStop: boolean;
  maxFavorableR: number;
  maxAdverseR: number;
  pnlR: number;
  barsToOutcome: number;
}

/* ─── CLI ─────────────────────────────────────────────────────────────────── */

interface CliArgs {
  input: string;
  output: string;
  format: "json" | "csv";
  maxLookforward: number;
  stopAtrMult: number;
  tpAtrMult: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      map.set(key, val);
    }
  }

  const input = map.get("input");
  const output = map.get("output");
  if (!input) {
    console.error("Missing --input <file>");
    process.exit(1);
  }
  if (!output) {
    console.error("Missing --output <file>");
    process.exit(1);
  }

  return {
    input,
    output,
    format: (map.get("format") as "json" | "csv") ?? "json",
    maxLookforward: Number(map.get("max-lookforward") ?? "100"),
    stopAtrMult: Number(map.get("stop-atr-mult") ?? "1.5"),
    tpAtrMult: Number(map.get("tp-atr-mult") ?? "3.0"),
  };
}

/* ─── Indicator Functions ─────────────────────────────────────────────────── */

function sma(values: number[], length: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (i < length - 1) { result[i] = null; continue; }
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) sum += values[j];
    result[i] = sum / length;
  }
  return result;
}

function ema(values: number[], length: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length);
  if (values.length === 0) return result;
  const alpha = 2 / (length + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < length - 1) { result[i] = null; continue; }
    if (prev === null) {
      let sum = 0;
      for (let j = 0; j < length; j++) sum += values[j];
      prev = sum / length;
    } else {
      prev = alpha * values[i] + (1 - alpha) * prev;
    }
    result[i] = prev;
  }
  return result;
}

function trueRange(
  high: number[], low: number[], close: number[],
): number[] {
  const tr: number[] = new Array(high.length);
  if (high.length > 0) {
    tr[0] = high[0] - low[0];
    for (let i = 1; i < high.length; i++) {
      const hl = high[i] - low[i];
      const hc = Math.abs(high[i] - close[i - 1]);
      const lc = Math.abs(low[i] - close[i - 1]);
      tr[i] = Math.max(hl, hc, lc);
    }
  }
  return tr;
}

function atr(
  high: number[], low: number[], close: number[], length: number,
): (number | null)[] {
  return sma(trueRange(high, low, close), length);
}

function rsi(close: number[], length: number): (number | null)[] {
  const result: (number | null)[] = new Array(close.length);
  if (close.length < length + 1) {
    for (let i = 0; i < close.length; i++) result[i] = null;
    return result;
  }
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const d = close[i] - close[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= length;
  avgLoss /= length;
  result[length] = avgLoss === 0 ? 50 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = length + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    result[i] = avgLoss === 0 ? 50 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  for (let i = 0; i < length; i++) result[i] = null;
  return result;
}

function rollingZscore(values: number[], length: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (i < length - 1) { result[i] = null; continue; }
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) sum += values[j];
    const mean = sum / length;
    let sq = 0;
    for (let j = i - length + 1; j <= i; j++) sq += (values[j] - mean) ** 2;
    const std = Math.sqrt(sq / length);
    result[i] = std === 0 ? 0 : (values[i] - mean) / std;
  }
  return result;
}

function bollinger(
  close: number[], length: number, stdMult: number,
): { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[]; width: (number | null)[] } {
  const mid = sma(close, length);
  const n = close.length;
  const upper: (number | null)[] = new Array(n);
  const lower: (number | null)[] = new Array(n);
  const width: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = mid[i];
    if (m === null) { upper[i] = lower[i] = width[i] = null; continue; }
    let sq = 0;
    for (let j = i - length + 1; j <= i; j++) sq += (close[j] - m) ** 2;
    const std = Math.sqrt(sq / length);
    upper[i] = m + std * stdMult;
    lower[i] = m - std * stdMult;
    width[i] = m !== 0 ? (upper[i]! - lower[i]!) / m : 0;
  }
  return { mid, upper, lower, width };
}

function percentRank(values: number[], length: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (i < length - 1) { result[i] = null; continue; }
    let count = 0;
    for (let j = i - length + 1; j <= i; j++) {
      if (values[j] <= values[i]) count++;
    }
    result[i] = count / length;
  }
  return result;
}

function linearSlope(values: (number | null)[], lookback: number, idx: number): number {
  const pts: { x: number; y: number }[] = [];
  for (let j = Math.max(0, idx - lookback + 1); j <= idx; j++) {
    const v = values[j];
    if (v !== null && Number.isFinite(v)) pts.push({ x: j, y: v });
  }
  if (pts.length < 2) return 0;
  const n = pts.length;
  const xMean = pts.reduce((s, p) => s + p.x, 0) / n;
  const yMean = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) {
    num += (p.x - xMean) * (p.y - yMean);
    den += (p.x - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/* ─── Enrich Candles ─────────────────────────────────────────────────────── */

function enrichCandles(klines: Kline[]): EnrichedCandle[] {
  const n = klines.length;
  if (n === 0) return [];

  const open = klines.map((k) => k.open);
  const high = klines.map((k) => k.high);
  const low = klines.map((k) => k.low);
  const close = klines.map((k) => k.close);
  const volume = klines.map((k) => k.volume);

  const ma7 = sma(close, 7);
  const ma25 = sma(close, 25);
  const ma99 = sma(close, 99);
  const atr14 = atr(high, low, close, 14);
  const volMa20 = sma(volume, 20);
  const volZ = rollingZscore(volume, 20);
  const rsi14 = rsi(close, 14);
  const bb = bollinger(close, 20, 2);

  const result: EnrichedCandle[] = [];
  for (let i = 0; i < n; i++) {
    const k = klines[i];
    const range = high[i] - low[i];
    const body = Math.abs(close[i] - open[i]);
    const bodyRatio = range > 0 ? body / range : 0;
    const closePosition = range > 0 ? (close[i] - low[i]) / range : 0.5;

    const ma25Val = ma25[i];
    const ma25Prev = i >= 5 ? ma25[i - 5] : null;
    const ma25Slope = ma25Val !== null && ma25Prev !== null ? ma25Val - ma25Prev : 0;

    const ma7Val = ma7[i];
    const atr14Val = atr14[i];
    const displacement = ma7Val !== null && atr14Val !== null && atr14Val > 0
      ? (close[i] - ma7Val) / atr14Val : 0;

    result.push({
      symbol: k.symbol,
      timeframe: k.timeframe,
      timestamp: k.timestamp,
      open: open[i], high: high[i], low: low[i], close: close[i], volume: volume[i],
      ma7: ma7Val ?? 0, ma25: ma25Val ?? 0, ma99: ma99[i] ?? 0,
      atr14: atr14Val ?? 0, volumeMa20: volMa20[i] ?? 0,
      volumeZscore: volZ[i] ?? 0, range, body, bodyRatio, closePosition,
      ma25Slope, rsi14: rsi14[i] ?? 0,
      bbMid: bb.mid[i] ?? 0, bbUpper: bb.upper[i] ?? 0,
      bbLower: bb.lower[i] ?? 0, bbWidth: bb.width[i] ?? 0,
      displacement,
    });
  }
  return result;
}

/* ─── Roll Windows ───────────────────────────────────────────────────────── */

function rollMax(values: number[], start: number, end: number): number {
  let m = -Infinity;
  for (let i = start; i < end; i++) if (values[i] > m) m = values[i];
  return m;
}

function rollMin(values: number[], start: number, end: number): number {
  let m = Infinity;
  for (let i = start; i < end; i++) if (values[i] < m) m = values[i];
  return m;
}

function rollAvg(values: number[], start: number, end: number): number {
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += values[i];
  return sum / (end - start);
}

/* ─── ICR Structure Detection ─────────────────────────────────────────────── */

interface Impulse {
  start: number; end: number;
  origin: number; extreme: number;
  rangeValue: number; avgVolume: number; score: number;
}

interface Compression {
  start: number; end: number;
  high: number; low: number;
  score: number; avgVolume: number; avgRange: number;
}

function findImpulse(
  candles: EnrichedCandle[], i: number, direction: "long" | "short",
): Impulse | null {
  const minBars = 2, maxBars = 14;
  const maxAge = 35;
  const impulseAtrMult = 1.2;
  const impulseVolMult = 1.0;
  const lookback = 50;

  const latestEnd = i - 2; // minPullbackBars
  const earliestEnd = Math.max(0, i - maxAge);
  let best: Impulse | null = null;

  for (let end = latestEnd; end >= earliestEnd; end--) {
    for (let len = minBars; len <= maxBars; len++) {
      const start = end - len + 1;
      if (start <= lookback || start < 0 || end >= candles.length) continue;

      const endCandle = candles[end];
      if (!Number.isFinite(endCandle.atr14) || endCandle.atr14 <= 0) continue;

      const segHigh = rollMax(candles.map((c) => c.high), start, end + 1);
      const segLow = rollMin(candles.map((c) => c.low), start, end + 1);
      const rng = segHigh - segLow;
      if (rng <= impulseAtrMult * endCandle.atr14) continue;

      const segVol = rollAvg(candles.map((c) => c.volume), start, end + 1);
      if (segVol <= impulseVolMult * endCandle.volumeMa20) continue;

      let closeBreak: boolean, maSep: boolean, directional: boolean;
      let origin: number, extreme: number;

      if (direction === "long") {
        const ph = rollMax(candles.map((c) => c.high), Math.max(0, start - lookback), start);
        if (!Number.isFinite(ph)) continue;
        closeBreak = candles[end].close > ph;
        maSep = endCandle.ma7 - endCandle.ma25 >= 0.03 * endCandle.atr14;
        directional = candles[end].close > candles[start].open;
        if (!(closeBreak && maSep && directional)) continue;
        origin = segLow; extreme = segHigh;
      } else {
        const pl = rollMin(candles.map((c) => c.low), Math.max(0, start - lookback), start);
        if (!Number.isFinite(pl)) continue;
        closeBreak = candles[end].close < pl;
        maSep = endCandle.ma25 - endCandle.ma7 >= 0.03 * endCandle.atr14;
        directional = candles[end].close < candles[start].open;
        if (!(closeBreak && maSep && directional)) continue;
        origin = segHigh; extreme = segLow;
      }

      let score = 0;
      score += rng >= 2.0 * endCandle.atr14 ? 6 : 4;
      score += segVol >= 1.25 * endCandle.volumeMa20 ? 5 : 3;
      score += closeBreak ? 5 : 0;
      score += maSep ? 4 : 0;

      const candidate: Impulse = { start, end, origin, extreme, rangeValue: rng, avgVolume: segVol, score: Math.min(20, score) };
      if (best === null || candidate.end > best.end || (candidate.end === best.end && candidate.score > best.score)) {
        best = candidate;
      }
    }
  }
  return best;
}

function validatePullback(
  candles: EnrichedCandle[], i: number, impulse: Impulse, direction: "long" | "short",
): { valid: boolean; score: number } {
  const start = impulse.end + 1;
  const end = i - 1;
  if (end - start + 1 < 2) return { valid: false, score: 0 };

  const pullback = candles.slice(start, end + 1);
  const triggerPrev = candles[end];
  if (!Number.isFinite(triggerPrev.ma25) || !Number.isFinite(triggerPrev.atr14)) {
    return { valid: false, score: 0 };
  }

  const avgVol = pullback.reduce((s, c) => s + c.volume, 0) / pullback.length;
  const avgRange = pullback.reduce((s, c) => s + c.range, 0) / pullback.length;
  const impulseAvgRange = impulse.rangeValue / Math.max(1, impulse.end - impulse.start + 1);

  const nearMa = pullback.some(
    (c) => Math.abs(c.close - c.ma25) <= 1.5 * triggerPrev.atr14,
  );
  const volOk = avgVol <= impulse.avgVolume * 1.15;
  const rangeOk = avgRange <= impulseAvgRange * 1.1;

  let holdsOrigin: boolean;
  if (direction === "long") {
    holdsOrigin = rollMin(candles.map((c) => c.low), start, end + 1) > impulse.origin;
  } else {
    holdsOrigin = rollMax(candles.map((c) => c.high), start, end + 1) < impulse.origin;
  }

  let score = 0;
  score += volOk ? 5 : 0;
  score += rangeOk ? 4 : 0;
  score += nearMa ? 3 : 0;
  score += holdsOrigin ? 3 : 0;
  return { valid: score >= 10, score: Math.min(15, score) };
}

function findCompression(
  candles: EnrichedCandle[], i: number, direction: "long" | "short",
): Compression | null {
  const lookback = 8;
  const end = i - 1;
  const start = end - lookback + 1;
  const prevStart = start - lookback;
  if (prevStart < 0 || start < 0) return null;

  const row = candles[end];
  if (!Number.isFinite(row.ma25) || !Number.isFinite(row.atr14)) return null;

  const compHigh = rollMax(candles.map((c) => c.high), start, end + 1);
  const compLow = rollMin(candles.map((c) => c.low), start, end + 1);
  const width = compHigh - compLow;

  const compRange = rollAvg(candles.map((c) => c.range), start, end + 1);
  const prevRange = rollAvg(candles.map((c) => c.range), prevStart, start);
  const compAtr = rollAvg(candles.map((c) => c.atr14), start, end + 1);
  const prevAtr = rollAvg(candles.map((c) => c.atr14), prevStart, start);
  const compVolume = rollAvg(candles.map((c) => c.volume), start, end + 1);
  const prevVolume = rollAvg(candles.map((c) => c.volume), prevStart, start);

  const rangeContract = compRange <= prevRange * 0.95;
  const atrContract = compAtr <= prevAtr * 0.99;
  const volumeContract = compVolume <= Math.min(prevVolume, row.volumeMa20) * 1.05;
  const nearMa = candles.slice(start, end + 1).some(
    (c) => Math.abs(c.close - c.ma25) <= 1.5 * row.atr14,
  );
  const narrow = width <= 4.0 * row.atr14;

  let score = 0;
  score += rangeContract ? 3 : 0;
  score += atrContract ? 3 : 0;
  score += volumeContract ? 3 : 0;
  score += nearMa ? 2 : 0;
  score += narrow ? 2 : 0;

  if (score < 8) return null;
  return { direction, start, end, high: compHigh, low: compLow, score: Math.min(15, score), avgVolume: compVolume, avgRange: compRange };
}

function volumeConfirmation(candle: EnrichedCandle, baselineVol: number): number {
  if (!Number.isFinite(baselineVol) || baselineVol <= 0) return 0;
  const ratio = candle.volume / baselineVol;
  const z = candle.volumeZscore;
  if (ratio >= 1.35 || z >= 1.5) return 10;
  if (ratio >= 1.15 || z >= 1.0) return 8;
  if (ratio >= 1.0) return 6;
  return 0;
}

function computeTriggerScore(
  candle: EnrichedCandle, compression: Compression,
  direction: "long" | "short",
): { triggered: boolean; score: number } {
  const close = candle.close;
  const ma7 = candle.ma7;
  let level: number;
  let decisive: boolean;

  if (direction === "long") {
    level = Math.max(compression.high, ma7);
    decisive = close > level && candle.closePosition >= 0.55;
  } else {
    level = Math.min(compression.low, ma7);
    decisive = close < level && candle.closePosition <= 0.45;
  }

  if (!decisive) return { triggered: false, score: 0 };

  let score = 10;
  const dist = direction === "long" ? close - level : level - close;
  if (candle.atr14 > 0 && dist >= 0.2 * candle.atr14) score += 3;
  if (candle.bodyRatio >= 0.5) score += 2;
  if (candle.displacement >= 1.0) score += 1;
  return { triggered: true, score: Math.min(15, score) };
}

function computeRRScore(rr: number): number {
  if (!Number.isFinite(rr) || rr < 1.5) return 0;
  if (rr >= 4.0) return 5;
  if (rr >= 3.0) return 4;
  return 3;
}

/* ─── Feature Computation ─────────────────────────────────────────────────── */

const TIMEFRAME_MAP: Record<string, number> = {
  "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
  "1h": 60, "2h": 120, "4h": 240, "6h": 360,
  "8h": 480, "12h": 720, "1d": 1440, "3d": 4320, "1w": 10080,
};

function computeFeatures(
  candles: EnrichedCandle[],
  i: number,
  direction: "long" | "short",
  pairIdx: number,
  stopAtrMult: number,
  tpAtrMult: number,
): FeatureRow | null {
  const candle = candles[i];
  if (!candle) return null;

  // Must have at least MA99 warmup (99 bars) and valid ATR
  if (i < 99) return null;
  if (!Number.isFinite(candle.atr14) || candle.atr14 <= 0) return null;
  if (!Number.isFinite(candle.close) || candle.close <= 0) return null;

  /* ── Market Structure Features ─────────────────────────────────────── */
  const ma7Slope = linearSlope(candles.map((c) => c.ma7), 5, i);
  const ma25Slope = candle.ma25Slope;
  const ma99Slope = linearSlope(candles.map((c) => c.ma99), 5, i);
  const maSeparation = (candle.ma7 - candle.ma25) / candle.atr14;

  // ATR percentile (20-bar lookback)
  const atrWindow = candles.slice(Math.max(0, i - 19), i + 1).map((c) => c.atr14);
  const atrPctRank = atrWindow.filter((v) => v <= candle.atr14).length / atrWindow.length;

  // BB position: where is close within the BB envelope?
  const bbRange = candle.bbUpper - candle.bbLower;
  const bbPosition = bbRange > 0 ? (candle.close - candle.bbLower) / bbRange : 0.5;

  // Volume trend: slope of volume MA20
  const volTrend = linearSlope(candles.map((c) => c.volumeMa20), 5, i);

  /* ── ICR Gate Scores ───────────────────────────────────────────────── */
  const gates = computeGateScores(candles, i, direction);

  /* ── Trade Structure ───────────────────────────────────────────────── */
  // Determine stop and TP based on compression if available, else ATR-based
  let stop: number;
  let tp: number;

  if (gates.compression > 0) {
    // Use compression-based stop
    const comp = findCompression(candles, i, direction);
    if (comp) {
      const atrBuffer = 0.1 * candle.atr14;
      if (direction === "long") {
        stop = comp.low - atrBuffer;
      } else {
        stop = comp.high + atrBuffer;
      }
      // TP based on impulse extreme if available
      const impulse = findImpulse(candles, i, direction);
      const risk = Math.abs(candle.close - stop);
      const tpFromImpulse = impulse
        ? (direction === "long"
            ? Math.max(impulse.extreme, candle.close + 3 * risk)
            : Math.min(impulse.extreme, candle.close - 3 * risk))
        : (direction === "long" ? candle.close + tpAtrMult * candle.atr14 : candle.close - tpAtrMult * candle.atr14);
      tp = tpFromImpulse;
    } else {
      // Fallback ATR-based
      stop = direction === "long"
        ? candle.close - stopAtrMult * candle.atr14
        : candle.close + stopAtrMult * candle.atr14;
      tp = direction === "long"
        ? candle.close + tpAtrMult * candle.atr14
        : candle.close - tpAtrMult * candle.atr14;
    }
  } else {
    // No compression detected — use ATR-based stop/TP
    stop = direction === "long"
      ? candle.close - stopAtrMult * candle.atr14
      : candle.close + stopAtrMult * candle.atr14;
    tp = direction === "long"
      ? candle.close + tpAtrMult * candle.atr14
      : candle.close - tpAtrMult * candle.atr14;
  }

  const risk = Math.abs(candle.close - stop);
  const reward = Math.abs(tp - candle.close);
  const rrRatio = risk > 0 ? reward / risk : 0;
  const stopDistAtr = candle.atr14 > 0 ? risk / candle.atr14 : stopAtrMult;
  const targetDistAtr = candle.atr14 > 0 ? reward / candle.atr14 : tpAtrMult;

  /* ── Context Features ──────────────────────────────────────────────── */
  const ts = new Date(candle.timestamp);
  const hourOfDay = ts.getUTCHours();
  const dayOfWeek = ts.getUTCDay();
  const maRegime = ma99Slope > 0.0001 ? 1 : ma99Slope < -0.0001 ? -1 : 0;
  const volRegime = atrPctRank;

  return {
    symbol: candle.symbol,
    timeframe: candle.timeframe,
    timestamp: candle.timestamp,
    direction,

    // Market Structure
    ma7_slope: ma7Slope,
    ma25_slope: ma25Slope,
    ma99_slope: ma99Slope,
    ma_separation: maSeparation,
    atr14: candle.atr14,
    atr_percentile: atrPctRank,
    bb_width: candle.bbWidth,
    bb_position: bbPosition,
    volume_zscore: candle.volumeZscore,
    volume_trend: volTrend,
    rsi14: candle.rsi14,
    displacement: candle.displacement,

    // ICR Gate Scores
    trend_score: gates.trend,
    impulse_score: gates.impulse,
    pullback_score: gates.pullback,
    compression_score: gates.compression,
    trigger_score: gates.trigger,
    volume_score: gates.volume,
    rr_score: gates.rr,

    // Trade Structure
    rr_ratio: rrRatio,
    stop_dist_atr: stopDistAtr,
    target_dist_atr: targetDistAtr,
    timeframe_encoded: TIMEFRAME_MAP[candle.timeframe] ?? 240,

    // Context
    hour_of_day: hourOfDay,
    day_of_week: dayOfWeek,
    ma_regime: maRegime,
    vol_regime: volRegime,
    pair_encoded: pairIdx,
    direction_encoded: direction === "long" ? 1 : 0,

    // Labels (filled later)
    hitTP: false,
    hitStop: false,
    maxFavorableR: 0,
    maxAdverseR: 0,
    pnlR: 0,
    barsToOutcome: 0,
  };
}

function computeGateScores(
  candles: EnrichedCandle[], i: number, direction: "long" | "short",
): GateScores {
  const candle = candles[i];

  /* Trend gate (20 pts) */
  let trendOk: boolean;
  if (direction === "long") {
    trendOk = candle.ma7 > candle.ma25 && candle.ma25 > candle.ma99 &&
      candle.close > candle.ma25 && candle.ma25Slope > 0;
  } else {
    trendOk = candle.ma7 < candle.ma25 && candle.ma25 < candle.ma99 &&
      candle.close < candle.ma25 && candle.ma25Slope < 0;
  }
  const trendScore = trendOk ? 20 : 0;

  /* Impulse detection (0-20 pts) */
  const impulse = findImpulse(candles, i, direction);
  const impulseScore = impulse ? impulse.score : 0;

  /* Pullback validation (0-15 pts) */
  let pullbackScore = 0;
  if (impulse) {
    const pb = validatePullback(candles, i, impulse, direction);
    pullbackScore = pb.valid ? pb.score : 0;
  }

  /* Compression detection (0-15 pts) */
  const compression = findCompression(candles, i, direction);
  const compressionScore = compression ? compression.score : 0;

  /* Trigger confirmation (0-15 pts) */
  let triggerScoreVal = 0;
  if (compression) {
    const trig = computeTriggerScore(candle, compression, direction);
    triggerScoreVal = trig.score;
  }

  /* Volume confirmation (0, 6, 8, 10) */
  let volumeScoreVal = 0;
  if (compression) {
    volumeScoreVal = volumeConfirmation(candle, compression.avgVolume);
  }

  /* RR score (0, 3, 4, 5) */
  let rrScoreVal = 0;
  if (compression && impulse) {
    const entry = candle.close;
    const atrBuffer = 0.1 * candle.atr14;
    let stop: number;
    if (direction === "long") {
      stop = compression.low - atrBuffer;
    } else {
      stop = compression.high + atrBuffer;
    }
    const risk = Math.abs(entry - stop);
    if (risk > 0) {
      const tp = direction === "long"
        ? Math.max(impulse.extreme, entry + 3.0 * risk, entry + 0.75 * impulse.rangeValue)
        : Math.min(impulse.extreme, entry - 3.0 * risk, entry - 0.75 * impulse.rangeValue);
      const rr = direction === "long" ? (tp - entry) / risk : (entry - tp) / risk;
      rrScoreVal = computeRRScore(rr);
    }
  }

  return {
    trend: trendScore,
    impulse: impulseScore,
    pullback: pullbackScore,
    compression: compressionScore,
    trigger: triggerScoreVal,
    volume: volumeScoreVal,
    rr: rrScoreVal,
  };
}

/* ─── Forward Outcome Computation ─────────────────────────────────────────── */

function computeForwardOutcome(
  candles: EnrichedCandle[],
  entryIdx: number,
  direction: "long" | "short",
  entry: number,
  stop: number,
  tp: number,
  maxLookforward: number,
): ForwardOutcome {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) {
    return { hitTP: false, hitStop: false, maxFavorableR: 0, maxAdverseR: 0, pnlR: 0, barsToOutcome: 0 };
  }

  let maxFav = 0;
  let maxAdv = 0;
  let hitTP = false;
  let hitStop = false;
  let pnlR = 0;
  let barsToOutcome = 0;

  const lookEnd = Math.min(candles.length, entryIdx + 1 + maxLookforward);

  for (let j = entryIdx + 1; j < lookEnd; j++) {
    const c = candles[j];
    barsToOutcome = j - entryIdx;

    if (direction === "long") {
      const favR = (c.high - entry) / risk;
      const advR = (entry - c.low) / risk;
      maxFav = Math.max(maxFav, favR);
      maxAdv = Math.max(maxAdv, advR);

      if (c.high >= tp && !hitStop) {
        hitTP = true;
        pnlR = (tp - entry) / risk;
        break;
      }
      if (c.low <= stop && !hitTP) {
        hitStop = true;
        pnlR = -1;
        break;
      }
    } else {
      const favR = (entry - c.low) / risk;
      const advR = (c.high - entry) / risk;
      maxFav = Math.max(maxFav, favR);
      maxAdv = Math.max(maxAdv, advR);

      if (c.low <= tp && !hitStop) {
        hitTP = true;
        pnlR = (entry - tp) / risk;
        break;
      }
      if (c.high >= stop && !hitTP) {
        hitStop = true;
        pnlR = -1;
        break;
      }
    }
  }

  // If neither TP nor stop was hit, mark-to-market at last candle
  if (!hitTP && !hitStop) {
    const lastCandle = candles[lookEnd - 1];
    if (lastCandle) {
      pnlR = direction === "long"
        ? (lastCandle.close - entry) / risk
        : (entry - lastCandle.close) / risk;
    }
    barsToOutcome = Math.min(maxLookforward, candles.length - entryIdx - 1);
  }

  return {
    hitTP,
    hitStop,
    maxFavorableR: maxFav,
    maxAdverseR: maxAdv,
    pnlR: Math.max(-1, pnlR), // Cap loss at -1R
    barsToOutcome,
  };
}

/* ─── Main Pipeline ───────────────────────────────────────────────────────── */

function processGroup(
  group: InputGroup,
  pairIdx: number,
  args: CliArgs,
): FeatureRow[] {
  const rows: FeatureRow[] = [];

  // Sort klines by timestamp ascending
  const sorted = [...group.klines].sort((a, b) => a.timestamp - b.timestamp);

  // Enrich candles
  const candles = enrichCandles(sorted);

  // Minimum warmup: MA99 (99 bars) + max lookforward buffer
  const warmupIdx = 99;

  for (let i = warmupIdx; i < candles.length - 1; i++) {
    for (const dir of ["long", "short"] as const) {
      const row = computeFeatures(candles, i, dir, pairIdx, args.stopAtrMult, args.tpAtrMult);
      if (!row) continue;

      // Compute forward outcome using the stop/TP from the feature row
      const entry = candles[i].close;
      const risk = Math.abs(entry - (dir === "long"
        ? entry - row.stop_dist_atr * candles[i].atr14
        : entry + row.stop_dist_atr * candles[i].atr14));

      const stop = dir === "long" ? entry - risk : entry + risk;
      const tp = dir === "long" ? entry + risk * row.rr_ratio : entry - risk * row.rr_ratio;

      // Recalculate stop/TP using the actual feature values for consistency
      const actualStop = dir === "long"
        ? entry - row.stop_dist_atr * candles[i].atr14
        : entry + row.stop_dist_atr * candles[i].atr14;
      const actualTp = dir === "long"
        ? entry + row.target_dist_atr * candles[i].atr14
        : entry - row.target_dist_atr * candles[i].atr14;

      const outcome = computeForwardOutcome(
        candles, i, dir, entry, actualStop, actualTp, args.maxLookforward,
      );

      row.hitTP = outcome.hitTP;
      row.hitStop = outcome.hitStop;
      row.maxFavorableR = outcome.maxFavorableR;
      row.maxAdverseR = outcome.maxAdverseR;
      row.pnlR = outcome.pnlR;
      row.barsToOutcome = outcome.barsToOutcome;

      rows.push(row);
    }
  }

  return rows;
}

/* ─── Output ──────────────────────────────────────────────────────────────── */

const CSV_HEADER = [
  "symbol", "timeframe", "timestamp", "direction",
  "ma7_slope", "ma25_slope", "ma99_slope", "ma_separation",
  "atr14", "atr_percentile", "bb_width", "bb_position",
  "volume_zscore", "volume_trend", "rsi14", "displacement",
  "trend_score", "impulse_score", "pullback_score", "compression_score",
  "trigger_score", "volume_score", "rr_score",
  "rr_ratio", "stop_dist_atr", "target_dist_atr", "timeframe_encoded",
  "hour_of_day", "day_of_week", "ma_regime", "vol_regime",
  "pair_encoded", "direction_encoded",
  "hitTP", "hitStop", "maxFavorableR", "maxAdverseR", "pnlR", "barsToOutcome",
].join(",");

function toCsv(rows: FeatureRow[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push([
      r.symbol, r.timeframe, r.timestamp, r.direction,
      r.ma7_slope, r.ma25_slope, r.ma99_slope, r.ma_separation,
      r.atr14, r.atr_percentile, r.bb_width, r.bb_position,
      r.volume_zscore, r.volume_trend, r.rsi14, r.displacement,
      r.trend_score, r.impulse_score, r.pullback_score, r.compression_score,
      r.trigger_score, r.volume_score, r.rr_score,
      r.rr_ratio, r.stop_dist_atr, r.target_dist_atr, r.timeframe_encoded,
      r.hour_of_day, r.day_of_week, r.ma_regime, r.vol_regime,
      r.pair_encoded, r.direction_encoded,
      r.hitTP, r.hitStop, r.maxFavorableR, r.maxAdverseR, r.pnlR, r.barsToOutcome,
    ].join(","));
  }
  return lines.join("\n");
}

/* ─── Entry Point ─────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`Loading klines from ${args.input}...`);
  const raw = fs.readFileSync(args.input, "utf-8");
  const inputData: InputGroup[] = JSON.parse(raw);

  if (!Array.isArray(inputData) || inputData.length === 0) {
    console.error("Input must be a non-empty array of { symbol, timeframe, klines } objects");
    process.exit(1);
  }

  console.log(`Processing ${inputData.length} symbol+timeframe groups...`);
  console.log(`Stop ATR mult: ${args.stopAtrMult}, TP ATR mult: ${args.tpAtrMult}, Max lookforward: ${args.maxLookforward}`);

  const allRows: FeatureRow[] = [];
  const pairMap = new Map<string, number>();
  let pairIdx = 0;

  for (const group of inputData) {
    if (!group.symbol || !group.timeframe || !Array.isArray(group.klines)) {
      console.warn(`Skipping invalid group: missing symbol/timeframe/klines`);
      continue;
    }
    if (group.klines.length < 100) {
      console.warn(`Skipping ${group.symbol} ${group.timeframe}: only ${group.klines.length} klines (need >= 100)`);
      continue;
    }

    const key = group.symbol;
    if (!pairMap.has(key)) {
      pairMap.set(key, pairIdx++);
    }
    const pIdx = pairMap.get(key)!;

    console.log(`  ${group.symbol} ${group.timeframe}: ${group.klines.length} klines...`);
    const rows = processGroup(group, pIdx, args);
    allRows.push(...rows);
    console.log(`    -> ${rows.length} feature rows generated`);
  }

  console.log(`\nTotal feature rows: ${allRows.length}`);

  // Stats
  const hitTP = allRows.filter((r) => r.hitTP).length;
  const hitStop = allRows.filter((r) => r.hitStop).length;
  const neither = allRows.length - hitTP - hitStop;
  console.log(`Label distribution: TP=${hitTP} (${(hitTP / allRows.length * 100).toFixed(1)}%), Stop=${hitStop} (${(hitStop / allRows.length * 100).toFixed(1)}%), Open=${neither} (${(neither / allRows.length * 100).toFixed(1)}%)`);

  const avgFavR = allRows.reduce((s, r) => s + r.maxFavorableR, 0) / allRows.length;
  const avgAdvR = allRows.reduce((s, r) => s + r.maxAdverseR, 0) / allRows.length;
  const avgPnlR = allRows.reduce((s, r) => s + r.pnlR, 0) / allRows.length;
  console.log(`Avg MFE: ${avgFavR.toFixed(3)}R, Avg MAE: ${avgAdvR.toFixed(3)}R, Avg PnL: ${avgPnlR.toFixed(3)}R`);

  // Write output
  if (args.format === "csv") {
    console.log(`Writing CSV to ${args.output}...`);
    fs.writeFileSync(args.output, toCsv(allRows), "utf-8");
  } else {
    console.log(`Writing JSON to ${args.output}...`);
    fs.writeFileSync(args.output, JSON.stringify(allRows), "utf-8");
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
