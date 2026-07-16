/**
 * DEPRECATED: Superseded by scripts/unified-backtest.mjs (8-strategy comparison).
 * Full-corpus backtest: fetch coinlegs API pages 0-N, score every signal
 * with the forward-only algorithm, simulate entry→SL→TP against real
 * Binance klines, report honest profit/loss.  No D1 dependency.
 *
 * Usage:  node scripts/full-backtest.mjs
 */
const API = "https://api.coinlegs.com/api/Exchange/SelectDetections";
const BINANCE = "https://api.binance.com/api/v3";

const ATR = { "5m":0.3,"15m":0.5,"30m":0.8,"1h":1.2,"4h":2.0,"1d":3.5,"1w":6.0 };
const MAP  = { "5m":"5m","15m":"15m","30m":"30m","1h":"1h","4h":"4h","1d":"1d","1w":"1w" };
function R(per) { return ["4h","1d","1w"].includes(per) ? 5 : per==="1h" ? 4 : 3; }

function scoreSignal(mp, dur, conf, per, ind, pct24) {
  let s = 0;
  const tf = (per||"1h").toLowerCase(), nm = (ind||"").toLowerCase();
  if (tf==="1w") s+=20; else if (tf==="1d") s+=18; else if (tf==="4h") s+=20;
  else if (tf==="1h") s+=14; else if (tf==="30m") s+=6; else if (tf==="15m") s+=4;
  if (nm.includes("macd")) s+=20; else if (nm.includes("stoch")) s+=18;
  else if (nm.includes("trend")||nm.includes("reversal")) s+=14;
  else if (nm.includes("cci")) s+=12; else if (nm.includes("ichimoku")) s+=10; else s+=6;
  if (conf>=5) s+=25; else if (conf>=4) s+=22; else if (conf>=3) s+=18; else if (conf>=2) s+=12;
  const m = pct24 ?? 0;
  if (m>10) s+=15; else if (m>5) s+=12; else if (m>1) s+=8; else if (m>=0) s+=5; else if (m>-3) s+=3;
  return { score: s, tier: s>=60?"A":s>=40?"B":"C" };
}

