#!/usr/bin/env node
/**
 * Multi-Timeframe Kline Fetcher — pulls 4h/1h/15m OHLCV for top USDT perpetuals.
 *
 * For each pair, fetches all 3 timeframes with 500 bars each, aligned by
 * timestamp so the feature builder can cross-reference: "what was the 1h OB
 * when this 4h FVG was active?"
 *
 * Usage:
 *   node scripts/fetch-klines-mtf.mjs
 *   node scripts/fetch-klines-mtf.mjs --pairs 30 --bars 300
 *
 * Output: scripts/data/klines-mtf.json
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINANCE_SPOT = 'https://api.binance.com';
const BINANCE_FUTURES = 'https://fapi.binance.com';

const TIMEFRAMES = ['4h', '1h', '15m'];

/** Milliseconds per timeframe interval — used for pagination + gap detection. */
const INTERVAL_MS = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

/** Binance caps a single klines request at 1000 bars. */
const MAX_KLINES_PER_REQ = 1000;

/** Binance API key from env — helps bypass geo-block on VPS with static US IP. */
const BINANCE_API_KEY = process.env.BINANCE_API_KEY?.trim() || "";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function fmtTime(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Snip a klines array so that the most recent bar does not extend past
 * `latestMs`.  Useful for aligning all timeframes to the same real-world
 * end time even though Binance returns bars whose close times differ.
 */
function clipToEnd(klines, latestMs) {
  // Bars whose close is after latestMs should be dropped (incomplete candle).
  // Keep the one whose close <= latestMs.
  while (klines.length > 0 && klines[klines.length - 1].timestamp > latestMs) {
    klines.pop();
  }
  return klines;
}

// ═══════════════════════════════════════════════════════════
// Fetch top USDT perpetual pairs by 24h volume
// ═══════════════════════════════════════════════════════════

async function fetchTopPairs(limit = 50) {
  console.log(`Fetching top ${limit} USDT perpetual pairs...`);
  const headers = BINANCE_API_KEY ? { "X-MBX-APIKEY": BINANCE_API_KEY } : {};
  const res = await fetch(`${BINANCE_FUTURES}/fapi/v1/exchangeInfo`, { headers });
  if (!res.ok) throw new Error(`exchangeInfo: HTTP ${res.status}`);
  const data = await res.json();

  const pairs = data.symbols
    .filter(
      (s) =>
        s.symbol.endsWith('USDT') &&
        s.status === 'TRADING' &&
        s.contractType === 'PERPETUAL',
    )
    .sort((a, b) => {
      const va = parseFloat(a.volume24h || '0');
      const vb = parseFloat(b.volume24h || '0');
      return vb - va;
    })
    .slice(0, limit)
    .map((s) => s.symbol);

  console.log(`  Got ${pairs.length} pairs: ${pairs.slice(0, 10).join(', ')}...`);
  return pairs;
}

// ═══════════════════════════════════════════════════════════
// Fetch klines for a single symbol + interval
// ═══════════════════════════════════════════════════════════

async function fetchKlines(symbol, interval, limit = 500, startTime = null) {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  });
  if (startTime != null) params.set('startTime', String(startTime));
  const headers = BINANCE_API_KEY ? { "X-MBX-APIKEY": BINANCE_API_KEY } : {};
  const url = `${BINANCE_SPOT}/api/v3/klines?${params}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${symbol} ${interval}: HTTP ${res.status}`);
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

/**
 * Fetch a long window of klines by paginating with startTime.
 * Binance returns at most 1000 bars per request, so we walk forward from
 * `startMs` until we reach the present, de-duplicating on open timestamp.
 * Respects rate limits via `delayMs` between page requests.
 */
async function fetchKlinesPaginated(symbol, interval, startMs, delayMs) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`Unknown interval ${interval}`);

  const seen = new Set();
  const out = [];
  let cursor = startMs;
  const nowMs = Date.now();

  // Hard cap on pages to avoid runaway loops on API misbehaviour.
  const maxPages = Math.ceil((nowMs - startMs) / (step * MAX_KLINES_PER_REQ)) + 5;
  let pages = 0;

  while (cursor < nowMs && pages < maxPages) {
    const batch = await fetchKlines(symbol, interval, MAX_KLINES_PER_REQ, cursor);
    pages++;
    if (batch.length === 0) break;

    let added = 0;
    for (const bar of batch) {
      if (!seen.has(bar.timestamp)) {
        seen.add(bar.timestamp);
        out.push(bar);
        added++;
      }
    }

    const lastTs = batch[batch.length - 1].timestamp;
    // Advance strictly past the last open time we received.
    const nextCursor = lastTs + step;
    if (nextCursor <= cursor) break; // no forward progress — stop
    cursor = nextCursor;

    // If the API returned fewer than a full page, we've caught up to the tip.
    if (batch.length < MAX_KLINES_PER_REQ) break;
    if (added === 0) break;

    await sleep(delayMs);
  }

  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

// ═══════════════════════════════════════════════════════════
// Fetch all 3 timeframes for one pair (serial, rate-limited)
// ═══════════════════════════════════════════════════════════

