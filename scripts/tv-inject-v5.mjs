// DEPRECATED: Superseded by v6 (scripts/tv-deploy-v6.mjs) — uses more robust CDP injection.
// Quick inject v5.0
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';

const source = readFileSync('/home/ariel/anavitrade-trading/scripts/icr-smc-engine-v5.pine', 'utf8');
const escaped = JSON.stringify(source);

const targets = await CDP.List({ port: 9222 });
const page = targets.find(t => t.type === 'page' && t.title.includes('TradingView'));
const client = await CDP({ target: page.id, port: 9222 });
await client.Runtime.enable();

// Inject
const { result } = await client.Runtime.evaluate({
  expression: `(function(){var c=document.querySelector('.monaco-editor.pine-editor-monaco');if(!c)return{error:'no_monaco'};var e=c,fk;for(var i=0;i<20;i++){if(!e)break;fk=Object.keys(e).find(function(k){return k.startsWith('__reactFiber$')});if(fk)break;e=e.parentElement}if(!fk)return{error:'no_fiber'};var cur=e[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var eds=cur.memoizedProps.value.monacoEnv.editor.getEditors();if(eds.length>0){eds[0].getModel().setValue(${escaped});return{success:true,lines:${source.split('\\n').length}}}}cur=cur.return}return{error:'no_editor'}})()`,
  returnByValue: true,
});
console.log('Inject:', JSON.stringify(result.value));

// Compile
await new Promise(r => setTimeout(r, 500));
await client.Runtime.evaluate({
  expression: `(function(){var b=document.querySelectorAll('button');for(var i=0;i<b.length;i++){var t=b[i].textContent.trim();if(/^add to chart$/i.test(t)||/^update on chart$/i.test(t)||/save and add/i.test(t)){b[i].click();return}}document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}))})()`,
});

await new Promise(r => setTimeout(r, 4000));

// Check markers
const errs = await client.Runtime.evaluate({
  expression: `(function(){var c=document.querySelector('.monaco-editor.pine-editor-monaco');if(!c)return[];var e=c,fk;for(var i=0;i<20;i++){if(!e)break;fk=Object.keys(e).find(function(k){return k.startsWith('__reactFiber$')});if(fk)break;e=e.parentElement}if(!fk)return[];var cur=e[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;var eds=env.editor.getEditors();if(eds.length>0){var m=eds[0].getModel();if(m)return env.editor.getModelMarkers({resource:m.uri}).map(function(mk){return{line:mk.startLineNumber,msg:mk.message,sev:mk.severity}})}}cur=cur.return}return[]})()`,
  returnByValue: true,
});

const markers = errs.result?.value || [];
const errors = markers.filter(m => m.sev === 8);
const warnings = markers.filter(m => m.sev === 4);
console.log(`Errors: ${errors.length} | Warnings: ${warnings.length}`);
if (errors.length) errors.slice(0,10).forEach(e => console.log(`  ❌ L${e.line}: ${e.msg}`));
if (warnings.length) warnings.slice(0,5).forEach(w => console.log(`  ⚠ L${w.line}: ${w.msg}`));

// Check strategy on chart
const strat = await client.Runtime.evaluate({
  expression: `(function(){var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;var ss=chart.model().model().dataSources();var strs=[];for(var i=0;i<ss.length;i++){try{var rd=ss[i].reportData?ss[i].reportData():null;if(rd&&typeof rd.value==='function')rd=rd.value();if(rd&&rd.performance){var a=rd.performance.all||{};strs.push({name:(ss[i].metaInfo()||{}).description||'',pf:a.profitFactor,trades:(a.numberOfWiningTrades||0)+(a.numberOfLosingTrades||0)})}}catch(e){}}return strs})()`,
  returnByValue: true,
});
console.log('\nStrategies on chart:', JSON.stringify(strat.result?.value));

await client.close();
