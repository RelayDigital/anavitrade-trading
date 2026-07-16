#!/usr/bin/env node
/**
 * Intelligent Auto-Fibonacci Detector for MTF Trading
 *
 * Auto-detects swing points, draws fibs from impulse origin to extreme,
 * computes confluence zones across timeframes, and ranks entries by
 * proximity to actual turn formations.
 *
 * Key levels (fib extensions + retracements):
 *   0.382, 0.5, 0.618, 0.786 (golden pocket), 1.0
 *   1.272, 1.618 (golden extension), 1.90 (190%), 2.0, 2.618, 3.618
 *
 * Usage:
 *   npx tsx scripts/ml/intelligent-fibs.ts --input scripts/data/klines-mtf.json --output fib-features.json
 */

import * as fs from "node:fs";

// ─── Types ──────────────────────────────────────────────────────────

interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface KlineGroup {
  symbol: string;
  klines: { "4h": Kline[]; "1h": Kline[]; "15m": Kline[] };
}

// ─── FIBONACCI CONSTANTS ────────────────────────────────────────────

const FIB_RETRACEMENTS = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
const FIB_EXTENSIONS  = [1.272, 1.618, 1.90, 2.0, 2.618, 3.618, 4.236];
const GOLDEN_POCKET_LO = 0.618;
const GOLDEN_POCKET_HI = 0.786;

// ─── CORE FUNCTIONS ─────────────────────────────────────────────────

/**
 * Detect swing highs/lows using pivot-based detection.
 * A swing high: a bar whose high is higher than N bars before AND after it.
 * A swing low: a bar whose low is lower than N bars before AND after it.
 */
function detectSwingPoints(klines: Kline[], lookback: number = 5) {
  const swingHighs: { idx: number; price: number }[] = [];
  const swingLows: { idx: number; price: number }[] = [];

  for (let i = lookback; i < klines.length - lookback; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= lookback; j++) {
      if (klines[i - j].high >= high) isSwingHigh = false;
      if (klines[i + j].high >= high) isSwingHigh = false;
      if (klines[i - j].low <= low) isSwingLow = false;
      if (klines[i + j].low <= low) isSwingLow = false;
    }

    if (isSwingHigh) swingHighs.push({ idx: i, price: high });
    if (isSwingLow) swingLows.push({ idx: i, price: low });
  }

  return { swingHighs, swingLows };
}

/**
 * Find the most recent significant swing for fib drawing.
 * Returns origin (start of impulse) and extreme (end of impulse).
 */
function findImpulseSwing(
  klines: Kline[],
  direction: "bull" | "bear",
  maxLookback: number = 100
) {
  const end = klines.length - 1;
  const start = Math.max(0, end - maxLookback);
  const window = klines.slice(start, end + 1);
  const { swingHighs, swingLows } = detectSwingPoints(window, 5);

  if (direction === "bull") {
    if (swingLows.length < 2) return null;
    // Find lowest swing low (origin) and subsequent highest swing high (extreme)
    const sortedLows = [...swingLows].sort((a, b) => a.price - b.price);
    const origin = sortedLows[0]; // lowest low = impulse start

    // Highest swing high AFTER the origin
    const extreme = swingHighs
      .filter(h => h.idx > origin.idx)
      .sort((a, b) => b.price - a.price)[0];

    if (!extreme) return null;
    return { origin, extreme, direction: "bull" as const };
  } else {
    if (swingHighs.length < 2) return null;
    const sortedHighs = [...swingHighs].sort((a, b) => b.price - a.price);
    const origin = sortedHighs[0]; // highest high = impulse start

    const extreme = swingLows
      .filter(l => l.idx > origin.idx)
      .sort((a, b) => a.price - b.price)[0];

    if (!extreme) return null;
    return { origin, extreme, direction: "bear" as const };
  }
}

/**
 * Compute fib retracement + extension levels given impulse origin and extreme.
 */
