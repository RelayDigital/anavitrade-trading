#!/usr/bin/env npx tsx
/**
 * MTF Training Data Builder v3 — SMC on 1h, BB/AO on BOTH 4h + chart TF.
 *
 * Architecture:
 *   4h bars  → Trend, fib levels, swing points, BB/AO (structural context)
 *   1h bars  → SMC pattern detection (OB, FVG, sweep, CHoCH)
 *   15m bars → BB, AO, volume, RSI — CONTINUOUS features on EVERY bar
 *
 * v3 changes:
 *   - Restored 4h-level BB/AO features (were lost when switched to ct_* only)
 *   - Sentinel -1.0 for missing SMC patterns (distinct from "price at zone")
 *   - 5 multiplicative interaction features for LightGBM
 *   - Total: ~55 features (up from 43)
 *
 * ALL features are computable WITHOUT lookahead.
 * Labels are the ONLY forward-looking component.
 *
 * Usage:
 *   npx tsx scripts/ml/build-training-data-mtf.ts \
 *     --input scripts/data/klines-mtf.json \
 *     --output scripts/data/training-data-mtf-v3.json
 *
 *   npx tsx scripts/ml/build-training-data-mtf.ts \
 *     --input scripts/data/klines-mtf.json \
 *     --output scripts/data/training-data-mtf-v3.csv \
 *     --format csv
 */

import * as fs from "node:fs";

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MtfGroup {
  symbol: string;
  klines: {
    "4h"?: Kline[];
    "1h": Kline[];
    "15m"?: Kline[];
  };
}

interface EnrichedBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  range: number;
  body: number;
  bodyRatio: number;
  closePosition: number;
  upperWick: number;
  lowerWick: number;
  wickMagnitude: number;
  // MAs
  ma7: number;
  ma25: number;
  ma99: number;
  // ATR
  atr14: number;
  atrPercentile: number; // 20-bar lookback
  // Volume
  volumeMa20: number;
  volumeZscore: number;
  // RSI
  rsi14: number;
  // Bollinger Bands
  bbMid: number;
  bbUpper: number;
  bbLower: number;
  bbWidthPct: number;
  // Awesome Oscillator
  ao: number;
  aoSlope: number;       // AO[0] - AO[3]
  aoAcceleration: number; // AO[0] - 2*AO[2] + AO[4]
  // Derived
  ma25Slope: number;      // 5-bar slope of MA25
  displacement: number;   // (close - ma7) / atr14
}

/* ─── SMC Detection Result Types ──────────────────────────────────────────── */

interface OBResult {
  found: boolean;
  top: number;
  bottom: number;
  barOffset: number; // offset from current bar
}

interface FVGResult {
  found: boolean;
  top: number;
  bottom: number;
  barOffset: number;
}

interface SweepResult {
  found: boolean;
  depthAtr: number; // how deep below/above the swing level in ATR
}

interface ChochResult {
  found: boolean;
}

/* ─── Fib Detection Types ─────────────────────────────────────────────────── */

interface FibResult {
  found: boolean;
  swingLow: number;
  swingHigh: number;
  fib618: number;  // 0.618 retracement level
  fib786: number;  // 0.786 retracement level
  direction: "bull" | "bear"; // bull = swing low→high, bear = swing high→low
}

/* ─── Feature Row ─────────────────────────────────────────────────────────── */

interface MtfFeatureRow {
  symbol: string;
  timeframe: string; // "4h" — the primary index timeframe
  timestamp: number;
  direction: "long" | "short";

  // ── 4h Structure (8 features)
  h4_trend_bull: number;           // 0/1 — MA7>25>99
  h4_trend_bear: number;           // 0/1 — MA7<25<99
  h4_ma_separation_atr: number;    // (MA7 - MA25) / ATR
  h4_ma25_slope: number;           // 5-bar slope of MA25
  h4_atr_percentile: number;       // 0-1
  h4_fib_detected: number;         // 0/1 — fib impulse swing found
  h4_fib_golden_distance_atr: number; // distance to nearest 0.618-0.786 level in ATR
  h4_swing_distance_atr: number;   // distance to nearest swing pivot in ATR

  // ── 4h BB/AO (6 features) — computed on actual 4h kline bars
  h4_bb_width_pct: number;         // BB(20,2) width as % of price on 4h close
  h4_bb_squeeze_intensity: number; // 0-1, 0=tightest in 20-bar 4h window
  h4_bb_expanding: number;         // 0/1, width increasing vs prior 4h bar
  h4_ao_value: number;             // AO(5,34) raw value on 4h
  h4_ao_slope: number;             // 3-bar slope on 4h
  h4_ao_acceleration: number;      // 2nd derivative on 4h

  // ── 1h SMC Patterns (20 features — v4 adds _present companions)
  h1_ob_bull: number;              // 0/1 — bullish OB found (anywhere in lookback)
  h1_ob_bear: number;              // 0/1 — bearish OB found
  h1_ob_distance_atr: number;      // distance to nearest OB zone in ATR (0 when no OB)
  h1_ob_size_atr: number;          // OB size in ATR (0 when no OB)
  h1_ob_present: number;           // 0/1 — v4: companion flag so model can gate
  h1_fvg_bull: number;             // 0/1
  h1_fvg_bear: number;             // 0/1
  h1_fvg_distance_atr: number;     // distance to nearest FVG zone in ATR (0 when no FVG)
  h1_fvg_size_atr: number;         // FVG size in ATR (0 when no FVG)
  h1_fvg_present: number;          // 0/1 — v4: companion flag
  h1_sweep_bull: number;           // 0/1
  h1_sweep_bear: number;           // 0/1
  h1_sweep_depth_atr: number;      // sweep depth in ATR (0 when no sweep)
  h1_sweep_present: number;        // 0/1 — v4: companion flag
  h1_choch_bull: number;           // 0/1
  h1_choch_bear: number;           // 0/1
  h1_smc_confluence_count: number; // 0-4 patterns agreeing
  h1_smc_any_present: number;      // 0/1 — v4: any SMC pattern found in trade direction

  // ── Chart TF Continuous (15m, 16 features) — always present
  ct_bb_width_pct: number;         // 0-100
  ct_bb_squeeze_intensity: number; // 0-1, 0=tightest
  ct_bb_expanding: number;         // 0/1
  ct_ao_value: number;             // raw AO
  ct_ao_slope: number;             // AO[0] - AO[3]
  ct_ao_acceleration: number;      // AO[0] - 2*AO[2] + AO[4]
  ct_ao_cross_up: number;          // 0/1 — crossed above zero this bar
  ct_ao_cross_down: number;        // 0/1 — crossed below zero this bar
  ct_rsi: number;                  // 0-100
  ct_rsi_velocity: number;         // RSI[0] - RSI[3]
  ct_volume_zscore: number;
  ct_volume_ratio: number;         // volume / volMA20
  ct_displacement: number;         // (close - MA7) / ATR
  ct_body_ratio: number;           // 0-1
  ct_close_position: number;       // 0-1
  ct_wick_magnitude_atr: number;   // larger wick / ATR

  // ── MTF Confluence (5 features)
  mtf_1h_ob_near_4h_fib: number;          // 0/1
  mtf_1h_ob_near_4h_fib_distance: number; // ATR
  mtf_1h_fvg_near_4h_fib: number;         // 0/1
  mtf_1h_fvg_near_4h_fib_distance: number;// ATR
  mtf_level_confluence_count: number;     // how many levels cluster near price

  // ── Interaction Features (5 features)
  bb_squeeze_x_fvg_distance: number;       // h4_bb_squeeze_intensity * h1_fvg_distance_atr (FVG present else 0)
  ao_accel_x_ob_distance: number;          // h4_ao_acceleration * h1_ob_distance_atr (OB present else 0)
  ma_sep_x_rsi_velocity: number;           // h4_ma_separation_atr * ct_rsi_velocity
  atr_percentile_x_bb_squeeze: number;     // h4_atr_percentile * ct_bb_squeeze_intensity
  fvg_distance_x_mtf_fib_distance: number; // h1_fvg_distance_atr * mtf_1h_fvg_near_4h_fib_distance (both present)

  // ── Derived Features v4 (8 features) — always present, no lookahead
  ct_price_in_bb: number;              // 0-1: price position within BB(20,2), 0=lower, 1=upper
  h4_price_in_bb: number;              // same on 4h bars
  ct_ao_distance_from_zero_atr: number; // |AO| / ATR — momentum magnitude normalized
  ct_rsi_extreme_bull: number;          // 0/1: RSI > 70
  ct_rsi_extreme_bear: number;          // 0/1: RSI < 30
  h4_trend_strength: number;           // |h4_ma_separation_atr| — continuous trend intensity
  ct_candle_engulfing_bull: number;    // 0/1: bullish engulfing on chart TF
  ct_candle_engulfing_bear: number;    // 0/1: bearish engulfing on chart TF

