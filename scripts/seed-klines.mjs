#!/usr/bin/env node
/**
 * Seed klines into remote D1 — fast path: single SQL file per symbol, one wrangler call each.
 *
 * Usage: node scripts/seed-klines.mjs [--pairs 10] [--bars 100] [--timeframe 4h]
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';

const args = process.argv;
const PAIRS = parseInt(args.includes('--pairs')    ? args[args.indexOf('--pairs')    + 1] : '15');
const BARS  = parseInt(args.includes('--bars')     ? args[args.indexOf('--bars')     + 1] : '200');
const TF    = args.includes('--timeframe')         ? args[args.indexOf('--timeframe') + 1] : '4h';

const BINANCE = 'https://fapi.binance.com';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchTopPairs(limit) {
  const res = await fetch(`${BINANCE}/fapi/v1/exchangeInfo`);
  if (!res.ok) throw new Error(`exchangeInfo: HTTP ${res.status}`);
  const data = await res.json();
  return data.symbols
    .filter(s => s.symbol.endsWith('USDT') && s.status === 'TRADING' && s.contractType === 'PERPETUAL')
    .sort((a, b) => (parseFloat(b.volume24h || 0) - parseFloat(a.volume24h || 0)))
    .slice(0, limit).map(s => s.symbol);
}

async function fetchKlines(symbol, interval, limit) {
  const p = new URLSearchParams({ symbol, interval, limit: String(limit) });
  const url = `${BINANCE}/fapi/v1/klines?${p}`;
  const res = await fetch(url);
  if (!res.ok) { console.warn(`  ${symbol}: HTTP ${res.status}`); return []; }
  return (await res.json()).map(k => ({
    symbol, timeframe: interval,
    timestamp: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5],
  }));
}

function q(v) {
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (v == null) return 'NULL';
  return String(v);
}

async function main() {
  console.log(`=== Seed Klines: ${PAIRS} pairs, ${BARS} bars, ${TF} ===\n`);

  const pairs = await fetchTopPairs(PAIRS);
  console.log(`Pairs: ${pairs.join(', ')}\n`);

  let total = 0;

  for (const [idx, symbol] of pairs.entries()) {
    console.log(`[${idx + 1}/${pairs.length}] ${symbol}...`);
    const klines = await fetchKlines(symbol, TF, BARS);
    if (!klines.length) { console.log('  0 fetched'); continue; }

    const now = Date.now();
    const tmp = `/tmp/seed-${symbol}.sql`;

    // Build ALL inserts as one SQL file (D1 handles raw SQL up to ~1MB body)
    let sql = '';
    for (const k of klines) {
      sql += `INSERT OR IGNORE INTO klines (symbol,timeframe,openTime,open,high,low,close,volume,closeTime,fetchedAt) VALUES (${q(k.symbol)},${q(k.timeframe)},${k.timestamp},${q(k.open)},${q(k.high)},${q(k.low)},${q(k.close)},${q(k.volume)},${k.timestamp},${now});\n`;
    }
    writeFileSync(tmp, sql);

    try {
      const out = execSync(
        `npx wrangler d1 execute anavitrade-db --remote --file "${tmp}" --yes 2>&1`,
        { timeout: 90000, encoding: 'utf8', stdio: 'pipe' }
      );
      // Count rows_written across all result objects
      const matches = [...out.matchAll(/rows_written[:\s"]+(\d+)/g)];
      const written = matches.reduce((s, m) => s + parseInt(m[1]), 0);
      total += written;
      console.log(`  ${klines.length} fetched, ${written} written (total: ${total})`);
    } catch (e) {
      console.warn(`  SQL execution failed: ${e?.message?.slice(0, 100)}`);
      // Fall back: split into chunks of 50
      console.log(`  Retrying in chunks of 50...`);
      const lines = sql.trim().split(';\n').filter(Boolean);
      let chunked = 0;
      for (let i = 0; i < lines.length; i += 50) {
        const chunk = lines.slice(i, i + 50).join(';\n') + ';';
        writeFileSync(tmp, chunk);
        try {
          execSync(`npx wrangler d1 execute anavitrade-db --remote --file "${tmp}" --yes 2>&1`, { timeout: 30000, encoding: 'utf8', stdio: 'pipe' });
          chunked += Math.min(50, lines.length - i);
        } catch {}
        await sleep(300);
      }
      total += chunked;
      console.log(`  ${chunked} inserted via chunks (total: ${total})`);
    }
    try { unlinkSync(tmp); } catch {}
    await sleep(500);
  }

  console.log(`\n=== Done: ${total} klines inserted ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
