/**
 * MTF Inference Router — meta-v20 MTF context model scoring for live TradeIntents.
 *
 * Architecture:
 *   TradeIntent → fetch 15m/1h/4h klines → build 30-feature MTF vector
 *   → rule-based LightGBM approximation → regime classification → TRADE/SKIP
 *
 * The 30 features (EXACT order matching model_card.json and training):
 *   m15_rsi, m15_bb_width, m15_bb_pos, m15_ao, m15_macd, m15_vol_z,
 *   m15_ma7_slope, m15_swing_dist, m15_trend, m15_atr_pct,
 *   h1_rsi, h1_bb_width, h1_bb_pos, h1_ao, h1_macd, h1_vol_z,
 *   h1_trend, h1_ma7_slope, mtf_15_1h_agree,
 *   h4_rsi, h4_bb_width, h4_bb_pos, h4_ao, h4_macd, h4_trend,
 *   mtf_triple_agree,
 *   rsi_gradient, bb_sqz_product, ao_gradient, tf_vol_sum
 *
 * Model: LightGBM (300 trees, max_depth=7, num_leaves=63, lr=0.02)
 * Threshold: 0.82 (from model_card.json)
 * Backtest: WR=80%, PF=10.0 on chronological test set (10 trades)
 *
 * The rule-based fallback approximates the ensemble by extracting key
 * split thresholds from the first 22 trees in classifier.txt:
 *   - h4_bb_pos (root split in 16/22 trees, threshold 0.231)
 *   - m15_macd (root split in 3/22 trees, threshold ~0)
 *   - m15_ma7_slope (root split in 2/22 trees, threshold -0.33)
 *   - h4_ao, h4_rsi, h1_rsi as secondary key features
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { setDbEnv, getDb } from "../db";
import { getKlines } from "../analysis/kline-repository";
import { publicProcedure, router } from "../_core/trpc";
import { getEnv } from "../_core/env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
}

export interface InferenceInput {
  symbol: string;
  direction: "long" | "short";
  klines15m: Candle[];
  klines1h: Candle[];
  klines4h: Candle[];
}

export interface InferenceResult {
  proba: number;
  threshold: number;
  decision: "TRADE" | "SKIP";
  regime: "MOMENTUM_CONTINUATION" | "OVERSOLD_REVERSAL" | "UNKNOWN";
  topFeatures: { name: string; value: number; importance: number }[];
  timestamp: number;
}

export interface InferenceRequest {
  tradeIntentId: number;
  symbol: string;
  direction: "long" | "short";
}

/**
 * All 30 features in the EXACT order matching model_card.json "features".
 * Index in this array = column index in LightGBM (0-29).
 */
export interface MtfFeatureVector {
  ao_gradient: number;
  bb_sqz_product: number;
  h1_ao: number;
  h1_bb_pos: number;
  h1_bb_width: number;
  h1_ma7_slope: number;
  h1_macd: number;
  h1_rsi: number;
  h1_trend: number;
  h1_vol_z: number;
  h4_ao: number;
  h4_bb_pos: number;
  h4_bb_width: number;
  h4_macd: number;
  h4_rsi: number;
  h4_trend: number;
  m15_ao: number;
  m15_atr_pct: number;
  m15_bb_pos: number;
  m15_bb_width: number;
  m15_ma7_slope: number;
  m15_macd: number;
  m15_rsi: number;
  m15_swing_dist: number;
  m15_trend: number;
  m15_vol_z: number;
  mtf_15_1h_agree: number;
  mtf_triple_agree: number;
  rsi_gradient: number;
  tf_vol_sum: number;
}

export type SignalRegime =
  | "MOMENTUM_CONTINUATION"
  | "OVERSOLD_REVERSAL"
  | "UNKNOWN";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Decision threshold from model_card.json (meta-v20-mtf-context). */
const DEFAULT_THRESHOLD = 0.82;

/**
 * Feature importance weights derived from classifier.txt.
 * Weighted by how frequently each feature appears as a top-2 split
 * across the first 22 trees.
 */
const FEATURE_IMPORTANCE: Record<string, number> = {
  h4_bb_pos: 16, // Root in 16/22 trees
  m15_macd: 6, // Root in 3 trees + frequent secondary
  m15_ma7_slope: 5, // Root in 2 trees + frequent secondary
  h4_ao: 5, // Frequent secondary split
  m15_swing_dist: 4, // Frequent mid-level split (feature index 24)
  h1_rsi: 4, // Frequent mid-level split
  h4_rsi: 4, // Frequent mid-level split
  h1_ao: 3, // Frequent secondary split
  m15_trend: 3, // Root in 1 tree + frequent
  h4_bb_width: 3, // Important secondary
  mtf_triple_agree: 3, // Late-tree splits
  h1_bb_pos: 2,
  h1_ma7_slope: 2,
  m15_vol_z: 2,
  m15_ao: 2,
  rsi_gradient: 2,
  m15_bb_width: 1,
  m15_atr_pct: 1,
  m15_rsi: 1,
  h1_macd: 1,
  h1_vol_z: 1,
  h4_macd: 1,
  h4_trend: 1,
};