  // ── Labels
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
  if (!input) { console.error("Missing --input <file>"); process.exit(1); }
  if (!output) { console.error("Missing --output <file>"); process.exit(1); }
  return {
    input,
    output,
    format: (map.get("format") as "json" | "csv") ?? "json",
    maxLookforward: Number(map.get("max-lookforward") ?? "100"),
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

function trueRange(high: number[], low: number[], close: number[]): number[] {
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

function atr(high: number[], low: number[], close: number[], length: number): (number | null)[] {
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

function linearSlope(values: number[], lookback: number, idx: number): number {
  const pts: { x: number; y: number }[] = [];
  for (let j = Math.max(0, idx - lookback + 1); j <= idx; j++) {
    if (Number.isFinite(values[j])) pts.push({ x: j, y: values[j] });
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

/* ─── Bollinger Bands ─────────────────────────────────────────────────────── */

function bollinger(
  close: number[], length: number, stdMult: number,
): { mid: number[]; upper: number[]; lower: number[]; widthPct: number[] } {
  const mid = sma(close, length);
  const n = close.length;
  const upper: number[] = new Array(n).fill(0);
  const lower: number[] = new Array(n).fill(0);
  const widthPct: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const m = mid[i];
    if (m === null) continue;
    let sq = 0;
    const start = Math.max(0, i - length + 1);
    const actualN = i - start + 1;
    for (let j = start; j <= i; j++) sq += (close[j] - m) ** 2;
    const std = Math.sqrt(sq / actualN);
    upper[i] = m + std * stdMult;
    lower[i] = m - std * stdMult;
    widthPct[i] = m > 0 ? (upper[i] - lower[i]) / m * 100 : 0;
  }
  return { mid: mid.map(v => v ?? 0), upper, lower, widthPct };
}

/* ─── Awesome Oscillator ──────────────────────────────────────────────────── */

function aoValues(high: number[], low: number[], fastLen: number, slowLen: number): (number | null)[] {
  const hl2 = high.map((h, i) => (h + low[i]) / 2);
  const fastSma = sma(hl2, fastLen);
  const slowSma = sma(hl2, slowLen);
  const n = hl2.length;
  const ao: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    ao[i] = (fastSma[i] !== null && slowSma[i] !== null)
      ? fastSma[i]! - slowSma[i]!
      : null;
  }
  return ao;
}

/* ─── Enrich Bars ─────────────────────────────────────────────────────────── */

function enrichBars(klines: Kline[]): EnrichedBar[] {
  const n = klines.length;
  if (n === 0) return [];

  const open = klines.map(k => k.open);
  const high = klines.map(k => k.high);
  const low = klines.map(k => k.low);
  const close = klines.map(k => k.close);
  const volume = klines.map(k => k.volume);

  const ma7 = sma(close, 7);
  const ma25 = sma(close, 25);
  const ma99 = sma(close, 99);
  const atr14 = atr(high, low, close, 14);
  const volMa20 = sma(volume, 20);
  const volZ = rollingZscore(volume, 20);
  const rsi14 = rsi(close, 14);
  const bb = bollinger(close, 20, 2);
  const ao = aoValues(high, low, 5, 34);
  const atrPercentile = percentRank(atr14.map(v => v ?? 0), 20);

  const result: EnrichedBar[] = [];
  for (let i = 0; i < n; i++) {
    const k = klines[i];
    const range = high[i] - low[i];
    const body = Math.abs(close[i] - open[i]);
    const bodyRatio = range > 0 ? body / range : 0;
    const closePosition = range > 0 ? (close[i] - low[i]) / range : 0.5;
    const upperWick = high[i] - Math.max(open[i], close[i]);
    const lowerWick = Math.min(open[i], close[i]) - low[i];
    const wickMagnitude = Math.max(upperWick, lowerWick);

    const ma25Val = ma25[i];
    const ma25Slope = linearSlope(
      ma25.map(v => v ?? 0), 5, i,
    );

    const ma7Val = ma7[i] ?? 0;
    const atrVal = atr14[i] ?? 0;
    const displacement = atrVal > 0 ? (close[i] - ma7Val) / atrVal : 0;

    const aoVal = ao[i];
    const aoSlope = (aoVal !== null && i >= 3 && ao[i - 3] !== null)
      ? aoVal - ao[i - 3]! : 0;
    const aoAccel = (aoVal !== null && i >= 4 && ao[i - 2] !== null && ao[i - 4] !== null)
      ? aoVal - 2 * ao[i - 2]! + ao[i - 4]! : 0;

    result.push({
      timestamp: k.timestamp,
      open: open[i], high: high[i], low: low[i], close: close[i], volume: volume[i],
      range, body, bodyRatio, closePosition,
      upperWick, lowerWick, wickMagnitude,
      ma7: ma7Val, ma25: ma25Val ?? 0, ma99: ma99[i] ?? 0,
      atr14: atrVal, atrPercentile: atrPercentile[i] ?? 0.5,
      volumeMa20: volMa20[i] ?? 0, volumeZscore: volZ[i] ?? 0,
      rsi14: rsi14[i] ?? 0,
      bbMid: bb.mid[i], bbUpper: bb.upper[i], bbLower: bb.lower[i],
      bbWidthPct: bb.widthPct[i],
      ao: aoVal ?? 0, aoSlope, aoAcceleration: aoAccel,
      ma25Slope, displacement,
    });
  }
  return result;
}

/* ─── Swing Point Detection ───────────────────────────────────────────────── */

function isPivotHigh(high: number[], idx: number, lookback: number): boolean {
  if (idx < lookback || idx >= high.length - lookback) return false;
  const val = high[idx];
  for (let j = 1; j <= lookback; j++) {
    if (high[idx - j] >= val || high[idx + j] >= val) return false;
  }
  return true;
}

function isPivotLow(low: number[], idx: number, lookback: number): boolean {
  if (idx < lookback || idx >= low.length - lookback) return false;
  const val = low[idx];
  for (let j = 1; j <= lookback; j++) {
    if (low[idx - j] <= val || low[idx + j] <= val) return false;
  }
  return true;
}

/* ─── 4h Fibonacci Level Detection ────────────────────────────────────────── */

/**
 * Find the most recent impulse swing on 4h and compute fib retracement levels.
 * An impulse swing is a significant move from a pivot low to pivot high
 * (or vice versa) with magnitude >= 2 * ATR.
 *
 * Returns the golden pocket (0.618-0.786) for the nearest impulse.
 */
function detectFibLevels(
  bars: EnrichedBar[],
  idx: number,
  swingLookback: number,
  fibLookback: number,
): FibResult {
  const empty: FibResult = {
    found: false, swingLow: 0, swingHigh: 0,
    fib618: 0, fib786: 0, direction: "bull",
  };
  if (idx < swingLookback + 1) return empty;

  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);

  // Find all pivot highs and lows in the lookback window
  const pivotsHigh: { bar: number; value: number }[] = [];
  const pivotsLow: { bar: number; value: number }[] = [];
  const start = Math.max(swingLookback, idx - fibLookback);
  for (let k = start; k <= idx - swingLookback; k++) {
    if (isPivotHigh(high, k, swingLookback)) {
      pivotsHigh.push({ bar: k, value: high[k] });
    }
    if (isPivotLow(low, k, swingLookback)) {
      pivotsLow.push({ bar: k, value: low[k] });
    }
  }

  if (pivotsHigh.length === 0 || pivotsLow.length === 0) return empty;

  // Pivot low → pivot high = bull impulse
  // Pivot high → pivot low = bear impulse
  // Find the most recent impulse with significant magnitude
  const currAtr = bars[idx].atr14;
  if (currAtr <= 0) return empty;

  // Bull fib: swing low → swing high, then retrace back to golden pocket
  // Scan for pivot low that precedes a pivot high
  let bestBull: FibResult | null = null;
  let bestBullRecency = Infinity;
  for (const pl of pivotsLow) {
    for (const ph of pivotsHigh) {
      if (ph.bar <= pl.bar) continue; // high must come after low
      const magnitude = ph.value - pl.value;
      if (magnitude < 1.5 * currAtr) continue; // significant impulse
      const fib618 = ph.value - 0.618 * magnitude;
      const fib786 = ph.value - 0.786 * magnitude;
      const recency = idx - ph.bar;
      if (recency < bestBullRecency && recency >= 0) {
        bestBullRecency = recency;
        bestBull = {
          found: true, swingLow: pl.value, swingHigh: ph.value,
          fib618, fib786, direction: "bull",
        };
      }
    }
  }

  // Bear fib: swing high → swing low, then retrace back to golden pocket
  let bestBear: FibResult | null = null;
  let bestBearRecency = Infinity;
  for (const ph of pivotsHigh) {
    for (const pl of pivotsLow) {
      if (pl.bar <= ph.bar) continue;
      const magnitude = ph.value - pl.value;
      if (magnitude < 1.5 * currAtr) continue;
      const fib618 = pl.value + 0.618 * magnitude;
      const fib786 = pl.value + 0.786 * magnitude;
      const recency = idx - pl.bar;
      if (recency < bestBearRecency && recency >= 0) {
        bestBearRecency = recency;
        bestBear = {
          found: true, swingLow: pl.value, swingHigh: ph.value,
          fib618, fib786, direction: "bear",
        };
      }
    }
  }

  // Return the most recent fib (bull or bear)
  if (bestBull && bestBear) {
    return bestBullRecency <= bestBearRecency ? bestBull : bestBear;
  }
  return bestBull ?? bestBear ?? empty;
}

/**
 * Distance from current price to the nearest golden pocket level (0.618 or 0.786).
 * Returns ATR-normalized distance. 0 = price is exactly at a golden level.
 */
function fibGoldenDistanceAtr(
  fib: FibResult,
  currentClose: number,
  atr: number,
): number {
  if (!fib.found || atr <= 0) return 5; // far away
  const pocketTop = Math.max(fib.fib618, fib.fib786);
  const pocketBot = Math.min(fib.fib618, fib.fib786);
  if (currentClose <= pocketTop && currentClose >= pocketBot) return 0; // inside
  const distAbove = Math.max(0, currentClose - pocketTop);
  const distBelow = Math.max(0, pocketBot - currentClose);
  return Math.min(distAbove, distBelow) / atr;
}

/**
 * Distance from current price to the nearest swing pivot (high or low) in ATR.
 */
function swingDistanceAtr(
  bars: EnrichedBar[],
  idx: number,
  swingLookback: number,
  searchRange: number,
): number {
  if (idx < swingLookback) return 5;
  const close = bars[idx].close;
  const atr = bars[idx].atr14;
  if (atr <= 0) return 5;

  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);

  let minDist = Infinity;
  for (let k = Math.max(swingLookback, idx - searchRange); k <= idx - swingLookback; k++) {
    if (isPivotHigh(high, k, swingLookback)) {
      minDist = Math.min(minDist, Math.abs(close - high[k]));
    }
    if (isPivotLow(low, k, swingLookback)) {
      minDist = Math.min(minDist, Math.abs(close - low[k]));
    }
  }
  return minDist === Infinity ? 5 : minDist / atr;
}

/* ─── 1h SMC Detection — Order Blocks (adapted from v5 Pine) ──────────────── */

/**
 * Detect unmitigated Order Blocks on 1h bars.
 * Bullish OB: last bearish candle before a strong rally (broke above pivot).
 * Bearish OB: last bullish candle before a strong drop (broke below pivot).
 *
 * Does NOT require retest proximity — returns the nearest found OB.
 */
function detectOB_1h(
  bars: EnrichedBar[],
  idx: number,
  isLong: boolean,
  lookbackOB: number,
  swingLookback: number,
): OBResult {
  const empty: OBResult = { found: false, top: 0, bottom: 0, barOffset: 0 };
  if (idx < swingLookback + 1) return empty;

  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);
  const close = bars.map(b => b.close);
  const open = bars.map(b => b.open);
  const atrVals = bars.map(b => b.atr14);

  for (let obRelOffset = swingLookback; obRelOffset <= lookbackOB; obRelOffset++) {
    const obOffset = idx - obRelOffset;
    if (obOffset < 0) continue;

    let obIdx = obOffset;

    if (isLong) {
      // Bullish OB: find pivot low
      if (!isPivotLow(low, obOffset, swingLookback)) continue;
      const pivotLow = low[obOffset];

      // Find candle that made this pivot
      for (let j = obOffset - 1; j >= Math.max(0, obOffset - swingLookback); j--) {
        if (low[j] <= pivotLow) { obIdx = j; break; }
      }

      // OB must be bearish candle
      let isBearish = close[obIdx] < open[obIdx];
      if (!isBearish) {
        if (obIdx + 1 < bars.length && close[obIdx + 1] < open[obIdx + 1]) {
          obIdx = obIdx + 1;
          isBearish = true;
        } else {
          continue;
        }
      }

      const obTop = high[obIdx];
      const obBot = low[obIdx];
      const obSize = obTop - obBot;

      // Check rally: max price after OB must be significantly above OB top
      let maxAfter = -Infinity;
      for (let k = obIdx - 1; k >= 0; k--) maxAfter = Math.max(maxAfter, high[k]);
      const rallyPct = obTop > 0 ? (maxAfter - obTop) / obTop * 100 : 0;
      if (rallyPct < 2.0 || maxAfter <= obTop * 1.005) continue;

      // Check unmitigated: no close below OB bottom since rally
      let mitigated = false;
      for (let k = obIdx - 1; k >= 0; k--) {
        if (close[k] < obBot) { mitigated = true; break; }
      }
      if (mitigated) continue;

      return { found: true, top: obTop, bottom: obBot, barOffset: obRelOffset };

    } else {
      // Bearish OB: find pivot high
      if (!isPivotHigh(high, obOffset, swingLookback)) continue;
      const pivotHigh = high[obOffset];

      for (let j = obOffset - 1; j >= Math.max(0, obOffset - swingLookback); j--) {
        if (high[j] >= pivotHigh) { obIdx = j; break; }
      }

      let isBullish = close[obIdx] > open[obIdx];
      if (!isBullish) {
        if (obIdx + 1 < bars.length && close[obIdx + 1] > open[obIdx + 1]) {
          obIdx = obIdx + 1;
          isBullish = true;
        } else {
          continue;
        }
      }

      const obTop = low[obIdx];   // lower bound for bearish OB
      const obBot = high[obIdx];  // upper bound for bearish OB
      const obSize = obBot - obTop;

      // Check drop
      let minAfter = Infinity;
      for (let k = obIdx - 1; k >= 0; k--) minAfter = Math.min(minAfter, low[k]);
      const dropPct = obBot > 0 ? (obBot - minAfter) / obBot * 100 : 0;
      if (dropPct < 2.0 || minAfter >= obBot * 0.995) continue;

      let mitigated = false;
      for (let k = obIdx - 1; k >= 0; k--) {
        if (close[k] > obBot) { mitigated = true; break; }
      }
      if (mitigated) continue;

      return { found: true, top: obTop, bottom: obBot, barOffset: obRelOffset };
    }
  }

  return empty;
}

/* ─── 1h SMC Detection — Fair Value Gaps (adapted from v5 Pine) ───────────── */

function detectFVG_1h(
  bars: EnrichedBar[],
  idx: number,
  isLong: boolean,
  lookback: number,
  minSizeAtr: number,
): FVGResult {
  const empty: FVGResult = { found: false, top: 0, bottom: 0, barOffset: 0 };
  if (idx < 3) return empty;

  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);
  const close = bars.map(b => b.close);
  const open = bars.map(b => b.open);
  const atrVals = bars.map(b => b.atr14);

