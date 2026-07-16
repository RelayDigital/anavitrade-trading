/**
 * @deprecated Use TreeGateEngine from ./tree-gate-engine.ts instead.
 *
 * This engine uses 8 hand-weighted component scores that were tuned to
 * meta-v20 feature importances, but the classifier.txt tree analysis shows
 * that only TWO conditions (h4_bb_pos and m15_bb_pos) account for 77.4%
 * of all root splits. The tree-gate engine replaces this with pure
 * decision-tree logic extracted from the LightGBM ensemble.
 *
 * Unified Signal Engine — composites ALL signal sources into a single
 * multi-timeframe, multi-indicator scoring system.
 *
 * ══════════════════════════════════════════════════════════════════════
 * CALIBRATED TO META-V20 MODEL (proven chronological backtest)
 * ══════════════════════════════════════════════════════════════════════
 * Top-5 features by importance (LightGBM, 300 est, depth=7):
 *   #1 h4_bb_pos   1472  → bbAweScore  (price position in 4h BBs)
 *   #2 m15_macd    1191  → momentumScore (15m MACD histogram)
 *   #3 h4_bb_width 1029  → bbAweScore  (4h BB width / squeeze)
 *   #4 h4_ao        995  → momentumScore (4h Awesome Oscillator)
 *   #5 h4_rsi       921  → oscillatorScore (4h RSI value)
 *   (30 features total, 19,599 15m trades, 70/30 chronological split)
 *
 * Dual-regime architecture (false-negative analysis confirmed):
 *   OVERSOLD_REVERSAL:       RSI < 35 (caught 605 winners)
 *   MOMENTUM_CONTINUATION:   AO > -1 AND MACD > -0.5 AND RSI >= 35
 *                            AND near structure (swing_dist < 2 ATR)
 *                            (the 4,829 false negatives - recovered)
 *
 * Stateless — all inputs passed explicitly to evaluate().
 */

import { detectMSS, detectOrderBlocks, detectLiquidity, detectFVG } from "./luxalgo-ict";
import type { Candle } from "./indicators";

/* ─── Exported Types ─────────────────────────────────────────────────── */

/** @deprecated Use SignalGate from ./tree-gate-engine.ts instead */
export type SignalRegime = "OVERSOLD_REVERSAL" | "MOMENTUM_CONTINUATION";
export type SignalDirection = "long" | "short";

/** @deprecated Use TreeGatedSignal from ./tree-gate-engine.ts instead */
export interface UnifiedSignalResult {
  symbol: string;
  timeframe: string;
  direction: SignalDirection;
  regime: SignalRegime;
  /** 0-100 overall confidence */
  compositeScore: number;
  /** 0-100 confidence within the classified regime */
  regimeScore: number;
  /** 0-100 how well higher timeframes align (quick estimate) */
  mtfAlignment: number;
  components: {
    /** SMC pattern strength (MSS, OB, FVG, Liq sweep) */
    smcScore: number;
    /** AO/MACD momentum score */
    momentumScore: number;
    /** RSI/Stoch/CCI score */
    oscillatorScore: number;
    /** BB squeeze + AO expansion */
    bbAweScore: number;
    /** Volume climax/absorption/dryness */
    volumeScore: number;
    /** RSI/AO/MACD divergence */
    divergenceScore: number;
  };
  entry: number;
  stopLoss: number;
  takeProfit: number;
  metadata: Record<string, number>;
}

/** @deprecated Config moved to TreeGateFeatures in ./tree-gate-engine.ts */
export interface UnifiedEngineConfig {
  /** Minimum composite score to emit signal (0-100, default 65) */
  minCompositeScore: number;
  /** Minimum MTF alignment to allow trade (0-100, default 40) */
  minMtfAlignment: number;
  /** Risk-reward ratio (default 2) */
  rr: number;
}

/* ─── Defaults ───────────────────────────────────────────────────────── */

const DEFAULT_CONFIG: UnifiedEngineConfig = {
  minCompositeScore: 65,
  minMtfAlignment: 40,
  rr: 2,
};

/**
 * Feature importance weights calibrated to the meta-v20 model.
 *
 * Model top-5 by importance (sum=5608):
 *   h4_bb_pos(1472) + h4_bb_width(1029) → bbAweScore
 *   m15_macd(1191)  + h4_ao(995)         → momentumScore
 *   h4_rsi(921)                           → oscillatorScore
 *
 * Remaining 25 features (lower individual importance) are distributed
 * across smcScore, divergenceScore, volumeScore.
 */
const WEIGHTS = {
  bbAweScore: 0.35,       // #1 BB pos + #3 BB width
  momentumScore: 0.28,    // #2 MACD + #4 AO
  oscillatorScore: 0.18,  // #5 RSI
  smcScore: 0.10,         // swing_dist < 2 ATR gate; structure confirmation
  divergenceScore: 0.06,  // RSI/AO/MACD divergence (triple-confirmation)
  volumeScore: 0.03,      // volume profile (climax/absorption/dryness)
};

