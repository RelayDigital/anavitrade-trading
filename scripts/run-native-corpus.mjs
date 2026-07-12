/**
 * Run the native signal generator against real Binance klines, collect every
 * Tier A/B signal it produces, simulate entry→SL→TP against actual price
 * data, and output a complete backtest corpus.  No coinlegs dependency.
 *
 * Scan: top 50 USDT perpetual pairs × 4h/1h timeframes × 30 candles each
 * Total API calls: 50 × 2 = 100 (Binance public, no key needed)
 */
const BINANCE = "https://api.binance.com/api/v3/klines";
const FAPI = "https://fapi.binance.com/fapi/v1";
const EXCHANGE_INFO = `${FAPI}/exchangeInfo`;
const TICKER_24HR = `${FAPI}/ticker/24hr`;

async function fetchKlines(symbol, interval, limit, startTime) {
  let url = `${BINANCE}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  if (startTime) url += `&startTime=${startTime}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const raw = await r.json();
  return raw.map(k => ({ t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]) }));
}

async function getTopPairs(count) {
  const [infoRes, tickerRes] = await Promise.all([
    fetch(EXCHANGE_INFO),
    fetch(TICKER_24HR),
  ]);
  if (!infoRes.ok) throw new Error(`exchangeInfo HTTP ${infoRes.status}`);
  if (!tickerRes.ok) throw new Error(`ticker/24hr HTTP ${tickerRes.status}`);
  const info = await infoRes.json();
  const tickers = await tickerRes.json();

  // Build volume map from real 24hr ticker data
  const volMap = {};
  for (const t of tickers) {
    volMap[t.symbol] = parseFloat(t.quoteVolume || t.volume || 0);
  }

  const usdt = info.symbols
    .filter(s => s.symbol.endsWith('USDT') && s.status === 'TRADING' && s.contractType === 'PERPETUAL')
    .sort((a, b) => (volMap[b.symbol] || 0) - (volMap[a.symbol] || 0));
  return usdt.slice(0, count).map(s => s.symbol);
}

// Standard 5 indicators
function sma(v, n) { if (v.length < n) return v[v.length-1]||0; return v.slice(-n).reduce((a,b)=>a+b,0)/n; }
function ema(v, p) { const k=2/(p+1),r=[v[0]]; for(let i=1;i<v.length;i++) r.push(v[i]*k+r[i-1]*(1-k)); return r; }

function detectMACD(c) { if(c.length<35)return null; const e12=ema(c,12),e26=ema(c,26),m=e12.map((v,i)=>v-e26[i]),s=sma(m,9); const curr=m[m.length-1],prev=m[m.length-2],cs=s[s.length-1],ps=s[s.length-2]; return prev<=ps&&curr>cs?('MACDcross',1):null; }
function detectStoch(h,l,c) { if(c.length<16)return null; const k=i=>{const s=l.slice(i-13,i+1);return(Math.max(...h.slice(i-13,i+1))-Math.min(...s))>0?((c[i]-Math.min(...s))/(Math.max(...h.slice(i-13,i+1))-Math.min(...s)))*100:50}; const curr=k(c.length-1),prev=k(c.length-2); return prev<25&&curr>25&&curr<50?1:curr<20?1:null; }
function detectCCI(h,l,c) { if(c.length<22)return null; const t=c.map((v,i)=>(h[i]+l[i]+v)/3),a=sma(t,20),md=t.slice(-20).reduce((s,v)=>s+Math.abs(v-a),0)/20; const cci=md>0?(t[t.length-1]-a)/(0.015*md):0; return cci<-80?1:null; }
function detectSmaCrossover(c) {
  if(c.length<50)return null; const m7=sma(c,7),m25=sma(c,25); const prev7=sma(c.slice(0,-1),7),prev25=sma(c.slice(0,-1),25); return prev7<=prev25&&m7>m25?1:null;
}

function scoreNative(symbol, tf, signals) {
  if (signals.length < 2) return null; // need 2+ indicators
  let s = 0;
  if (tf === '4h') s += 20; else if (tf === '1h') s += 14; else s += 6;
  // Score from indicator types that fired
  for (const sig of signals) {
    const ind = sig.toLowerCase();
    if (ind.includes('macd')) s += 20;
    else if (ind.includes('stoch')) s += 18;
    else if (ind.includes('cci')) s += 12;
  }
  if (signals.length >= 3) s += 18;
  else if (signals.length >= 2) s += 12;
  const tier = s >= 55 ? 'A' : s >= 40 ? 'B' : 'C';
  return { score: s, tier, signals };
}

const TIMEFRAMES = ['4h', '1h'];
const CANDLES_NEEDED = 60; // 60 4h = 10 days, 60 1h = 2.5 days