  for (let fvgRelOffset = 2; fvgRelOffset <= lookback; fvgRelOffset++) {
    const a = idx - (fvgRelOffset + 2);
    const b = idx - (fvgRelOffset + 1);
    const c = idx - fvgRelOffset;
    if (a < 0 || b < 0 || c < 0) continue;

    let gapTop: number, gapBot: number, gapSize: number;

    if (isLong) {
      // Bullish FVG: low[a] > high[c]
      gapTop = low[a];
      gapBot = high[c];
      if (gapTop <= gapBot) continue;

      gapSize = gapTop - gapBot;
      if (gapSize < minSizeAtr * atrVals[c]) continue;

      // Candle B must be large impulsive bullish
      const bBody = Math.abs(close[b] - open[b]);
      const bRange = high[b] - low[b];
      const bBullish = close[b] > open[b];
      const bImpulsive = bRange > 0 && bBody / bRange >= 0.5 && bBullish;
      if (!(bImpulsive || bRange >= 0.8 * atrVals[b])) continue;

      // Check unmitigated
      let mitigated = false;
      for (let k = fvgRelOffset - 1; k >= 0; k--) {
        const ki = idx - k;
        if (high[ki] >= gapBot && low[ki] <= gapTop) { mitigated = true; break; }
      }
      if (mitigated) continue;

      return { found: true, top: gapTop, bottom: gapBot, barOffset: fvgRelOffset };
    } else {
      // Bearish FVG: low[a] > high[c] (A is above C, price dropped leaving gap)
      // B must be a strong bearish candle.
      gapTop = low[a];
      gapBot = high[c];
      if (gapTop <= gapBot) continue;

      gapSize = gapTop - gapBot;
      if (gapSize < minSizeAtr * atrVals[c]) continue;

      const bBody = Math.abs(close[b] - open[b]);
      const bRange = high[b] - low[b];
      const bBearish = close[b] < open[b];
      const bImpulsive = bRange > 0 && bBody / bRange >= 0.5 && bBearish;
      if (!(bImpulsive || bRange >= 0.8 * atrVals[b])) continue;

      // Check unmitigated: price has not retraced into the gap
      let mitigated = false;
      for (let k = fvgRelOffset - 1; k >= 0; k--) {
        const ki = idx - k;
        if (high[ki] >= gapBot && low[ki] <= gapTop) { mitigated = true; break; }
      }
      if (mitigated) continue;

      return { found: true, top: gapTop, bottom: gapBot, barOffset: fvgRelOffset };
    }
  }

  return empty;
}

/* ─── 1h SMC Detection — Liquidity Sweep (adapted from v5 Pine) ───────────── */

function detectSweep_1h(
  bars: EnrichedBar[],
  idx: number,
  isLong: boolean,
  swingLookback: number,
  sweepLookback: number,
): SweepResult {
  const empty: SweepResult = { found: false, depthAtr: 0 };
  if (idx < swingLookback + 1) return empty;

  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);
  const close = bars.map(b => b.close);
  const atrVals = bars.map(b => b.atr14);

  for (let sweepRelOffset = swingLookback; sweepRelOffset <= sweepLookback; sweepRelOffset++) {
    const sweepIdx = idx - sweepRelOffset;
    if (sweepIdx < swingLookback) continue;

    if (isLong) {
      // Bullish sweep: price dips below swing low, wicks below, closes back above
      if (!isPivotLow(low, sweepIdx, swingLookback)) continue;
      const pivotLow = low[sweepIdx];

      let wickedBelow = false;
      let reclaimed = false;
      let maxDepth = 0;
      for (let k = sweepRelOffset - 1; k >= 0; k--) {
        const ki = idx - k;
        if (low[ki] < pivotLow) {
          wickedBelow = true;
          maxDepth = Math.max(maxDepth, pivotLow - low[ki]);
        }
        if (wickedBelow && close[ki] > pivotLow) { reclaimed = true; break; }
      }
      if (!(wickedBelow && reclaimed)) continue;
      if (close[idx] <= pivotLow) continue;

      const depthAtr = atrVals[idx] > 0 ? maxDepth / atrVals[idx] : 0;
      return { found: true, depthAtr };
    } else {
      // Bearish sweep: price spikes above swing high, wicks above, closes back below
      if (!isPivotHigh(high, sweepIdx, swingLookback)) continue;
      const pivotHigh = high[sweepIdx];

      let wickedAbove = false;
      let rejected = false;
      let maxDepth = 0;
      for (let k = sweepRelOffset - 1; k >= 0; k--) {
        const ki = idx - k;
        if (high[ki] > pivotHigh) {
          wickedAbove = true;
          maxDepth = Math.max(maxDepth, high[ki] - pivotHigh);
        }
        if (wickedAbove && close[ki] < pivotHigh) { rejected = true; break; }
      }
      if (!(wickedAbove && rejected)) continue;
      if (close[idx] >= pivotHigh) continue;

      const depthAtr = atrVals[idx] > 0 ? maxDepth / atrVals[idx] : 0;
      return { found: true, depthAtr };
    }
  }

  return empty;
}

/* ─── 1h SMC Detection — CHoCH (adapted from v5 Pine) ─────────────────────── */

function detectCHoCH_1h(
  bars: EnrichedBar[],
  idx: number,
  isLong: boolean,
  chochLookback: number,
  swingLookback: number,
): ChochResult {
  const empty: ChochResult = { found: false };
  if (idx < chochLookback + swingLookback) return empty;

  const close = bars.map(b => b.close);
  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);
  const ma25 = bars.map(b => b.ma25);
  const ma99 = bars.map(b => b.ma99);

  if (isLong) {
    // Bullish CHoCH: need downtrend context
    const downtrend = idx >= 99 && close[idx] < ma25[idx] && ma25[idx] < ma99[idx];
    if (!downtrend) return empty;

    // Find last lower high
    let lastLH = 0;
    for (let k = chochLookback; k >= 0; k--) {
      const ki = idx - k;
      if (ki < swingLookback) continue;
      if (isPivotHigh(high, ki, swingLookback)) { lastLH = high[ki]; break; }
    }
    if (lastLH <= 0) return empty;

    // Check if price broke above last LH
    let brokeAbove = false;
    for (let k = 0; k < chochLookback; k++) {
      if (idx - k < 0) break;
      if (close[idx - k] > lastLH) { brokeAbove = true; break; }
    }
    if (!brokeAbove) return empty;

    return { found: true };
  } else {
    // Bearish CHoCH: need uptrend context
    const uptrend = idx >= 99 && close[idx] > ma25[idx] && ma25[idx] > ma99[idx];
    if (!uptrend) return empty;

    let lastHL = Infinity;
    for (let k = chochLookback; k >= 0; k--) {
      const ki = idx - k;
      if (ki < swingLookback) continue;
      if (isPivotLow(low, ki, swingLookback)) { lastHL = low[ki]; break; }
    }
    if (lastHL >= Infinity) return empty;

    let brokeBelow = false;
    for (let k = 0; k < chochLookback; k++) {
      if (idx - k < 0) break;
      if (close[idx - k] < lastHL) { brokeBelow = true; break; }
    }
    if (!brokeBelow) return empty;

    return { found: true };
  }
}

/* ─── 1h SMC Parameter Set ────────────────────────────────────────────────── */

const SMC_PARAMS_1H = {
  obLookback: 15,
  swingLookback: 4,
  fvgLookback: 12,
  fvgMinSizeAtr: 0.12,
  sweepLookback: 8,
  chochLookback: 12,
};

/* ─── BB Squeeze Intensity (portfolio: on chart TF bars) ──────────────────── */

function bbSqueezeIntensity(
  bars: EnrichedBar[],
  idx: number,
  lookback: number,
): number {
  if (idx < lookback) return 0.5;
  let bbMin = Infinity, bbMax = -Infinity;
  for (let j = idx - lookback + 1; j <= idx; j++) {
    const w = bars[j].bbWidthPct;
    if (w < bbMin) bbMin = w;
    if (w > bbMax) bbMax = w;
  }
  const bbRange = bbMax - bbMin;
  if (bbRange <= 0) return 0.5;
  // 0 = at tightest squeeze (width at min), 1 = widest (max expansion)
  return (bars[idx].bbWidthPct - bbMin) / bbRange;
}

/* ─── Time Window Helper ──────────────────────────────────────────────────── */
const FOUR_H_MS = 4 * 60 * 60 * 1000;

function barsInWindow(
  target: EnrichedBar[],
  anchorTimestamp: number,
  windowMs: number,
): { start: number; end: number } {
  let lo = 0, hi = target.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (target[mid].timestamp < anchorTimestamp) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  const endTs = anchorTimestamp + windowMs;
  lo = start;
  hi = target.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (target[mid].timestamp < endTs) lo = mid + 1;
    else hi = mid;
  }
  return { start, end: lo };
}

/* ─── Feature Row Builder ─────────────────────────────────────────────────── */

