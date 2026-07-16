#!/usr/bin/env node
/**
 * Deploy v6 to TradingView using MCP's proven Pine Editor access.
 * This module directly imports the TV MCP core to access Monaco.
 */
import CDP from "chrome-remote-interface";
import { readFileSync } from "fs";

const SOURCE = readFileSync("/home/ariel/anavitrade-trading/scripts/icr-sniper-mtf-v6.pine", "utf8");
const ESC = JSON.stringify(SOURCE);

// --- Copied from TV MCP core/pine.js (FIND_MONACO expression) ---
const FIND_MONACO = `(function findMonacoEditor() {
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
})()`;

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const target = targets.find((p) => p.type === "page" && p.title.includes("TradingView"));
  if (!target) {
    console.error("No TradingView page found");
    process.exit(1);
  }
  const c = await CDP({ target: target.id, port: 9222 });
  await c.Runtime.enable();

  async function evalPage(expr, opts = {}) {
    const { result } = await c.Runtime.evaluate({
      expression: expr,
      returnByValue: true,
      ...opts,
    });
    if (result?.subtype === "error") throw new Error(result.description);
    return result?.value;
  }

  // 1. Open Pine Editor via bottom panel bar
  console.log("1. Opening Pine Editor...");
  const opened = await evalPage(`(function(){
    try {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (bwb && typeof bwb.showWidget === "function") {
        bwb.showWidget("pine-editor"); return "showWidget";
      }
      if (bwb && typeof bwb.activateScriptEditorTab === "function") {
        bwb.activateScriptEditorTab(); return "activateTab";
      }
    } catch(e) {}
    return "no_api";
  })()`);
  console.log("   " + opened);

  // 2. Poll for Monaco with the MCP fiber walk (up to 15s)
  console.log("2. Waiting for Monaco editor...");
  let monacoReady = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const m = await evalPage(`(function(){ return ${FIND_MONACO} !== null; })()`);
    if (m) {
      console.log("   ✓ Found at " + ((i + 1) * 0.5).toFixed(1) + "s");
      monacoReady = true;
      break;
    }
  }
  if (!monacoReady) {
    // Force display
    console.log("   Monaco not found. Forcing display...");
    await evalPage(`(function(){
      var all = document.querySelectorAll(".monaco-editor");
      all.forEach(function(m){ m.style.cssText="display:block!important;visibility:visible!important;opacity:1!important;height:600px!important;"; });
      return "forced " + all.length + " editors";
    })()`);
    await new Promise((r) => setTimeout(r, 1000));
    const m2 = await evalPage(`(function(){ return ${FIND_MONACO} !== null; })()`);
    if (m2) {
      monacoReady = true;
      console.log("   ✓ Found after force");
    } else {
      console.log("   ⚠ Still not found. Trying Alt+P as last resort...");
      await c.Input.dispatchKeyEvent({ type: "keyDown", key: "p", code: "KeyP", altKey: true });
      await c.Input.dispatchKeyEvent({ type: "keyUp", key: "p", code: "KeyP", altKey: true });
      await new Promise((r) => setTimeout(r, 3000));
      const m3 = await evalPage(`(function(){ return ${FIND_MONACO} !== null; })()`);
      if (m3) {
        console.log("   ✓ Found after Alt+P");
        monacoReady = true;
      }
    }
  }

  // 3. Inject source via Monaco model
  if (monacoReady) {
    console.log("3. Injecting source (" + SOURCE.split("\n").length + " lines)...");
    const injected = await evalPage(`(function(){
      var m = ${FIND_MONACO};
      if (!m) return "no_monaco";
      try {
        m.editor.getModel().setValue(${ESC});
        return "injected";
      } catch(e) { return "err:" + e.message; }
    })()`);
    console.log("   " + injected);

    // 4. Save
    console.log("4. Saving...");
    await c.Input.dispatchKeyEvent({ type: "keyDown", key: "s", code: "KeyS", ctrlKey: true });
    await c.Input.dispatchKeyEvent({ type: "keyUp", key: "s", code: "KeyS", ctrlKey: true });
    await new Promise((r) => setTimeout(r, 2000));

    // Handle save dialog
    await evalPage(`(function(){
      var btns = document.querySelectorAll("button");
      for (var i=0;i<btns.length;i++) {
        if (btns[i].textContent.trim() === "Save" && btns[i].offsetParent) { btns[i].click(); return; }
      }
    })()`);
    await new Promise((r) => setTimeout(r, 1000));

    // 5. Compile
    console.log("5. Compiling...");
    await c.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", code: "Enter", ctrlKey: true });
    await c.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", ctrlKey: true });
    await new Promise((r) => setTimeout(r, 5000));

    // 6. Check errors
    const errors = await evalPage(`(function(){
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      return m.env.editor.getModelMarkers({ resource: model.uri }).map(function(mk) {
        return { line: mk.startLineNumber, msg: mk.message, sev: mk.severity };
      });
    })()`);
    console.log("6. Compilation: " + (errors || []).length + " markers");
    const compileErrors = (errors || []).filter((e) => e.sev === 8);
    compileErrors.slice(0, 10).forEach((e) => console.log("   ❌ L" + e.line + ": " + e.msg));
    if (compileErrors.length === 0) console.log("   ✓ No errors!");

    // 7. Check strategy on chart
    const strats = await evalPage(`(function(){
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var ss = chart.model().model().dataSources();
      var result = [];
      for(var i=0;i<ss.length;i++){
        try{
          var rd=ss[i].reportData(); if(rd&&typeof rd.value==="function")rd=rd.value();
          if(rd&&rd.performance){
            var a=rd.performance.all||{}, mi=ss[i].metaInfo();
            result.push({name:mi?.description||"?",trades:(a.numberOfWiningTrades||0)+(a.numberOfLosingTrades||0),pf:a.profitFactor});
          }
        } catch(e) {}
      }
      return result;
    })()`);
    console.log("7. Chart: " + JSON.stringify(strats));
  }

  await c.close();
  console.log("\n✓ Done");
}

main().catch((e) => { console.error(e); process.exit(1); });