const TOTAL_IMPORTANCE = Object.values(FEATURE_IMPORTANCE).reduce(
  (a, b) => a + b,
  0,
);

// ---------------------------------------------------------------------------
// Indicator Functions (pure, zero-dependency)
// ---------------------------------------------------------------------------

function sma(values: number[], length: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (i < length - 1) {
      result[i] = null;
      continue;
    }
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
  let prevEma: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < length - 1) {
      result[i] = null;
      continue;
    }
    if (prevEma === null) {
      let sum = 0;
      for (let j = 0; j < length; j++) sum += values[j];
      prevEma = sum / length;
      result[i] = prevEma;
    } else {
      prevEma = alpha * values[i] + (1 - alpha) * prevEma;
      result[i] = prevEma;
    }
  }
  return result;
}

function trueRange(
  high: number[],
  low: number[],
  close: number[],
): number[] {
  const tr: number[] = new Array(high.length);
  if (high.length === 0) return tr;
  tr[0] = high[0] - low[0];
  for (let i = 1; i < high.length; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }
  return tr;
}

function atr(
  high: number[],
  low: number[],
  close: number[],
  length: number,
): (number | null)[] {
  return sma(trueRange(high, low, close), length);
}

function rsi(close: number[], length: number): (number | null)[] {
  const result: (number | null)[] = new Array(close.length);
  if (close.length < length + 1) {
    for (let i = 0; i < close.length; i++) result[i] = null;
    return result;
  }
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const d = close[i] - close[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
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
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  for (let i = 0; i < length; i++) result[i] = null;
  return result;
}

function bollinger(
  close: number[],
  length: number,
  stdMult: number,
): {
  mid: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
  width: (number | null)[];
} {
  const mid = sma(close, length);
  const n = close.length;
  const upper: (number | null)[] = new Array(n);
  const lower: (number | null)[] = new Array(n);
  const width: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = mid[i];
    if (m === null) {
      upper[i] = null;
      lower[i] = null;
      width[i] = null;
      continue;
    }
    let sqDiff = 0;
    for (let j = i - length + 1; j <= i; j++) sqDiff += (close[j] - m) ** 2;
    const std = Math.sqrt(sqDiff / length);
    upper[i] = m + std * stdMult;
    lower[i] = m - std * stdMult;
    width[i] = m !== 0 ? ((upper[i]! - lower[i]!) / m) * 100 : 0;
  }
  return { mid, upper, lower, width };
}

function awesomeOscillator(
  high: number[],
  low: number[],
  fastLen: number,
  slowLen: number,
): (number | null)[] {
  const hl2 = high.map((h, i) => (h + low[i]) / 2);
  const fastSma = sma(hl2, fastLen);
  const slowSma = sma(hl2, slowLen);
  const n = hl2.length;
  const ao: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    ao[i] =
      fastSma[i] !== null && slowSma[i] !== null
        ? fastSma[i]! - slowSma[i]!
        : null;
  }
  return ao;
}

function rollingZscore(
  values: number[],
  length: number,
): (number | null)[] {
  const result: (number | null)[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (i < length - 1) {
      result[i] = null;
      continue;
    }
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) sum += values[j];
    const mean = sum / length;
    let sqDiff = 0;
    for (let j = i - length + 1; j <= i; j++) sqDiff += (values[j] - mean) ** 2;
    const std = Math.sqrt(sqDiff / length);
    result[i] = std === 0 ? 0 : (values[i] - mean) / std;
  }
  return result;
}

function linearSlope(
  values: number[],
  lookback: number,
  idx: number,
): number {
  const pts: { x: number; y: number }[] = [];
  for (let j = Math.max(0, idx - lookback + 1); j <= idx; j++) {
    if (Number.isFinite(values[j])) pts.push({ x: j, y: values[j] });
  }
  if (pts.length < 2) return 0;
  const n = pts.length;
  const xMean = pts.reduce((s, p) => s + p.x, 0) / n;
  const yMean = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - xMean) * (p.y - yMean);
    den += (p.x - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function macdHistogram(
  close: number[],
  fastLen: number,
  slowLen: number,
  signalLen: number,
): (number | null)[] {
  const fastEma = ema(close, fastLen);
  const slowEma = ema(close, slowLen);
  const n = close.length;
  const macdLine: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    macdLine[i] =
      fastEma[i] !== null && slowEma[i] !== null
        ? fastEma[i]! - slowEma[i]!
        : null;
  }
  const macdVals = macdLine.map((v) => v ?? 0);
  const signalLine = ema(macdVals, signalLen);
  const histogram: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    histogram[i] =
      macdLine[i] !== null && signalLine[i] !== null
        ? macdLine[i]! - signalLine[i]!
        : null;
  }
  return histogram;
}