const ATR_PCT: Record<string, number> = {
  "5m": 0.3, "15m": 0.5, "30m": 0.8, "1h": 1.2, "2h": 1.5, "4h": 2.0, "1d": 3.5, "1w": 6.0,
};

/* ─── Pure Math Helpers ──────────────────────────────────────────────── */

function sma(values: number[], window: number): number {
  if (values.length < window) return values[values.length - 1] || 0;
  return values.slice(-window).reduce((a, b) => a + b, 0) / window;
}

function stdevPct(values: number[], window: number): number {
  const avg = sma(values, window);
  const squared = values.slice(-window).reduce((a, v) => a + (v - avg) ** 2, 0);
  return Math.sqrt(squared / window);
}

function emaArr(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function zscore(values: number[], window: number): number {
  if (values.length < window || window < 2) return 0;
  const slice = values.slice(-window);
  const avg = slice.reduce((a, b) => a + b, 0) / window;
  const std = Math.sqrt(slice.reduce((a, v) => a + (v - avg) ** 2, 0) / (window - 1));
  return std > 0 ? (slice[window - 1] - avg) / std : 0;
}

function slope(values: number[], lookback: number): number {
  if (values.length < lookback || lookback < 2) return 0;
  const ys = values.slice(-lookback);
  const xs = Array.from({ length: lookback }, (_, i) => i);
  const n = lookback;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  return denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
}

/* ─── Swing Point Detection (for divergence) ─────────────────────────── */

function findSwingLows(values: number[], lookback: number): number[] {
  const points: number[] = [];
  for (let i = lookback; i < values.length - lookback; i++) {
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback && isLow; j++) {
      if (j !== i && values[j] <= values[i]) isLow = false;
    }
    if (isLow) points.push(i);
  }
  return points;
}

function findSwingHighs(values: number[], lookback: number): number[] {
  const points: number[] = [];
  for (let i = lookback; i < values.length - lookback; i++) {
    let isHigh = true;
    for (let j = i - lookback; j <= i + lookback && isHigh; j++) {
      if (j !== i && values[j] >= values[i]) isHigh = false;
    }
    if (isHigh) points.push(i);
  }
  return points;
}

/* ─── Indicator Computation ──────────────────────────────────────────── */

function computeRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
  return 100 - 100 / (1 + rs);
}

/**
 * Compute MACD(12,26,9) histogram value (MACD line - signal line).
 * Positive histogram = bullish momentum, negative = bearish.
 * Returns { histogram, macdLine, signalLine }.
 */