function computeFibLevels(
  origin: { price: number },
  extreme: { price: number },
  direction: "bull" | "bear"
) {
  const swing = Math.abs(extreme.price - origin.price);
  if (swing <= 0) return { retracements: {}, extensions: {} };

  const retracements: Record<string, number> = {};
  const extensions: Record<string, number> = {};

  const base = origin.price; // fibs measured from origin
  const dir = direction === "bull" ? 1 : -1;

  for (const level of FIB_RETRACEMENTS) {
    retracements[level.toFixed(3)] = base + dir * swing * level;
  }

  for (const level of FIB_EXTENSIONS) {
    extensions[level.toFixed(3)] = base + dir * swing * level;
  }

  return { retracements, extensions };
}

/**
 * Rank entry quality based on proximity to detected fib levels.
 * Lower score = better (closer to ideal entry at a fib level + swing turn).
 */
function rankEntryQuality(
  entryPrice: number,
  fibLevels: Record<string, number>,
  swingTurns: { price: number }[],
  atr: number
): number {
  // 1. Proximity to nearest fib retracement level (golden pocket weighted higher)
  let bestFibDist = Infinity;
  for (const [level, price] of Object.entries(fibLevels)) {
    const dist = Math.abs(entryPrice - price) / atr;
    const levelNum = parseFloat(level);
    // Golden pocket (0.618-0.786): half the effective distance
    const weight = levelNum >= GOLDEN_POCKET_LO && levelNum <= GOLDEN_POCKET_HI ? 0.5 : 1.0;
    bestFibDist = Math.min(bestFibDist, dist * weight);
  }

  // 2. Proximity to actual swing turn (where price physically reversed)
  let bestTurnDist = Infinity;
  for (const turn of swingTurns) {
    bestTurnDist = Math.min(bestTurnDist, Math.abs(entryPrice - turn.price) / atr);
  }

  // 3. Combined sniper score: weighted blend
  const fibScore = Math.max(0, 10 - bestFibDist * 2); // 0-10, lower dist = higher score
  const turnScore = Math.max(0, 10 - bestTurnDist * 2); // 0-10
  const snipingScore = fibScore * 0.6 + turnScore * 0.4; // fib convergence matters more

  return Math.round(snipingScore * 10) / 10;
}

/**
 * Multi-timeframe fib confluence detector.
 * Finds zones where fib levels from different TFs cluster within ATR-based tolerance.
 */
function computeMTFConfluence(
  entryPrice: number,
  fibs4h: ReturnType<typeof computeFibLevels>,
  fibs1h: ReturnType<typeof computeFibLevels>,
  atr: number
) {
  const tolerance = atr * 0.3; // 30% of ATR = confluence zone width
  const zones: { level: number; count: number; tfs: string[] }[] = [];

  const allLevels: { price: number; tf: string }[] = [];
  for (const p of Object.values(fibs4h.retracements)) allLevels.push({ price: p, tf: "4h" });
  for (const p of Object.values(fibs4h.extensions)) allLevels.push({ price: p, tf: "4h" });
  for (const p of Object.values(fibs1h.retracements)) allLevels.push({ price: p, tf: "1h" });
  for (const p of Object.values(fibs1h.extensions)) allLevels.push({ price: p, tf: "1h" });

  // Cluster detection: group levels within tolerance
  const sorted = [...allLevels].sort((a, b) => a.price - b.price);
  let cluster: { price: number; tfs: string[] } | null = null;

  for (const l of sorted) {
    if (!cluster) {
      cluster = { price: l.price, tfs: [l.tf] };
    } else if (Math.abs(l.price - cluster.price) <= tolerance) {
      cluster.price = (cluster.price * cluster.tfs.length + l.price) / (cluster.tfs.length + 1);
      cluster.tfs.push(l.tf);
    } else {
      if (cluster.tfs.length >= 2) zones.push({ level: cluster.price, count: cluster.tfs.length, tfs: [...new Set(cluster.tfs)] });
      cluster = { price: l.price, tfs: [l.tf] };
    }
  }
  if (cluster && cluster.tfs.length >= 2) zones.push({ level: cluster.price, count: cluster.tfs.length, tfs: [...new Set(cluster.tfs)] });

  // Score: how close is entry to highest-confluence zone?
  let bestConfluence = 0;
  let bestZonePrice = 0;
  for (const z of zones) {
    const score = z.count * (z.tfs.includes("4h") && z.tfs.includes("1h") ? 2 : 1);
    if (score > bestConfluence) {
      bestConfluence = score;
      bestZonePrice = z.level;
    }
  }

  const distToZone = bestZonePrice > 0 ? Math.abs(entryPrice - bestZonePrice) / atr : Infinity;
  const confluenceScore = Math.max(0, 10 - distToZone * 1.5) * (bestConfluence / 4);

  return {
    zones: zones.slice(0, 10),
    bestConfluence,
    bestZonePrice,
    distToZone,
    confluenceScore: Math.round(confluenceScore * 10) / 10,
  };
}