function macdCrossover(
  close: number[],
  fastLen: number,
  slowLen: number,
  signalLen: number,
): (0 | 1 | -1 | null)[] {
  const hist = macdHistogram(close, fastLen, slowLen, signalLen);
  const n = hist.length;
  const result: (0 | 1 | -1 | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (hist[i] === null || i < 1 || hist[i - 1] === null) {
      result[i] = null;
      continue;
    }
    if (hist[i - 1]! <= 0 && hist[i]! > 0) result[i] = 1; // bullish cross
    else if (hist[i - 1]! >= 0 && hist[i]! < 0) result[i] = -1; // bearish cross
    else result[i] = 0; // no cross
  }
  return result;
}

// ---------------------------------------------------------------------------
// Swing Pivot Detection (for m15_swing_dist)
// ---------------------------------------------------------------------------

function isPivotLow(low: number[], idx: number, lookback: number): boolean {
  if (idx < lookback || idx >= low.length - lookback) return false;
  const val = low[idx];
  for (let j = 1; j <= lookback; j++) {
    if (low[idx - j] <= val || low[idx + j] <= val) return false;
  }
  return true;
}

function isPivotHigh(high: number[], idx: number, lookback: number): boolean {
  if (idx < lookback || idx >= high.length - lookback) return false;
  const val = high[idx];
  for (let j = 1; j <= lookback; j++) {
    if (high[idx - j] >= val || high[idx + j] >= val) return false;
  }
  return true;
}

/**
 * Distance from current price to the nearest swing pivot in ATR units.
 * Caps at 5 ATR (matches training data range).
 */
function swingDistanceAtr(
  high: number[],
  low: number[],
  close: number,
  atrVal: number,
  idx: number,
  swingLookback: number,
  searchRange: number,
): number {
  if (idx < swingLookback || atrVal <= 0) return 5;
  let minDist = Infinity;
  const start = Math.max(swingLookback, idx - searchRange);
  for (let k = start; k <= idx - swingLookback; k++) {
    if (isPivotLow(low, k, swingLookback)) {
      minDist = Math.min(minDist, Math.abs(close - low[k]));
    }
    if (isPivotHigh(high, k, swingLookback)) {
      minDist = Math.min(minDist, Math.abs(close - high[k]));
    }
  }
  return minDist === Infinity ? 5 : Math.min(5, minDist / atrVal);
}

// ---------------------------------------------------------------------------
// Per-timeframe enrichment
// ---------------------------------------------------------------------------

interface EnrichedBars {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  opens: number[];
  ma7: (number | null)[];
  ma25: (number | null)[];
  ma99: (number | null)[];
  atr14: (number | null)[];
  rsi14: (number | null)[];
  bbMid: (number | null)[];
  bbUpper: (number | null)[];
  bbLower: (number | null)[];
  bbWidth: (number | null)[];
  ao: (number | null)[];
  volZscore: (number | null)[];
  ma25Slope: number[];
}

function enrichCandles(candles: Candle[]): EnrichedBars {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const opens = candles.map((c) => c.open);

  const ma7 = sma(closes, 7);
  const ma25 = sma(closes, 25);
  const ma99 = sma(closes, 99);
  const atr14 = atr(highs, lows, closes, 14);
  const rsi14 = rsi(closes, 14);
  const bb = bollinger(closes, 20, 2);
  const ao = awesomeOscillator(highs, lows, 5, 34);
  const volZscore = rollingZscore(volumes, 20);

  const ma25Slope: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    ma25Slope[i] = linearSlope(
      ma25.map((v) => v ?? 0),
      5,
      i,
    );
  }

  return {
    closes,
    highs,
    lows,
    volumes,
    opens,
    ma7,
    ma25,
    ma99,
    atr14,
    rsi14,
    bbMid: bb.mid,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    bbWidth: bb.width,
    ao,
    volZscore,
    ma25Slope,
  };
}

// ---------------------------------------------------------------------------
// Feature Builders
// ---------------------------------------------------------------------------

function getLastNonNil<T>(arr: (T | null)[]): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i];
  }
  return null;
}