function buildFeatureRow(
  symbol: string,
  h4Bars: EnrichedBar[],
  h1Bars: EnrichedBar[],
  m15Bars: EnrichedBar[],
  h4Idx: number,
  direction: "long" | "short",
): MtfFeatureRow | null {
  const isLong = direction === "long";
  const h4 = h4Bars[h4Idx];
  if (!h4 || h4.atr14 <= 0 || !Number.isFinite(h4.close) || h4.close <= 0) return null;

  /* ── 4h Structure Features ───────────────────────────────────────────── */
  const h4TrendBull = (h4.ma7 > h4.ma25 && h4.ma25 > h4.ma99) ? 1 : 0;
  const h4TrendBear = (h4.ma7 < h4.ma25 && h4.ma25 < h4.ma99) ? 1 : 0;
  const h4MASeparationAtr = h4.atr14 > 0 ? (h4.ma7 - h4.ma25) / h4.atr14 : 0;
  const h4MA25Slope = h4.ma25Slope;
  const h4ATRPercentile = h4.atrPercentile;

  const fib = detectFibLevels(h4Bars, h4Idx, 5, 30);
  const h4FibDetected = fib.found ? 1 : 0;
  const h4FibGoldenDistanceAtr = fibGoldenDistanceAtr(fib, h4.close, h4.atr14);
  const h4SwingDistanceAtr = swingDistanceAtr(h4Bars, h4Idx, 5, 30);

  /* ── 4h BB/AO Features (on actual 4h kline bars) ─────────────────────── */
  const h4BBWidthPct = h4.bbWidthPct;
  const h4BBSqueezeIntensity = bbSqueezeIntensity(h4Bars, h4Idx, 20);
  const h4BBExpanding = (h4Idx >= 1 && h4.bbWidthPct > h4Bars[h4Idx - 1].bbWidthPct) ? 1 : 0;
  const h4AOValue = h4.ao;
  const h4AOSlope = h4.aoSlope;
  const h4AOAcceleration = h4.aoAcceleration;

  /* ── 1h SMC Patterns ────────────────────────────────────────────────── */
  // Find the 1h bar closest to the 4h bar's close
  const h1Win = barsInWindow(h1Bars, h4.timestamp, FOUR_H_MS);
  const h1Idx = h1Win.end - 1;
  const h1IdxValid = h1Idx >= 0 && h1Idx < h1Bars.length;
  const h1 = h1IdxValid ? h1Bars[h1Idx] : null;

  // Detect SMC patterns in both directions on 1h
  const p = SMC_PARAMS_1H;

  let bullOB: OBResult, bearOB: OBResult;
  let bullFVG: FVGResult, bearFVG: FVGResult;
  let bullSweep: SweepResult, bearSweep: SweepResult;
  let bullCHoCH: ChochResult, bearCHoCH: ChochResult;

  if (h1IdxValid) {
    bullOB = detectOB_1h(h1Bars, h1Idx, true, p.obLookback, p.swingLookback);
    bearOB = detectOB_1h(h1Bars, h1Idx, false, p.obLookback, p.swingLookback);
    bullFVG = detectFVG_1h(h1Bars, h1Idx, true, p.fvgLookback, p.fvgMinSizeAtr);
    bearFVG = detectFVG_1h(h1Bars, h1Idx, false, p.fvgLookback, p.fvgMinSizeAtr);
    bullSweep = detectSweep_1h(h1Bars, h1Idx, true, p.swingLookback, p.sweepLookback);
    bearSweep = detectSweep_1h(h1Bars, h1Idx, false, p.swingLookback, p.sweepLookback);
    bullCHoCH = detectCHoCH_1h(h1Bars, h1Idx, true, p.chochLookback, p.swingLookback);
    bearCHoCH = detectCHoCH_1h(h1Bars, h1Idx, false, p.chochLookback, p.swingLookback);
  } else {
    const noOB: OBResult = { found: false, top: 0, bottom: 0, barOffset: 0 };
    const noFVG: FVGResult = { found: false, top: 0, bottom: 0, barOffset: 0 };
    const noSweep: SweepResult = { found: false, depthAtr: 0 };
    const noCHoCH: ChochResult = { found: false };
    bullOB = bearOB = noOB;
    bullFVG = bearFVG = noFVG;
    bullSweep = bearSweep = noSweep;
    bullCHoCH = bearCHoCH = noCHoCH;
  }

  const h1Close = h1?.close ?? h4.close;
  const h1Atr = h1?.atr14 ?? h4.atr14;

  // OB distance/size: measure to the nearest OB (bull or bear) in the trade direction
  // v4: set to 0 when no pattern (was -1.0 sentinel). Use _present flag to distinguish.
  const dirOB = isLong ? bullOB : bearOB;
  const h1OBDistanceAtr = dirOB.found
    ? Math.min(20, Math.abs(h1Close - dirOB.top) / Math.max(h1Atr, 0.0001))
    : 0;
  const h1OBSizeAtr = dirOB.found
    ? Math.min(3, Math.abs(dirOB.top - dirOB.bottom) / Math.max(h1Atr, 0.0001))
    : 0;

  // FVG distance/size — 0 when no pattern
  const dirFVG = isLong ? bullFVG : bearFVG;
  const h1FVGDistanceAtr = dirFVG.found
    ? Math.min(20, Math.abs(h1Close - dirFVG.top) / Math.max(h1Atr, 0.0001))
    : 0;
  const h1FVGSizeAtr = dirFVG.found
    ? Math.min(3, Math.abs(dirFVG.top - dirFVG.bottom) / Math.max(h1Atr, 0.0001))
    : 0;

  // Sweep depth — 0 when no sweep
  const dirSweep = isLong ? bullSweep : bearSweep;
  const h1SweepDepthAtr = dirSweep.found ? Math.min(3, dirSweep.depthAtr) : 0;

  // Confluence count: patterns agreeing with direction
  let smcConfluence = 0;
  if (dirOB.found) smcConfluence++;
  if (dirFVG.found) smcConfluence++;
  if (dirSweep.found) smcConfluence++;
  if ((isLong ? bullCHoCH : bearCHoCH).found) smcConfluence++;

  /* ── Chart TF Continuous Features (15m) ──────────────────────────────── */
  // Use the LAST 15m bar within the 4h window
  const m15Win = barsInWindow(m15Bars, h4.timestamp, FOUR_H_MS);
  const m15Idx = m15Win.end - 1;
  const m15Valid = m15Idx >= 0 && m15Idx < m15Bars.length;
  const ct = m15Valid ? m15Bars[m15Idx] : null;

  let ctBBWidthPct: number, ctBBSqueezeIntensity: number, ctBBExpanding: number;
  let ctAOValue: number, ctAOSlope: number, ctAOAcceleration: number;
  let ctAOCrossUp: number, ctAOCrossDown: number;
  let ctRSI: number, ctRSIVelocity: number;
  let ctVolumeZscore: number, ctVolumeRatio: number;
  let ctDisplacement: number, ctBodyRatio: number, ctClosePosition: number;
  let ctWickMagnitudeAtr: number;

  if (ct) {
    ctBBWidthPct = ct.bbWidthPct;
    ctBBSqueezeIntensity = bbSqueezeIntensity(m15Bars, m15Idx, 20);
    ctBBExpanding = (m15Idx >= 1 && ct.bbWidthPct > m15Bars[m15Idx - 1].bbWidthPct) ? 1 : 0;
    ctAOValue = ct.ao;
    ctAOSlope = ct.aoSlope;
    ctAOAcceleration = ct.aoAcceleration;
    ctAOCrossUp = (m15Idx >= 1 && m15Bars[m15Idx - 1].ao < 0 && ct.ao > 0) ? 1 : 0;
    ctAOCrossDown = (m15Idx >= 1 && m15Bars[m15Idx - 1].ao > 0 && ct.ao < 0) ? 1 : 0;
    ctRSI = ct.rsi14;
    ctRSIVelocity = m15Idx >= 3 ? ct.rsi14 - m15Bars[m15Idx - 3].rsi14 : 0;
    ctVolumeZscore = ct.volumeZscore;
    ctVolumeRatio = ct.volumeMa20 > 0 ? ct.volume / ct.volumeMa20 : 1;
    ctDisplacement = ct.displacement;
    ctBodyRatio = ct.bodyRatio;
    ctClosePosition = ct.closePosition;
    ctWickMagnitudeAtr = ct.atr14 > 0 ? ct.wickMagnitude / ct.atr14 : 0;
  } else {
    ctBBWidthPct = 0;
    ctBBSqueezeIntensity = 0.5;
    ctBBExpanding = 0;
    ctAOValue = 0;
    ctAOSlope = 0;
    ctAOAcceleration = 0;
    ctAOCrossUp = 0;
    ctAOCrossDown = 0;
    ctRSI = 50;
    ctRSIVelocity = 0;
    ctVolumeZscore = 0;
    ctVolumeRatio = 1;
    ctDisplacement = 0;
    ctBodyRatio = 0;
    ctClosePosition = 0.5;
    ctWickMagnitudeAtr = 0;
  }

  /* ── MTF Confluence ──────────────────────────────────────────────────── */
  // Check if 1h OB is near 4h fib golden pocket
  const mtfOBFibNear = fib.found && dirOB.found;
  const nearThresholdAtr = 2.0;
  let mtfOBFibDistance = 5;
  if (mtfOBFibNear) {
    const pocketTop = Math.max(fib.fib618, fib.fib786);
    const pocketBot = Math.min(fib.fib618, fib.fib786);
    const obMid = (dirOB.top + dirOB.bottom) / 2;
    const distToPocket = obMid >= pocketBot && obMid <= pocketTop
      ? 0
      : Math.min(Math.abs(obMid - pocketTop), Math.abs(obMid - pocketBot));
    mtfOBFibDistance = h4.atr14 > 0 ? distToPocket / h4.atr14 : 5;
  }
  const mtfOBFibNearBool = mtfOBFibNear && mtfOBFibDistance < nearThresholdAtr ? 1 : 0;

  // Check if 1h FVG is near 4h fib golden pocket
  const mtfFVGFibNear = fib.found && dirFVG.found;
  let mtfFVGFibDistance = 5;
  if (mtfFVGFibNear) {
    const pocketTop = Math.max(fib.fib618, fib.fib786);
    const pocketBot = Math.min(fib.fib618, fib.fib786);
    const fvgMid = (dirFVG.top + dirFVG.bottom) / 2;
    const distToPocket = fvgMid >= pocketBot && fvgMid <= pocketTop
      ? 0
      : Math.min(Math.abs(fvgMid - pocketTop), Math.abs(fvgMid - pocketBot));
    mtfFVGFibDistance = h4.atr14 > 0 ? distToPocket / h4.atr14 : 5;
  }
  const mtfFVGFibNearBool = mtfFVGFibNear && mtfFVGFibDistance < nearThresholdAtr ? 1 : 0;

  // Level confluence count: how many levels (fib, OB, FVG) cluster near current price
  let levelConfluence = 0;
  if (fib.found && h4FibGoldenDistanceAtr < 1.5) levelConfluence++;
  if (dirOB.found && h1OBDistanceAtr < 2.0) levelConfluence++;
  if (dirFVG.found && h1FVGDistanceAtr < 2.0) levelConfluence++;

  /* ── Interaction Features ─────────────────────────────────────────────── */
  function cap100(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return Math.max(-100, Math.min(100, v));
  }
  const interactionBBSqueezeXFvgDist = dirFVG.found ? cap100(h4BBSqueezeIntensity * h1FVGDistanceAtr) : 0;
  const interactionAOAccelXObDist = dirOB.found ? cap100(h4AOAcceleration * h1OBDistanceAtr) : 0;
  const interactionMASepXRSIVelocity = cap100(h4MASeparationAtr * ctRSIVelocity);
  const interactionATRPercentileXBBSqueeze = cap100(h4ATRPercentile * ctBBSqueezeIntensity);
  const interactionFvgDistXMTFFibDist = (dirFVG.found && fib.found)
    ? cap100(h1FVGDistanceAtr * mtfFVGFibDistance)
    : 0;

  /* ── Derived Features v4 ──────────────────────────────────────────────── */
  // Price position within BB bands (0=lower, 0.5=mid, 1=upper)
  const ctPriceInBB = ct && ct.bbUpper > ct.bbLower && Number.isFinite(ct.close)
    ? Math.max(0, Math.min(1, (ct.close - ct.bbLower) / (ct.bbUpper - ct.bbLower)))
    : 0.5;
  const h4PriceInBB = h4.bbUpper > h4.bbLower
    ? Math.max(0, Math.min(1, (h4.close - h4.bbLower) / (h4.bbUpper - h4.bbLower)))
    : 0.5;
  const ctAODistanceFromZeroAtr = h4.atr14 > 0 ? Math.abs(ctAOValue) / h4.atr14 : 0;
  const ctRSIExtremeBull = ctRSI > 70 ? 1 : 0;
  const ctRSIExtremeBear = ctRSI < 30 ? 1 : 0;
  const h4TrendStrength = Math.abs(h4MASeparationAtr);

  // Candlestick patterns on chart TF (15m)
  let ctEngulfingBull = 0, ctEngulfingBear = 0;
  if (ct && m15Idx >= 1) {
    const prev = m15Bars[m15Idx - 1];
    if (prev.close < prev.open && ct.close > ct.open &&
        ct.open <= prev.close && ct.close >= prev.open) {
      ctEngulfingBull = 1;
    }
    if (prev.close > prev.open && ct.close < ct.open &&
        ct.open >= prev.close && ct.close <= prev.open) {
      ctEngulfingBear = 1;
    }
  }

  return {
    symbol,
    timeframe: "4h",
    timestamp: h4.timestamp,
    direction,

    /* 4h Structure */
    h4_trend_bull: h4TrendBull,
    h4_trend_bear: h4TrendBear,
    h4_ma_separation_atr: h4MASeparationAtr,
    h4_ma25_slope: h4MA25Slope,
    h4_atr_percentile: h4ATRPercentile,
    h4_fib_detected: h4FibDetected,
    h4_fib_golden_distance_atr: h4FibGoldenDistanceAtr,
    h4_swing_distance_atr: h4SwingDistanceAtr,

    /* 4h BB/AO (on actual 4h kline bars) */
    h4_bb_width_pct: h4BBWidthPct,
    h4_bb_squeeze_intensity: h4BBSqueezeIntensity,
    h4_bb_expanding: h4BBExpanding,
    h4_ao_value: h4AOValue,
    h4_ao_slope: h4AOSlope,
    h4_ao_acceleration: h4AOAcceleration,

    /* 1h SMC Patterns — v4: 0 when absent, _present booleans for gating */
    h1_ob_bull: bullOB.found ? 1 : 0,
    h1_ob_bear: bearOB.found ? 1 : 0,
    h1_ob_distance_atr: h1OBDistanceAtr,
    h1_ob_size_atr: h1OBSizeAtr,
    h1_ob_present: dirOB.found ? 1 : 0,
    h1_fvg_bull: bullFVG.found ? 1 : 0,
    h1_fvg_bear: bearFVG.found ? 1 : 0,
    h1_fvg_distance_atr: h1FVGDistanceAtr,
    h1_fvg_size_atr: h1FVGSizeAtr,
    h1_fvg_present: dirFVG.found ? 1 : 0,
    h1_sweep_bull: bullSweep.found ? 1 : 0,
    h1_sweep_bear: bearSweep.found ? 1 : 0,
    h1_sweep_depth_atr: h1SweepDepthAtr,
    h1_sweep_present: dirSweep.found ? 1 : 0,
    h1_choch_bull: bullCHoCH.found ? 1 : 0,
    h1_choch_bear: bearCHoCH.found ? 1 : 0,
    h1_smc_confluence_count: smcConfluence,
    h1_smc_any_present: (dirOB.found || dirFVG.found || dirSweep.found || (isLong ? bullCHoCH : bearCHoCH).found) ? 1 : 0,

    /* Chart TF Continuous (15m) */
    ct_bb_width_pct: ctBBWidthPct,
    ct_bb_squeeze_intensity: ctBBSqueezeIntensity,
    ct_bb_expanding: ctBBExpanding,
    ct_ao_value: ctAOValue,
    ct_ao_slope: ctAOSlope,
    ct_ao_acceleration: ctAOAcceleration,
    ct_ao_cross_up: ctAOCrossUp,
    ct_ao_cross_down: ctAOCrossDown,
    ct_rsi: ctRSI,
    ct_rsi_velocity: ctRSIVelocity,
    ct_volume_zscore: ctVolumeZscore,
    ct_volume_ratio: ctVolumeRatio,
    ct_displacement: ctDisplacement,
    ct_body_ratio: ctBodyRatio,
    ct_close_position: ctClosePosition,
    ct_wick_magnitude_atr: ctWickMagnitudeAtr,

    /* MTF Confluence */
    mtf_1h_ob_near_4h_fib: mtfOBFibNearBool,
    mtf_1h_ob_near_4h_fib_distance: mtfOBFibDistance,
    mtf_1h_fvg_near_4h_fib: mtfFVGFibNearBool,
    mtf_1h_fvg_near_4h_fib_distance: mtfFVGFibDistance,
    mtf_level_confluence_count: levelConfluence,

    /* Interaction Features */
    bb_squeeze_x_fvg_distance: interactionBBSqueezeXFvgDist,
    ao_accel_x_ob_distance: interactionAOAccelXObDist,
    ma_sep_x_rsi_velocity: interactionMASepXRSIVelocity,
    atr_percentile_x_bb_squeeze: interactionATRPercentileXBBSqueeze,
    fvg_distance_x_mtf_fib_distance: interactionFvgDistXMTFFibDist,

    /* Derived Features v4 */
    ct_price_in_bb: ctPriceInBB,
    h4_price_in_bb: h4PriceInBB,
    ct_ao_distance_from_zero_atr: ctAODistanceFromZeroAtr,
    ct_rsi_extreme_bull: ctRSIExtremeBull,
    ct_rsi_extreme_bear: ctRSIExtremeBear,
    h4_trend_strength: h4TrendStrength,
    ct_candle_engulfing_bull: ctEngulfingBull,
    ct_candle_engulfing_bear: ctEngulfingBear,

    /* Labels — filled later */
    hitTP: false,
    hitStop: false,
    maxFavorableR: 0,
    maxAdverseR: 0,
    pnlR: 0,
    barsToOutcome: 0,
  };
}