async function main() {
  console.log(`NATIVE GENERATOR CORPUS — Real Binance perpetual klines`);
  console.log("=".repeat(70));

  const pairs = await getTopPairs(50);
  console.log(`Pairs: ${pairs.length}`);

  let totalSignals = 0, totalTierA = 0, totalTierB = 0;
  const signals = [];

  for (const symbol of pairs) {
    process.stdout.write(`\r  ${pairs.indexOf(symbol)+1}/${pairs.length} ${symbol.padEnd(15)}`);

    for (const tf of TIMEFRAMES) {
      const candles = await fetchKlines(symbol, tf, CANDLES_NEEDED);
      if (candles.length < 30) continue;

      const c = candles.map(x => x.c), h = candles.map(x => x.h), l = candles.map(x => x.l);

      // Run detectors
      const detected = [];
      if (detectMACD(c)) detected.push('MACD');
      if (detectStoch(h, l, c)) detected.push('Stochastic');
      if (detectCCI(h, l, c)) detected.push('CCI');

      const result = scoreNative(symbol, tf, detected);
      if (!result) continue;

      totalSignals++;
      if (result.tier === 'A') totalTierA++;
      else totalTierB++;

      // Simulate: enter at close of signal candle, SL at swept swing low
      const entry = c[c.length - 1];
      const swingLow = Math.min(...l.slice(-5));
      const stop = swingLow * 0.995;
      const stopPct = ((entry - stop) / entry) * 100;
      const sl = entry * 0.985; // hard floor at 1.5% below entry
      const effectiveStop = Math.max(stop, sl);
      const stopDist = ((entry - effectiveStop) / entry) * 100;

      // TP: 3R
      const tpDist = stopDist * 3;
      const tp = entry * (1 + tpDist / 100);

      // Check outcome: scan FORWARD candles (after entry candle's close time)
      const entryCandleCloseTime = candles[candles.length - 1].t;
      const rawOutcome = await fetchKlines(symbol, tf, 20, entryCandleCloseTime);
      // Binance includes the candle at startTime — skip it to avoid SL/TP hit on entry candle
      const outcomeCandles = rawOutcome.filter(oc => oc.t > entryCandleCloseTime);
      let outcome = 'open', exitPrice = 0;
      for (const oc of outcomeCandles) {
        if (oc.l <= effectiveStop) { outcome = 'stopped'; exitPrice = effectiveStop; break; }
        if (oc.h >= tp) { outcome = 'tp_hit'; exitPrice = tp; break; }
      }
      if (outcome === 'open' && outcomeCandles.length > 0) {
        outcome = 'time_exit';
        exitPrice = outcomeCandles[outcomeCandles.length-1].c;
      }

      const pnlPct = exitPrice > 0 ? ((exitPrice - entry) / entry) * 100 : 0;

      signals.push({
        symbol, tf, tier: result.tier, score: result.score,
        indicators: result.signals,
        entry: entry.toFixed(6), stop: effectiveStop.toFixed(6), tp: tp.toFixed(6),
        outcome, pnlPct: pnlPct.toFixed(2), win: pnlPct > 0,
      });

      await new Promise(r => setTimeout(r, 100)); // rate limit
    }
  }

  console.log(`\n\nTotal signals: ${totalSignals} (A:${totalTierA} B:${totalTierB})`);

  const wins = signals.filter(s => s.win);
  const losses = signals.filter(s => !s.win);
  const wr = signals.length ? (wins.length / signals.length * 100) : 0;
  const avgW = wins.length ? wins.reduce((s,x)=>s+parseFloat(x.pnlPct),0)/wins.length : 0;
  const avgL = losses.length ? losses.reduce((s,x)=>s+parseFloat(x.pnlPct),0)/losses.length : 0;
  const exp = signals.length ? (avgW*wins.length+avgL*losses.length)/signals.length : 0;

  console.log(`\nBACKTEST RESULTS:`);
  console.log(`  Wins: ${wins.length} (${wr.toFixed(1)}%) | Losses: ${losses.length}`);
  console.log(`  Avg Win: ${avgW.toFixed(2)}% | Avg Loss: ${avgL.toFixed(2)}% | Expectancy: ${exp.toFixed(3)}%`);
  console.log(`  PF: ${losses.length && avgL ? Math.abs(avgW*wins.length/(avgL*losses.length)).toFixed(2) : '∞'}`);

  // Per timeframe
  for (const tf of TIMEFRAMES) {
    const t = signals.filter(s => s.tf === tf);
    if (!t.length) continue;
    const w = t.filter(s => s.win);
    console.log(`  ${tf}: ${t.length} signals, ${w.length} wins (${(w.length/t.length*100).toFixed(1)}% WR)`);
  }

  // Save
  const fs = await import('fs');
  fs.writeFileSync('/home/ariel/anavitrade-trading/scripts/native-corpus.json', JSON.stringify({ pairs: pairs.length, signals }, null, 2));
  console.log(`\nSaved ${signals.length} signals to scripts/native-corpus.json`);
}

main().catch(console.error);