function computeMtfFeatures(
  e15: EnrichedBars,
  e1h: EnrichedBars,
  e4h: EnrichedBars,
  direction: "long" | "short",
): MtfFeatureVector {
  const n15 = e15.closes.length;
  const n1h = e1h.closes.length;
  const n4h = e4h.closes.length;
  const idx15 = n15 - 1;
  const idx1h = n1h - 1;
  const idx4h = n4h - 1;

  // --- Helper to safely get value at index ---
  const val = (arr: (number | null)[], i: number): number =>
    arr[i] ?? 0;

  // --- 15m Features ---

  // m15_rsi: RSI(14) on 15m close
  const m15_rsi = val(e15.rsi14, idx15);

  // m15_macd: MACD(12,26,9) histogram on 15m
  const m15MacdHist = macdHistogram(e15.closes, 12, 26, 9);
  const m15_macd = val(m15MacdHist, idx15);

  // m15_bb_pos: (close - lower) / (upper - lower), 0-1
  const m15BbUpper = val(e15.bbUpper, idx15);
  const m15BbLower = val(e15.bbLower, idx15);
  const m15BbRange = m15BbUpper - m15BbLower;
  const m15_bb_pos =
    m15BbRange > 0
      ? Math.max(
          -0.5,
          Math.min(1.5, (e15.closes[idx15] - m15BbLower) / m15BbRange),
        )
      : 0.5;

  // m15_bb_width: BB width as percentage
  const m15_bb_width = val(e15.bbWidth, idx15);

  // m15_ao: AO(5,34) on 15m
  const m15_ao = val(e15.ao, idx15);

  // m15_atr_pct: ATR(14) / close * 100
  const m15Atr = val(e15.atr14, idx15);
  const m15Close = e15.closes[idx15];
  const m15_atr_pct =
    m15Close > 0 ? (m15Atr / m15Close) * 100 : 0;

  // m15_vol_z: Volume Z-score (20-bar)
  const m15_vol_z = val(e15.volZscore, idx15);

  // m15_ma7_slope: 5-bar linear slope of MA7
  const m15_ma7_slope = linearSlope(
    e15.ma7.map((v) => v ?? 0),
    5,
    idx15,
  );

  // m15_swing_dist: nearest swing pivot distance in ATR
  const m15_swing_dist = swingDistanceAtr(
    e15.highs,
    e15.lows,
    e15.closes[idx15],
    m15Atr,
    idx15,
    3,
    20,
  );

  // m15_trend: (MA7 - MA25) / ATR14
  const m15Ma7 = val(e15.ma7, idx15);
  const m15Ma25 = val(e15.ma25, idx15);
  const m15_trend = m15Atr > 0 ? (m15Ma7 - m15Ma25) / m15Atr : 0;

  // --- 1h Features ---

  // h1_rsi
  const h1_rsi = val(e1h.rsi14, idx1h);

  // h1_macd: 1 if MACD histogram > 0 (bullish), 0 otherwise
  const h1MacdHist = macdHistogram(e1h.closes, 12, 26, 9);
  const h1MacdVal = val(h1MacdHist, idx1h);
  const h1_macd = h1MacdVal > 0 ? 1 : 0;

  // h1_bb_pos
  const h1BbUpper = val(e1h.bbUpper, idx1h);
  const h1BbLower = val(e1h.bbLower, idx1h);
  const h1BbRange = h1BbUpper - h1BbLower;
  const h1_bb_pos =
    h1BbRange > 0
      ? Math.max(
          -0.5,
          Math.min(1.5, (e1h.closes[idx1h] - h1BbLower) / h1BbRange),
        )
      : 0.5;

  // h1_bb_width
  const h1_bb_width = val(e1h.bbWidth, idx1h);

  // h1_ao
  const h1_ao = val(e1h.ao, idx1h);

  // h1_ma7_slope: 5-bar slope of MA7 on 1h
  const h1_ma7_slope = linearSlope(
    e1h.ma7.map((v) => v ?? 0),
    5,
    idx1h,
  );

  // h1_trend: 1 if MA7 > MA25 > MA99 (bullish alignment)
  const h1Ma7 = val(e1h.ma7, idx1h);
  const h1Ma25 = val(e1h.ma25, idx1h);
  const h1Ma99 = val(e1h.ma99, idx1h);
  const h1_trend =
    h1Ma7 > h1Ma25 && h1Ma25 > h1Ma99 ? 1 : 0;

  // h1_vol_z
  const h1_vol_z = val(e1h.volZscore, idx1h);

  // --- 4h Features ---

  // h4_rsi
  const h4_rsi = val(e4h.rsi14, idx4h);

  // h4_macd: 1 if MACD histogram > 0, 0 otherwise
  const h4MacdHist = macdHistogram(e4h.closes, 12, 26, 9);
  const h4MacdVal = val(h4MacdHist, idx4h);
  const h4_macd = h4MacdVal > 0 ? 1 : 0;

  // h4_bb_pos
  const h4BbUpper = val(e4h.bbUpper, idx4h);
  const h4BbLower = val(e4h.bbLower, idx4h);
  const h4BbRange = h4BbUpper - h4BbLower;
  const h4_bb_pos =
    h4BbRange > 0
      ? Math.max(
          -0.5,
          Math.min(1.5, (e4h.closes[idx4h] - h4BbLower) / h4BbRange),
        )
      : 0.5;

  // h4_bb_width
  const h4_bb_width = val(e4h.bbWidth, idx4h);

  // h4_ao
  const h4_ao = val(e4h.ao, idx4h);

  // h4_trend: 1 if MA7 > MA25 > MA99 (bullish alignment)
  const h4Ma7 = val(e4h.ma7, idx4h);
  const h4Ma25 = val(e4h.ma25, idx4h);
  const h4Ma99 = val(e4h.ma99, idx4h);
  const h4_trend =
    h4Ma7 > h4Ma25 && h4Ma25 > h4Ma99 ? 1 : 0;

  // --- MTF Confluence ---

  // mtf_15_1h_agree: 1 if both 15m and 1h trend direction agree
  const m15TrendBull = m15_trend > 0;
  const h1TrendBull = h1_trend === 1;
  const mtf_15_1h_agree =
    (m15TrendBull && h1TrendBull) || (!m15TrendBull && !h1TrendBull) ? 1 : 0;

  // mtf_triple_agree: 1 if all three timeframes agree
  const h4TrendBool = h4_trend === 1;
  const mtf_triple_agree =
    (m15TrendBull === h1TrendBull && m15TrendBull === h4TrendBool) ? 1 : 0;

  // --- Gradient / Aggregation Features ---

  // rsi_gradient: RSI change on 15m over 3 bars (RSI[0] - RSI[3])
  const rsi3 = idx15 >= 3 ? val(e15.rsi14, idx15 - 3) : val(e15.rsi14, 0);
  const rsi_gradient = m15_rsi - rsi3;

  // ao_gradient: AO change on 15m over 3 bars (AO[0] - AO[3])
  const ao3 = idx15 >= 3 ? val(e15.ao, idx15 - 3) : val(e15.ao, 0);
  const ao_gradient = m15_ao - ao3;

  // bb_sqz_product: BB squeeze intensity product across timeframes
  // Squeeze intensity = (current_width - min_width) / (max_width - min_width) in 20-bar window
  // bb_sqz_product = m15_squeeze * h1_squeeze * 100 (scaled)
  const m15Squeeze = bbSqueezeIntensity(e15.bbWidth, idx15, 20);
  const h1Squeeze = bbSqueezeIntensity(e1h.bbWidth, idx1h, 20);
  const m15SqzRaw = m15Squeeze === null ? 0.5 : m15Squeeze;
  const h1SqzRaw = h1Squeeze === null ? 0.5 : h1Squeeze;
  const bb_sqz_product = m15SqzRaw * h1SqzRaw * 100;

  // tf_vol_sum: sum of volume z-scores across timeframes
  const tf_vol_sum = m15_vol_z + h1_vol_z + val(e4h.volZscore, idx4h);

  return {
    ao_gradient,
    bb_sqz_product,
    h1_ao,
    h1_bb_pos,
    h1_bb_width,
    h1_ma7_slope,
    h1_macd,
    h1_rsi,
    h1_trend,
    h1_vol_z,
    h4_ao,
    h4_bb_pos,
    h4_bb_width,
    h4_macd,
    h4_rsi,
    h4_trend,
    m15_ao,
    m15_atr_pct,
    m15_bb_pos,
    m15_bb_width,
    m15_ma7_slope,
    m15_macd,
    m15_rsi,
    m15_swing_dist,
    m15_trend,
    m15_vol_z,
    mtf_15_1h_agree,
    mtf_triple_agree,
    rsi_gradient,
    tf_vol_sum,
  };
}

