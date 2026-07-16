#!/usr/bin/env node
/**
 * Quick TradingView Strategy Tester Sweep
 * V4.0 is already compiled on the chart — just loop symbols and extract metrics.
 * Usage: node scripts/tv-sweep-v4.mjs --symbols "SOLUSDT,AVAXUSDT" --tf 4h
 */
import CDP from 'chrome-remote-interface';

const CHART_API = "window.TradingViewApi._activeChartWidgetWV.value()";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = process.argv.slice(2);
  const tf = args.includes('--tf') ? args[args.indexOf('--tf') + 1] : '4h';
  const defaultSyms = ['SOLUSDT','AVAXUSDT','AAVEUSDT','SEIUSDT','SUIUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT','TIAUSDT'];
  const symbols = args.includes('--symbols') ? args[args.indexOf('--symbols') + 1].split(',') : defaultSyms;

  console.log('═'.repeat(70));
  console.log(`TV Sweep: ${symbols.length} symbols, ${tf}`);
  console.log('═'.repeat(70));

  const targets = await CDP.List({ port: 9222 });
  const page = targets.find(t => t.type === 'page' && t.title.includes('TradingView'));
  const client = await CDP({ target: page.id, port: 9222 });
  await client.Runtime.enable();

  // Set timeframe
  await client.Runtime.evaluate({ expression: `${CHART_API}.setResolution('${tf}', {})`, returnByValue: true });
  await sleep(2000);

  const results = [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    console.log(`[${i + 1}/${symbols.length}] BINANCE:${sym}...`);

    // Set symbol
    await client.Runtime.evaluate({ expression: `(function(c,s){return new Promise(r=>{c.setSymbol(s,{});setTimeout(r,1500)});})(${CHART_API},"BINANCE:${sym}")`, awaitPromise: true });
    await sleep(5000); // Wait for strategy recalculation

    // Extract metrics
    const { result } = await client.Runtime.evaluate({
      expression: `(function(){
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        for(var i=0;i<sources.length;i++){
          var s=sources[i];
          try{
            var rd=s.reportData? s.reportData():null;
            if(rd && typeof rd.value==='function') rd=rd.value();
            if(rd && rd.performance){
              var p=rd.performance, a=p.all||{};
              return {
                netProfit:a.netProfit, pf:a.profitFactor, wr:a.percentProfitable,
                sharpe:p.sharpeRatio, maxDD:p.maxStrategyDrawDownPercent,
                trades:(a.numberOfWiningTrades||0)+(a.numberOfLosingTrades||0),
                avgTradePct:a.avgTradePercent, avgBars:a.avgBarsInTrade,
                grossProfit:a.grossProfit, grossLoss:a.grossLoss,
                maxConsWins:a.maxConsecutiveWins, maxConsLoss:a.maxConsecutiveLosses
              };
            }
          }catch(e){}
        }
        return {error:'no_strategy'};
      })()`,
      returnByValue: true,
    });

    const m = result?.value || {};
    const pf = m.pf || 0, wr = m.wr || 0, dd = m.maxDD || 0;
    const icon = pf >= 1.5 ? '🟢' : pf >= 1.0 ? '🟡' : '🔴';
    console.log(`  ${icon} Trades:${m.trades||0} WR:${(wr*100).toFixed(1)}% PF:${pf.toFixed(2)} Sharpe:${(m.sharpe||0).toFixed(2)} MaxDD:${(dd*100).toFixed(2)}%`);

    results.push({ symbol: sym, timeframe: tf, ...m });
  }

  // Summary
  const valid = results.filter(r => !r.error);
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`${'Symbol'.padEnd(12)} | Trades | WR%   | PF    | Sharpe | MaxDD%`);
  console.log('─'.repeat(70));
  for (const r of valid) {
    console.log(`${r.symbol.padEnd(12)} | ${String(r.trades||0).padStart(6)} | ${((r.wr||0)*100).toFixed(1).padStart(5)}% | ${(r.pf||0).toFixed(2).padStart(5)} | ${(r.sharpe||0).toFixed(2).padStart(6)} | ${((r.maxDD||0)*100).toFixed(2).padStart(5)}%`);
  }

  if (valid.length > 0) {
    const avgPF = valid.reduce((s,r) => s+(r.pf||0),0) / valid.length;
    const avgWR = valid.reduce((s,r) => s+(r.wr||0),0) / valid.length;
    const avgDD = valid.reduce((s,r) => s+(r.maxDD||0),0) / valid.length;
    const totalT = valid.reduce((s,r) => s+(r.trades||0), 0);
    console.log('─'.repeat(70));
    console.log(`${'AVERAGE'.padEnd(12)} | ${String(totalT).padStart(6)} | ${(avgWR*100).toFixed(1).padStart(4)}% | ${avgPF.toFixed(2).padStart(5)} | ${'--'.padStart(6)} | ${(avgDD*100).toFixed(2).padStart(5)}%`);
  }

  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