async function fetchPairMTF(symbol, bars, delayMs, days = 0) {
  const klines = {};
  const startMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;

  for (const tf of TIMEFRAMES) {
    const raw = days > 0
      ? await fetchKlinesPaginated(symbol, tf, startMs, delayMs)
      : await fetchKlines(symbol, tf, bars);
    klines[tf] = raw;
    // Respect rate limit between each request
    if (tf !== TIMEFRAMES[TIMEFRAMES.length - 1]) {
      await sleep(delayMs);
    }
  }

  // Align: use the earliest "latest close" across all 3 TFs as the cutoff.
  // The 15m bars will have the most recent close; we align all TFs so they
  // don't include bars that haven't closed yet in the higher TFs.
  const latestByTf = {};
  for (const tf of TIMEFRAMES) {
    latestByTf[tf] = klines[tf][klines[tf].length - 1].timestamp;
  }
  const cutoff = Math.min(...Object.values(latestByTf));

  for (const tf of TIMEFRAMES) {
    klines[tf] = clipToEnd(klines[tf], cutoff);
  }

  return { symbol, klines };
}

// ═══════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const pairsCount = parseInt(
    args.includes('--pairs') ? args[args.indexOf('--pairs') + 1] : '50',
  );
  const bars = parseInt(
    args.includes('--bars') ? args[args.indexOf('--bars') + 1] : '500',
  );
  const delayMs = parseInt(
    args.includes('--delay') ? args[args.indexOf('--delay') + 1] : '150',
  );
  const days = parseInt(
    args.includes('--days') ? args[args.indexOf('--days') + 1] : '0',
  );

  const outDir = join(__dirname, 'data');
  const outFile = args.includes('--out')
    ? args[args.indexOf('--out') + 1]
    : 'klines-mtf.json';
  // --out resolution:
  //   absolute path            → used as-is
  //   path containing a slash   → resolved against the current working dir
  //   bare filename             → placed in scripts/data
  const outPath = outFile.startsWith('/')
    ? outFile
    : outFile.includes('/')
      ? join(process.cwd(), outFile)
      : join(outDir, outFile);

  console.log('═'.repeat(60));
  console.log(
    days > 0
      ? `MTF Kline Fetcher — ${TIMEFRAMES.join('/')}, ${days} days (paginated), ${pairsCount} pairs`
      : `MTF Kline Fetcher — ${TIMEFRAMES.join('/')}, ${bars} bars, ${pairsCount} pairs`,
  );
  console.log(`Rate limit: ${delayMs}ms between requests`);
  console.log(`Estimated time: ~${Math.ceil((pairsCount * TIMEFRAMES.length * delayMs) / 1000)}s`);
  console.log('═'.repeat(60));

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // Get top pairs
  const pairs = await fetchTopPairs(pairsCount);
  await sleep(delayMs);

  // Fetch MTF data for each pair
  const data = [];
  let fetched = 0;
  let errors = 0;
  const totalRequests = pairs.length; // one pair = 3 internal requests

  const startTime = Date.now();

  for (let i = 0; i < pairs.length; i++) {
    const sym = pairs[i];
    try {
      const entry = await fetchPairMTF(sym, bars, delayMs, days);
      data.push(entry);
      fetched++;

      // Progress every 5 pairs (15 requests) or on last
      if ((i + 1) % 5 === 0 || i === pairs.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const barCounts = TIMEFRAMES.map(
          (tf) => `${tf}:${entry.klines[tf].length}`,
        ).join(', ');
        console.log(
          `  [${i + 1}/${pairs.length}] ${fetched} ok, ${errors} err | ${elapsed}s | ${sym} (${barCounts})`,
        );
      }
    } catch (err) {
      errors++;
      console.error(`  ✗ ${sym}: ${err.message}`);
    }

    // Rate limit between pairs (each pair already has internal delays)
    if (i < pairs.length - 1) {
      await sleep(delayMs);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Done in ${totalElapsed}s: ${fetched} symbols, ${errors} errors`);

  const totalBars = data.reduce(
    (sum, entry) =>
      sum +
      TIMEFRAMES.reduce((s, tf) => s + (entry.klines[tf]?.length ?? 0), 0),
    0,
  );
  console.log(`Total bars: ${totalBars.toLocaleString()}`);

  // Save
  writeFileSync(outPath, JSON.stringify(data));
  const sizeKB = (Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(1);
  console.log(`Saved: ${outPath} (${sizeKB} KB)`);

  // Sample sizes
  console.log(`\nSample sizes (first 5):`);
  for (const entry of data.slice(0, 5)) {
    const parts = TIMEFRAMES.map((tf) => {
      const kl = entry.klines[tf];
      if (!kl || kl.length === 0) return `${tf}:0`;
      const first = kl[0];
      const last = kl[kl.length - 1];
      return `${tf}:${kl.length} [${fmtTime(first.timestamp)} .. ${fmtTime(last.timestamp)}]`;
    });
    console.log(`  ${entry.symbol}`);
    for (const p of parts) console.log(`    ${p}`);
  }

  // Alignment check: verify all TFs for a pair share the same end boundary
  console.log(`\nAlignment check (first pair ${data[0]?.symbol}):`);
  if (data.length > 0) {
    const first = data[0];
    for (const tf of TIMEFRAMES) {
      const kl = first.klines[tf];
      if (kl && kl.length > 0) {
        console.log(
          `  ${tf}: last bar close → ${fmtTime(kl[kl.length - 1].timestamp)}`,
        );
      }
    }
  }

  console.log(`\n✓ Output: ${outPath}`);
  return outPath;
}

main()
  .then((p) => {
    console.log(`\n✓ Complete`);
    process.exit(0);
  })
  .catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
