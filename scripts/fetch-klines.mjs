#!/usr/bin/env node
/**
 * Binance Kline Fetcher — pulls real OHLCV for ML training pipeline.
 *
 * Fetches 4h klines for 50+ USDT perpetual pairs from Binance public REST API.
 * No auth needed. Respects rate limits.
 *
 * Usage:
 *   node scripts/fetch-klines.mjs --tf 4h --bars 500 --out data/klines-4h.json
 *   node scripts/fetch-klines.mjs --tf 1h --bars 1000 --out data/klines-1h.json
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINANCE_SPOT = 'https://api.binance.com';
const BINANCE_FUTURES = 'https://fapi.binance.com';
const BINANCE_API_KEY = process.env.BINANCE_API_KEY?.trim() || "";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════
// Fetch top USDT pairs by volume
// ═══════════════════════════════════════════════════════════

async function fetchTopPairs(limit = 50) {
  console.log(`Fetching top ${limit} USDT perpetual pairs...`);
  const headers = BINANCE_API_KEY ? { "X-MBX-APIKEY": BINANCE_API_KEY } : {};
  const res = await fetch(`${BINANCE_FUTURES}/fapi/v1/exchangeInfo`, { headers });
  const data = await res.json();
  const pairs = data.symbols
    .filter(s => s.symbol.endsWith('USDT') && s.status === 'TRADING' && s.contractType === 'PERPETUAL')
    .sort((a, b) => {
      const va = parseFloat(a.volume24h || '0');
      const vb = parseFloat(b.volume24h || '0');
      return vb - va;
    })
    .slice(0, limit)
    .map(s => s.symbol);
  console.log(`  Got ${pairs.length} pairs: ${pairs.slice(0, 10).join(', ')}...`);
  return pairs;
}

// ═══════════════════════════════════════════════════════════
// Fetch klines for a single pair
// ═══════════════════════════════════════════════════════════

async function fetchKlines(symbol, interval, limit = 500) {
  const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
  const headers = BINANCE_API_KEY ? { "X-MBX-APIKEY": BINANCE_API_KEY } : {};
  const url = `${BINANCE_SPOT}/api/v3/klines?${params}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const raw = await res.json();
  return raw.map(c => ({
    timestamp: c[0],
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

// ═══════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const tf = args.includes('--tf') ? args[args.indexOf('--tf') + 1] : '4h';
  const bars = parseInt(args.includes('--bars') ? args[args.indexOf('--bars') + 1] : '500');
  const outPath = args.includes('--out')
    ? args[args.indexOf('--out') + 1]
    : join(__dirname, 'data', `klines-${tf}.json`);
  const pairCount = parseInt(args.includes('--pairs') ? args[args.indexOf('--pairs') + 1] : '50');

  console.log('═'.repeat(60));
  console.log(`Binance Kline Fetcher — ${tf}, ${bars} bars, ${pairCount} pairs`);
  console.log('═'.repeat(60));

  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // Get top pairs
  const pairs = await fetchTopPairs(pairCount);

  // Fetch klines for each pair
  const data = [];
  let fetched = 0, errors = 0;

  for (let i = 0; i < pairs.length; i++) {
    const sym = pairs[i];
    try {
      const klines = await fetchKlines(sym, tf, bars);
      data.push({ symbol: sym, timeframe: tf, klines });
      fetched++;
      if ((i + 1) % 10 === 0) {
        console.log(`  [${i + 1}/${pairs.length}] Fetched ${fetched}, ${errors} errors, last: ${sym} (${klines.length} bars)`);
      }
    } catch (err) {
      errors++;
      console.error(`  ✗ ${sym}: ${err.message}`);
    }
    // Rate limit: 20 req/sec max, be conservative
    await sleep(150);
  }

  console.log(`\nDone: ${fetched} symbols, ${errors} errors`);
  const totalBars = data.reduce((s, g) => s + g.klines.length, 0);
  console.log(`Total bars: ${totalBars.toLocaleString()}`);

  // Save
  writeFileSync(outPath, JSON.stringify(data));
  const sizeMB = (Buffer.byteLength(JSON.stringify(data)) / 1e6).toFixed(1);
  console.log(`Saved: ${outPath} (${sizeMB} MB)`);

  // Summary
  console.log(`\nSample sizes:`);
  data.slice(0, 5).forEach(g => {
    const first = g.klines[0];
    const last = g.klines[g.klines.length - 1];
    console.log(`  ${g.symbol}: ${g.klines.length} bars, ${new Date(first.timestamp).toISOString().slice(0,10)} → ${new Date(last.timestamp).toISOString().slice(0,10)}`);
  });

  return outPath;
}

main()
  .then(p => { console.log(`\n✓ Output: ${p}`); process.exit(0); })
  .catch(e => { console.error('FATAL:', e); process.exit(1); });
