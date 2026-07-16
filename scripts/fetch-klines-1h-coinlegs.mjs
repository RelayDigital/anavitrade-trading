#!/usr/bin/env node
/**
 * Coinlegs 1h Kline Fetcher — fetches 1h OHLCV for top 80 Coinlegs pairs.
 *
 * Reads the pair list from backtest-prioritized.json, ranks by frequency,
 * and fetches 500 bars of 1h klines from Binance spot for each pair.
 *
 * Output format (1h-only, compatible with build-training-data-mtf.ts v4):
 *   [{"symbol": "TAOUSDT", "timeframe": "1h", "klines": [{...}]}]
 *
 * Usage:
 *   node scripts/fetch-klines-1h-coinlegs.mjs
 *   node scripts/fetch-klines-1h-coinlegs.mjs --pairs 80 --bars 500
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINANCE_SPOT = 'https://api.binance.com';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtTime(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Extract pairs from backtest-prioritized.json, ranked by frequency.
 */
function loadCoinlegsPairs(limit = 80) {
  const path = join(__dirname, '..', 'scripts', 'backtest-prioritized.json');
  const data = JSON.parse(readFileSync(path, 'utf-8'));

  // Count trades per pair
  const counts = new Map();
  for (const t of data.trades) {
    const pair = t.pair;
    if (!pair) continue;
    counts.set(pair, (counts.get(pair) || 0) + 1);
  }

  // Filter to USDT pairs (exclude UP/DOWN/BULL/BEAR leveraged tokens)
  const usdtPairs = [...counts.entries()]
    .filter(([p]) => p.endsWith('USDT') && !/[A-Z]\d+(UP|DOWN|BULL|BEAR)/.test(p))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  return usdtPairs.map(([pair, count]) => ({ pair, count }));
}

async function fetch1hKlines(symbol, limit = 500) {
  const params = new URLSearchParams({
    symbol,
    interval: '1h',
    limit: String(limit),
  });
  const url = `${BINANCE_SPOT}/api/v3/klines?${params}`;
  const res = await fetch(url);

  if (res.status === 429 || res.status === 418) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '60');
    console.log(`  Rate limited, waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000 + 500);
    return fetch1hKlines(symbol, limit);
  }

  if (!res.ok) {
    throw new Error(`${symbol}: HTTP ${res.status}`);
  }

  const raw = await res.json();
  if (!Array.isArray(raw)) {
    throw new Error(`${symbol}: Invalid response`);
  }

  return raw.map((c) => ({
    timestamp: c[0],
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const pairsCount = parseInt(
    args.includes('--pairs') ? args[args.indexOf('--pairs') + 1] : '80',
  );
  const bars = parseInt(
    args.includes('--bars') ? args[args.indexOf('--bars') + 1] : '500',
  );
  const delayMs = parseInt(
    args.includes('--delay') ? args[args.indexOf('--delay') + 1] : '150',
  );

  const outDir = join(__dirname, 'data');
  const outPath = join(outDir, 'klines-1h-coinlegs.json');

  console.log('='.repeat(60));
  console.log(`Coinlegs 1h Kline Fetcher — ${pairsCount} pairs, ${bars} bars each`);
  console.log(`Rate limit: ${delayMs}ms between requests`);
  console.log(`Estimated time: ~${Math.ceil((pairsCount * delayMs) / 1000)}s`);
  console.log('='.repeat(60));

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // Load pairs from backtest data
  const pairs = loadCoinlegsPairs(pairsCount);
  console.log(`Loaded ${pairs.length} pairs from backtest corpus.`);
  console.log(`Top 10: ${pairs.slice(0, 10).map(p => `${p.pair}(${p.count})`).join(', ')}`);

  // Fetch 1h klines for each
  const data = [];
  let fetched = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < pairs.length; i++) {
    const { pair: sym, count } = pairs[i];
    try {
      const klines = await fetch1hKlines(sym, bars);
      if (klines.length < 100) {
        console.warn(`  ${sym}: only ${klines.length} bars (skipped — need >= 100)`);
        errors++;
        await sleep(delayMs);
        continue;
      }
      data.push({
        symbol: sym,
        klines: { '1h': klines },
      });
      fetched++;

      if ((i + 1) % 10 === 0 || i === pairs.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const lastKl = klines[klines.length - 1];
        const range = `${fmtTime(klines[0].timestamp)} .. ${fmtTime(lastKl.timestamp)}`;
        console.log(
          `  [${i + 1}/${pairs.length}] ${fetched} ok, ${errors} err | ${elapsed}s | ${sym} (${klines.length} bars, ${range})`,
        );
      }
    } catch (err) {
      errors++;
      console.error(`  x ${sym}: ${err.message}`);
    }

    if (i < pairs.length - 1) {
      await sleep(delayMs);
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`Done in ${totalElapsed}s: ${fetched} symbols, ${errors} errors`);

  const totalBars = data.reduce(
    (sum, entry) => sum + (entry.klines['1h']?.length ?? 0),
    0,
  );
  console.log(`Total bars: ${totalBars.toLocaleString()}`);

  writeFileSync(outPath, JSON.stringify(data));
  const sizeKB = (Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(1);
  console.log(`Saved: ${outPath} (${sizeKB} KB)`);

  // Sample
  console.log(`\nSample sizes (first 5):`);
  for (const entry of data.slice(0, 5)) {
    const kl = entry.klines['1h'];
    const first = fmtTime(kl[0].timestamp);
    const last = fmtTime(kl[kl.length - 1].timestamp);
    console.log(`  ${entry.symbol}: ${kl.length} bars [${first} .. ${last}]`);
  }

  console.log(`\nOutput: ${outPath}`);
  return outPath;
}

main()
  .then((p) => {
    console.log(`\nComplete: ${p}`);
    process.exit(0);
  })
  .catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