/* ─── 1h-Only Feature Row Builder ──────────────────────────────────────────── */
// When only 1h klines are available, compute ALL features (trend, SMC, BB, AO,
// fib, swing) from 1h bars. Prefix stays "h4_" for column compatibility but
// everything is derived from 1h bars.

function buildFeatureRow1hOnly(
  symbol: string,
  h1Bars: EnrichedBar[],
  h1Idx: number,
  direction: "long" | "short",
): MtfFeatureRow | null {
  const isLong = direction === "long";
  const bar = h1Bars[h1Idx];
  if (!bar || bar.atr14 <= 0 || !Number.isFinite(bar.close) || bar.close <= 0) return null;

  /* ── Structure Features (from 1h bars, stored as h4_* for col compat) ── */
  const trendBull = (bar.ma7 > bar.ma25 && bar.ma25 > bar.ma99) ? 1 : 0;
  const trendBear = (bar.ma7 < bar.ma25 && bar.ma25 < bar.ma99) ? 1 : 0;
  const maSeparationAtr = bar.atr14 > 0 ? (bar.ma7 - bar.ma25) / bar.atr14 : 0;
  const ma25Slope = bar.ma25Slope;
  const atrPercentile = bar.atrPercentile;

  const fib = detectFibLevels(h1Bars, h1Idx, 5, 30);
  const fibDetected = fib.found ? 1 : 0;
  const fibGoldenDistAtr = fibGoldenDistanceAtr(fib, bar.close, bar.atr14);
  const swingDistAtr = swingDistanceAtr(h1Bars, h1Idx, 5, 30);

  /* ── BB/AO Features (from 1h bars) ─────────────────────────────────────── */
  const bbWidthPct1h = bar.bbWidthPct;
  const bbSqzIntensity = bbSqueezeIntensity(h1Bars, h1Idx, 20);
  const bbExpanding1h = (h1Idx >= 1 && bar.bbWidthPct > h1Bars[h1Idx - 1].bbWidthPct) ? 1 : 0;
  const aoValue = bar.ao;
  const aoSlope = bar.aoSlope;
  const aoAcceleration = bar.aoAcceleration;

  /* ── SMC Patterns (on 1h bars) ────────────────────────────────────────── */
  const p = SMC_PARAMS_1H;
  const bullOB = detectOB_1h(h1Bars, h1Idx, true, p.obLookback, p.swingLookback);
  const bearOB = detectOB_1h(h1Bars, h1Idx, false, p.obLookback, p.swingLookback);
  const bullFVG = detectFVG_1h(h1Bars, h1Idx, true, p.fvgLookback, p.fvgMinSizeAtr);
  const bearFVG = detectFVG_1h(h1Bars, h1Idx, false, p.fvgLookback, p.fvgMinSizeAtr);
  const bullSweep = detectSweep_1h(h1Bars, h1Idx, true, p.swingLookback, p.sweepLookback);
  const bearSweep = detectSweep_1h(h1Bars, h1Idx, false, p.swingLookback, p.sweepLookback);
  const bullCHoCH = detectCHoCH_1h(h1Bars, h1Idx, true, p.chochLookback, p.swingLookback);
  const bearCHoCH = detectCHoCH_1h(h1Bars, h1Idx, false, p.chochLookback, p.swingLookback);

  const dirOB = isLong ? bullOB : bearOB;
  const dirFVG = isLong ? bullFVG : bearFVG;
  const dirSweep = isLong ? bullSweep : bearSweep;

  const obDistanceAtr = dirOB.found
    ? Math.min(20, Math.abs(bar.close - dirOB.top) / Math.max(bar.atr14, 0.0001)) : 0;
  const obSizeAtr = dirOB.found
    ? Math.min(3, Math.abs(dirOB.top - dirOB.bottom) / Math.max(bar.atr14, 0.0001)) : 0;
  const fvgDistanceAtr = dirFVG.found
    ? Math.min(20, Math.abs(bar.close - dirFVG.top) / Math.max(bar.atr14, 0.0001)) : 0;
  const fvgSizeAtr = dirFVG.found
    ? Math.min(3, Math.abs(dirFVG.top - dirFVG.bottom) / Math.max(bar.atr14, 0.0001)) : 0;
  const sweepDepthAtr = dirSweep.found ? Math.min(3, dirSweep.depthAtr) : 0;

  let smcConfluence = 0;
  if (dirOB.found) smcConfluence++;
  if (dirFVG.found) smcConfluence++;
  if (dirSweep.found) smcConfluence++;
  if ((isLong ? bullCHoCH : bearCHoCH).found) smcConfluence++;

  /* ── Chart-TF Features (same 1h bars — scaled accordingly) ────────────── */
  const ctAOAcceleration = bar.aoAcceleration;
  const ctAOCrossUp = (h1Idx >= 1 && h1Bars[h1Idx - 1].ao < 0 && bar.ao > 0) ? 1 : 0;
  const ctAOCrossDown = (h1Idx >= 1 && h1Bars[h1Idx - 1].ao > 0 && bar.ao < 0) ? 1 : 0;
  const ctRSIVelocity = h1Idx >= 3 ? bar.rsi14 - h1Bars[h1Idx - 3].rsi14 : 0;

  /* ── MTF Confluence — 0 (no 4h to compare) ────────────────────────────── */

  /* ── Interaction Features (capped) ────────────────────────────────────── */
  function cap(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return Math.max(-100, Math.min(100, v));
  }
  const ixBbSqzFvg = dirFVG.found ? cap(bbSqzIntensity * fvgDistanceAtr) : 0;
  const ixAoAccelOb = dirOB.found ? cap(aoAcceleration * obDistanceAtr) : 0;
  const ixMaSepRsi = cap(maSeparationAtr * ctRSIVelocity);
  const ixAtrPctBb = cap(atrPercentile * bbSqzIntensity);
  const ixFvgMtf = 0; // no MTF comparison possible

  return {
    symbol,
    timeframe: "1h",
    timestamp: bar.timestamp,
    direction,

    h4_trend_bull: trendBull,
    h4_trend_bear: trendBear,
    h4_ma_separation_atr: maSeparationAtr,
    h4_ma25_slope: ma25Slope,
    h4_atr_percentile: atrPercentile,
    h4_fib_detected: fibDetected,
    h4_fib_golden_distance_atr: fibGoldenDistAtr,
    h4_swing_distance_atr: swingDistAtr,

    h4_bb_width_pct: bbWidthPct1h,
    h4_bb_squeeze_intensity: bbSqzIntensity,
    h4_bb_expanding: bbExpanding1h,
    h4_ao_value: aoValue,
    h4_ao_slope: aoSlope,
    h4_ao_acceleration: aoAcceleration,

    h1_ob_bull: bullOB.found ? 1 : 0,
    h1_ob_bear: bearOB.found ? 1 : 0,
    h1_ob_distance_atr: obDistanceAtr,
    h1_ob_size_atr: obSizeAtr,
    h1_ob_present: dirOB.found ? 1 : 0,
    h1_fvg_bull: bullFVG.found ? 1 : 0,
    h1_fvg_bear: bearFVG.found ? 1 : 0,
    h1_fvg_distance_atr: fvgDistanceAtr,
    h1_fvg_size_atr: fvgSizeAtr,
    h1_fvg_present: dirFVG.found ? 1 : 0,
    h1_sweep_bull: bullSweep.found ? 1 : 0,
    h1_sweep_bear: bearSweep.found ? 1 : 0,
    h1_sweep_depth_atr: sweepDepthAtr,
    h1_sweep_present: dirSweep.found ? 1 : 0,
    h1_choch_bull: bullCHoCH.found ? 1 : 0,
    h1_choch_bear: bearCHoCH.found ? 1 : 0,
    h1_smc_confluence_count: smcConfluence,
    h1_smc_any_present: (dirOB.found || dirFVG.found || dirSweep.found || (isLong ? bullCHoCH : bearCHoCH).found) ? 1 : 0,

    ct_bb_width_pct: bbWidthPct1h,
    ct_bb_squeeze_intensity: bbSqzIntensity,
    ct_bb_expanding: bbExpanding1h,
    ct_ao_value: aoValue,
    ct_ao_slope: aoSlope,
    ct_ao_acceleration: ctAOAcceleration,
    ct_ao_cross_up: ctAOCrossUp,
    ct_ao_cross_down: ctAOCrossDown,
    ct_rsi: bar.rsi14,
    ct_rsi_velocity: ctRSIVelocity,
    ct_volume_zscore: bar.volumeZscore,
    ct_volume_ratio: bar.volumeMa20 > 0 ? bar.volume / bar.volumeMa20 : 1,
    ct_displacement: bar.displacement,
    ct_body_ratio: bar.bodyRatio,
    ct_close_position: bar.closePosition,
    ct_wick_magnitude_atr: bar.atr14 > 0 ? bar.wickMagnitude / bar.atr14 : 0,

    mtf_1h_ob_near_4h_fib: 0,
    mtf_1h_ob_near_4h_fib_distance: 5,
    mtf_1h_fvg_near_4h_fib: 0,
    mtf_1h_fvg_near_4h_fib_distance: 5,
    mtf_level_confluence_count: 0,

    bb_squeeze_x_fvg_distance: ixBbSqzFvg,
    ao_accel_x_ob_distance: ixAoAccelOb,
    ma_sep_x_rsi_velocity: ixMaSepRsi,
    atr_percentile_x_bb_squeeze: ixAtrPctBb,
    fvg_distance_x_mtf_fib_distance: ixFvgMtf,

    /* Derived Features v4 (computed from 1h bars) */
    ct_price_in_bb: bar.bbUpper > bar.bbLower ? Math.max(0, Math.min(1, (bar.close - bar.bbLower) / (bar.bbUpper - bar.bbLower))) : 0.5,
    h4_price_in_bb: bar.bbUpper > bar.bbLower ? Math.max(0, Math.min(1, (bar.close - bar.bbLower) / (bar.bbUpper - bar.bbLower))) : 0.5,
    ct_ao_distance_from_zero_atr: bar.atr14 > 0 ? Math.abs(bar.ao) / bar.atr14 : 0,
    ct_rsi_extreme_bull: bar.rsi14 > 70 ? 1 : 0,
    ct_rsi_extreme_bear: bar.rsi14 < 30 ? 1 : 0,
    h4_trend_strength: Math.abs(maSeparationAtr),
    ct_candle_engulfing_bull: 0,
    ct_candle_engulfing_bear: 0,

    hitTP: false,
    hitStop: false,
    maxFavorableR: 0,
    maxAdverseR: 0,
    pnlR: 0,
    barsToOutcome: 0,
  };
}