async function main() {
  console.log("Phase 1: Pulling full coinlegs corpus...");
  const all = [];
  const PAYLOAD = {
    Exchg:"Binance",Market:"USDT", IncludeBuySignal:true,IncludeNeutralSignal:false,IncludeSellSignal:false,
    DetectionIds:[47,9,8,46,7], Periods:["5m","15m","30m","1h","4h","1d","1w"],
    MarketName:"",__Key:"scraper",Sorting:{},StartDate:"2026-07-09T00:00:00.000Z",EndDate:"2026-07-10T23:59:59.000Z",RowsInPage:100
  };

  for (let page=0; page<71; page++) {
    const r = await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...PAYLOAD,Page:page})});
    if (!r.ok) { console.log(`  page ${page}: HTTP ${r.status} — done`); break; }
    const j = await r.json();
    const sigs = j?.Data?.Signals ?? [];
    if (!sigs.length) { console.log(`  page ${page}: empty — done`); break; }
    // Compute confluence per (marketName, period) group within this batch
    const groupMap = new Map();
    sigs.forEach(s => {
      const k = `${s.MarketName}_${s.Period}`;
      if (!groupMap.has(k)) groupMap.set(k, []);
      groupMap.get(k).push(s);
    });
    sigs.forEach(s => {
      const k = `${s.MarketName}_${s.Period}`;
      const conf = groupMap.get(k).filter(x => x.Name !== s.Name).length + 1;
      const { score, tier } = scoreSignal(0,"",conf,s.Period||"1h",s.Name||"",s.Percentage24??0);
      all.push({...s, _conf:conf, _score:score, _tier:tier});
    });
    process.stdout.write(`  page ${page}: ${sigs.length} signals, ${all.length} total\r`);
    await new Promise(r=>setTimeout(r,150));
  }
  console.log(`\n  Total: ${all.length} signals`);

  // Buy signals only, deduplicated by (marketName, period, Name)
  const seen = new Set();
  const buys = all.filter(s => {
    if (s.Signal !== 1) return false;
    const k = `${s.MarketName}_${s.Period}_${s.Name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`  Buys (deduped): ${buys.length}`);
  console.log(`  Tier A: ${buys.filter(s=>s._tier==="A").length} | B: ${buys.filter(s=>s._tier==="B").length} | C: ${buys.filter(s=>s._tier==="C").length}`);

  // Phase 2: Backtest
  console.log("\nPhase 2: Simulating against Binance klines...");
  const results = [];
  let kfetched = 0;

  for (const sig of buys) {
    const pair = (sig.MarketName||"").replace("/","").replace("USDT","");
    const symbol = `${pair}USDT`;
    const interval = MAP[sig.Period] || "1h";
    const stopPct = (ATR[sig.Period]||1.5) * 1.5;
    const tpPct = stopPct * R(sig.Period);
    const entryPrice = parseFloat(sig.Price||sig.LastPrice||"0");
    if (!entryPrice) continue;
    const stopPrice = entryPrice * (1 - stopPct/100);
    const tpPrice = entryPrice * (1 + tpPct/100);
    const signalTs = sig.SignalDateUTCString ? new Date(sig.SignalDateUTCString).getTime() : Date.now() - 86400000;

    try {
      const kRes = await fetch(`${BINANCE}/klines?symbol=${symbol}&interval=${interval}&startTime=${signalTs}&limit=50`);
      if (!kRes.ok) { results.push({pair:sig.MarketName,period:sig.Period,status:"klines_fail",code:kRes.status}); continue; }
      const klines = await kRes.json();
      kfetched++;
      if (klines.length < 1) { results.push({pair:sig.MarketName,period:sig.Period,status:"no_klines"}); continue; }

      let ei = 0;
      for (; ei<klines.length; ei++) if (klines[ei][0] >= signalTs) break;
      if (ei >= klines.length-1) { results.push({pair:sig.MarketName,period:sig.Period,status:"stale"}); continue; }

      const entryClose = parseFloat(klines[ei][4]);
      let outcome="time_exit", exitPrice=entryClose, maxHi=entryClose, minLo=entryClose;
      for (let i=ei+1; i<klines.length; i++) {
        const hi = parseFloat(klines[i][2]), lo = parseFloat(klines[i][3]), cl = parseFloat(klines[i][4]);
        if (hi>maxHi) maxHi=hi; if (lo<minLo) minLo=lo;
        if (lo<=stopPrice && hi>=tpPrice) { outcome="stopped"; exitPrice=stopPrice; break; }
        if (lo<=stopPrice) { outcome="stopped"; exitPrice=stopPrice; break; }
        if (hi>=tpPrice) { outcome="tp_hit"; exitPrice=tpPrice; break; }
        if (i===klines.length-1) { outcome="time_exit"; exitPrice=cl; }
      }

      const pnlPct = ((exitPrice-entryClose)/entryClose)*100;
      const actualMax = ((maxHi-entryClose)/entryClose)*100;
      const actualDD = ((entryClose-minLo)/entryClose)*100;

      results.push({
        pair:sig.MarketName, period:sig.Period, tier:sig._tier, score:sig._score,
        indicator:sig.Name, entryPrice:entryClose, stopPrice, tpPrice,
        outcome, exitPrice, pnlPct:pnlPct.toFixed(2),
        actualMaxProfitPct:actualMax.toFixed(2), actualDrawdownPct:actualDD.toFixed(2),
        win:pnlPct>0, conf:sig._conf, candles:klines.length,
        date: sig.SignalDateUTCString || new Date(signalTs).toISOString()
      });
      process.stdout.write(`\r  ${results.length}/${buys.length} backtested (${kfetched} kline fetches)`);
    } catch(e) {
      results.push({pair:sig.MarketName,period:sig.Period,status:"fetch_error",error:e.message});
    }
    await new Promise(r=>setTimeout(r,200));
  }

  // Phase 3: Report
  const done = results.filter(r=>r.outcome&&r.outcome!=="open");
  const wins = done.filter(r=>r.win);
  const losses = done.filter(r=>!r.win);
  const aDone = done.filter(r=>r.tier==="A");
  const aWins = aDone.filter(r=>r.win);

  const report = {
    generated: new Date().toISOString(),
    corpus: { total: all.length, buys: buys.length, tierA: buys.filter(s=>s._tier==="A").length, tierB: buys.filter(s=>s._tier==="B").length, tierC: buys.filter(s=>s._tier==="C").length },
    backtest: {
      simulated: done.length, klineFetches: kfetched,
      wins: wins.length, losses: losses.length,
      winRate: done.length ? `${(wins.length/done.length*100).toFixed(1)}%` : "N/A",
      avgWinPct: wins.length ? `${(wins.reduce((s,r)=>s+parseFloat(r.pnlPct),0)/wins.length).toFixed(2)}%` : "N/A",
      avgLossPct: losses.length ? `${(losses.reduce((s,r)=>s+parseFloat(r.pnlPct),0)/losses.length).toFixed(2)}%` : "N/A",
      tpRate: done.length ? `${(done.filter(r=>r.outcome==="tp_hit").length/done.length*100).toFixed(1)}%` : "N/A",
      stopRate: done.length ? `${(done.filter(r=>r.outcome==="stopped").length/done.length*100).toFixed(1)}%` : "N/A",
      tierA: aDone.length ? { count: aDone.length, wins: aWins.length, winRate: `${(aWins.length/aDone.length*100).toFixed(1)}%` } : null,
    },
    byPeriod: {}, byIndicator: {}, byTier: {},
    deploy: "",
    trades: results,
  };

  for (const p of [...new Set(done.map(r=>r.period))]) {
    const t = done.filter(r=>r.period===p), tw = t.filter(r=>r.win);
    report.byPeriod[p] = { count:t.length, wins:tw.length, winRate:`${(tw.length/t.length*100).toFixed(1)}%` };
  }
  for (const ind of [...new Set(done.map(r=>r.indicator))].filter(Boolean)) {
    const t = done.filter(r=>r.indicator===ind), tw = t.filter(r=>r.win);
    report.byIndicator[ind] = { count:t.length, wins:tw.length, winRate:`${(tw.length/t.length*100).toFixed(1)}%` };
  }
  for (const tier of ["A","B","C"]) {
    const t = done.filter(r=>r.tier===tier), tw = t.filter(r=>r.win);
    if (t.length) report.byTier[tier] = { count:t.length, wins:tw.length, winRate:`${(tw.length/t.length*100).toFixed(1)}%` };
  }

  const wr = parseFloat(report.backtest.winRate);
  const exp = wins.length*parseFloat(report.backtest.avgWinPct||"0")/done.length + losses.length*parseFloat(report.backtest.avgLossPct||"0")/done.length;
  report.backtest.expectancy = `${exp.toFixed(2)}%`;

  if (done.length < 30) report.deploy = "INSUFFICIENT_DATA";
  else if (exp > 0 && wr >= 50) report.deploy = "EDGE_CONFIRMED";
  else if (exp > 0) report.deploy = "EDGE_CANDIDATE";
  else report.deploy = "NO_EDGE";

  console.log("\n\n" + JSON.stringify(report, null, 2));

  const fs = require("fs");
  fs.writeFileSync(__dirname + "/full-backtest-results.json", JSON.stringify(report, null, 2));
  console.log("\nSaved to scripts/full-backtest-results.json");
}

main().catch(e => { console.error(e); process.exit(1); });
