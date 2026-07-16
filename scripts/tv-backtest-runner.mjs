#!/usr/bin/env node
/**
 * TradingView Backtest Runner v3.0
 *
 * Uses TradingView's internal JavaScript API (via CDP) to:
 *   1. Inject Pine Script into the editor
 *   2. Save + compile as strategy and add to chart
 *   3. Loop through symbols, extract Strategy Tester metrics per symbol
 *   4. Save results + screenshots
 *
 * v3.0 fixes over v2.0:
 *   - Uses Ctrl+Enter keyboard shortcut for compilation (button text varies by
 *     TV state and button detection is unreliable in desktop app).
 *   - Saves script before compile and handles "Save Script" dialog.
 *   - Focuses Monaco editor before keyboard shortcuts.
 *   - Verifies strategy appears on chart after compile with diagnostic dumps.
 *   - Unhides hidden strategies before reading reports.
 *   - Longer wait after symbol changes for strategy recalculation (up to 20s).
 *   - Re-verifies strategy presence after each symbol change.
 *
 * Prerequisites:
 *   TradingView Desktop running with --remote-debugging-port=9222
 *
 * Usage:
 *   node scripts/tv-backtest-runner.mjs
 *   node scripts/tv-backtest-runner.mjs --symbols BINANCE:SOLUSDT --tf 4h
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDP_PORT = 9222;
const OUTPUT_DIR = join(__dirname, 'tv-backtest-results');
const CDP = (await import('chrome-remote-interface')).default;

const CHART_API = "window.TradingViewApi._activeChartWidgetWV.value()";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════
// Shared JS snippets (mirror TV MCP patterns)
// ═══════════════════════════════════════════════════════════════════

const FIND_MONACO_JS = `
(function findMonacoEditor() {
  var container = document.querySelector('.monaco-editor.pine-editor-monaco');
  if (!container) return null;
  var el = container;
  var fiberKey;
  for (var i = 0; i < 20; i++) {
    if (!el) break;
    fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
    if (fiberKey) break;
    el = el.parentElement;
  }
  if (!fiberKey) return null;
  var current = el[fiberKey];
  for (var d = 0; d < 15; d++) {
    if (!current) break;
    if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
      var env = current.memoizedProps.value.monacoEnv;
      if (env.editor && typeof env.editor.getEditors === 'function') {
        var editors = env.editor.getEditors();
        if (editors.length > 0) return { editor: editors[0], env: env };
      }
    }
    current = current.return;
  }
  return null;
})()
`;

const FIND_STRATEGY_JS = `
function _reportOf(s) {
  try { var rd = s.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value(); return rd; } catch (e) { return null; }
}
function findStrategies() {
  var chart = ${CHART_API}._chartWidget;
  var sources = chart.model().model().dataSources();
  var strategies = [];
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i], mi = null;
    try { mi = s.metaInfo ? s.metaInfo() : null; } catch (e) {}
    var isStrat = mi && (mi.isTVScriptStrategy || mi.is_strategy);
    if ((isStrat || typeof s.reportData === 'function') && typeof s.reportData === 'function') {
      strategies.push({ s: s, name: mi ? (mi.description || mi.shortDescription || '') : '', isstrategy: !!isStrat });
    }
  }
  return strategies;
}
function findStrategy() {
  var strategies = findStrategies();
  for (var j = 0; j < strategies.length; j++) {
    var rd = _reportOf(strategies[j].s);
    if (rd && rd.performance) return { strat: strategies[j].s, report: rd, name: strategies[j].name, strategy_count: strategies.length };
  }
  if (strategies.length) return { strat: strategies[0].s, report: null, name: strategies[0].name, strategy_count: strategies.length };
  return null;
}
function unhideStrategies() {
  var unhidden = [];
  var strategies = findStrategies();
  for (var i = 0; i < strategies.length; i++) {
    var s = strategies[i].s;
    try {
      var vis = null;
      try { vis = s.properties().visible.value(); } catch (e) {}
      if (vis !== false) continue;
      var done = false;
      try { s.properties().visible.setValue(true); done = true; } catch (e) {}
      if (!done) {
        try { var st = ${CHART_API}.getStudyById(s.id()); if (st) { st.setVisible(true); done = true; } } catch (e) {}
      }
      if (done) unhidden.push(strategies[i].name || 'strategy');
    } catch (e) {}
  }
  return unhidden;
}
`;

// ═══════════════════════════════════════════════════════════════════
// CDP helpers
// ═══════════════════════════════════════════════════════════════════

async function evalPage(client, expr) {
  const { result } = await client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: false });
  if (result?.subtype === 'error') throw new Error(result.description);
  if (result?.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Eval error';
    throw new Error(`JS: ${msg}`);
  }
  return result?.value;
}

async function evalAsync(client, expr) {
  const wrap = `(function() { return new Promise(function(resolve) { ${expr} }); })()`;
  const { result } = await client.Runtime.evaluate({ expression: wrap, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Eval error';
    throw new Error(`JS: ${msg}`);
  }
  return result?.value;
}

function safeStr(s) { return JSON.stringify(String(s)); }

// ═══════════════════════════════════════════════════════════════════
// Pine Editor
// ═══════════════════════════════════════════════════════════════════

// Simple DOM check — avoids serializing complex Monaco objects through CDP
async function isMonacoInDOM(client) {
  return evalPage(client, `
    (function() {
      var c = document.querySelector('.monaco-editor.pine-editor-monaco');
      return !!(c && c.offsetParent !== null);
    })()
  `);
}

async function ensurePineEditorOpen(client) {
  if (await isMonacoInDOM(client)) return true;

  // Switch to Pine Editor in the bottom panel
  console.log('   Switching to Pine Editor...');

  // Method 1: bottomWidgetBar.showWidget with known widget names
  await evalPage(client, `
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return 'no_bwb';
      // Try multiple known widget names
      var names = ['pine-editor', 'pine', 'PineEditor', 'pine_editor', 'script'];
      for (var i = 0; i < names.length; i++) {
        try { bwb.showWidget(names[i]); } catch(e) {}
      }
    })()
  `);
  await sleep(1000);

  if (await isMonacoInDOM(client)) return true;

  // Method 2: Find and click the Pine Editor tab button in bottom panel
  await evalPage(client, `
    (function() {
      var bottom = document.querySelector('[class*="layout__area--bottom"]');
      if (!bottom) return;
      // Try various selectors for the Pine Editor button/tab
      var btn = bottom.querySelector('[data-name*="pine"]')
        || bottom.querySelector('[aria-label*="Pine"]')
        || bottom.querySelector('[title*="Pine"]');
      if (btn) { btn.click(); return 'clicked_pine_in_bottom'; }
      // Also try top-level
      var topBtn = document.querySelector('[aria-label="Pine Editor"]')
        || document.querySelector('[data-name="pine-editor-button"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (topBtn) { topBtn.click(); return 'clicked_pine_top'; }
    })()
  `);
  await sleep(1000);

  if (await isMonacoInDOM(client)) return true;

  // Method 3: Look for the panel switcher tabs at the bottom
  await evalPage(client, `
    (function() {
      // Find all bottom panel tabs
      var tabs = document.querySelectorAll('[class*="tab-jogw"], [class*="tabBar-"], [class*="widgetTabs"] [class*="tab"]');
      for (var i = 0; i < tabs.length; i++) {
        var txt = (tabs[i].textContent || '').trim();
        if (/Pine|pine|PINE/i.test(txt) && tabs[i].offsetParent !== null) {
          tabs[i].click();
          return;
        }
      }
      // Fallback: try clicking any tab in the bottom widget bar
      var bottomTabs = document.querySelectorAll('[class*="layout__area--bottom"] [class*="tab"]');
      for (var j = 0; j < bottomTabs.length; j++) {
        if (bottomTabs[j].offsetParent !== null) {
          bottomTabs[j].click();
          return;
        }
      }
    })()
  `);

  // Wait up to 10 seconds for Monaco to appear
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    if (await isMonacoInDOM(client)) {
      console.log(`   Pine Editor appeared after ${(i + 1) * 200}ms`);
      return true;
    }
  }
  return false;
}

async function setPineSource(client, source) {
  const escaped = JSON.stringify(source);
  return evalPage(client, `
    (function() {
      var m = ${FIND_MONACO_JS};
      if (!m) return { error: 'no_monaco' };
      try {
        m.editor.setValue(${escaped});
        return { success: true, lines: ${source.split('\n').length} };
      } catch(e) { return { error: e.message }; }
    })()
  `);
}

// ═══════════════════════════════════════════════════════════════════
// Save + Compile (keyboard-driven — buttons are unreliable in desktop)
// ═══════════════════════════════════════════════════════════════════

async function savePineScript(client) {
  // Focus Monaco first so keyboard shortcuts work
  await evalPage(client, `
    (function() {
      var m = ${FIND_MONACO_JS};
      if (m) m.editor.focus();
    })()
  `);
  await sleep(300);

  // Ctrl+S
  await client.Input.dispatchKeyEvent({
    type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83
  });
  await client.Input.dispatchKeyEvent({
    type: 'keyUp', key: 's', code: 'KeyS'
  });
  await sleep(1000);

  // Handle "Save Script" name dialog for unsaved scripts
  const dialogHandled = await evalPage(client, `
    (function() {
      var saveBtn = null;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' && btns[i].offsetParent !== null) {
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (parent) { saveBtn = btns[i]; break; }
        }
      }
      if (saveBtn) { saveBtn.click(); return true; }
      return false;
    })()
  `);
  if (dialogHandled) await sleep(500);

  return { saved: true, dialogHandled };
}

async function compilePine(client) {
  // Count studies before
  const studiesBefore = await evalPage(client, `
    (function() {
      try {
        var chart = ${CHART_API};
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);
  console.log(`   Studies before compile: ${studiesBefore}`);

  // Focus Monaco editor (critical for keyboard shortcut to work)
  await evalPage(client, `
    (function() {
      var m = ${FIND_MONACO_JS};
      if (m) m.editor.focus();
    })()
  `);
  await sleep(300);

  // Try button click first (handles "Save and add to chart" flow)
  let buttonClicked = await evalPage(client, `
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (!btns[i].offsetParent || btns[i].offsetWidth === 0) continue; // skip hidden
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (/^add to chart$/i.test(text)) {
          btns[i].click();
          return 'Add to chart';
        }
        if (/^update on chart$/i.test(text)) {
          btns[i].click();
          return 'Update on chart';
        }
      }
      return null;
    })()
  `);

  if (!buttonClicked) {
    // Use Ctrl+Enter — the standard Pine Editor compile keyboard shortcut
    console.log('   No compile button visible, using Ctrl+Enter...');
    await client.Input.dispatchKeyEvent({
      type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13
    });
    await client.Input.dispatchKeyEvent({
      type: 'keyUp', key: 'Enter', code: 'Enter'
    });
    buttonClicked = 'Ctrl+Enter';
  }

  console.log(`   Compile: ${buttonClicked}`);

  // Wait for compilation
  await sleep(3000);

  // Check errors
  const errors = await evalPage(client, `
    (function() {
      var m = ${FIND_MONACO_JS};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  // Count studies after
  const studiesAfter = await evalPage(client, `
    (function() {
      try {
        var chart = ${CHART_API};
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);
  console.log(`   Studies after compile: ${studiesAfter}`);

  return {
    buttonClicked,
    hasErrors: errors?.length > 0,
    errors: errors || [],
    studyAdded: (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Strategy verification
// ═══════════════════════════════════════════════════════════════════

async function verifyStrategyOnChart(client) {
  return evalPage(client, `
    (function() {
      ${FIND_STRATEGY_JS}
      var strategies = findStrategies();
      return {
        strategyCount: strategies.length,
        strategies: strategies.map(function(st) { return { name: st.name, isstrategy: st.isstrategy }; })
      };
    })()
  `);
}

async function diagnoseAllSources(client) {
  return evalPage(client, `
    (function() {
      var chart = ${CHART_API}._chartWidget;
      var sources = chart.model().model().dataSources();
      var info = [];
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i], mi = null;
        try { mi = s.metaInfo ? s.metaInfo() : null; } catch(e) {}
        info.push({
          index: i,
          desc: mi ? (mi.description || mi.shortDescription || '') : '(no meta)',
          isStrategy: mi ? !!(mi.isTVScriptStrategy || mi.is_strategy) : false,
          hasReport: typeof s.reportData === 'function',
          hasOrders: typeof s.ordersData === 'function',
          isPriceStudy: mi ? !!mi.is_price_study : false,
        });
      }
      return { total: sources.length, sources: info };
    })()
  `);
}

// ═══════════════════════════════════════════════════════════════════
// Chart control
// ═══════════════════════════════════════════════════════════════════

async function getChartState(client) {
  return evalPage(client, `
    (function() {
      try {
        var chart = ${CHART_API};
        return { symbol: chart.symbol(), resolution: chart.resolution() };
      } catch(e) { return { error: e.message }; }
    })()
  `);
}

async function waitForReportReady(client, maxWaitMs = 20000) {
  const deadline = Date.now() + maxWaitMs;
  let lastStatus = 'pending';
  while (Date.now() < deadline) {
    const status = await evalPage(client, `
      (function() {
        ${FIND_STRATEGY_JS}
        var f = findStrategy();
        if (!f) return 'no-strategy';
        return f.report && f.report.performance ? 'ready' : 'pending';
      })()
    `);
    if (status === 'ready' || status === 'no-strategy') return status === 'ready';
    if (status !== lastStatus) {
      lastStatus = status;
    }
    await sleep(500);
  }
  return false;
}

async function setSymbol(client, symbol) {
  console.log(`   Setting symbol to ${symbol}...`);
  await evalAsync(client, `
    var chart = ${CHART_API};
    chart.setSymbol(${safeStr(symbol)}, {});
    setTimeout(resolve, 1000);
  `);

  // Wait for loading spinner to clear
  console.log('   Waiting for chart to load...');
  let loaded = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const state = await evalPage(client, `
      (function() {
        try {
          var chart = ${CHART_API};
          var spinner = document.querySelector('[class*="loader"]:not([class*="initial"])')
            || document.querySelector('[class*="loading"]:not([class*="initial"])')
            || document.querySelector('[data-name="loading"]');
          var isLoading = !!(spinner && spinner.offsetParent !== null);
          return { symbol: chart.symbol(), loading: isLoading };
        } catch(e) { return { error: e.message }; }
      })()
    `);
    if (state?.error) continue;
    if (!state?.loading && state?.symbol) {
      loaded = true;
      break;
    }
  }
  if (!loaded) console.log('   Warning: chart may still be loading');
  else console.log('   Chart loaded.');

  // Wait for strategy to recalculate on new symbol (can take 10-20s)
  console.log('   Waiting for strategy report to recompute...');
  const reportReady = await waitForReportReady(client, 20000);
  if (reportReady) {
    console.log('   Strategy report recomputed.');
  } else {
    console.log('   Warning: strategy report not ready. Will attempt read anyway.');
  }

  return getChartState(client);
}

async function setTimeframe(client, tf) {
  await evalPage(client, `
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${safeStr(tf)}, {});
    })()
  `);
  await sleep(4000);
  await waitForReportReady(client, 15000);
}

// ═══════════════════════════════════════════════════════════════════
// Strategy Tester
// ═══════════════════════════════════════════════════════════════════

async function ensureStrategyTesterReady(client, maxWaitMs = 8000) {
  // Open the Strategy Tester panel
  await evalPage(client, `
    (function() {
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (bwb && typeof bwb.showWidget === 'function') bwb.showWidget('backtesting');
      } catch (e) {}
    })()
  `);

  // Unhide any hidden strategies
  const unhidden = await evalPage(client, `
    (function() {
      ${FIND_STRATEGY_JS}
      return unhideStrategies();
    })()
  `);
  if (unhidden?.length) {
    console.log(`   Unhidden strategies: ${unhidden.join(', ')}`);
  }

  // Wait for report
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const ready = await evalPage(client, `
      (function() {
        ${FIND_STRATEGY_JS}
        var f = findStrategy();
        if (!f) return 'no-strategy';
        return f.report && f.report.performance ? 'ready' : 'pending';
      })()
    `);
    if (ready === 'ready' || ready === 'no-strategy') break;
    await sleep(500);
  }
}

async function getStrategyMetrics(client) {
  await ensureStrategyTesterReady(client);

  return evalPage(client, `
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var found = findStrategy();
        if (!found) return { error: 'no_strategy_found' };
        var rd = found.report;
        if (!rd || !rd.performance) return { error: 'report_not_computed' };
        var perf = rd.performance;
        var all = perf.all || {};
        return {
          netProfit: all.netProfit,
          netProfitPercent: all.netProfitPercent,
          grossProfit: all.grossProfit,
          grossLoss: all.grossLoss,
          profitFactor: all.profitFactor,
          maxDrawdown: perf.maxStrategyDrawDown,
          maxDrawdownPercent: perf.maxStrategyDrawDownPercent,
          totalTrades: (all.numberOfWiningTrades || 0) + (all.numberOfLosingTrades || 0),
          winningTrades: all.numberOfWiningTrades || 0,
          losingTrades: all.numberOfLosingTrades || 0,
          percentProfitable: all.percentProfitable,
          avgTrade: all.avgTrade,
          avgTradePercent: all.avgTradePercent,
          largestWin: all.largestWinTrade,
          largestLoss: all.largestLosTrade,
          sharpeRatio: perf.sharpeRatio,
          sortinoRatio: perf.sortinoRatio,
          avgBarsInTrade: all.avgBarsInTrade,
          avgBarsInWin: all.avgBarsInWiningTrade,
          avgBarsInLoss: all.avgBarsInLosingTrade,
          maxConsecutiveWins: all.maxConsecutiveWins,
          maxConsecutiveLosses: all.maxConsecutiveLosses,
          strategy: found.name,
          buyHoldReturn: perf.buyHoldReturn,
          openPL: perf.openPL,
          commissionPaid: all.commissionPaid,
        };
      } catch(e) { return { error: e.message }; }
    })()
  `);
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const timeframe = args.includes('--tf') ? args[args.indexOf('--tf') + 1] : '4h';

  const defaultSymbols = [
    'BINANCE:SOLUSDT', 'BINANCE:AVAXUSDT', 'BINANCE:AAVEUSDT',
    'BINANCE:SEIUSDT', 'BINANCE:SUIUSDT', 'BINANCE:NEARUSDT',
    'BINANCE:APTUSDT', 'BINANCE:ARBUSDT', 'BINANCE:OPUSDT',
    'BINANCE:TIAUSDT', 'BINANCE:DYDXUSDT', 'BINANCE:INJUSDT',
    'BINANCE:RUNEUSDT', 'BINANCE:LDOUSDT', 'BINANCE:RNDRUSDT',
  ];

  const symbols = args.includes('--symbols')
    ? args[args.indexOf('--symbols') + 1].split(',')
    : defaultSymbols;

  console.log('='.repeat(80));
  console.log('TradingView Backtest Runner v3.0');
  console.log(`Timeframe: ${timeframe} | Symbols: ${symbols.length}`);
  console.log('='.repeat(80));

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  // ═══════════════════════ CONNECT ═══════════════════════
  console.log('\n[1] Connecting to TradingView CDP...');
  let client;
  try {
    const targets = await CDP.List({ port: CDP_PORT });
    const pageTarget = targets.find(t => t.type === 'page' && t.title.includes('TradingView'));
    if (!pageTarget) throw new Error('No TradingView page found. Is TV running?');
    console.log(`   Target: ${pageTarget.title}`);
    client = await CDP({ target: pageTarget.id, host: '127.0.0.1', port: CDP_PORT });
  } catch (err) {
    console.error(`   Error: ${err.message}`);
    process.exit(1);
  }

  await client.Runtime.enable();
  await client.Page.enable();

  const state = await getChartState(client);
  console.log(`   Current: ${state.symbol} ${state.resolution}`);

  // ═══════════════════════ LOAD ═══════════════════════
  console.log('\n[2] Loading Pine Script...');
  const pinePath = join(__dirname, 'icr-smc-engine.pine');
  const pineSource = readFileSync(pinePath, 'utf8');
  console.log(`   ${pineSource.split('\n').length} lines from icr-smc-engine.pine`);

  // ═══════════════════════ OPEN EDITOR ═══════════════════════
  console.log('\n[3] Opening Pine Editor...');
  const editorReady = await ensurePineEditorOpen(client);
  if (!editorReady) {
    console.error('   Pine Editor not found. Make sure the Pine Editor tab is accessible in TradingView.');
    await client.close();
    process.exit(1);
  }
  console.log('   Pine Editor ready');

  // ═══════════════════════ INJECT ═══════════════════════
  console.log('\n[4] Injecting Pine Script...');
  const injectResult = await setPineSource(client, pineSource);
  console.log(`   Inject: ${JSON.stringify(injectResult)}`);
  if (injectResult?.error) {
    console.error(`   Failed: ${injectResult.error}`);
    await client.close();
    process.exit(1);
  }

  // ═══════════════════════ SAVE + COMPILE ═══════════════════════
  console.log('\n[5] Saving...');
  const saveResult = await savePineScript(client);
  console.log(`   Save: ${JSON.stringify(saveResult)}`);

  console.log('\n[6] Compiling...');
  const compileResult = await compilePine(client);

  if (compileResult.hasErrors) {
    console.log(`   Errors (${compileResult.errors.length}):`);
    compileResult.errors.forEach(e => console.log(`      L${e.line}: ${e.message}`));
    const fatal = compileResult.errors.some(e => e.severity >= 8);
    if (fatal) {
      console.error('   Fatal compilation errors. Aborting.');
      await client.close();
      process.exit(1);
    }
    console.log('   Non-fatal, continuing...');
  } else {
    console.log('   No compilation errors');
  }

  // ═══════════════════════ VERIFY ═══════════════════════
  console.log('\n[7] Verifying strategy on chart...');
  const verify = await verifyStrategyOnChart(client);
  console.log(`   Strategies: ${verify.strategyCount}`);
  verify.strategies.forEach(s => console.log(`     - "${s.name}" isStrategy=${s.isstrategy}`));

  if (verify.strategyCount === 0) {
    console.log('\n   No strategy found. Dumping all data sources...');
    const diag = await diagnoseAllSources(client);
    console.log(`   Total sources: ${diag.total}`);
    const candidates = diag.sources.filter(s => s.hasReport || s.hasOrders);
    console.log(`   Sources with report/orders: ${candidates.length}`);
    candidates.slice(0, 10).forEach(s => {
      console.log(`     [${s.index}] "${s.desc}" strategy=${s.isStrategy} report=${s.hasReport} orders=${s.hasOrders}`);
    });

    // Retry compile
    console.log('\n   Retrying compile...');
    const retry = await compilePine(client);
    console.log(`   Retry button: ${retry.buttonClicked}, studyAdded: ${retry.studyAdded}`);
    await sleep(3000);

    const verify2 = await verifyStrategyOnChart(client);
    console.log(`   Strategies after retry: ${verify2.strategyCount}`);
    if (verify2.strategyCount === 0) {
      console.error('\n   STRATEGY STILL NOT ON CHART.');
      console.error('   The Pine Script may have compiled as an indicator variant.');
      console.error('   Full source dump:');
      const diag2 = await diagnoseAllSources(client);
      diag2.sources.forEach(s => {
        console.log(`     [${s.index}] "${s.desc}" strategy=${s.isStrategy} report=${s.hasReport} orders=${s.hasOrders} priceStudy=${s.isPriceStudy}`);
      });
      await client.close();
      process.exit(1);
    }
  }

  // ═══════════════════════ TIMEFRAME ═══════════════════════
  console.log(`\n[8] Setting timeframe to ${timeframe}...`);
  await setTimeframe(client, timeframe);
  const tfState = await getChartState(client);
  console.log(`   Chart: ${tfState.symbol} ${tfState.resolution}`);

  // ═══════════════════════ BACKTEST LOOP ═══════════════════════
  const results = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    console.log(`\n${'-'.repeat(80)}`);
    console.log(`[${i + 1}/${symbols.length}] ${symbol} ${timeframe}`);
    console.log('-'.repeat(80));

    try {
      // Set symbol (includes wait for strategy recalculation)
      const symState = await setSymbol(client, symbol);
      console.log(`   Chart: ${symState.symbol} ${symState.resolution}`);

      // Verify strategy still on chart after symbol change
      const stratCheck = await verifyStrategyOnChart(client);
      if (stratCheck.strategyCount === 0) {
        console.log('   Strategy disappeared after symbol change. Recompiling...');
        await compilePine(client);
        await waitForReportReady(client, 10000);
      }

      // Get strategy metrics
      console.log('   Reading Strategy Tester...');
      const metrics = await getStrategyMetrics(client);

      if (metrics?.error) {
        console.log(`   ${metrics.error}`);
        results.push({ symbol, timeframe, error: metrics.error });
      } else {
        // TV returns percentages as fractions (0.28 = 28%), multiply by 100 for display
        const pct = (v) => v != null ? (v * 100) : null;
        console.log(`   Net Profit: ${metrics.netProfit != null ? metrics.netProfit.toFixed(2) : 'N/A'}`);
        console.log(`   Profit Factor: ${metrics.profitFactor != null ? metrics.profitFactor.toFixed(2) : 'N/A'}`);
        console.log(`   Win Rate: ${pct(metrics.percentProfitable) != null ? pct(metrics.percentProfitable).toFixed(1) + '%' : 'N/A'}`);
        console.log(`   Sharpe: ${metrics.sharpeRatio != null ? metrics.sharpeRatio.toFixed(2) : 'N/A'}`);
        console.log(`   Max DD: ${pct(metrics.maxDrawdownPercent) != null ? pct(metrics.maxDrawdownPercent).toFixed(1) + '%' : 'N/A'}`);
        console.log(`   Total Trades: ${metrics.totalTrades || 0} (W: ${metrics.winningTrades || 0} / L: ${metrics.losingTrades || 0})`);

        results.push({
          symbol, timeframe, timestamp: new Date().toISOString(),
          netProfit: metrics.netProfit, netProfitPercent: metrics.netProfitPercent,
          grossProfit: metrics.grossProfit, grossLoss: metrics.grossLoss,
          profitFactor: metrics.profitFactor, maxDrawdown: metrics.maxDrawdown,
          maxDrawdownPercent: metrics.maxDrawdownPercent,
          totalTrades: metrics.totalTrades, winningTrades: metrics.winningTrades,
          losingTrades: metrics.losingTrades, winRate: metrics.percentProfitable,
          sharpeRatio: metrics.sharpeRatio, sortinoRatio: metrics.sortinoRatio,
          avgTrade: metrics.avgTrade, avgTradePercent: metrics.avgTradePercent,
          largestWin: metrics.largestWin, largestLoss: metrics.largestLoss,
          avgBarsInTrade: metrics.avgBarsInTrade, maxConsecutiveLosses: metrics.maxConsecutiveLosses,
        });
      }

      // Screenshot
      try {
        const { data } = await client.Page.captureScreenshot({ format: 'png', fromSurface: true });
        const ssName = `${symbol.replace(':', '_')}_${timeframe}.png`;
        writeFileSync(join(OUTPUT_DIR, ssName), Buffer.from(data, 'base64'));
        console.log(`   Screenshot: ${ssName}`);
      } catch (e) {
        console.log(`   Screenshot failed: ${e.message}`);
      }

    } catch (err) {
      console.log(`   Error: ${err.message}`);
      results.push({ symbol, timeframe, error: err.message });
    }

    // Save incrementally
    writeFileSync(join(OUTPUT_DIR, `results-${Date.now()}.json`), JSON.stringify(results, null, 2));
  }

  // ═══════════════════════ FINAL REPORT ═══════════════════════
  const valid = results.filter(r => !r.error && r.totalTrades > 0);

  console.log(`\n${'='.repeat(80)}`);
  console.log('FINAL BACKTEST RESULTS');
  console.log('='.repeat(80));
  console.log(`Valid: ${valid.length}/${results.length} symbols\n`);

  if (valid.length > 0) {
    console.log(`${'Symbol'.padEnd(22)} | Trades | WR%   | PF    | Sharpe | MaxDD% | NetProfit% | AvgTrade%`);
    console.log('-'.repeat(100));
    for (const r of valid) {
      const s = r.symbol.replace('BINANCE:', '');
      console.log(
        `${s.padEnd(22)} | ${String(r.totalTrades).padStart(6)} | ${((r.winRate||0)*100).toFixed(1).padStart(5)}% | ${(r.profitFactor||0).toFixed(2).padStart(5)} | ${(r.sharpeRatio||0).toFixed(2).padStart(6)} | ${((r.maxDrawdownPercent||0)*100).toFixed(1).padStart(5)}% | ${((r.netProfitPercent||0)*100).toFixed(1).padStart(9)}% | ${((r.avgTradePercent||0)*100).toFixed(2).padStart(8)}%`
      );
    }

    const n = valid.length;
    const aWR = valid.reduce((s,r)=>s+(r.winRate||0),0)/n * 100;
    const aPF = valid.reduce((s,r)=>s+(r.profitFactor||0),0)/n;
    const aSh = valid.reduce((s,r)=>s+(r.sharpeRatio||0),0)/n;
    const aDD = valid.reduce((s,r)=>s+(r.maxDrawdownPercent||0),0)/n * 100;
    const tot = valid.reduce((s,r)=>s+(r.totalTrades||0),0);

    console.log('-'.repeat(100));
    console.log(`${'AVERAGE'.padEnd(22)} | ${String(tot).padStart(6)} | ${aWR.toFixed(1).padStart(4)}% | ${aPF.toFixed(2).padStart(5)} | ${aSh.toFixed(2).padStart(6)} | ${aDD.toFixed(1).padStart(5)}%`);

    const sortedPF = [...valid].sort((a,b)=>(b.profitFactor||0)-(a.profitFactor||0));
    console.log(`\nBest PF:  ${sortedPF[0]?.symbol.replace('BINANCE:','')} (${sortedPF[0]?.profitFactor?.toFixed(2)})`);
    console.log(`Best WR:  ${[...valid].sort((a,b)=>(b.winRate||0)-(a.winRate||0))[0]?.symbol.replace('BINANCE:','')}`);
    console.log(`Worst DD: ${[...valid].sort((a,b)=>(b.maxDrawdownPercent||0)-(a.maxDrawdownPercent||0))[0]?.symbol.replace('BINANCE:','')}`);
  }

  const reportPath = join(OUTPUT_DIR, `final-report-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify({
    config: { timeframe, symbolCount: symbols.length },
    results,
    aggregate: valid.length > 0 ? {
      avgWinRate: valid.reduce((s,r)=>s+(r.winRate||0),0)/valid.length,
      avgProfitFactor: valid.reduce((s,r)=>s+(r.profitFactor||0),0)/valid.length,
      avgSharpe: valid.reduce((s,r)=>s+(r.sharpeRatio||0),0)/valid.length,
      avgMaxDD: valid.reduce((s,r)=>s+(r.maxDrawdownPercent||0),0)/valid.length,
      totalTrades: valid.reduce((s,r)=>s+(r.totalTrades||0),0),
    } : null,
  }, null, 2));

  console.log(`\nReport: ${reportPath}`);

  await client.close();
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