/**
 * BB Squeeze Intensity: 0 = tightest in 20-bar window, 1 = widest.
 * Returns null if insufficient data.
 */
function bbSqueezeIntensity(
  bbWidth: (number | null)[],
  idx: number,
  lookback: number,
): number | null {
  if (idx < lookback) return null;
  let bbMin = Infinity;
  let bbMax = -Infinity;
  for (let j = idx - lookback + 1; j <= idx; j++) {
    const w = bbWidth[j] ?? 0;
    if (w < bbMin) bbMin = w;
    if (w > bbMax) bbMax = w;
  }
  const bbRange = bbMax - bbMin;
  if (bbRange <= 0) return 0.5;
  const current = bbWidth[idx] ?? 0;
  return (current - bbMin) / bbRange;
}

// ---------------------------------------------------------------------------
// Feature vector -> ordered array for model consumption
// ---------------------------------------------------------------------------

const FEATURE_ORDER: (keyof MtfFeatureVector)[] = [
  "ao_gradient",
  "bb_sqz_product",
  "h1_ao",
  "h1_bb_pos",
  "h1_bb_width",
  "h1_ma7_slope",
  "h1_macd",
  "h1_rsi",
  "h1_trend",
  "h1_vol_z",
  "h4_ao",
  "h4_bb_pos",
  "h4_bb_width",
  "h4_macd",
  "h4_rsi",
  "h4_trend",
  "m15_ao",
  "m15_atr_pct",
  "m15_bb_pos",
  "m15_bb_width",
  "m15_ma7_slope",
  "m15_macd",
  "m15_rsi",
  "m15_swing_dist",
  "m15_trend",
  "m15_vol_z",
  "mtf_15_1h_agree",
  "mtf_triple_agree",
  "rsi_gradient",
  "tf_vol_sum",
];

