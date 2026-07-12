/**
 * Validate coinlegs signals against real Binance klines.
 * 1.5% stop (tight, structural), 4.5% TP (3R), on actual Binance data.
 */

import { readFileSync, writeFileSync } from 'fs';

const signals = JSON.parse(readFileSync('/tmp/coinlegs_prioritized.json', 'utf8'));
const ATR = {'5m':0.3,'15m':0.5,'30m':0.8,'1h':1.2,'4h':2.0};

let val = 0, wins = 0, totalPnl = 0;
const results = [];

for (const sig of signals.slice(0, 500)) {
  const pair = (sig.MarketName||'').replace('/','').replace('USDT','');
  const symbol = pair + 'USDT';
  const interval = sig.Period || '4h';
  const entry = parseFloat(sig.Price||sig.LastPrice||0);
  if (!entry) continue;

  const signalTs = sig.SignalDateUTCString ? new Date(sig.SignalDateUTCString).getTime() : Date.now() - 86400000;

  try {
    const res = await fetch('https://api.binance.com/api/v3/klines?symbol='+symbol+'&interval='+interval+'&startTime='+signalTs+'&limit=30');
    if (!res.ok) continue;
    const klines = await res.json();
    if (!Array.isArray(klines)||klines.length<2) continue;

    const entryClose = parseFloat(klines[0][4]);
    const stopPct = (ATR[interval]||1.5) * 1.5;
    const sl = entryClose * (1 - stopPct/100);
    const tp = entryClose * (1 + stopPct*3/100);

    let outcome='time_exit', exitPrice=entryClose;
    for (let i=1;i<klines.length;i++) {
      const k=klines[i], l=parseFloat(k[3]), h=parseFloat(k[2]), c=parseFloat(k[4]);
      if(l<=sl){outcome='stopped';exitPrice=sl;break;}
      if(h>=tp){outcome='tp_hit';exitPrice=tp;break;}
      if(i===klines.length-1){outcome='time_exit';exitPrice=c;}
    }

    const pnl = ((exitPrice-entryClose)/entryClose)*100;
    const win = pnl > 0;
    if (win) wins++;
    totalPnl += pnl;
    val++;

    results.push({
      pair: sig.MarketName, period: interval, indicator: sig.Name,
      entry: entryClose.toFixed(6), sl: sl.toFixed(6), tp: tp.toFixed(6),
      outcome, pnlPct: pnl.toFixed(2), win,
      coinlegsMaxProfit: sig.MaxProfit,
    });

    await new Promise(r=>setTimeout(r,100));
  } catch(e) {}
}

const wr = val ? (wins/val*100).toFixed(1) : 'N/A';
const avgPnl = val ? (totalPnl/val).toFixed(2) : 'N/A';

console.log(`=== VALIDATED AGAINST REAL BINANCE KLINES ===`);
console.log(`Signals tested: ${val}`);
console.log(`Wins: ${wins} | WR: ${wr}`);
console.log(`Avg PnL: ${avgPnl}%`);
console.log(`Source: live Binance ${'https://api.binance.com/api/v3/klines'}`);

// Per timeframe
for (const tf of ['4h','1h','30m','15m']) {
  const t = results.filter(r=>r.period===tf);
  if (!t.length) continue;
  const w = t.filter(r=>r.win);
  console.log(`${tf}: ${t.length} trades, ${w.length} wins (${(w.length/t.length*100).toFixed(1)}% WR)`);
}

writeFileSync('/home/ariel/anavitrade-trading/scripts/binance-validated.json', JSON.stringify(results, null, 2));
console.log(`\nSaved ${results.length} validated trades to scripts/binance-validated.json`);