// ─── MAIN ───────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const inputPath = args.includes("--input")
    ? args[args.indexOf("--input") + 1]
    : "scripts/data/klines-mtf.json";
  const outputPath = args.includes("--output")
    ? args[args.indexOf("--output") + 1]
    : "scripts/data/fib-features.json";

  console.log("═".repeat(70));
  console.log("Intelligent Auto-Fibonacci Detector");
  console.log(`Input: ${inputPath} | Output: ${outputPath}`);
  console.log("═".repeat(70));

  if (!fs.existsSync(inputPath)) {
    console.error(`Not found: ${inputPath}. Run fetch-klines-mtf.mjs first.`);
    process.exit(1);
  }

  const data: KlineGroup[] = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  console.log(`Loaded ${data.length} symbols`);

  const results: any[] = [];

  for (const group of data) {
    const { symbol, klines } = group;
    const k4h = klines["4h"];
    const k1h = klines["1h"];

    if (!k4h || k4h.length < 100 || !k1h || k1h.length < 100) continue;

    // Detect swing points on 4h
    const swings4h = detectSwingPoints(k4h, 5);

    // Find impulse swings for both directions
    const bullImpulse = findImpulseSwing(k4h, "bull", 80);
    const bearImpulse = findImpulseSwing(k4h, "bear", 80);

    // Compute fibs
    const bullFibs4h = bullImpulse
      ? computeFibLevels(bullImpulse.origin, bullImpulse.extreme, "bull")
      : { retracements: {}, extensions: {} };
    const bearFibs4h = bearImpulse
      ? computeFibLevels(bearImpulse.origin, bearImpulse.extreme, "bear")
      : { retracements: {}, extensions: {} };

    // 1h fibs
    const swings1h = detectSwingPoints(k1h, 5);
    const bullImpulse1h = findImpulseSwing(k1h, "bull", 80);
    const bearImpulse1h = findImpulseSwing(k1h, "bear", 80);
    const bullFibs1h = bullImpulse1h
      ? computeFibLevels(bullImpulse1h.origin, bullImpulse1h.extreme, "bull")
      : { retracements: {}, extensions: {} };
    const bearFibs1h = bearImpulse1h
      ? computeFibLevels(bearImpulse1h.origin, bearImpulse1h.extreme, "bear")
      : { retracements: {}, extensions: {} };

    // ATR for zone sizing
    const atr4h = computeATR(k4h, 14);
    const currentPrice = k4h[k4h.length - 1].close;
    const atr = atr4h > 0 ? atr4h : currentPrice * 0.02;

    // Rank entry quality and compute MTF confluence
    const bullEntryRank = rankEntryQuality(currentPrice, { ...bullFibs4h.retracements, ...bullFibs4h.extensions }, swings4h.swingLows, atr);
    const bearEntryRank = rankEntryQuality(currentPrice, { ...bearFibs4h.retracements, ...bearFibs4h.extensions }, swings4h.swingHighs, atr);

    const bullConfluence = computeMTFConfluence(currentPrice, bullFibs4h, bullFibs1h, atr);
    const bearConfluence = computeMTFConfluence(currentPrice, bearFibs4h, bearFibs1h, atr);

    // Collect entry targets (190% and 261.8% extensions for exit targets)
    const targets = {
      "190": bullFibs4h.extensions["1.900"] || 0,
      "2618": bullFibs4h.extensions["2.618"] || 0,
      "190_bear": bearFibs4h.extensions["1.900"] || 0,
      "2618_bear": bearFibs4h.extensions["2.618"] || 0,
    };

    results.push({
      symbol,
      timestamp: k4h[k4h.length - 1].timestamp,
      currentPrice,
      atr4h: atr,
      swings4h: {
        highCount: swings4h.swingHighs.length,
        lowCount: swings4h.swingLows.length,
        lastSwingHigh: swings4h.swingHighs[swings4h.swingHighs.length - 1]?.price || null,
        lastSwingLow: swings4h.swingLows[swings4h.swingLows.length - 1]?.price || null,
      },
      bullFibs: {
        retracements: bullFibs4h.retracements,
        extensions: bullFibs4h.extensions,
        entryRank: bullEntryRank,
      },
      bearFibs: {
        retracements: bearFibs4h.retracements,
        extensions: bearFibs4h.extensions,
        entryRank: bearEntryRank,
      },
      mtfConfluence: {
        bull: bullConfluence,
        bear: bearConfluence,
      },
      targets,
    });

    if (results.length % 10 === 0) {
      console.log(`  Processed ${results.length}/${data.length} symbols...`);
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nSave: ${outputPath} (${results.length} symbols)`);

  // Summary
  const withBullFibs = results.filter(r => Object.keys(r.bullFibs.retracements).length > 0);
  const withBearFibs = results.filter(r => Object.keys(r.bearFibs.retracements).length > 0);
  const highConfluence = results.filter(r =>
    r.mtfConfluence.bull.confluenceScore > 5 || r.mtfConfluence.bear.confluenceScore > 5
  );

  console.log(`\nFib Analysis Summary:`);
  console.log(`  Bull fibs detected: ${withBullFibs.length}`);
  console.log(`  Bear fibs detected: ${withBearFibs.length}`);
  console.log(`  High MTF confluence (>5): ${highConfluence.length}`);
  console.log(`  Avg bull entry rank: ${(results.reduce((s, r) => s + r.bullFibs.entryRank, 0) / results.length).toFixed(1)}/10`);
  console.log(`  Avg bear entry rank: ${(results.reduce((s, r) => s + r.bearFibs.entryRank, 0) / results.length).toFixed(1)}/10`);

  // Top 10 sniper setups
  console.log(`\nTop 10 Sniper Setups (by entry rank):`);
  const ranked = [...results]
    .map(r => ({ symbol: r.symbol, bullRank: r.bullFibs.entryRank, bearRank: r.bearFibs.entryRank, confluence: Math.max(r.mtfConfluence.bull.confluenceScore, r.mtfConfluence.bear.confluenceScore) }))
    .sort((a, b) => b.bullRank - a.bullRank)
    .slice(0, 10);
  ranked.forEach(r => console.log(`  ${r.symbol}: bull rank ${r.bullRank.toFixed(1)}, bear rank ${r.bearRank.toFixed(1)}, confluence ${r.confluence.toFixed(1)}`));
}

// ─── HELPERS ────────────────────────────────────────────────────────

function computeATR(klines: Kline[], period: number = 14): number {
  if (klines.length < period + 1) return 0;
  let sum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const tr = Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i - 1].close),
      Math.abs(klines[i].low - klines[i - 1].close)
    );
    sum += tr;
  }
  return sum / period;
}

main().catch(e => { console.error(e); process.exit(1); });
