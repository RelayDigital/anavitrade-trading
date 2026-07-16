// Quick inject + compile Pine Script v4.0 into TradingView
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';

(async () => {
  const targets = await CDP.List({ port: 9222 });
  const page = targets.find(t => t.type === 'page' && t.title.includes('TradingView'));
  const client = await CDP({ target: page.id, port: 9222 });
  await client.Runtime.enable();

  const source = readFileSync('/home/ariel/anavitrade-trading/scripts/icr-smc-engine.pine', 'utf8');
  const escaped = JSON.stringify(source);

  // Inject v4.0
  const { result } = await client.Runtime.evaluate({
    expression: `(function() {
      var container = document.querySelector('.monaco-editor.pine-editor-monaco');
      if (!container) return {error:'no_monaco'};
      var el = container, fiberKey;
      for (var i = 0; i < 20; i++) { if (!el) break; fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); }); if (fiberKey) break; el = el.parentElement; }
      if (!fiberKey) return {error:'no_fiber'};
      var current = el[fiberKey];
      for (var d = 0; d < 15; d++) {
        if (!current) break;
        if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
          var editors = current.memoizedProps.value.monacoEnv.editor.getEditors();
          if (editors.length > 0) { editors[0].getModel().setValue(${escaped}); return {success:true,lines:${source.split('\n').length}}; }
        }
        current = current.return;
      }
      return {error:'no_editor'};
    })()`,
    returnByValue: true,
  });
  console.log('Inject:', JSON.stringify(result.value));

  // Compile
  await new Promise(r => setTimeout(r, 500));
  await client.Runtime.evaluate({
    expression: `(function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var t = btns[i].textContent.trim();
        if (/^add to chart$/i.test(t) || /^update on chart$/i.test(t) || /save and add/i.test(t)) { btns[i].click(); return 'clicked'; }
      }
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      return 'ctrl_enter';
    })()`,
    returnByValue: true,
  });

  await new Promise(r => setTimeout(r, 4000));

  // Check errors
  const errs = await client.Runtime.evaluate({
    expression: `(function() {
      var container = document.querySelector('.monaco-editor.pine-editor-monaco');
      if (!container) return [];
      var el = container, fiberKey;
      for (var i = 0; i < 20; i++) { if (!el) break; fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); }); if (fiberKey) break; el = el.parentElement; }
      if (!fiberKey) return [];
      var current = el[fiberKey];
      for (var d = 0; d < 15; d++) {
        if (!current) break;
        if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
          var env = current.memoizedProps.value.monacoEnv;
          var editors = env.editor.getEditors();
          if (editors.length > 0) {
            var model = editors[0].getModel();
            if (model) return env.editor.getModelMarkers({ resource: model.uri }).map(function(m) { return {line:m.startLineNumber,msg:m.message,sev:m.severity}; });
          }
        }
        current = current.return;
      }
      return [];
    })()`,
    returnByValue: true,
  });

  const markers = errs.result?.value || [];
  const errors = markers.filter(m => m.sev === 8);
  console.log('Markers:', markers.length, '| Errors:', errors.length);
  errors.slice(0,10).forEach(e => console.log('  L' + e.line + ': ' + e.msg));

  await client.close();
})();
