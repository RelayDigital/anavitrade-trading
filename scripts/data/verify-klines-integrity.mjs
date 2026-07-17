#!/usr/bin/env node
/**
 * Data-integrity verifier for MTF kline datasets (PRD §3.5 gates).
 *
 * For every pair/timeframe it checks:
 *   - timestamps strictly increasing (no out-of-order bars)
 *   - no duplicate open timestamps
 *   - no gaps larger than 2x the timeframe interval (logged)
 *   - reports the actual date range covered
 *
 * Usage: node scripts/data/verify-klines-integrity.mjs <path-to-klines.json>
 */
import { readFileSync } from 'fs';

const INTERVAL_MS = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

const path = process.argv[2];
if (!path) {
  console.error('Usage: node verify-klines-integrity.mjs <klines.json>');
  process.exit(1);
}

const iso = (ts) => new Date(ts).toISOString();
const data = JSON.parse(readFileSync(path, 'utf8'));

let totalBars = 0;
let totalDupes = 0;
let totalNonMonotonic = 0;
let totalGaps = 0;
const perTf = {};
const rangeByTf = {};

for (const entry of data) {
  for (const tf of Object.keys(entry.klines)) {
    const step = INTERVAL_MS[tf];
    const bars = entry.klines[tf];
    perTf[tf] ??= { bars: 0, pairs: 0, minLen: Infinity, maxLen: 0 };
    perTf[tf].bars += bars.length;
    perTf[tf].pairs += 1;
    perTf[tf].minLen = Math.min(perTf[tf].minLen, bars.length);
    perTf[tf].maxLen = Math.max(perTf[tf].maxLen, bars.length);
    totalBars += bars.length;

    if (bars.length === 0) {
      console.log(`  [EMPTY] ${entry.symbol} ${tf}`);
      continue;
    }

    // Range tracking
    rangeByTf[tf] ??= { min: Infinity, max: -Infinity };
    rangeByTf[tf].min = Math.min(rangeByTf[tf].min, bars[0].timestamp);
    rangeByTf[tf].max = Math.max(rangeByTf[tf].max, bars[bars.length - 1].timestamp);

    const seen = new Set();
    for (let i = 0; i < bars.length; i++) {
      const ts = bars[i].timestamp;
      if (seen.has(ts)) {
        totalDupes++;
        console.log(`  [DUPLICATE] ${entry.symbol} ${tf} @ ${iso(ts)}`);
      }
      seen.add(ts);

      if (i > 0) {
        const prev = bars[i - 1].timestamp;
        if (ts <= prev) {
          totalNonMonotonic++;
          console.log(`  [NON-MONOTONIC] ${entry.symbol} ${tf} idx ${i}: ${iso(prev)} -> ${iso(ts)}`);
        } else {
          const delta = ts - prev;
          if (delta > 2 * step) {
            totalGaps++;
            const missing = Math.round(delta / step) - 1;
            console.log(`  [GAP] ${entry.symbol} ${tf}: ${iso(prev)} -> ${iso(ts)} (${missing} missing bars)`);
          }
        }
      }
    }
  }
}

console.log('\n' + '='.repeat(60));
console.log(`File: ${path}`);
console.log(`Pairs: ${data.length}   Total bars: ${totalBars.toLocaleString()}`);
console.log('\nPer-timeframe:');
for (const tf of Object.keys(perTf)) {
  const p = perTf[tf];
  const r = rangeByTf[tf];
  console.log(`  ${tf}: ${p.pairs} pairs, ${p.bars.toLocaleString()} bars, len[min=${p.minLen}, max=${p.maxLen}]`);
  console.log(`       range ${iso(r.min)} .. ${iso(r.max)}`);
}
console.log('\nIntegrity:');
console.log(`  duplicates:      ${totalDupes}`);
console.log(`  non-monotonic:   ${totalNonMonotonic}`);
console.log(`  gaps (>2x intv): ${totalGaps}`);
console.log('='.repeat(60));

process.exit(totalDupes + totalNonMonotonic > 0 ? 2 : 0);
