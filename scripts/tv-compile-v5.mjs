// DEPRECATED: Superseded by v6 (scripts/tv-deploy-v6.mjs) — has more robust CDP injection and compilation.
#!/usr/bin/env node
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';

const source = readFileSync('/home/ariel/anavitrade-trading/scripts/icr-smc-engine-v5.pine', 'utf8');
const escapedSource = JSON.stringify(source);

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const page = targets.find(t => t.type === 'page' && t.title.includes('TradingView'));
  const client = await CDP({ target: page.id, port: 9222 });
  await client.Runtime.enable();
  await client.Page.enable();

  // 1. Open Pine Editor
  console.log('1. Opening Pine Editor...');
  await client.Runtime.evaluate({
    expression: `(function(){
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (bwb && typeof bwb.activateScriptEditorTab === 'function') {
          bwb.activateScriptEditorTab();
        } else if (bwb && typeof bwb.showWidget === 'function') {
          bwb.showWidget('pine-editor');
        }
      } catch(e) {}
    })()`,
  });

  // 2. Wait for Monaco to become visible (poll up to 10s)
  console.log('2. Waiting for Monaco to render...');
  let monacoReady = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(r => setTimeout(r, 500));
    const check = await client.Runtime.evaluate({
      expression: `(function(){
        var c = document.querySelector('.monaco-editor.pine-editor-monaco');
        if (!c || !c.offsetParent) return false;
        // Check if monaco global exists and has models
        try {
          if (typeof monaco !== 'undefined' && monaco.editor && monaco.editor.getModels) {
            var models = monaco.editor.getModels();
            if (models.length > 0) return true;
          }
        } catch(e) {}
        // Try React fiber path
        var el = c, fiberKey = null;
        for (var i = 0; i < 20; i++) {
          if (!el) break;
          fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
          if (fiberKey) break;
          el = el.parentElement;
        }
        if (!fiberKey) return false;
        var cur = el[fiberKey];
        for (var d = 0; d < 20; d++) {
          if (!cur) break;
          if (cur.memoizedProps && cur.memoizedProps.value && cur.memoizedProps.value.monacoEnv) {
            return true;
          }
          cur = cur.return;
        }
        return false;
      })()`,
      returnByValue: true,
    });
    if (check.result?.value) {
      console.log('   Monaco ready at attempt ' + (attempt + 1));
      monacoReady = true;
      break;
    }
  }
  if (!monacoReady) {
    console.log('   Monaco not ready after 10s. Trying raw keypress injection...');
  }

  // 3. Inject source — try multiple methods
  console.log('3. Injecting source (' + source.split('\n').length + ' lines)...');
  let injected = false;

  // Method A: global monaco object
  const mA = await client.Runtime.evaluate({
    expression: `(function(){
      try {
        if (typeof monaco !== 'undefined' && monaco.editor && monaco.editor.getModels) {
          var models = monaco.editor.getModels();
          if (models.length > 0) {
            models[0].setValue(${escapedSource});
            return 'monaco_global';
          }
        }
      } catch(e) { return 'monaco_err: ' + e.message; }
      return 'no_monaco_global';
    })()`,
    returnByValue: true,
  });
  console.log('   A: ' + mA.result?.value);

  // Method B: React fiber walk
  const mB = await client.Runtime.evaluate({
    expression: `(function(){
      var container = document.querySelector('.monaco-editor.pine-editor-monaco');
      if (!container) return 'no_container';
      var el = container, fiberKey = null;
      for (var i = 0; i < 25; i++) {
        if (!el) break;
        fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
        if (fiberKey) break;
        el = el.parentElement;
      }
      if (!fiberKey) return 'no_fiber';
      var cur = el[fiberKey];
      for (var d = 0; d < 20; d++) {
        if (!cur) break;
        var mp = cur.memoizedProps;
        if (mp && mp.value && mp.value.monacoEnv && mp.value.monacoEnv.editor) {
          var eds = mp.value.monacoEnv.editor.getEditors();
          if (eds.length > 0) {
            eds[0].getModel().setValue(${escapedSource});
            return 'fiber_ok_d' + d;
          }
        }
        cur = cur.return;
      }
      return 'no_env';
    })()`,
    returnByValue: true,
  });
  console.log('   B: ' + mB.result?.value);

  // Method C: Use Window.pineEditor or similar
  const mC = await client.Runtime.evaluate({
    expression: `(function(){
      try {
        // Check various known TV internal objects
        for (var k of Object.keys(window)) {
          try {
            var v = window[k];
            if (v && typeof v === 'object' && typeof v.setSource === 'function') {
              v.setSource(${escapedSource});
              return 'setSource_' + k;
            }
          } catch(e) {}
        }
      } catch(e) {}
      return 'no_setSource';
    })()`,
    returnByValue: true,
  });
  console.log('   C: ' + mC.result?.value);

  if (mA.result?.value?.startsWith('monaco_global') || mB.result?.value?.startsWith('fiber_ok')) {
    injected = true;
  }

  // 4. If injection succeeded, save and compile
  if (injected) {
    // Save (Ctrl+S)
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 's', code: 'KeyS', ctrlKey: true });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS', ctrlKey: true });
    console.log('4. Ctrl+S sent');
    await new Promise(r => setTimeout(r, 2000));

    // Handle save dialog
    await client.Runtime.evaluate({
      expression: `(function(){
        var buttons = document.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent.trim() === 'Save' && buttons[i].offsetParent) {
            buttons[i].click(); return;
          }
        }
      })()`,
    });
    await new Promise(r => setTimeout(r, 1000));

    // Compile (Ctrl+Enter)
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', ctrlKey: true });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', ctrlKey: true });
    console.log('5. Ctrl+Enter sent (compile)');
    await new Promise(r => setTimeout(r, 5000));
  } else {
    // Direct approach: click into the editor, select all, delete, paste
    console.log('4. Using clipboard paste fallback...');

    // Click on the Monaco editor area to focus
    await client.Runtime.evaluate({
      expression: `(function(){
        var container = document.querySelector('.monaco-editor.pine-editor-monaco');
        if (container) {
          container.click();
          container.focus();
          return 'clicked';
        }
        return 'no_container';
      })()`,
    });
    await new Promise(r => setTimeout(r, 500));

    // Select all
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', ctrlKey: true });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', ctrlKey: true });
    await new Promise(r => setTimeout(r, 200));

    // Paste the source
    await client.Runtime.evaluate({
      expression: `(function(src){
        // Try to set clipboard and paste
        var textarea = document.querySelector('.monaco-editor textarea, .inputarea');
        if (textarea) {
          // Inject via the hidden textarea that Monaco listens to
          var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeInputValueSetter.call(textarea, src);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
          return 'textarea_set';
        }
        return 'no_textarea';
      })(${escapedSource})`,
      returnByValue: true,
    }).then(async r => {
      console.log('   Paste: ' + r.result?.value);
      if (r.result?.value === 'textarea_set') {
        // Compile
        await new Promise(r => setTimeout(r, 500));
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', ctrlKey: true });
        await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', ctrlKey: true });
        console.log('   Compile sent');
        await new Promise(r => setTimeout(r, 5000));
      }
    });
  }

  // 6. Check for compilation errors and strategy
  const markers = await client.Runtime.evaluate({
    expression: `(function(){
      try {
        if (typeof monaco !== 'undefined' && monaco.editor && monaco.editor.getModels) {
          var models = monaco.editor.getModels();
          if (models.length > 0) {
            return monaco.editor.getModelMarkers({ resource: models[0].uri }).map(function(mk) {
              return {line:mk.startLineNumber, msg:mk.message, sev:mk.severity};
            });
          }
        }
      } catch(e) {}
      return [];
    })()`,
    returnByValue: true,
  });

  const markerList = markers.result?.value || [];
  const errors = markerList.filter(m => m.sev === 8);
  const warnings = markerList.filter(m => m.sev === 4);
  console.log('\n6. Compilation: ' + errors.length + ' errors, ' + warnings.length + ' warnings');
  errors.slice(0, 10).forEach(e => console.log('   ❌ L' + e.line + ': ' + e.msg));
  if (errors.length === 0) console.log('   ✓ No compilation errors!');

  // 7. Check strategies on chart
  const strats = await client.Runtime.evaluate({
    expression: `(function(){
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      var strategies = [];
      for (var i = 0; i < sources.length; i++) {
        try {
          var rd = sources[i].reportData ? sources[i].reportData() : null;
          if (rd && typeof rd.value === 'function') rd = rd.value();
          if (rd && rd.performance) {
            var p = rd.performance, a = p.all || {};
            var mi = sources[i].metaInfo ? sources[i].metaInfo() : {};
            strategies.push({
              name: mi.description || mi.shortDescription || '?',
              pf: a.profitFactor, trades: (a.numberOfWiningTrades||0)+(a.numberOfLosingTrades||0),
              wr: a.percentProfitable, maxDD: p.maxStrategyDrawDownPercent
            });
          }
        } catch(e) {}
      }
      return strategies;
    })()`,
    returnByValue: true,
  });

  console.log('\n7. Strategies on chart:');
  (strats.result?.value || []).forEach(s => {
    console.log('   ' + s.name + ': ' + s.trades + ' trades, WR ' + (s.wr*100).toFixed(1) + '%, PF ' + s.pf?.toFixed(2));
  });

  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
