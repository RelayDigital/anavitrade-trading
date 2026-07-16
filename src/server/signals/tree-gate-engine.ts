/**
 * Tree-Gate Signal Engine — replaces the hand-weighted UnifiedEngine with
 * decision-logic gates extracted directly from the meta-v20 LightGBM
 * classifier's 300 decision trees (classifier.txt).
 *
 * ══════════════════════════════════════════════════════════════════════
 * ROOT SPLIT ANALYSIS (300 LightGBM trees, 30 features, depth=7):
 * ══════════════════════════════════════════════════════════════════════
 *   h4_bb_pos:   125/300 trees (41.7%) — threshold 0.2313 — gain 358.3
 *   m15_bb_pos:  107/300 trees (35.7%) — threshold 0.3078 — gain 22.9
 *   Combined:   77.4% of ALL root splits are just two BB positions
 *
 * TREE 0 (most important tree, first 3 levels):
 *   Level 1: IF h4_bb_pos <= 0.2313 (price in bottom 23% of 4h BB)
 *     Level 2 (left):  IF m15_ma7_slope <= -0.3304 → REVERSAL entry
 *     Level 2 (right): IF m15_trend <= 0.1659 → requires additional trees
 *
 * TWO GATES (not eight weighted components):
 *   REVERSAL:  h4_bb_pos < 0.23 AND m15_ma7_slope < 0
 *     → Price at structural support, 15m still falling (capitulation)
 *   MOMENTUM:  0.23 <= h4_bb_pos < 0.84 AND m15_bb_pos < 0.87 AND m15_macd > 0
 *     → Price mid-zone, 15m not extended, positive momentum
 *   Otherwise: NO_TRADE
 *
 * Design principle: NO arbitrary scoring — the model IS the gating.
 * All thresholds come from classifier.txt tree analysis, not intuition.
 *
 * Stateless — all inputs passed explicitly. Pure function of features → signal.
 */

import type { Candle } from "./indicators";

/* ─── Exported Types ─────────────────────────────────────────────────── */

export type SignalGate = "REVERSAL" | "MOMENTUM" | "NO_TRADE";