function computeMacd(closes: number[]): { histogram: number; macdLine: number; signalLine: number } {
  if (closes.length < 35) return { histogram: 0, macdLine: 0, signalLine: 0 };
  const ema12 = emaArr(closes, 12);
  const ema26 = emaArr(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLineArr = emaArr(macdLine.slice(), 9);
  const last = macdLine.length - 1;
  const prev = last - 1;
  const hist = macdLine[last] - signalLineArr[last];
  const histPrev = macdLine[prev] - signalLineArr[prev];
  return {
    histogram: hist,
    macdLine: macdLine[last],
    signalLine: signalLineArr[last],
  };
}

/**
 * Awesome Oscillator: median(5) - median(34) on HL/2.
 * Positive AO = short-term momentum above long-term (bullish).
 */
function computeAo(highs: number[], lows: number[]): number {
  if (highs.length < 35) return 0;
  const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
  const fastMa = sma(hl2, 5);
  const slowMa = sma(hl2, 34);
  return fastMa - slowMa;
}

function computeAoSlope(highs: number[], lows: number[]): number {
  if (highs.length < 38) return 0;
  const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
  const fastMa = sma(hl2, 5);
  const slowMa = sma(hl2, 34);
  const curr = fastMa - slowMa;
  // 3 bars ago: use hl2 excluding last 3, then append remainder
  const hl2Prev = highs.slice(0, -3).map((h, i) => (h + lows[i]) / 2);
  if (hl2Prev.length < 34) return 0;
  const fastMaPrev = sma(hl2Prev, 5);
  const slowMaPrev = sma(hl2Prev, 34);
  const prev = fastMaPrev - slowMaPrev;
  return curr - prev;
}

function computeBb(closes: number[], period = 20, mult = 2): {
  mid: number; upper: number; lower: number; width: number; position: number;
} {
  const L = closes.length;
  if (L < period) {
    return { mid: closes[L - 1] || 0, upper: 0, lower: 0, width: 0, position: 0.5 };
  }
  const mid = sma(closes, period);
  const std = stdevPct(closes, period);
  const upper = mid + mult * std;
  const lower = mid - mult * std;
  const width = mid > 0 ? ((upper - lower) / mid) * 100 : 0;
  const position = upper > lower ? (closes[L - 1] - lower) / (upper - lower) : 0.5;
  return { mid, upper, lower, width, position };
}

/**
 * BB squeeze intensity: how tight current BB width is relative to recent history.
 * 0 = very tight (high squeeze), 1 = very wide (no squeeze).
 */
function bbSqueezePercentile(closes: number[], period = 20, mult = 2, lookback = 50): number {
  const L = closes.length;
  if (L < period + lookback) return 0.5;
  const widths: number[] = [];
  for (let i = L - lookback; i < L; i++) {
    const slice = closes.slice(Math.max(0, i - period + 1), i + 1);
    if (slice.length < period) continue;
    const m = sma(slice, period);
    const s = stdevPct(slice, period);
    const w = m > 0 ? (2 * mult * s / m) * 100 : 0;
    widths.push(w);
  }
  if (widths.length < 5) return 0.5;
  const current = widths[widths.length - 1];
  const sorted = [...widths].sort((a, b) => a - b);
  const rank = sorted.indexOf(current);
  return rank / (sorted.length - 1 || 1);
}

function computeStochastic(highs: number[], lows: number[], closes: number[], kPeriod = 14): number {
  const L = Math.min(highs.length, lows.length, closes.length);
  if (L < kPeriod + 1) return 50;
  const slice = {
    high: Math.max(...highs.slice(-kPeriod)),
    low: Math.min(...lows.slice(-kPeriod)),
    close: closes[L - 1],
  };
  const range = slice.high - slice.low;
  return range > 0 ? ((slice.close - slice.low) / range) * 100 : 50;
}

function computeCci(highs: number[], lows: number[], closes: number[], period = 20): number {
  const L = Math.min(highs.length, lows.length, closes.length);
  if (L < period + 1) return 0;
  const typical = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const avg = sma(typical, period);
  const md = typical.slice(-period).reduce((a, v) => a + Math.abs(v - avg), 0) / period;
  return md > 0 ? (typical[L - 1] - avg) / (0.015 * md) : 0;
}

/* ─── Volume Profile (adapted from volume_profile.py) ────────────────── */

function computeVolumeMetrics(candles: Candle[]): {
  zscore: number; rangeRatio: number; bodyRatio: number;
  buyPressure: number; climax: number; dryness: number;
  absorption: number; expansion: number;
} {
  const L = candles.length;
  const lookback = 20;
  if (L < lookback + 1) {
    return { zscore: 0, rangeRatio: 1, bodyRatio: 0, buyPressure: 0.5,
      climax: 0, dryness: 0, absorption: 0, expansion: 0 };
  }

  const volumes = candles.map(c => c.volume);
  const volZ = zscore(volumes, lookback);

  const ranges = candles.map(c => c.high - c.low);
  const avgRange = ranges.slice(-lookback).reduce((a, b) => a + b, 0) / lookback;
  const rangeNow = ranges[L - 1];
  const rangeRatio = avgRange > 0 ? rangeNow / avgRange : 1;

  const last = candles[L - 1];
  const body = Math.abs(last.close - last.open);
  const bodyRatio = rangeNow > 0 ? body / rangeNow : 0;

  // Buy/sell pressure proxy (from volume_profile.py)
  let buyVol = 0, sellVol = 0;
  for (let k = L - lookback; k < L; k++) {
    const c = candles[k];
    const r = c.high - c.low;
    if (r <= 0) continue;
    const cp = (c.close - c.low) / r; // 0 = at low, 1 = at high
    buyVol += c.volume * cp;
    sellVol += c.volume * (1 - cp);
  }
  const total = buyVol + sellVol;
  const buyPressure = total > 0 ? buyVol / total : 0.5;

  return {
    zscore: volZ,
    rangeRatio,
    bodyRatio,
    buyPressure,
    climax: volZ > 2.0 && rangeRatio < 0.8 ? 1 : 0,
    dryness: volZ < -1.2 && rangeRatio < 0.6 ? 1 : 0,
    absorption: volZ > 1.5 && rangeRatio < 0.7 && bodyRatio < 0.4 ? 1 : 0,
    expansion: volZ > 1.5 && rangeRatio > 1.3 ? 1 : 0,
  };
}

/* ─── Divergence Detection (adapted from divergence.py) ──────────────── */

/**
 * Detect RSI regular bullish divergence:
 * Price makes lower low, RSI makes higher low.
 */
function detectRsiBullDiv(closes: number[], rsiValues: number[], lookback = 30): number {
  if (closes.length < lookback || rsiValues.length < lookback) return 0;
  const start = Math.max(0, closes.length - lookback);
  const priceWin = closes.slice(start);
  const rsiWin = rsiValues.slice(-priceWin.length);

  const priceLows = findSwingLows(priceWin, 3);
  if (priceLows.length < 2) return 0;

  const p1 = priceLows[priceLows.length - 2];
  const p2 = priceLows[priceLows.length - 1];

  // Must be near the last bar
  if (Math.abs(p2 - (priceWin.length - 1)) > 3) return 0;

  // Price lower low
  if (priceWin[p2] >= priceWin[p1] * 0.998) return 0;

  // RSI higher low
  if (rsiWin[p2] <= rsiWin[p1] + 2) return 0;

  return 1;
}

/**
 * Detect AO regular bullish divergence:
 * Price makes lower low, AO makes higher low.
 */
function detectAoBullDiv(closes: number[], aoValues: number[], lookback = 30): number {
  if (closes.length < lookback || aoValues.length < lookback) return 0;
  const start = Math.max(0, closes.length - lookback);
  const priceWin = closes.slice(start);
  const aoWin = aoValues.slice(-priceWin.length);

  const priceLows = findSwingLows(priceWin, 3);
  if (priceLows.length < 2) return 0;

  const p1 = priceLows[priceLows.length - 2];
  const p2 = priceLows[priceLows.length - 1];

  if (Math.abs(p2 - (priceWin.length - 1)) > 3) return 0;
  if (priceWin[p2] >= priceWin[p1] * 0.998) return 0;
  if (aoWin[p2] <= aoWin[p1]) return 0;

  return 1;
}

/**
 * Detect MACD histogram regular bullish divergence:
 * Price makes lower low, MACD histogram makes higher low.
 */
function detectMacdBullDiv(closes: number[], macdHist: number[], lookback = 30): number {
  if (closes.length < lookback || macdHist.length < lookback) return 0;
  const start = Math.max(0, closes.length - lookback);
  const priceWin = closes.slice(start);
  const macdWin = macdHist.slice(-priceWin.length);

  const priceLows = findSwingLows(priceWin, 3);
  if (priceLows.length < 2) return 0;

  const p1 = priceLows[priceLows.length - 2];
  const p2 = priceLows[priceLows.length - 1];

  if (Math.abs(p2 - (priceWin.length - 1)) > 3) return 0;
  if (priceWin[p2] >= priceWin[p1] * 0.998) return 0;
  if (macdWin[p2] <= macdWin[p1]) return 0;

  return 1;
}

/* ─── Swing Distance ──────────────────────────────────────────────────────
 * How far current price is from the nearest structural swing low, measured in ATR.
 * From meta-v20: swing_dist < 3 ATR catches 4,272/4,829 false negatives (88.5%).
 * < 2 ATR = near structure (MOMENTUM_CONTINUATION gate). */

function computeSwingDistAtr(closes: number[], lows: number[], atr14: number): number {
  if (closes.length < 20 || atr14 <= 0) return 5;
  const lowsWin = lows.slice(-30);
  const swingLows = findSwingLows(lowsWin, 3);
  if (swingLows.length < 1) return 5;
  const nearestSwing = swingLows[swingLows.length - 1];
  const swingPrice = lowsWin[nearestSwing];
  const currentPrice = closes[closes.length - 1];
  const dist = currentPrice - swingPrice;
  return dist > 0 ? dist / atr14 : 0;
}

interface IndicatorSnapshot {
  rsi: number;
  macdHistogram: number;
  macdLine: number;
  ao: number;
  bbPosition: number;
  bbWidth: number;
  bbSqueezePct: number;
  /** Distance from price to nearest structural swing low, in ATR units */
  swingDistAtr: number;
}

/* ─── UnifiedEngine Class ────────────────────────────────────────────── */

/** @deprecated Use treeGateEngine from ./tree-gate-engine.ts instead */
export class UnifiedEngine {
  private config: UnifiedEngineConfig;

  constructor(config?: Partial<UnifiedEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate all signal components for a single candle set.
   * Returns a UnifiedSignalResult if composite score meets thresholds, or null.
   *
   * Stateless — all inputs passed explicitly. Thread-safe.
   */
  evaluate(params: {
    symbol: string;
    timeframe: string;
    candles: Candle[];
  }): UnifiedSignalResult | null {
    const { symbol, timeframe, candles } = params;
    const L = candles.length;
    if (L < 50) return null;

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const last = L - 1;
    const entry = closes[last];

    // ── Compute shared indicators ──
    const rsi = computeRsi(closes);
    const macd = computeMacd(closes);
    const ao = computeAo(highs, lows);
    const aoSl = computeAoSlope(highs, lows);
    const bb = computeBb(closes);
    const squeezePct = bbSqueezePercentile(closes);
    const stochK = computeStochastic(highs, lows, closes);
    const cci = computeCci(highs, lows, closes);
    const vol = computeVolumeMetrics(candles);

    // ── Compute AO array for divergence detection ──
    let aoArr: number[] = [];
    if (highs.length >= 35) {
      aoArr = highs.map((h, i) => {
        if (i < 34) return 0;
        const hl2s = highs.slice(0, i + 1).map((hh, ii) => (hh + lows[ii]) / 2);
        return sma(hl2s, 5) - sma(hl2s, 34);
      });
    }

    // Compute MACD histogram array for divergence detection
    let macdHistArr: number[] = [];
    if (closes.length >= 35) {
      const ema12 = emaArr(closes, 12);
      const ema26 = emaArr(closes, 26);
      const macdLine = ema12.map((v, i) => v - ema26[i]);
      const sigLine = emaArr(macdLine.slice(), 9);
      macdHistArr = macdLine.map((v, i) => v - (sigLine[i] ?? 0));
    }

    // ── Compute ATR for swing distance ──
    let atr14 = 1;
    if (L >= 15) {
      const trs: number[] = [];
      for (let i = 1; i < L; i++) {
        const tr = Math.max(highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1]));
        trs.push(tr);
      }
      atr14 = sma(trs, 14);
    }
    const swingDistAtr = computeSwingDistAtr(closes, lows, atr14);

    const indicatorSnap: IndicatorSnapshot = {
      rsi, macdHistogram: macd.histogram, macdLine: macd.macdLine, ao,
      bbPosition: bb.position, bbWidth: bb.width, bbSqueezePct: squeezePct,
      swingDistAtr,
    };

    // ── 1. Score each component ──
    const smcScore = this.scoreSmc(closes, highs, lows, symbol, timeframe);
    const momentumScore = this.scoreMomentum(macd, ao, aoSl, indicatorSnap);
    const oscillatorScore = this.scoreOscillator(rsi, stochK, cci, indicatorSnap);
    const bbAweScore = this.scoreBbawe(bb, squeezePct, ao, aoSl, indicatorSnap);
    const volumeScore = this.scoreVolume(vol);
    const divergenceScore = this.scoreDivergence(closes, rsi, aoArr, macdHistArr);

    // ── 2. Classify regime ──
    const regime = this.classifyRegime(indicatorSnap);
    const regimeScore = this.computeRegimeScore(regime, indicatorSnap);

    // ── 3. Detect direction ──
    const direction = this.detectDirection(indicatorSnap, smcScore, divergenceScore);

    // ── 4. Composite score (weighted sum per meta-v20 calibration) ──
    const compositeScore = Math.round(
      WEIGHTS.bbAweScore * bbAweScore +
      WEIGHTS.momentumScore * momentumScore +
      WEIGHTS.oscillatorScore * oscillatorScore +
      WEIGHTS.smcScore * smcScore +
      WEIGHTS.divergenceScore * divergenceScore +
      WEIGHTS.volumeScore * volumeScore
    );

    // ── 5. Quick MTF alignment ──
    const mtfAlignment = this.quickMtfScore(closes, timeframe);

    // ── 6. Gate: minimum requirements ──
    if (compositeScore < this.config.minCompositeScore) return null;
    if (mtfAlignment < this.config.minMtfAlignment) return null;

    // ── 7. Compute SL/TP ──
    const stopPct = (ATR_PCT[timeframe] || 1.5) * 1.5;
    const stopLoss = parseFloat((entry * (1 - stopPct / 100)).toFixed(8));
    const takeProfit = parseFloat((entry * (1 + (stopPct * this.config.rr) / 100)).toFixed(8));

    // ── 8. Build metadata ──
    const metadata: Record<string, number> = {
      rsi,
      macdHistogram: macd.histogram,
      macdLine: macd.macdLine,
      aoValue: ao,
      aoSlope: aoSl,
      bbMid: bb.mid,
      bbWidth: bb.width,
      bbPosition: bb.position,
      bbSqueezePct: squeezePct,
      stochK,
      cci,
      volZscore: vol.zscore,
      buyPressure: vol.buyPressure,
      volClimax: vol.climax,
      volDryness: vol.dryness,
      swingDistAtr,
      candlesAvailable: L,
      ma7: sma(closes, 7),
      ma25: sma(closes, 25),
    };

    return {
      symbol,
      timeframe,
      direction,
      regime,
      compositeScore,
      regimeScore,
      mtfAlignment,
      components: {
        smcScore,
        momentumScore,
        oscillatorScore,
        bbAweScore,
        volumeScore,
        divergenceScore,
      },
      entry,
      stopLoss,
      takeProfit,
      metadata,
    };
  }

  /* ─── Component Scorers ───────────────────────────────────────────── */

  /**
   * SMC pattern strength: MSS/BOS, Order Blocks, Liquidity sweeps, FVGs.
   * Uses existing LuxAlgo ICT detectors. Score is 0-100.
   */
  private scoreSmc(closes: number[], highs: number[], lows: number[],
                    symbol: string, timeframe: string): number {
    let score = 0;

    // MSS/BOS: structural break is strongest SMC signal
    const mssSignals = detectMSS(closes, highs, lows, symbol, timeframe);
    for (const ms of mssSignals) {
      if (ms.type === "mss_bull" || ms.type === "mss_bear") score += 30;
      else score += 20;
    }

    // Order Blocks: price inside active, unmitigated OB
    const { signals: obSignals } = detectOrderBlocks(closes, highs, lows, symbol, timeframe);
    for (const ob of obSignals) {
      if (ob.confidence >= 70) score += 30;
      else score += 20;
    }

    // Liquidity sweep: sweep of stacked swing lows then reclaim
    const liqSignals = detectLiquidity(highs, lows, closes, symbol, timeframe);
    for (const liq of liqSignals) {
      if (liq.type === "liq_sweep_bull") score += 25;
      else score += 20;
    }

    // FVG: unmitigated fair value gap
    const fvgSignals = detectFVG(highs, lows, symbol, timeframe);
    for (const fvg of fvgSignals) {
      if (fvg.type === "fvg_bull") score += 15;
      else score += 10;
    }

    return Math.min(100, score);
  }

  /**
   * Momentum score: MACD histogram + AO bar + AO slope.
   * 0-100 based on momentum strength and direction.
   */
  private scoreMomentum(macd: { histogram: number; macdLine: number; signalLine: number },
                        ao: number, aoSlope: number, snap: IndicatorSnapshot): number {
    let score = 0;

    // MACD histogram: positive = bullish momentum, rising = strengthening
    if (macd.histogram > 0) {
      score += 25;
      // Histogram rising (higher than previous bar)
      if (macd.histogram > Math.abs(macd.signalLine) * 0.1) score += 15;
    }
    // MACD line above signal line = crossover confirmation
    if (macd.macdLine > macd.signalLine) score += 15;

    // AO positive = short-term momentum above long-term
    if (ao > 0) {
      score += 20;
      // AO rising = acceleration
      if (aoSlope > 0) score += 15;
    }

    // MA slope contribution (feature importance #5)
    if (snap.rsi > 50) score += 10;

    return Math.min(100, score);
  }

  /**
   * Oscillator score: RSI zone + Stochastics + CCI.
   * 0-100 based on oversold recovery or momentum continuation setup.
   */
  private scoreOscillator(rsi: number, stochK: number, cci: number,
                          snap: IndicatorSnapshot): number {
    let score = 0;

    // RSI zone (0-35)
    if (rsi < 35) {
      // Deep oversold — reversal setup, score if BB position supports it
      score += 25;
    } else if (rsi >= 40 && rsi <= 60) {
      // Neutral zone — continuation setup (the 4,828 false-negative zone)
      score += 30;
    } else if (rsi > 35 && rsi < 40) {
      // Borderline oversold
      score += 20;
    } else if (rsi > 60 && rsi < 70) {
      // Approaching overbought — reduced score
      score += 10;
    }

    // RSI gradient: rising from oversold is strongest
    if (rsi > 35 && rsi < 55) score += 15;

    // Stochastics
    if (stochK < 20) {
      // Oversold — reversal setup
      score += 15;
    } else if (stochK >= 20 && stochK <= 50) {
      // Rising from oversold or neutral bullish
      score += 15;
    } else if (stochK > 50 && stochK < 80) {
      score += 10;
    }

    // CCI
    if (cci > -100 && cci < 0) {
      // Recovering from oversold
      score += 15;
    } else if (cci >= 0 && cci < 100) {
      // Neutral bullish
      score += 10;
    } else if (cci < -100) {
      // Oversold — potential reversal if other indicators agree
      score += 10;
    }

    return Math.min(100, score);
  }

  /**
   * BB/AWE score: Bollinger Band squeeze + position + AO expansion.
   * Most heavily weighted component (30% — combines #1 BB position and #3 BB width).
   */
  private scoreBbawe(bb: { mid: number; upper: number; lower: number; width: number; position: number },
                     squeezePct: number, ao: number, aoSlope: number,
                     snap: IndicatorSnapshot): number {
    let score = 0;

    // BB position: where price sits in bands (0=lower, 1=upper)
    // Reversal zone: lower 30% of bands
    if (bb.position >= 0 && bb.position <= 0.3) {
      // Price near lower band — oversold reversal zone
      score += 30;
    } else if (bb.position > 0.3 && bb.position <= 0.6) {
      // Price in middle zone — continuation setup
      score += 25;
    } else if (bb.position > 0.6 && bb.position < 0.8) {
      score += 15;
    }

    // BB squeeze: tighter bands = higher squeeze potential
    // squeezePct: 0 = very tight (squeezed), 1 = very wide
    if (squeezePct < 0.15) {
      score += 35; // Extremely tight squeeze — imminent expansion
    } else if (squeezePct < 0.35) {
      score += 30; // Moderate squeeze
    } else if (squeezePct < 0.55) {
      score += 20; // Mild squeeze
    } else {
      score += 10; // No squeeze — reduced confidence
    }

    // AO expansion confirmation (BBAWE R1.1 methodology)
    if (ao > 0 && aoSlope > 0) {
      score += 35; // Positive and rising AO = momentum expansion
    } else if (ao > 0) {
      score += 20; // Positive AO but not rising
    } else if (ao < 0 && snap.rsi < 40) {
      // Negative AO with oversold RSI = potential reversal setup
      score += 15;
    }

    return Math.min(100, score);
  }

  /**
   * Volume score: climax/absorption/dryness patterns adapted from volume_profile.py.
   * 0-100 based on volume structure quality.
   */
  private scoreVolume(vol: ReturnType<typeof computeVolumeMetrics>): number {
    let score = 0;

    // Volume climax (z > 2 + small range) = smart money absorption at extremes
    // This is a HIGH quality reversal signal
    if (vol.climax) {
      score += 30;
    }

    // Volume dryness (z < -1.2 + tight range) = compression → breakout imminent
    if (vol.dryness) {
      score += 30;
    }

    // Volume absorption (z > 1.5 + small body) = smart money absorbing
    if (vol.absorption) {
      score += 25;
    }

    // Volume expansion (z > 1.5 + large range) = trend momentum
    if (vol.expansion) {
      score += 15;
    }

    // Buy pressure dominance (>60% buy volume)
    if (vol.buyPressure > 0.6) {
      score += 20;
    } else if (vol.buyPressure > 0.55) {
      score += 10;
    }

    // Narrow range = coiling (bonus if also volume dryness)
    if (vol.rangeRatio < 0.7 && !vol.dryness) {
      score += 10;
    }

    return Math.min(100, score);
  }

  /**
   * Divergence score: RSI/AO/MACD triple confirmation.
   * Adapted from divergence.py — swing point comparison methodology.
   */
  private scoreDivergence(closes: number[], rsi: number,
                          aoArr: number[], macdHistArr: number[]): number {
    let count = 0;

    // RSI divergence
    if (closes.length >= 35) {
      // Build RSI array for divergence detection
      const rsiArr: number[] = [];
      for (let i = 14; i < closes.length; i++) {
        rsiArr.push(computeRsi(closes.slice(0, i + 1)));
      }
      if (rsiArr.length > 20) {
        if (detectRsiBullDiv(closes, rsiArr)) count++;
      }
    }

    // AO divergence
    if (aoArr.length > 20) {
      if (detectAoBullDiv(closes, aoArr)) count++;
    }

    // MACD histogram divergence
    if (macdHistArr.length > 20) {
      if (detectMacdBullDiv(closes, macdHistArr)) count++;
    }

    // Score based on confirmation count
    if (count >= 3) return 100;    // Triple confirmation — max score
    if (count >= 2) return 70;     // Double confirmation
    if (count >= 1) return 40;     // Single confirmation
    return 0;                      // No divergence detected
  }

  /* ─── Regime ──────────────────────────────────────────────────────── */

  /**
   * Classify market regime based on the meta-v20 false-negative analysis.
   *
   * OVERSOLD_REVERSAL: RSI < 35
   *   → Caught 605 winners at WR=86.8%. Price near lower BB, negative AO.
   *
   * MOMENTUM_CONTINUATION: AO > -1 AND MACD > -0.5 AND RSI >= 35
   *                        AND swingDistAtr < 2 ATR
   *   → The 4,829 false negatives (Mann-Whitney U p<0.0001).
   *     RSI~50, stoch~48, AO>0, MACD>0, swing_dist=1.4 ATR
   *     swing_dist < 3 ATR recovers 4,272/4,829 of them (88.5%).
   *
   * Default (unclassified): falls to MOMENTUM_CONTINUATION with reduced score.
   */
  private classifyRegime(snap: IndicatorSnapshot): SignalRegime {
    if (snap.rsi < 35) return "OVERSOLD_REVERSAL";

    // MOMENTUM_CONTINUATION: proven recovery gate for false negatives
    const isContinuation =
      snap.ao > -1 &&
      snap.macdHistogram > -0.5 &&
      snap.rsi >= 35 &&
      snap.swingDistAtr < 2;

    if (isContinuation) return "MOMENTUM_CONTINUATION";

    // Default to MOMENTUM_CONTINUATION (most trades are continuations)
    return "MOMENTUM_CONTINUATION";
  }

  /**
   * Confidence score within the classified regime (0-100).
   * IMPORTANT: per-regime feature importance differs — score each
   * regime's quality SEPARATELY (meta-v20 finding).
   *
   * OVERSOLD_REVERSAL regime: BB position + RSI depth + volume climax
   * MOMENTUM_CONTINUATION regime: AO trend + MACD confirmation + swing distance
   */
  private computeRegimeScore(regime: SignalRegime, snap: IndicatorSnapshot): number {
    if (regime === "OVERSOLD_REVERSAL") {
      // OVERSOLD_REVERSAL regime score:
      // RSI depth + BB position + BB squeeze + volume confirmation
      let s = 30;

      // RSI depth: lower = stronger reversal potential (caught winners RSI~27)
      if (snap.rsi < 20) s += 30;
      else if (snap.rsi < 25) s += 25;
      else if (snap.rsi < 30) s += 15;
      else if (snap.rsi < 35) s += 10;

      // BB position: near lower band = reversal zone
      if (snap.bbPosition < 0.1) s += 20;
      else if (snap.bbPosition < 0.2) s += 15;
      else if (snap.bbPosition < 0.35) s += 10;

      // BB squeeze: tight bands increase reversal probability
      if (snap.bbSqueezePct < 0.15) s += 15;
      else if (snap.bbSqueezePct < 0.35) s += 10;

      // Volume climax at low = smart money absorbing
      // (volume zscore > 2 + small range — already in vol metrics)
      // Bonus: negative AO deeper = more stretched
      if (snap.ao < -2) s += 10;
      else if (snap.ao < -1) s += 5;

      return Math.min(100, Math.max(0, s));
    }

    // MOMENTUM_CONTINUATION regime score:
    // AO trend + MACD + swing proximity + BB position
    let s = 30;

    // AO positive = short-term momentum above long-term (h4_ao #4)
    if (snap.ao > 0) s += 20;
    else if (snap.ao > -0.5) s += 10;

    // MACD histogram positive = momentum confirmation (m15_macd #2)
    if (snap.macdHistogram > 0) s += 20;
    else if (snap.macdHistogram > -0.5) s += 10;
    if (snap.macdLine > 0) s += 5; // MACD line positive is bullish

    // RSI sweet spot: 40-60 (false negatives cluster at RSI~50)
    if (snap.rsi >= 45 && snap.rsi <= 55) s += 10;
    else if (snap.rsi >= 40 && snap.rsi <= 60) s += 5;

    // Swing distance: closer to structure = better risk (false neg swing_dist=1.4 ATR)
    if (snap.swingDistAtr < 1) s += 15;
    else if (snap.swingDistAtr < 1.5) s += 12;
    else if (snap.swingDistAtr < 2) s += 8;

    // BB position (mid-zone = healthier for continuation)
    if (snap.bbPosition >= 0.3 && snap.bbPosition <= 0.6) s += 10;

    return Math.min(100, Math.max(0, s));
  }

  /**
   * Detect trade direction from indicator alignment.
   * Primarily detects LONG setups; SHORT when indicators are clearly bearish.
   */
  private detectDirection(snap: IndicatorSnapshot, smcScore: number,
                           divergenceScore: number): SignalDirection {
    let bullScore = 0;
    let bearScore = 0;

    // SMC structure
    if (smcScore >= 40) bullScore += 20;
    else if (smcScore >= 20) bullScore += 10;

    // RSI
    if (snap.rsi > 30 && snap.rsi < 70) bullScore += 15;
    if (snap.rsi > 70) bearScore += 15;
    if (snap.rsi < 30) bearScore += 10;

    // MACD
    if (snap.macdHistogram > 0) bullScore += 15;
    else if (snap.macdHistogram < -0.5) bearScore += 15;

    // AO
    if (snap.ao > 0) bullScore += 15;
    else if (snap.ao < -0.5) bearScore += 15;

    // Divergence (check highest thresholds first)
    if (divergenceScore >= 70) bullScore += 25;    // Triple or double confirmation
    else if (divergenceScore >= 40) bullScore += 20; // Single confirmation

    // BB position (near lower band is bullish for reversal)
    if (snap.bbPosition < 0.4) bullScore += 15;

    return bullScore >= bearScore ? "long" : "short";
  }

  /**
   * Quick synchronous MTF estimate from current candle data.
   * Uses MA structure + momentum as proxy for higher timeframe alignment.
   *
   * For async MTF evaluation with Binance, use evaluateMtfMatrix() from mtf-matrix.ts.
   */
  private quickMtfScore(closes: number[], timeframe: string): number {
    const L = closes.length;
    if (L < 25) return 50;

    const ma7 = sma(closes, 7);
    const ma25 = sma(closes, 25);
    const ma99 = L >= 99 ? sma(closes, 99) : ma25;
    const bullish = ma7 > ma25 && ma25 > ma99;

    // Momentum over last 5 bars
    const mom5 = L >= 6 ? ((closes[L - 1] - closes[L - 6]) / closes[L - 6]) * 100 : 0;

    // Compression: recent range vs average (coiling = potential expansion)
    const last5 = closes.slice(-5);
    const range5 = Math.max(...last5) - Math.min(...last5);
    const avgRange = L >= 25 ? (Math.max(...closes.slice(-25)) - Math.min(...closes.slice(-25))) / 25 * 5 : range5;
    const compressed = avgRange > 0 && range5 / avgRange < 0.7;

    let score = 50;

    // Trend alignment
    if (bullish && mom5 > 0) score += 25;
    else if (bullish) score += 15;
    else if (!bullish && mom5 < 0) score += 10;
    else score -= 10;

    // Compression bonus (coiling before expansion)
    if (compressed) score += 10;

    // Timeframe confidence: higher TFs get higher baseline alignment
    if (timeframe === "4h" || timeframe === "1d") score += 10;
    else if (timeframe === "1h") score += 5;

    return Math.max(0, Math.min(100, score));
  }

  /* ─── Config Access ───────────────────────────────────────────────── */

  getConfig(): UnifiedEngineConfig {
    return { ...this.config };
  }
}

/* ─── Re-exports from Tree-Gate Engine ────────────────────────────────
 * New signals should use the tree-gate engine directly:
 *   import { treeGateEngine, treeGateEvaluate } from "./tree-gate-engine";
 * These re-exports provide a migration path from the deprecated UnifiedEngine. */

export type { SignalGate, TreeGatedSignal, TreeGateEngine, TreeGateFeatures } from "./tree-gate-engine";
export { treeGateEngine, treeGateEvaluate } from "./tree-gate-engine";