/* ─── Structural Level Detection ──────────────────────────────────────────── */

/**
 * Scan lookback bars for pivot swing lows and highs relative to current price.
 * "Nearest" = closest to current price in the relevant direction.
 */
function findSwingLevels(
  bars: EnrichedBar[],
  idx: number,
  swingLookback: number,
  searchRange: number,
): { nearestSwingLow: number | null; nearestSwingHigh: number | null } {
  if (idx < swingLookback) return { nearestSwingLow: null, nearestSwingHigh: null };

  const currentPrice = bars[idx].close;
  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);

  let nearestSwingLow: number | null = null;
  let nearestSwingHigh: number | null = null;
  let minDistLow = Infinity;
  let minDistHigh = Infinity;

  const start = Math.max(swingLookback, idx - searchRange);
  for (let k = start; k <= idx - swingLookback; k++) {
    if (isPivotLow(low, k, swingLookback)) {
      if (low[k] < currentPrice) {
        const dist = currentPrice - low[k];
        if (dist < minDistLow) { minDistLow = dist; nearestSwingLow = low[k]; }
      }
    }
    if (isPivotHigh(high, k, swingLookback)) {
      if (high[k] > currentPrice) {
        const dist = high[k] - currentPrice;
        if (dist < minDistHigh) { minDistHigh = dist; nearestSwingHigh = high[k]; }
      }
    }
  }

  return { nearestSwingLow, nearestSwingHigh };
}

/**
 * Scan for SMC order block and FVG zones relative to current price.
 * Bull OB/FVG = support (below price for long stop, short TP).
 * Bear OB/FVG = resistance (above price for short stop, long TP).
 */
function findSMCLevels(
  bars: EnrichedBar[],
  idx: number,
  swingLookback: number,
  searchRange: number,
): {
  nearestBullOB: { top: number; bottom: number } | null;
  nearestBearOB: { top: number; bottom: number } | null;
  nearestBullFVG: { top: number; bottom: number } | null;
  nearestBearFVG: { top: number; bottom: number } | null;
} {
  const empty = {
    nearestBullOB: null as { top: number; bottom: number } | null,
    nearestBearOB: null as { top: number; bottom: number } | null,
    nearestBullFVG: null as { top: number; bottom: number } | null,
    nearestBearFVG: null as { top: number; bottom: number } | null,
  };
  if (idx < 3) return empty;

  const currentPrice = bars[idx].close;
  const atrVal = bars[idx].atr14;
  if (atrVal <= 0) return empty;

  const bullOB = detectOB_1h(bars, idx, true, searchRange, swingLookback);
  const bearOB = detectOB_1h(bars, idx, false, searchRange, swingLookback);
  const bullFVG = detectFVG_1h(bars, idx, true, searchRange, 0.12);
  const bearFVG = detectFVG_1h(bars, idx, false, searchRange, 0.12);

  // Bull OB is support — only relevant if its bottom is below current price
  if (bullOB.found && bullOB.bottom < currentPrice) {
    empty.nearestBullOB = { top: bullOB.top, bottom: bullOB.bottom };
  }
  // Bear OB is resistance — only relevant if its top is above current price
  if (bearOB.found && bearOB.top > currentPrice) {
    empty.nearestBearOB = { top: bearOB.top, bottom: bearOB.bottom };
  }
  // Bull FVG is support
  if (bullFVG.found && bullFVG.bottom < currentPrice) {
    empty.nearestBullFVG = { top: bullFVG.top, bottom: bullFVG.bottom };
  }
  // Bear FVG is resistance
  if (bearFVG.found && bearFVG.top > currentPrice) {
    empty.nearestBearFVG = { top: bearFVG.top, bottom: bearFVG.bottom };
  }

  return empty;
}

interface OutcomeLabel {
  hitTP: boolean;
  hitStop: boolean;
  maxFavorableR: number;
  maxAdverseR: number;
  pnlR: number;
  barsToOutcome: number;
}

/**
 * Compute outcome using STRUCTURAL stop and TP levels instead of fixed ATR multipliers.
 *
 * For LONG:
 *   Stop = nearest support (swing low, bull OB, bull FVG) - 0.1 ATR buffer
 *   TP   = nearest resistance (fib 0.618/0.786 above, swing high)
 *
 * For SHORT:
 *   Stop = nearest resistance (swing high, bear OB, bear FVG) + 0.1 ATR buffer
 *   TP   = nearest support (fib 0.618/0.786 below, swing low)
 *
 * Falls back to a wide ATR-based stop (4 ATR) if no structural level is found.
 */
