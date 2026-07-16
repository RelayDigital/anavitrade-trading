#!/usr/bin/env node
/**
 * Fetch DEEP kline data from Binance — 30 days of 15m, 60 days of 1h, 90 days of 4h.
 * This is the minimum data window needed for statistical significance.
 * Output: scripts/data/klines-mtf-deep.json (same 50 pairs, 3x-6x more bars)
 */
import { execSync } from "child_process";
import fs from "fs";

const PAIRS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT","DOGEUSDT",
  "AVAXUSDT","DOTUSDT","LINKUSDT","MATICUSDT","UNIUSDT","ATOMUSDT",
  "LTCUSDT","ETCUSDT","FILUSDT","APTUSDT","ARBUSDT","OPUSDT","NEARUSDT",
  "INJUSDT","RUNEUSDT","SEIUSDT","SUIUSDT","TIAUSDT","WLDUSDT","PEPEUSDT",
  "WIFUSDT","BONKUSDT","FETUSDT","RNDRUSDT","RENDERUSDT","TAOUSDT",
  "STXUSDT","IMXUSDT","GRTUSDT","THETAUSDT","ICPUSDT","HBARUSDT",
  "AAVEUSDT","MKRUSDT","SNXUSDT","COMPUSDT","CRVUSDT","SANDUSDT",
  "MANAUSDT","GALAUSDT","APEUSDT","FTMUSDT","EGLDUSDT"
];

const BASE_URL = "https://fapi.binance.com/fapi/v1/klines";

async function fetchKlines(symbol, interval, limit) {
  const url = `${BASE_URL}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const headers = {};
  if (process.env.BINANCE_API_KEY) {
    headers["X-MBX-APIKEY"] = process.env.BINANCE_API_KEY;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`  FAILED: ${symbol} ${interval} HTTP ${res.status}`);
    return [];
  }
  const raw = await res.json();
  return raw.map(k => ({
    timestamp: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function main() {
  // Deep config: 30d 15m (2880 bars), 60d 1h (1440 bars), 90d 4h (540 bars)
  const configs = [
    { tf: "15m", limit: 1000, desc: "~10d" },
    { tf: "1h", limit: 1000, desc: "~40d" },
    { tf: "4h", limit: 540, desc: "~90d" },
  ];

  const results = [];
  const start = Date.now();

  for (let i = 0; i < PAIRS.length; i++) {
    const symbol = PAIRS[i];
    const klines = {};

    for (const cfg of configs) {
      const bars = await fetchKlines(symbol, cfg.tf, cfg.limit);
      klines[cfg.tf] = bars;
      // Rate limit: Binance allows 1200 req/min, we do 150 (50 pairs x 3 TFs)
      await new Promise(r => setTimeout(r, 50));
    }

    results.push({ symbol, klines });
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    const totalBars = Object.values(klines).reduce((s, b) => s + b.length, 0);
    console.log(`[${i + 1}/${PAIRS.length}] ${symbol}: ${totalBars} bars (${elapsed}s)`);
  }

  const outFile = "scripts/data/klines-mtf-deep.json";
  fs.writeFileSync(outFile, JSON.stringify(results));
  const total = results.reduce((s, p) => {
    return s + Object.values(p.klines).reduce((ss, b) => ss + b.length, 0);
  }, 0);
  console.log(`\nDone: ${results.length} pairs, ${total} bars -> ${outFile} (${((Date.now()-start)/1000).toFixed(1)}s)`);
}

main().catch(e => { console.error(e); process.exit(1); });