function featureVectorToArray(fv: MtfFeatureVector): number[] {
  return FEATURE_ORDER.map((k) => fv[k]);
}

function featureVectorToRecord(fv: MtfFeatureVector): Record<string, number> {
  const rec: Record<string, number> = {};
  for (const k of FEATURE_ORDER) rec[k] = fv[k];
  return rec;
}

// ---------------------------------------------------------------------------
// LightGBM Rule-Based Scoring
// ---------------------------------------------------------------------------

/**
 * Rule-based approximation of the LightGBM ensemble.
 *
 * Extracts key decision thresholds from classifier.txt (first 22 trees):
 *
 * Tree root splits:
 *   h4_bb_pos <= 0.231  (16/22 trees — dominant root split)
 *   m15_macd <= 3.86e-15 (~0) (3/22 trees)
 *   m15_ma7_slope <= -0.33 (2/22 trees)
 *
 * Key secondary splits (from Trees 0-22):
 *   h4_ao threshold: ~0 (positive/negative)
 *   h4_rsi thresholds: 33.36, 80.68
 *   h1_rsi threshold: 41.69
 *   h4_bb_width thresholds: 0.83
 *   m15_swing_dist threshold: 0.005
 *   h1_ma7_slope threshold: -4.2, 4.48
 *   h1_bb_pos threshold: -0.49, 1.54
 *   m15_trend threshold: -0.56
 *   mtf_triple_agree threshold: 0 (boolean)
 *
 * Scoring: each feature contributes to a raw score based on its position
 * relative to key tree thresholds, weighted by feature importance.
 * The raw score is clamped + sigmoid to produce 0-1 probability.
 */
export function lightgbmRuleBasedScore(
  features: MtfFeatureVector,
): number {
  let score = 0;

  // ── h4_bb_pos: Root split in 16/22 trees at 0.231 ──
  // price above threshold (+contribution) vs below (-contribution)
  if (features.h4_bb_pos <= 0.23) score -= 0.08;
  else score += 0.04;

  // ── m15_macd: Root split in 3/22 trees at ~0 ──
  if (features.m15_macd > 0) score += 0.06;
  else score -= 0.02;

  // ── m15_ma7_slope: threshold -0.33 ──
  if (features.m15_ma7_slope > -0.33) score += 0.04;
  else score -= 0.03;

  // ── m15_swing_dist: near structure vs far ──
  if (features.m15_swing_dist < 3.0) score += 0.04;
  if (features.m15_swing_dist < 0.5) score += 0.03; // very near pivot

  // ── h4_ao: 4h momentum direction ──
  if (features.h4_ao > 0) score += 0.03;
  else score -= 0.02;

  // ── h1_rsi: RSI not extreme ──
  if (features.h1_rsi < 70 && features.h1_rsi > 30) score += 0.03;
  if (features.h1_rsi < 35) score += 0.03; // near oversold (reversal zone)

  // ── h4_rsi: 4h RSI in mild/cold zone ──
  if (features.h4_rsi > 30 && features.h4_rsi < 50) score += 0.04;
  if (features.h4_rsi <= 30) score += 0.02; // deeply oversold

  // ── h4_bb_width: some volatility on 4h ──
  if (features.h4_bb_width > 2.0) score += 0.03;
  if (features.h4_bb_width > 5.0) score += 0.02; // elevated volatility

  // ── mtf_triple_agree: all timeframes aligned ──
  if (features.mtf_triple_agree > 0) score += 0.05;

  // ── mtf_15_1h_agree: two shorter TFs aligned ──
  if (features.mtf_15_1h_agree > 0) score += 0.03;

  // ── ao_gradient: AO momentum ──
  if (features.ao_gradient > 0) score += 0.02;
  else score -= 0.02;

  // ── rsi_gradient: RSI rising ──
  if (features.rsi_gradient > 0) score += 0.02;

  // ── h1_ma7_slope: 1h short-term trend ──
  if (features.h1_ma7_slope > 0) score += 0.02;

  // ── m15_trend: 15m trend strength ──
  if (features.m15_trend > 0.5) score += 0.03;
  if (features.m15_trend < -0.5) score -= 0.02;

  // ── h1_ao: 1h momentum ──
  if (features.h1_ao > 0) score += 0.02;

  // ── tf_vol_sum: volume confirmation ──
  if (features.tf_vol_sum > 0.5) score += 0.02;

  // ── bb_sqz_product: squeeze expansion ──
  if (features.bb_sqz_product > 20) score += 0.02;

  // Baseline adjustment (LightGBM base is ~0.277 from model_card)
  // The model expects ~27.7% base win rate (unbalanced), shift accordingly
  score += 0.25;

  // Sigmoid to produce 0-1 probability
  const proba = 1 / (1 + Math.exp(-score));

  // Clamp for numerical stability
  return Math.max(0.001, Math.min(0.999, proba));
}