function computeStructuralOutcome(
  candles: EnrichedBar[],
  entryIdx: number,
  direction: "long" | "short",
  entry: number,
  structuralLevels: {
    swingLow: number | null;
    swingHigh: number | null;
    bullOB: { top: number; bottom: number } | null;
    bearOB: { top: number; bottom: number } | null;
    bullFVG: { top: number; bottom: number } | null;
    bearFVG: { top: number; bottom: number } | null;
    fib618: number | null;
    fib786: number | null;
    fibDirection: "bull" | "bear" | null;
  },
  atrVal: number,
  maxLookforward: number,
): OutcomeLabel {
  const BUFFER_ATR = 0.1;
  const FALLBACK_STOP_ATR = 4.0; // Wide fallback — rarely hit in lookforward
  let stop: number;
  let tp: number;

  if (direction === "long") {
    // ── Stop: nearest support BELOW entry ──
    const supports: number[] = [];
    if (structuralLevels.swingLow !== null && structuralLevels.swingLow < entry) {
      supports.push(structuralLevels.swingLow);
    }
    if (structuralLevels.bullOB !== null && structuralLevels.bullOB.bottom < entry) {
      supports.push(structuralLevels.bullOB.bottom);
    }
    if (structuralLevels.bullFVG !== null && structuralLevels.bullFVG.bottom < entry) {
      supports.push(structuralLevels.bullFVG.bottom);
    }
    if (supports.length > 0) {
      // Nearest support = highest below entry
      const nearestSupport = Math.max(...supports);
      stop = nearestSupport - BUFFER_ATR * atrVal;
    } else {
      stop = entry - FALLBACK_STOP_ATR * atrVal;
    }

    // ── TP: nearest resistance ABOVE entry ──
    const resistances: number[] = [];
    if (structuralLevels.swingHigh !== null && structuralLevels.swingHigh > entry) {
      resistances.push(structuralLevels.swingHigh);
    }
    // Fib levels for TP: bear fib = retracement after a drop, levels are above swing low
    if (structuralLevels.fibDirection === "bear") {
      if (structuralLevels.fib618 !== null && structuralLevels.fib618 > entry) {
        resistances.push(structuralLevels.fib618);
      }
      if (structuralLevels.fib786 !== null && structuralLevels.fib786 > entry) {
        resistances.push(structuralLevels.fib786);
      }
    }
    // Also check bear OB/FVG tops as resistance
    if (structuralLevels.bearOB !== null && structuralLevels.bearOB.top > entry) {
      resistances.push(structuralLevels.bearOB.top);
    }
    if (structuralLevels.bearFVG !== null && structuralLevels.bearFVG.top > entry) {
      resistances.push(structuralLevels.bearFVG.top);
    }
    if (resistances.length > 0) {
      // Nearest resistance = lowest above entry
      tp = Math.min(...resistances);
    } else {
      tp = entry + 3.0 * atrVal; // Default 1:3 R:R as fallback
    }
  } else {
    // ── Short ──
    // ── Stop: nearest resistance ABOVE entry ──
    const resistances: number[] = [];
    if (structuralLevels.swingHigh !== null && structuralLevels.swingHigh > entry) {
      resistances.push(structuralLevels.swingHigh);
    }
    if (structuralLevels.bearOB !== null && structuralLevels.bearOB.top > entry) {
      resistances.push(structuralLevels.bearOB.top);
    }
    if (structuralLevels.bearFVG !== null && structuralLevels.bearFVG.top > entry) {
      resistances.push(structuralLevels.bearFVG.top);
    }
    if (resistances.length > 0) {
      const nearestResistance = Math.min(...resistances);
      stop = nearestResistance + BUFFER_ATR * atrVal;
    } else {
      stop = entry + FALLBACK_STOP_ATR * atrVal;
    }

    // ── TP: nearest support BELOW entry ──
    const supports: number[] = [];
    if (structuralLevels.swingLow !== null && structuralLevels.swingLow < entry) {
      supports.push(structuralLevels.swingLow);
    }
    // Fib levels for TP: bull fib = retracement after a rally, levels are below swing high
    if (structuralLevels.fibDirection === "bull") {
      if (structuralLevels.fib618 !== null && structuralLevels.fib618 < entry) {
        supports.push(structuralLevels.fib618);
      }
      if (structuralLevels.fib786 !== null && structuralLevels.fib786 < entry) {
        supports.push(structuralLevels.fib786);
      }
    }
    if (structuralLevels.bullOB !== null && structuralLevels.bullOB.bottom < entry) {
      supports.push(structuralLevels.bullOB.bottom);
    }
    if (structuralLevels.bullFVG !== null && structuralLevels.bullFVG.bottom < entry) {
      supports.push(structuralLevels.bullFVG.bottom);
    }
    if (supports.length > 0) {
      tp = Math.max(...supports); // Nearest support below = highest below entry
    } else {
      tp = entry - 3.0 * atrVal;
    }
  }

  // ── Scan forward to see what hits first ──
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
    pnlR: Math.max(-1, pnlR),
    barsToOutcome,
  };
}

/**
 * Check if an SMC pattern is active AND price is near it (within 2 ATR).
 * Only bars with active tradeable setups get labeled.
 */
function isSMCSetupActive(row: MtfFeatureRow): boolean {
  // Any SMC pattern present in the trade direction
  if (row.h1_smc_any_present !== 1) return false;

  // Price must be within 2 ATR of at least one SMC zone
  const obNear = row.h1_ob_present === 1 && row.h1_ob_distance_atr < 2.0;
  const fvgNear = row.h1_fvg_present === 1 && row.h1_fvg_distance_atr < 2.0;
  const sweepActive = row.h1_sweep_present === 1; // Sweeps are by definition near price

  return obNear || fvgNear || sweepActive;
}

/* ─── 1h-Only Pipeline ─────────────────────────────────────────────────────── */

function process1hOnlyGroup(group: MtfGroup, args: CliArgs): MtfFeatureRow[] {
  const rows: MtfFeatureRow[] = [];
  const h1Raw = [...group.klines["1h"]].sort((a, b) => a.timestamp - b.timestamp);

  if (h1Raw.length < 100) {
    console.warn(`  ${group.symbol}: only ${h1Raw.length} 1h bars (need >= 100)`);
    return rows;
  }

  const h1Bars = enrichBars(h1Raw);

  // Warmup for MA99
  const warmupIdx = 99;
  const lastFeatureIdx = h1Bars.length - 1 - args.maxLookforward;

  let skippedNoSMC = 0;
  let labeledRows = 0;

  for (let i = warmupIdx; i <= lastFeatureIdx; i++) {
    const bar = h1Bars[i];
    if (!Number.isFinite(bar.atr14) || bar.atr14 <= 0) continue;

    // Compute structural levels once per bar (swings + SMC zones on 1h)
    const swingLevels = findSwingLevels(h1Bars, i, 4, 30);
    const smcLevels = findSMCLevels(h1Bars, i, 4, 15);

    // Compute fib levels on 1h bars
    const fib = detectFibLevels(h1Bars, i, 5, 30);

    for (const dir of ["long", "short"] as const) {
      const row = buildFeatureRow1hOnly(group.symbol, h1Bars, i, dir);
      if (!row) continue;

      // SMC filter: only label bars with active SMC patterns near price
      if (!isSMCSetupActive(row)) {
        skippedNoSMC++;
        continue;
      }

      const entry = bar.close;
      const structuralLevels = {
        swingLow: swingLevels.nearestSwingLow,
        swingHigh: swingLevels.nearestSwingHigh,
        bullOB: smcLevels.nearestBullOB,
        bearOB: smcLevels.nearestBearOB,
        bullFVG: smcLevels.nearestBullFVG,
        bearFVG: smcLevels.nearestBearFVG,
        fib618: fib.found ? fib.fib618 : null,
        fib786: fib.found ? fib.fib786 : null,
        fibDirection: fib.found ? fib.direction : null,
      };

      const outcome = computeStructuralOutcome(
        h1Bars, i, dir, entry, structuralLevels, bar.atr14, args.maxLookforward,
      );

      row.hitTP = outcome.hitTP;
      row.hitStop = outcome.hitStop;
      row.maxFavorableR = outcome.maxFavorableR;
      row.maxAdverseR = outcome.maxAdverseR;
      row.pnlR = outcome.pnlR;
      row.barsToOutcome = outcome.barsToOutcome;

      rows.push(row);
      labeledRows++;
    }
  }

  if (skippedNoSMC > 0) {
    console.log(`    filtered ${skippedNoSMC} rows (no SMC setup near price)`);
  }
  return rows;
}

/* ─── Main Pipeline ───────────────────────────────────────────────────────── */

