#!/usr/bin/env node
/**
 * Coinlegs Kline Fetcher — pulls 1h + 4h OHLCV for lesser-known altcoin pairs
 * that appear frequently in Coinlegs signals (>3 signals, excluding top 10 majors).
 *
 * These pairs have higher volatility and better SMC pattern formations than
 * top-50-by-volume pairs, making them the single biggest lever for improving
 * model performance.
 *
 * Usage:
 *   node scripts/fetch-coinlegs-klines.mjs
 *   node scripts/fetch-coinlegs-klines.mjs --bars 300 --delay 200
 *
 * Output:
 *   scripts/data/klines-1h-coinlegs.json
 *   scripts/data/klines-4h-coinlegs.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINANCE_SPOT = 'https://api.binance.com';

// Top 10 majors to exclude — these are covered by the standard MTF fetcher
const EXCLUDED_MAJORS = new Set([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
]);

// Also exclude wrapped/synthetic duplicates of the excluded majors
const EXCLUDED_WRAPPED = new Set([
  'WBTCUSDT',  // wrapped BTC
]);

// Minimum signals to include a pair
const MIN_SIGNALS = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtTime(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

// ═══════════════════════════════════════════════════════════
// 1. Read Coinlegs pair list from backtest-prioritized.json
// ═══════════════════════════════════════════════════════════

function loadCoinlegsPairs() {
  const raw = readFileSync(join(__dirname, 'backtest-prioritized.json'), 'utf8');
  const data = JSON.parse(raw);

  // Count signals per pair
  const pairCounts = {};
  for (const t of data.trades) {
    pairCounts[t.pair] = (pairCounts[t.pair] || 0) + 1;
  }

  // Filter: exclude majors, exclude wrapped, require MIN_SIGNALS
  const pairs = Object.entries(pairCounts)
    .filter(([pair, count]) =>
      count >= MIN_SIGNALS &&
      !EXCLUDED_MAJORS.has(pair) &&
      !EXCLUDED_WRAPPED.has(pair),
    )
    .sort((a, b) => b[1] - a[1]) // most signals first
    .map(([pair]) => pair);

  console.log(`Loaded ${pairs.length} Coinlegs altcoin pairs (${MIN_SIGNALS}+ signals, excluding top 10 majors)`);
  console.log(`Top signal counts: ${pairs.slice(0, 10).join(', ')}`);

  return pairs;
}

// ═══════════════════════════════════════════════════════════
// 2. Fetch klines from Binance
// ═══════════════════════════════════════════════════════════

async function fetchKlines(symbol, interval, limit = 500) {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  });
  const url = `${BINANCE_SPOT}/api/v3/klines?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    // Binance returns 400 for unknown symbols — skip gracefully
    if (res.status === 400) {
      const body = await res.json();
      throw new Error(`Bad request: ${body.msg || 'unknown symbol'}`);
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const raw = await res.json();
  return raw.map((c) => ({
    timestamp: c[0], // open time in ms
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

// ═══════════════════════════════════════════════════════════
// 3. Fetch a single timeframe for all pairs, saving incrementally
// ═══════════════════════════════════════════════════════════

async function fetchAllPairs(pairs, timeframe, bars, delayMs, outPath) {
  const data = [];
  let fetched = 0;
  let errors = 0;
  const skipped = [];
  const startTime = Date.now();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Fetching ${timeframe} for ${pairs.length} pairs (${bars} bars, ${delayMs}ms delay)`);
  console.log(`${'─'.repeat(60)}`);

  for (let i = 0; i < pairs.length; i++) {
    const sym = pairs[i];
    try {
      const klines = await fetchKlines(sym, timeframe, bars);
      data.push({ symbol: sym, timeframe, klines });
      fetched++;

      // Progress every 10 pairs or on last
      if ((i + 1) % 10 === 0 || i === pairs.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const barSample = data.length > 0 ? data[data.length - 1].klines.length : 0;
        console.log(
          `  [${i + 1}/${pairs.length}] ${fetched} ok, ${errors} err | ${elapsed}s | ${sym} (${barSample} bars)`,
        );
      }
    } catch (err) {
      errors++;
      const msg = err.message.length > 60 ? err.message.slice(0, 60) + '...' : err.message;
      skipped.push({ symbol: sym, reason: msg });
      console.error(`  SKIP ${sym}: ${msg}`);
    }

    // Rate limit between requests
    if (i < pairs.length - 1) {
      await sleep(delayMs);
    }
  }

  // ── Save ──────────────────────────────────────────────
  writeFileSync(outPath, JSON.stringify(data));
  const sizeKB = (Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(1);
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${timeframe} done in ${totalElapsed}s: ${fetched} ok, ${errors} skipped`);
  console.log(`Saved: ${outPath} (${sizeKB} KB)`);

  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length} pairs:`);
    for (const s of skipped) {
      console.log(`  ${s.symbol}: ${s.reason}`);
    }
  }

  // Sample sizes
  if (data.length > 0) {
    console.log(`\nSample sizes (first 3):`);
    for (const entry of data.slice(0, 3)) {
      const kl = entry.klines;
      const first = kl[0];
      const last = kl[kl.length - 1];
      console.log(`  ${entry.symbol}: ${kl.length} bars [${fmtTime(first.timestamp)} .. ${fmtTime(last.timestamp)}]`);
    }
  }

  return { data, fetched, errors, skipped };
}

// ═══════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const bars = parseInt(
    args.includes('--bars') ? args[args.indexOf('--bars') + 1] : '500',
  );
  const delayMs = parseInt(
    args.includes('--delay') ? args[args.indexOf('--delay') + 1] : '150',
  );

  const outDir = join(__dirname, 'data');
  const outPath1h = join(outDir, 'klines-1h-coinlegs.json');
  const outPath4h = join(outDir, 'klines-4h-coinlegs.json');

  console.log('═'.repeat(60));
  console.log('Coinlegs Altcoin Kline Fetcher — 1h + 4h');
  console.log(`Bars: ${bars} | Delay: ${delayMs}ms`);
  console.log('═'.repeat(60));

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // Load pair list
  const pairs = loadCoinlegsPairs();
  const estimatedSec = Math.ceil((pairs.length * 2 * delayMs) / 1000);
  console.log(`Estimated time: ~${estimatedSec}s (${pairs.length} pairs x 2 timeframes)`);

  // Fetch 1h
  await fetchAllPairs(pairs, '1h', bars, delayMs, outPath1h);

  // Fetch 4h
  await fetchAllPairs(pairs, '4h', bars, delayMs, outPath4h);

  const totalElapsed = ((Date.now() - process._startTime) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`All done!`);
  console.log(`  1h → ${outPath1h}`);
  console.log(`  4h → ${outPath4h}`);
  console.log(`${'═'.repeat(60)}`);
}

process._startTime = Date.now();

main()
  .then(() => {
    console.log('\n✓ Complete');
    process.exit(0);
  })
  .catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