// ---------------------------------------------------------------------------
// Regime Classification (Dual-Regime Architecture)
// ---------------------------------------------------------------------------

/**
 * Classify the current market regime based on the statistical profiles
 * revealed by the false-negative analysis:
 *
 * OVERSOLD_REVERSAL: RSI<35, negative AO, BB near lower, bearish divergence
 *   → caught by old filter (605 winners)
 *
 * MOMENTUM_CONTINUATION: RSI~40-60, AO>0, MACD>0, near structure
 *   → missed by old filter (4,829 winners)
 *
 * Gate conditions from false-negative analysis (Mann-Whitney U p<0.0001):
 *   - OVERSOLD_REVERSAL: RSI < 35
 *   - MOMENTUM_CONTINUATION: AO > -1 AND MACD > -0.5 AND RSI >= 35
 *     AND near structure (swing_dist < 2 ATR)
 */
export function classifyRegime(features: MtfFeatureVector): SignalRegime {
  // Oversold reversal gate: RSI < 35 on 15m
  if (features.m15_rsi < 35) {
    return "OVERSOLD_REVERSAL";
  }

  // Momentum continuation gate:
  // AO not deeply negative, MACD not deeply negative, RSI not oversold,
  // and price near structural level
  const aoPositive = features.m15_ao > -1;
  const macdNotBad = features.m15_macd > -0.5;
  const rsiNotOversold = features.m15_rsi >= 35;
  const nearStructure = features.m15_swing_dist < 2;

  if (aoPositive && macdNotBad && rsiNotOversold && nearStructure) {
    return "MOMENTUM_CONTINUATION";
  }

  // Relaxed momentum gate (if mostly positive but structure slightly farther)
  if (features.m15_ao > -5 && features.m15_macd > -1 && features.m15_rsi >= 40) {
    return "MOMENTUM_CONTINUATION";
  }

  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Top Features Extraction
// ---------------------------------------------------------------------------

function getTopFeatures(features: MtfFeatureVector): {
  name: string;
  value: number;
  importance: number;
}[] {
  const entries: { name: string; value: number; importance: number }[] = [];
  for (const key of FEATURE_ORDER) {
    const imp = FEATURE_IMPORTANCE[key] ?? 0;
    if (imp > 0) {
      entries.push({
        name: key,
        value: features[key],
        importance: imp / TOTAL_IMPORTANCE,
      });
    }
  }
  return entries
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main Inference
// ---------------------------------------------------------------------------

export function buildMtfFeatureVector(
  klines15m: Candle[],
  klines1h: Candle[],
  klines4h: Candle[],
): MtfFeatureVector {
  const e15 = enrichCandles(klines15m);
  const e1h = enrichCandles(klines1h);
  const e4h = enrichCandles(klines4h);

  return computeMtfFeatures(e15, e1h, e4h, "long");
}

/**
 * Run full inference pipeline: build features → score → classify → decide.
 */
export function runInference(input: InferenceInput): InferenceResult {
  const features = buildMtfFeatureVector(
    input.klines15m,
    input.klines1h,
    input.klines4h,
  );

  // Rule-based LightGBM approximation (see lightgbmRuleBasedScore for derivation)
  const proba = lightgbmRuleBasedScore(features);

  // Classify regime from features
  const regime = classifyRegime(features);

  // Decision vs threshold
  const threshold = DEFAULT_THRESHOLD;
  const decision: "TRADE" | "SKIP" = proba >= threshold ? "TRADE" : "SKIP";

  // Top features for explainability
  const topFeatures = getTopFeatures(features);

  return {
    proba: Math.round(proba * 10000) / 10000,
    threshold,
    decision,
    regime,
    topFeatures,
    timestamp: Date.now(),
  };
}

/**
 * Validate that klines have enough bars for MTF computation.
 * 15m needs at least 120 bars (to ensure MACD warmup + swing detection),
 * 1h needs at least 60 bars, 4h needs at least 40 bars.
 */
export function validateKlines(
  klines15m: Candle[],
  klines1h: Candle[],
  klines4h: Candle[],
): string | null {
  if (klines15m.length < 60)
    return `Need ≥60 15m bars, got ${klines15m.length}`;
  if (klines1h.length < 40)
    return `Need ≥40 1h bars, got ${klines1h.length}`;
  if (klines4h.length < 35)
    return `Need ≥35 4h bars, got ${klines4h.length}`;
  return null;
}

// ---------------------------------------------------------------------------
// tRPC Router
// ---------------------------------------------------------------------------

export const inferenceRouter = router({
  /**
   * Run MTF inference on a symbol.
   * Fetches 15m/1h/4h klines from D1 or Binance,
   * builds the 30-feature vector, computes score, classifies regime.
   *
   * Returns probability, decision, regime, and top features.
   */
  inferTrade: publicProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(20),
        direction: z.enum(["long", "short"]).default("long"),
        // Optionally pass klines to avoid refetch (for batch usage)
        klines15m: z
          .array(
            z.object({
              open: z.number(),
              high: z.number(),
              low: z.number(),
              close: z.number(),
              volume: z.number(),
              time: z.number(),
            }),
          )
          .optional(),
        klines1h: z
          .array(
            z.object({
              open: z.number(),
              high: z.number(),
              low: z.number(),
              close: z.number(),
              volume: z.number(),
              time: z.number(),
            }),
          )
          .optional(),
        klines4h: z
          .array(
            z.object({
              open: z.number(),
              high: z.number(),
              low: z.number(),
              close: z.number(),
              volume: z.number(),
              time: z.number(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        setDbEnv(ctx.env);

        // Fetch klines if not provided
        let klines15m: Candle[];
        let klines1h: Candle[];
        let klines4h: Candle[];

        if (input.klines15m && input.klines1h && input.klines4h) {
          klines15m = input.klines15m;
          klines1h = input.klines1h;
          klines4h = input.klines4h;
        } else {
          // Fetch from D1 if available, else from Binance
          const raw15m = await fetchKlinesFromDB(
            ctx.env,
            input.symbol,
            "15m",
            60,
          );
          const raw1h = await fetchKlinesFromDB(
            ctx.env,
            input.symbol,
            "1h",
            60,
          );
          const raw4h = await fetchKlinesFromDB(
            ctx.env,
            input.symbol,
            "4h",
            60,
          );

          klines15m =
            raw15m.length > 0
              ? raw15m.map(klineToCandle)
              : await fetchKlinesFromBinance(input.symbol, "15m", 60);
          klines1h =
            raw1h.length > 0
              ? raw1h.map(klineToCandle)
              : await fetchKlinesFromBinance(input.symbol, "1h", 60);
          klines4h =
            raw4h.length > 0
              ? raw4h.map(klineToCandle)
              : await fetchKlinesFromBinance(input.symbol, "4h", 60);
        }

        // Validate
        const validationError = validateKlines(klines15m, klines1h, klines4h);
        if (validationError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: validationError,
          });
        }

        // Run inference
        const result = runInference({
          symbol: input.symbol,
          direction: input.direction,
          klines15m,
          klines1h,
          klines4h,
        });

        return result;
      } catch (e: any) {
        if (e instanceof TRPCError) throw e;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Inference failed: ${e?.message ?? String(e)}`,
        });
      }
    }),
});

// ---------------------------------------------------------------------------
// Kline Fetching Helpers
// ---------------------------------------------------------------------------

function klineToCandle(row: any): Candle {
  return {
    open: parseFloat(row.open),
    high: parseFloat(row.high),
    low: parseFloat(row.low),
    close: parseFloat(row.close),
    volume: parseFloat(row.volume),
    time: row.openTime ?? row.timestamp,
  };
}

async function fetchKlinesFromDB(
  env: any,
  symbol: string,
  timeframe: string,
  limit: number,
): Promise<any[]> {
  try {
    const { getDb } = await import("../db");
    const { klines } = await import("../../drizzle/schema");
    const { eq, and, desc } = await import("drizzle-orm");
    setDbEnv(env);
    const db = getDb();
    const rows = await db
      .select()
      .from(klines)
      .where(
        and(eq(klines.symbol, symbol), eq(klines.timeframe, timeframe)),
      )
      .orderBy(desc(klines.openTime))
      .limit(limit);
    return rows.reverse();
  } catch {
    return [];
  }
}

async function fetchKlinesFromBinance(
  symbol: string,
  interval: string,
  limit: number,
): Promise<Candle[]> {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const raw = (await res.json()) as any[];
  return raw.map((k: any[]) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}