function processMtfGroup(group: MtfGroup, args: CliArgs): MtfFeatureRow[] {
  const rows: MtfFeatureRow[] = [];

  const h4Raw = [...group.klines["4h"]].sort((a, b) => a.timestamp - b.timestamp);
  const h1Raw = [...group.klines["1h"]].sort((a, b) => a.timestamp - b.timestamp);
  const m15Raw = [...group.klines["15m"]].sort((a, b) => a.timestamp - b.timestamp);

  if (h4Raw.length < 100) {
    console.warn(`  ${group.symbol}: only ${h4Raw.length} 4h bars (need >= 100)`);
    return rows;
  }

  const h4Bars = enrichBars(h4Raw);
  const h1Bars = enrichBars(h1Raw);
  const m15Bars = enrichBars(m15Raw);

  // Warmup: need MA99 (99 bars) on 4h
  const warmupIdx = 99;
  // Buffer at end for forward labeling
  const lastFeatureIdx = h4Bars.length - 1 - 1;

  let skippedNoSMC = 0;

  for (let i = warmupIdx; i <= lastFeatureIdx; i++) {
    const h4 = h4Bars[i];
    if (!Number.isFinite(h4.atr14) || h4.atr14 <= 0) continue;

    // Compute structural levels on 4h (swings + fibs) and 1h (SMC zones)
    const h4SwingLevels = findSwingLevels(h4Bars, i, 5, 30);
    const h4Fib = detectFibLevels(h4Bars, i, 5, 30);

    // Find 1h bar closest to 4h bar close
    const h1Win = barsInWindow(h1Bars, h4.timestamp, FOUR_H_MS);
    const h1Idx = h1Win.end - 1;
    const h1IdxValid = h1Idx >= 0 && h1Idx < h1Bars.length;

    const h1SMCLevels = h1IdxValid
      ? findSMCLevels(h1Bars, h1Idx, 4, 15)
      : { nearestBullOB: null, nearestBearOB: null, nearestBullFVG: null, nearestBearFVG: null };

    for (const dir of ["long", "short"] as const) {
      const row = buildFeatureRow(group.symbol, h4Bars, h1Bars, m15Bars, i, dir);
      if (!row) continue;

      // SMC filter: only label bars with active SMC patterns near price
      if (!isSMCSetupActive(row)) {
        skippedNoSMC++;
        continue;
      }

      const entry = h4.close;
      const structuralLevels = {
        swingLow: h4SwingLevels.nearestSwingLow,
        swingHigh: h4SwingLevels.nearestSwingHigh,
        bullOB: h1SMCLevels.nearestBullOB,
        bearOB: h1SMCLevels.nearestBearOB,
        bullFVG: h1SMCLevels.nearestBullFVG,
        bearFVG: h1SMCLevels.nearestBearFVG,
        fib618: h4Fib.found ? h4Fib.fib618 : null,
        fib786: h4Fib.found ? h4Fib.fib786 : null,
        fibDirection: h4Fib.found ? h4Fib.direction : null,
      };

      const outcome = computeStructuralOutcome(
        h4Bars, i, dir, entry, structuralLevels, h4.atr14, args.maxLookforward,
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

  if (skippedNoSMC > 0) {
    console.log(`    filtered ${skippedNoSMC} rows (no SMC setup near price)`);
  }
  return rows;
}

/* ─── CSV Output ──────────────────────────────────────────────────────────── */

const FEATURE_NAMES = [
  "symbol", "timeframe", "timestamp", "direction",
  // 4h Structure (8)
  "h4_trend_bull", "h4_trend_bear", "h4_ma_separation_atr", "h4_ma25_slope",
  "h4_atr_percentile", "h4_fib_detected", "h4_fib_golden_distance_atr",
  "h4_swing_distance_atr",
  // 4h BB/AO (6)
  "h4_bb_width_pct", "h4_bb_squeeze_intensity", "h4_bb_expanding",
  "h4_ao_value", "h4_ao_slope", "h4_ao_acceleration",
  // 1h SMC (20) — v4: +4 _present companions, +1 smc_any_present
  "h1_ob_bull", "h1_ob_bear", "h1_ob_distance_atr", "h1_ob_size_atr", "h1_ob_present",
  "h1_fvg_bull", "h1_fvg_bear", "h1_fvg_distance_atr", "h1_fvg_size_atr", "h1_fvg_present",
  "h1_sweep_bull", "h1_sweep_bear", "h1_sweep_depth_atr", "h1_sweep_present",
  "h1_choch_bull", "h1_choch_bear", "h1_smc_confluence_count", "h1_smc_any_present",
  // Chart TF (16)
  "ct_bb_width_pct", "ct_bb_squeeze_intensity", "ct_bb_expanding",
  "ct_ao_value", "ct_ao_slope", "ct_ao_acceleration",
  "ct_ao_cross_up", "ct_ao_cross_down",
  "ct_rsi", "ct_rsi_velocity",
  "ct_volume_zscore", "ct_volume_ratio",
  "ct_displacement", "ct_body_ratio", "ct_close_position",
  "ct_wick_magnitude_atr",
  // MTF Confluence (5)
  "mtf_1h_ob_near_4h_fib", "mtf_1h_ob_near_4h_fib_distance",
  "mtf_1h_fvg_near_4h_fib", "mtf_1h_fvg_near_4h_fib_distance",
  "mtf_level_confluence_count",
  // Interaction (5)
  "bb_squeeze_x_fvg_distance", "ao_accel_x_ob_distance",
  "ma_sep_x_rsi_velocity", "atr_percentile_x_bb_squeeze",
  "fvg_distance_x_mtf_fib_distance",
  // Derived v4 (8)
  "ct_price_in_bb", "h4_price_in_bb",
  "ct_ao_distance_from_zero_atr", "ct_rsi_extreme_bull", "ct_rsi_extreme_bear",
  "h4_trend_strength", "ct_candle_engulfing_bull", "ct_candle_engulfing_bear",
  // Labels (6)
  "hitTP", "hitStop", "maxFavorableR", "maxAdverseR", "pnlR", "barsToOutcome",
];

const CSV_HEADER = FEATURE_NAMES.join(",");

function toCsv(rows: MtfFeatureRow[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push([
      r.symbol, r.timeframe, r.timestamp, r.direction,
      r.h4_trend_bull, r.h4_trend_bear, r.h4_ma_separation_atr, r.h4_ma25_slope,
      r.h4_atr_percentile, r.h4_fib_detected, r.h4_fib_golden_distance_atr,
      r.h4_swing_distance_atr,
      r.h4_bb_width_pct, r.h4_bb_squeeze_intensity, r.h4_bb_expanding,
      r.h4_ao_value, r.h4_ao_slope, r.h4_ao_acceleration,
      r.h1_ob_bull, r.h1_ob_bear, r.h1_ob_distance_atr, r.h1_ob_size_atr, r.h1_ob_present,
      r.h1_fvg_bull, r.h1_fvg_bear, r.h1_fvg_distance_atr, r.h1_fvg_size_atr, r.h1_fvg_present,
      r.h1_sweep_bull, r.h1_sweep_bear, r.h1_sweep_depth_atr, r.h1_sweep_present,
      r.h1_choch_bull, r.h1_choch_bear, r.h1_smc_confluence_count, r.h1_smc_any_present,
      r.ct_bb_width_pct, r.ct_bb_squeeze_intensity, r.ct_bb_expanding,
      r.ct_ao_value, r.ct_ao_slope, r.ct_ao_acceleration,
      r.ct_ao_cross_up, r.ct_ao_cross_down,
      r.ct_rsi, r.ct_rsi_velocity,
      r.ct_volume_zscore, r.ct_volume_ratio,
      r.ct_displacement, r.ct_body_ratio, r.ct_close_position,
      r.ct_wick_magnitude_atr,
      r.mtf_1h_ob_near_4h_fib, r.mtf_1h_ob_near_4h_fib_distance,
      r.mtf_1h_fvg_near_4h_fib, r.mtf_1h_fvg_near_4h_fib_distance,
      r.mtf_level_confluence_count,
      r.bb_squeeze_x_fvg_distance, r.ao_accel_x_ob_distance,
      r.ma_sep_x_rsi_velocity, r.atr_percentile_x_bb_squeeze,
      r.fvg_distance_x_mtf_fib_distance,
      r.ct_price_in_bb, r.h4_price_in_bb,
      r.ct_ao_distance_from_zero_atr, r.ct_rsi_extreme_bull, r.ct_rsi_extreme_bear,
      r.h4_trend_strength, r.ct_candle_engulfing_bull, r.ct_candle_engulfing_bear,
      r.hitTP, r.hitStop, r.maxFavorableR, r.maxAdverseR, r.pnlR, r.barsToOutcome,
    ].join(","));
  }
  return lines.join("\n");
}

/* ─── Entry Point ─────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`Loading MTF klines from ${args.input}...`);
  const raw = fs.readFileSync(args.input, "utf-8");
  const inputData: MtfGroup[] = JSON.parse(raw);

  if (!Array.isArray(inputData) || inputData.length === 0) {
    console.error("Input must be a non-empty array");
    process.exit(1);
  }

  console.log(`Processing ${inputData.length} symbol(s)...`);
  console.log(`Stop ATR: ${args.stopAtrMult}, TP: ${args.tpAtrMult}, Max lookforward: ${args.maxLookforward}`);

  const allRows: MtfFeatureRow[] = [];

  for (const group of inputData) {
    if (!group.symbol || !group.klines["1h"]) {
      console.warn(`  Skipping ${group.symbol}: missing 1h klines`);
      continue;
    }

    const has4h = !!group.klines["4h"] && group.klines["4h"].length >= 100;
    const has15m = !!group.klines["15m"] && group.klines["15m"].length > 0;

    if (has4h && has15m) {
      // Full MTF mode
      const barCounts = {
        "4h": group.klines["4h"]!.length,
        "1h": group.klines["1h"].length,
        "15m": group.klines["15m"]!.length,
      };
      console.log(`  ${group.symbol} [MTF]: 4h=${barCounts["4h"]}, 1h=${barCounts["1h"]}, 15m=${barCounts["15m"]}`);

      const rows = processMtfGroup(group as any, args);
      allRows.push(...rows);
      console.log(`    -> ${rows.length} feature rows`);
    } else {
      // 1h-only mode: compute all features from 1h bars
      const barCount = group.klines["1h"].length;
      console.log(`  ${group.symbol} [1h-only]: 1h=${barCount} bars`);

      const rows = process1hOnlyGroup(group, args);
      allRows.push(...rows);
      console.log(`    -> ${rows.length} feature rows`);
    }
  }

  console.log(`\nTotal MTF feature rows: ${allRows.length}`);

  if (allRows.length === 0) {
    console.error("No feature rows generated. Check input data.");
    process.exit(1);
  }

  // Stats
  const hitTP = allRows.filter(r => r.hitTP).length;
  const hitStop = allRows.filter(r => r.hitStop).length;
  const neither = allRows.length - hitTP - hitStop;
  console.log(`Label distribution: TP=${hitTP} (${(hitTP / allRows.length * 100).toFixed(1)}%), Stop=${hitStop} (${(hitStop / allRows.length * 100).toFixed(1)}%), Open=${neither} (${(neither / allRows.length * 100).toFixed(1)}%)`);

  const avgFavR = allRows.reduce((s, r) => s + r.maxFavorableR, 0) / allRows.length;
  const avgAdvR = allRows.reduce((s, r) => s + r.maxAdverseR, 0) / allRows.length;
  const avgPnlR = allRows.reduce((s, r) => s + r.pnlR, 0) / allRows.length;
  console.log(`Avg MFE: ${avgFavR.toFixed(3)}R, Avg MAE: ${avgAdvR.toFixed(3)}R, Avg PnL: ${avgPnlR.toFixed(3)}R`);

  // Feature prevalence
  const bullTrendPct = allRows.filter(r => r.h4_trend_bull === 1).length / allRows.length * 100;
  const bearTrendPct = allRows.filter(r => r.h4_trend_bear === 1).length / allRows.length * 100;
  const fibPct = allRows.filter(r => r.h4_fib_detected === 1).length / allRows.length * 100;
  const obBullPct = allRows.filter(r => r.h1_ob_bull === 1).length / allRows.length * 100;
  const obBearPct = allRows.filter(r => r.h1_ob_bear === 1).length / allRows.length * 100;
  const fvgBullPct = allRows.filter(r => r.h1_fvg_bull === 1).length / allRows.length * 100;
  const fvgBearPct = allRows.filter(r => r.h1_fvg_bear === 1).length / allRows.length * 100;
  const sweepBullPct = allRows.filter(r => r.h1_sweep_bull === 1).length / allRows.length * 100;
  const sweepBearPct = allRows.filter(r => r.h1_sweep_bear === 1).length / allRows.length * 100;
  const chochBullPct = allRows.filter(r => r.h1_choch_bull === 1).length / allRows.length * 100;
  const chochBearPct = allRows.filter(r => r.h1_choch_bear === 1).length / allRows.length * 100;
  console.log(`Feature prevalence:`);
  console.log(`  4h: bullTrend=${bullTrendPct.toFixed(1)}%, bearTrend=${bearTrendPct.toFixed(1)}%, fib=${fibPct.toFixed(1)}%`);
  console.log(`  1h: OB_bull=${obBullPct.toFixed(1)}%, OB_bear=${obBearPct.toFixed(1)}%, FVG_bull=${fvgBullPct.toFixed(1)}%, FVG_bear=${fvgBearPct.toFixed(1)}%`);
  console.log(`  1h: sweep_bull=${sweepBullPct.toFixed(1)}%, sweep_bear=${sweepBearPct.toFixed(1)}%, CHoCH_bull=${chochBullPct.toFixed(1)}%, CHoCH_bear=${chochBearPct.toFixed(1)}%`);

  const featureCount = FEATURE_NAMES.length - 6; // subtract label columns
  console.log(`Feature count: ${featureCount} features + 4 identifier columns + 6 label columns = ${FEATURE_NAMES.length} total`);

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

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