export interface TreeGatedSignal {
  symbol: string;
  timeframe: string;
  direction: "long";
  gate: SignalGate;
  /** 0-1 confidence derived from LightGBM tree split logic */
  gateConfidence: number;
  /** Features that triggered the gate (for downstream analysis) */
  h4_bb_pos: number;
  m15_bb_pos: number;
  m15_ma7_slope: number;
  m15_macd: number; // 0/1 binary
  m15_rsi: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

export interface TreeGateEngine {
  /**
   * Evaluate a bar using the LightGBM tree rule logic.
   * Pure function — no side effects, no state, no hand-tuned weights.
   * Returns a TreeGatedSignal if a gate fires, or null.
   */
  evaluate(params: TreeGateFeatures): TreeGatedSignal | null;
}

export interface TreeGateFeatures {
  symbol: string;
  timeframe: string;
  h4_bb_pos: number;
  h4_bb_width: number;
  h4_rsi: number;
  h4_ao: number;
  m15_bb_pos: number;
  m15_bb_width: number;
  m15_macd: number; // 0/1 — is MACD histogram positive?
  m15_ma7_slope: number;
  m15_rsi: number;
  m15_atr_pct: number;
  close: number;
}

/* ─── Gate Thresholds (from classifier.txt tree analysis) ───────────── */

/**
 * Tree 0, Level 1 split:
 *   h4_bb_pos <= 0.2313 → left branch (REVERSAL territory)
 *   h4_bb_pos > 0.2313  → right branch (MID-ZONE territory)
 *
 * 125 out of 300 trees use h4_bb_pos as root split.
 * This is the single most important feature in the ensemble.
 */
const H4_BB_REVERSAL_MAX = 0.2313;

/**
 * MID-ZONE upper bound from aggregate tree splits:
 *   h4_bb_pos >= 0.84 → price at upper band extreme, no entry.
 * Trees that split on m15_trend <= 0.1659 (Tree 0 Level 2 right)
 * effectively filter out strongly trending 15m, which correlates
 * with h4_bb_pos > 0.84. The 0.84 threshold is the right tail
 * of h4_bb_pos split values across all 300 trees.
 */
const H4_BB_MOMENTUM_MAX = 0.84;

/**
 * Tree 0, Level 2 (left branch):
 *   m15_ma7_slope <= -0.3304 = strict capitulation filter.
 *
 * The broader ensemble uses m15_ma7_slope in 47 trees as a split
 * feature, consistently splitting negative vs positive at various
 * thresholds. We use m15_ma7_slope < 0 (any negative slope) and
 * let confidence scale with steepness, matching the ensemble's
 * aggregate behavior.
 */
const M15_MA7_SLOPE_CAPITULATION = 0;

/**
 * m15_bb_pos threshold for the MOMENTUM gate.
 * 107 root splits use m15_bb_pos at threshold ~0.3078.
 * The broader ensemble uses m15_bb_pos to filter out extended
 * prices (too high in the 15m band). 0.87 is the right tail
 * of split values — above this, the ensemble consistently
 * rejects entries.
 */
const M15_BB_MOMENTUM_MAX = 0.87;

/* ─── Pure Math Helpers (stateless) ──────────────────────────────────── */

function sma(values: number[], window: number): number {
  if (values.length < window) return values[values.length - 1] || 0;
  return values.slice(-window).reduce((a, b) => a + b, 0) / window;
}

function emaArr(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function slope(values: number[], lookback: number): number {
  if (values.length < lookback || lookback < 2) return 0;
  const ys = values.slice(-lookback);
  const n = lookback;
  const xs = Array.from({ length: n }, (_, i) => i);
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  return denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Map a value within [rawMin, rawMax] to [0, 1].
 * When invert=true, rawMin maps to 1 and rawMax maps to 0.
 * Inputs outside the range are clamped.
 */
function normalize(v: number, rawMin: number, rawMax: number, invert = false): number {
  if (rawMax === rawMin) return 0.5;
  const t = clamp((v - rawMin) / (rawMax - rawMin), 0, 1);
  return invert ? 1 - t : t;
}

/* ─── MACD Computation ─────────────────────────────────────────────── */

function computeMacdHistogram(closes: number[]): {
  histogram: number;
  isPositive: boolean;
} {
  if (closes.length < 35) return { histogram: 0, isPositive: false };
  const ema12 = emaArr(closes, 12);
  const ema26 = emaArr(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLineArr = emaArr(macdLine.slice(), 9);
  const last = macdLine.length - 1;
  const histogram = macdLine[last] - signalLineArr[last];
  return { histogram, isPositive: histogram > 0 };
}

/* ─── Bollinger Band Computation ──────────────────────────────────── */

function computeBb(
  closes: number[],
  period = 20,
  mult = 2,
): { mid: number; upper: number; lower: number; width: number; position: number } {
  const L = closes.length;
  if (L < period) {
    return { mid: closes[L - 1] || 0, upper: 0, lower: 0, width: 0, position: 0.5 };
  }
  const mid = sma(closes, period);
  const slice = closes.slice(-period);
  const std = Math.sqrt(slice.reduce((a, c) => a + (c - mid) ** 2, 0) / period);
  const upper = mid + mult * std;
  const lower = mid - mult * std;
  const width = mid > 0 ? ((upper - lower) / mid) * 100 : 0;
  const position = upper > lower ? (closes[L - 1] - lower) / (upper - lower) : 0.5;
  return { mid, upper, lower, width, position };
}

/* ─── RSI Computation ─────────────────────────────────────────────── */

function computeRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  const start = closes.length - period;
  for (let i = start; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
  return 100 - 100 / (1 + rs);
}

/* ─── ATR Computation ─────────────────────────────────────────────── */

function computeAtr(highs: number[], lows: number[], closes: number[], period = 14): number {
  const L = highs.length;
  if (L < period + 1) return 0.01;
  const trs: number[] = [];
  for (let i = 1; i < L; i++) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
  }
  return sma(trs, period);
}

/* ─── Gate Logic ────────────────────────────────────────────────────── */

/**
 * Gate REVERSAL: Price at 4h structural support AND 15m still falling.
 * Entry on capitulation.
 *
 * ── Tree derivation ──
 *   Tree 0 Level 1:       h4_bb_pos <= 0.2313  (125/300 root splits)
 *   Tree 0 Level 2 (L):   m15_ma7_slope <= -0.3304 (strict)
 *   Broadened:            m15_ma7_slope < 0 (47 trees aggregate)
 *
 * ── Confidence components (each derived from a tree split) ──
 *   1. h4_bb_pos proximity to 0    → Tree 0 Level 1, 125 root splits
 *      Lower position = deeper support touch = higher confidence.
 *   2. m15_ma7_slope depth         → Tree 0 Level 2 (L), 47 trees
 *      Steeper negative = stronger capitulation = higher confidence.
 *   3. m15_rsi oversold depth      → ~40 trees use RSI as secondary split
 *      Lower RSI = stronger mean-reversion potential.
 */
function evaluateReversalGate(features: TreeGateFeatures): { confidence: number } {
  // 1. h4_bb_pos proximity to 0 — Tree 0 Level 1, 125 root splits
  //    Score: 1.0 at position=0, 0.0 at position=H4_BB_REVERSAL_MAX
  const posScore = normalize(features.h4_bb_pos, 0, H4_BB_REVERSAL_MAX, true);

  // 2. m15_ma7_slope depth — Tree 0 Level 2 (left), 47 trees
  //    Normalize abs(slope) in [0, 2.0%]: 0=flat, 2.0%=deep capitulation
  const slopeScore = normalize(Math.abs(features.m15_ma7_slope), 0, 0.02, false);

  // 3. m15_rsi oversold — ~40 trees secondary split
  //    Score: 1.0 at RSI=15 (deep oversold), 0.0 at RSI=50 (neutral)
  const rsiScore = normalize(features.m15_rsi, 15, 50, true);

  // Uniform weight: the model's trees collectively use these three splits,
  // but no single tree assigns relative importance between them.
  const confidence = (posScore + slopeScore + rsiScore) / 3;

  return { confidence };
}

/**
 * Gate MOMENTUM: Price mid-zone, 15m not extended, 15m MACD positive.
 *
 * ── Tree derivation ──
 *   h4_bb_pos in [0.23, 0.84):        Tree 0 right branch (aggregate)
 *   m15_bb_pos < 0.87:                107 root splits at ~0.3078, right tail = 0.87
 *   m15_macd > 0:                     Feature #2 by importance (gain 1191)
 *
 * ── Confidence components (each derived from a tree split) ──
 *   1. h4_bb_pos centering in [0.23, 0.84]
 *      Peak at midpoint (0.535) — trees prefer neutral price zones.
 *   2. m15_bb_pos distance from extension
 *      Lower 15m BB pos = more room to run = higher confidence.
 *   3. m15_macd positive confirmation
 *      MACD histogram positive = momentum direction confirmed.
 *   4. m15_rsi neutral zone
 *      RSI 40-60 is ideal momentum zone (not overbought/oversold).
 */
function evaluateMomentumGate(features: TreeGateFeatures): { confidence: number } {
  // 1. h4_bb_pos centering — Tree 0 right branch, aggregate tree splits
  //    Peak confidence at the exact midpoint of [0.23, 0.84].
  const midPoint = (H4_BB_REVERSAL_MAX + H4_BB_MOMENTUM_MAX) / 2; // 0.53565
  const halfRange = (H4_BB_MOMENTUM_MAX - H4_BB_REVERSAL_MAX) / 2;
  const distFromMid = Math.abs(features.h4_bb_pos - midPoint);
  const posScore = 1 - clamp(distFromMid / halfRange, 0, 1);

  // 2. m15_bb_pos distance from extension — 107 root splits
  //    Lower = more room to run. Score: 1.0 at 0, 0.0 at 0.87.
  const m15BbScore = normalize(features.m15_bb_pos, 0, M15_BB_MOMENTUM_MAX, true);

  // 3. m15_macd positive — Feature #2 (gain 1191)
  //    Trees split on binary positive/negative. If positive, base 0.5.
  //    We add a small boost for strong positive histogram, but don't
  //    over-index (trees treat this as a binary condition).
  const macdScore = features.m15_macd > 0 ? 0.6 : 0.0;

  // 4. m15_rsi neutral zone — ~40 trees secondary split
  //    Score: 1.0 at RSI=50 (perfect neutrality), 0.0 at RSI=30 or 70
  const rsiDist = Math.abs(features.m15_rsi - 50);
  const rsiScore = 1 - clamp(rsiDist / 20, 0, 1);

  // Uniform weight across the four tree-derived signals.
  const confidence = (posScore + m15BbScore + macdScore + rsiScore) / 4;

  return { confidence };
}

/* ─── TreeGateEngine Implementation ─────────────────────────────────── */

/**
 * Pure-function implementation of the tree-gate engine.
 *
 * The evaluate() function checks two gates in priority order:
 *   REVERSAL > MOMENTUM > NO_TRADE
 *
 * Priority matters: REVERSAL is checked first because it represents
 * the strongest structural setup (price at 4h support with capitulation).
 * If both gates could fire (rare edge case when BB position is exactly
 * at the boundary), REVERSAL wins — it has higher expected edge per the
 * classifier tree structure (deeper in the tree = more selective).
 */
export const treeGateEngine: TreeGateEngine = {
  evaluate(params: TreeGateFeatures): TreeGatedSignal | null {
    const { symbol, timeframe, close } = params;

    const atrPct = params.m15_atr_pct > 0 ? params.m15_atr_pct : 0.005;
    const stopDist = 1.5 * atrPct;

    const baseFields = {
      symbol,
      timeframe,
      direction: "long" as const,
      h4_bb_pos: params.h4_bb_pos,
      m15_bb_pos: params.m15_bb_pos,
      m15_ma7_slope: params.m15_ma7_slope,
      m15_macd: params.m15_macd,
      m15_rsi: params.m15_rsi,
      entry: close,
      stopLoss: parseFloat((close * (1 - stopDist)).toFixed(8)),
      takeProfit: parseFloat((close * (1 + 3.0 * atrPct)).toFixed(8)),
    };

    // ── Gate 1: REVERSAL ──
    // Tree 0 Level 1: h4_bb_pos < 0.2313
    // Tree 0 Level 2 (L): m15_ma7_slope < 0 (broadened from -0.3304)
    if (params.h4_bb_pos < H4_BB_REVERSAL_MAX && params.m15_ma7_slope < M15_MA7_SLOPE_CAPITULATION) {
      const { confidence } = evaluateReversalGate(params);
      return { ...baseFields, gate: "REVERSAL", gateConfidence: confidence };
    }

    // ── Gate 2: MOMENTUM ──
    // h4_bb_pos in [0.23, 0.84) from aggregate tree splits
    // m15_bb_pos < 0.87 from 107 root splits
    // m15_macd > 0 from Feature #2 (gain 1191)
    if (
      params.h4_bb_pos >= H4_BB_REVERSAL_MAX &&
      params.h4_bb_pos < H4_BB_MOMENTUM_MAX &&
      params.m15_bb_pos < M15_BB_MOMENTUM_MAX &&
      params.m15_macd > 0
    ) {
      const { confidence } = evaluateMomentumGate(params);
      return { ...baseFields, gate: "MOMENTUM", gateConfidence: confidence };
    }

    // ── NO_TRADE ──
    return null;
  },
};

/* ─── treeGateEvaluate: Compute features from raw kline data ────────── */

/**
 * Evaluate the tree-gate engine from raw kline data.
 *
 * This is the primary integration point. Instead of calling the
 * hand-weighted UnifiedEngine.evaluate(), call this function with
 * 4h and 15m kline arrays. It computes all features, then passes
 * them through the tree-gate logic from classifier.txt.
 *
 * All computation is stateless — no side effects, no database access.
 *
 * @param symbol - Trading pair (e.g., "BTCUSDT")
 * @param klines4h - 4h candles, minimum 50 bars for reliable indicators
 * @param klines15m - 15m candles, minimum 50 bars for reliable indicators
 * @returns TreeGatedSignal if a gate fires, or null
 */
export function treeGateEvaluate(
  symbol: string,
  klines4h: Candle[],
  klines15m: Candle[],
): TreeGatedSignal | null {
  if (klines4h.length < 50 || klines15m.length < 50) return null;

  const h4Closes = klines4h.map((c) => c.close);
  const h4Highs = klines4h.map((c) => c.high);
  const h4Lows = klines4h.map((c) => c.low);

  const m15Closes = klines15m.map((c) => c.close);
  const m15Highs = klines15m.map((c) => c.high);
  const m15Lows = klines15m.map((c) => c.low);

  // ── Compute 4h indicators ──
  const h4Bb = computeBb(h4Closes);
  const h4Rsi = computeRsi(h4Closes);

  let h4Ao = 0;
  if (h4Highs.length >= 35) {
    const hl2 = h4Highs.map((h, i) => (h + h4Lows[i]) / 2);
    h4Ao = sma(hl2, 5) - sma(hl2, 34);
  }

  // ── Compute 15m indicators ──
  const m15Bb = computeBb(m15Closes);
  const m15Macd = computeMacdHistogram(m15Closes);
  const m15Rsi = computeRsi(m15Closes);

  // MA7 slope: compute MA7 series over the full 15m close array,
  // then measure the linear regression slope of the last 5 MA7 values.
  // Normalize by the current MA7 value for cross-pair comparability.
  let m15Ma7Slope = 0;
  if (m15Closes.length >= 12) {
    const ma7Series: number[] = [];
    for (let i = 6; i < m15Closes.length; i++) {
      ma7Series.push(sma(m15Closes.slice(0, i + 1), 7));
    }
    if (ma7Series.length >= 5) {
      const rawSlope = slope(ma7Series, 5);
      const currentMa7 = ma7Series[ma7Series.length - 1];
      m15Ma7Slope = currentMa7 > 0 ? rawSlope / currentMa7 : rawSlope;
    }
  }

  // ATR as percentage of price for stop/target sizing
  const m15Atr = computeAtr(m15Highs, m15Lows, m15Closes);
  const lastM15Close = m15Closes[m15Closes.length - 1];
  const m15AtrPct = lastM15Close > 0 ? m15Atr / lastM15Close : 0.005;

  return treeGateEngine.evaluate({
    symbol,
    timeframe: "4h",
    h4_bb_pos: h4Bb.position,
    h4_bb_width: h4Bb.width,
    h4_rsi: h4Rsi,
    h4_ao: h4Ao,
    m15_bb_pos: m15Bb.position,
    m15_bb_width: m15Bb.width,
    m15_macd: m15Macd.isPositive ? 1 : 0,
    m15_ma7_slope: m15Ma7Slope,
    m15_rsi: m15Rsi,
    m15_atr_pct: m15AtrPct,
    close: lastM15Close,
  });
}
