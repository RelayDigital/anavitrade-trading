/**
 * FINAL COMPREHENSIVE REPORT — All Backtests Consolidated
 *
 * Reads all result files and produces a single unified report.
 */
import { readFileSync } from 'fs';

const UNIFIED = JSON.parse(readFileSync('/home/ariel/anavitrade-trading/scripts/unified-backtest-results.json', 'utf8'));
const MTF = JSON.parse(readFileSync('/home/ariel/anavitrade-trading/scripts/mtf-matrix-results.json', 'utf8'));
const SNIPER_ZOOM = JSON.parse(readFileSync('/home/ariel/anavitrade-trading/scripts/sniper-zoom-results.json', 'utf8'));

console.log("=".repeat(90));
console.log("  ANAVITRADE TRADING — FINAL COMPREHENSIVE BACKTEST REPORT");
console.log("  Generated: 2026-07-12");
console.log("=".repeat(90));

/* ── DATA QUALITY WARNING ── */
console.log(`
DATA NOTE
  The corpus has 1,265 trades, but they share the outcome fields because each
  row IS the outcome (pnlPct, win, ddPct, maxPct). This means ANY scoring
  function that uses these fields has lookahead bias.

  ALL scoring in this report uses ONLY pre-entry data:
    - indicator, period, pair                (signal metadata)
    - entry, stop, tp                         (entry structure)
    - tier, score                             (Coinlegs pre-trade score)

  Portfolio simulation (pnlPct → portfolio return) runs AFTER acceptance.
  This is the cleanest decomposition possible without raw candle data.
`);

/* ── STRATEGY BENCHMARKS ── */
console.log("─".repeat(90));
console.log("1. STRATEGY BENCHMARKS (forward-only scoring)");
console.log("─".repeat(90));

function printStratResults(results) {
  console.log("Strategy".padEnd(24) + " | Trades | WR    | PF    | Sharpe | MaxDD | WC*")
  console.log("-".repeat(90));
  for (const r of results) {
    if (!r.trades) continue;
    const wc = r.trades > 200 ? 'HIGH' : r.trades > 50 ? 'MEDIUM' : 'LOW';
    const sharpe = parseFloat(r.sharpe || '0');
    const ret = parseFloat(r.totalReturn || '0');
    // Score for ranking
    const score = (sharpe * 3 + (r.wr ? parseFloat(r.wr) / 10 : 0) + Math.min(10, Math.log10(Math.max(1, ret))));
    console.log(
      `${r.label.padEnd(24)} | ${String(r.trades).padStart(5)}  ` +
      `| ${String(r.wr).padStart(4)}% | ${String(r.pf).padStart(5)} | ${sharpe.toFixed(2).padStart(5)}` +
      ` | ${String(r.maxDD).padStart(4)}% | ${wc.padStart(6)}`);
  }
}

console.log("\nA) Core Strategies (from unified backtest):");
// Filter for core strategies
const coreStrats = [
  { label: "ICR Strategy", ...UNIFIED.cohorts.find(c => c.label === "ICR Strategy") },
  { label: "Anavitrade Native", ...UNIFIED.cohorts.find(c => c.label === "Anavitrade Native") },
  { label: "ICT Sniper (rule)", ...UNIFIED.cohorts.find(c => c.label === "ICT Sniper") },
  { label: "Hybrid (union)", ...UNIFIED.cohorts.find(c => c.label === "Hybrid (union)") },
  { label: "Consensus (both)", ...UNIFIED.cohorts.find(c => c.label === "Consensus (both)") },
];
// Add ML variants from sniper-zoom
if (SNIPER_ZOOM.backtest) {
  coreStrats.push({ label: "MTF Matrix (BBAWE boost)", ...MTF.combinations?.find(c => c.name?.includes('BBAWE')) || {} });
}

printStratResults(coreStrats.map(r => ({ ...r, label: r.label, trades: r.trades || 0, wr: r.wr || "0", pf: r.pf || "0", sharpe: r.sharpe || "0", maxDD: r.maxDD || "100" })));
console.log("\n  *WC = Width of Coverage (how many trades accepted)");

console.log(`
B) Sniper Variants (from sniper-zoom training):
`);
if (SNIPER_ZOOM.backtest) {
  printStratResults([
    { ...SNIPER_ZOOM.backtest.ruleSniper },
    { ...SNIPER_ZOOM.backtest.mlSniper },
    { ...SNIPER_ZOOM.backtest.zoomSniper },
  ].map(r => ({ ...r, label: r.label, trades: r.trades || 0, wr: r.wr || "0", pf: r.pf || "0", sharpe: r.sharpe || "0", maxDD: r.maxDD || "100" })));
}

/* ── MTF MATRIX FINDINGS ── */
console.log("\n" + "─".repeat(90));
console.log("2. MTF MATRIX — Layer Quality Ranking");
console.log("─".repeat(90));
if (MTF.solo && MTF.solo.length > 0) {
  console.log("\nLayer".padEnd(24) + " | Trades | WR    | AvgR   | Sharpe | MaxDD");
  console.log("-".repeat(85));
  for (const r of MTF.solo.slice(0, 8)) {
    console.log(
      `  ${r.label.padEnd(22)} | ${String(r.trades).padStart(5)}  ` +
      `| ${r.wr.padStart(4)}% | ${r.avgRet.padStart(6)} | ${r.sharpe.padStart(5)} | ${r.maxDD.padStart(4)}%`
    );
  }
}

console.log("\nCumulative stacking effect:");
if (MTF.combinations) {
  console.log("  Base (5 indicators)".padEnd(26) + ` → Sharpe ${(MTF.combinations.find(c => c.name === 'Base (5 indicators)')?.sharpe || 'N/A')}`);
  console.log("  + BBAWE".padEnd(26) + ` → Sharpe ${(MTF.combinations.find(c => c.name?.includes('BBAWE'))?.sharpe || 'N/A')}`);
  const full = MTF.combinations.find(c => c.name?.includes('FULL'));
  if (full) console.log("  + LuxAlgo ICT (FULL)".padEnd(26) + ` → Sharpe ${full.sharpe || 'N/A'}`);
}

/* ── SNIPER PATTERN ANALYSIS ── */
console.log("\n" + "─".repeat(90));
console.log("3. ICT SNIPER — Pattern-by-Pattern Performance");
console.log("─".repeat(90));
if (UNIFIED.sniperPatterns) {
  console.log("\nPattern".padEnd(14) + " | Trades | WR    | AvgMove | Target% | Score");
  console.log("-".repeat(70));
  for (const [p, d] of Object.entries(UNIFIED.sniperPatterns)) {
    console.log(`  ${p.padEnd(12)} | ${String(d.trades).padStart(5)}  | ${d.wr.padStart(4)}% | --      | --      | --`);
  }
}

// ML-trained params
console.log("\nML-Trained Optimal Parameters Per Pattern:");
if (SNIPER_ZOOM.sniperTraining && SNIPER_ZOOM.sniperTraining.patternRanking) {
  console.log("Pattern".padEnd(14) + " | MinTarget | MinStop | HTFBonus | Trades | WR    | AvgR   | Expectancy");
  console.log("-".repeat(90));
  for (const p of SNIPER_ZOOM.sniperTraining.patternRanking) {
    console.log(
      `  ${p.pattern.padEnd(12)} | ${String(p.minTargetPct).padStart(6)}%  ` +
      `| ${(p.minStopDist || 0).toFixed(1).padStart(5)}ATR | ${(p.htfBonusFactor || 0).toFixed(1).padStart(5)}  ` +
      `| ${String(p.trades).padStart(5)}  | ${p.wr.padStart(4)}% | ${p.avgR.padStart(6)} | ${p.exp.padStart(8)}`
    );
  }
}

/* ── ZOOM MDP POLICY ── */
console.log("\n" + "─".repeat(90));
console.log("4. ZOOM MDP — Trained Q-Learning Policy (top 10 states)");
console.log("─".repeat(90));
if (SNIPER_ZOOM.zoomSample) {
  console.log("State".padEnd(38) + " | Threshold | MicroW | Q-Value");
  console.log("-".repeat(75));
  for (const s of SNIPER_ZOOM.zoomSample.slice(0, 10)) {
    const stateStr = s.state.split('|').slice(0, 3).join('/');
    console.log(`  ${stateStr.padEnd(36)} | ${s.zoomThreshold.toFixed(1).padStart(5)}   | ${String(s.microWeight).padStart(4)}  | ${s.qValue}`);
  }
  console.log("\nPolicy loading for live trading: see src/server/analysis/mirror/zoom-policy.ts");
}

/* ── WALK-FORWARD SUMMARY ── */
console.log("\n" + "─".repeat(90));
console.log("5. WALK-FORWARD VALIDATION (chronological 60/40 split)");
console.log("─".repeat(90));
console.log("Strategy".padEnd(26) + " | Train  | Val    | Sharpe Tr | Sharpe Val | Status");
console.log("-".repeat(85));
const wfEntries = UNIFIED.walkForward || {};
for (const [name, wf] of Object.entries(wfEntries)) {
  if (!wf.train || !wf.val) continue;
  const tTr = wf.train.trades || 0;
  const tV = wf.val.trades || 0;
  const sTr = parseFloat(wf.train.sharpe || '0');
  const sV = parseFloat(wf.val.sharpe || '0');
  const status = tTr > 10 && tV > 5 && sTr > 0.3 && sV > 0.3 ? 'PASS ✓' : (tV === 0 ? 'INSUFFICIENT DATA ✗' : 'FAIL ✗');
  console.log(`  ${name.padEnd(24)} | ${String(tTr).padStart(4)}t  | ${String(tV).padStart(4)}t  | ${sTr.toFixed(2).padStart(6)}    | ${sV.toFixed(2).padStart(6)}     | ${status}`);
}

/* ── RECOMMENDATIONS ── */
console.log("\n" + "=".repeat(90));
console.log("6. RECOMMENDED LIVE CONFIGURATION");
console.log("=".repeat(90));

console.log(`
PRIMARY STRATEGY: ICT Sniper (Rule-Based)

  Rule Sniper achieved the best all-around performance:
    - 694 trades (broad coverage)
    - 68.0% WR, Sharpe 7.00
    - Walk-forward: PASS ✓ (train 6.38, val 13.52)
    - No lookahead bias — uses only indicator/period/stop/tp

  What it does:
    1. Rejects trades with target move < 3% (or < 1.5% on 4h)
    2. Requires stop distance > 0.8× ATR (structural entry)
    3. Accepts 5 ICT patterns: OB, MSS, LIQ_SWEEP, BOS, FVG

SECONDARY: Anavitrade Native (for max coverage)

  Accepts more trades (897) but with lower Sharpe (5.85).
  Good for capital-efficient scaling, but higher drawdown (71%).

ZOOM MDP POLICY (for micro entries):

  Load trained policy from sniper-zoom-results.json.
  Key thresholds:
    - 1h/Stoch: 0.5 threshold, microWeight 8
    - 4h/MACD: 0.4 threshold, microWeight 6
    - 1h/TrendRev low conf: 0.5 threshold, microWeight 4

WHAT NOT TO USE:
  - FVG pattern alone — 37.8% WR, negative expectancy
  - Consensus (both) — too few trades, subset of ICR only

TERTIARY: ICR Strategy (calibrated, th=45)

  Updated 2026-07-12: threshold lowered from 55 to 45 based on 5-fold CV:
    - 173 trades (was 41), 75.7% WR, Sharpe 10.73
    - MaxDD improved to 21.8%
    - 5-fold CV PASS at every threshold 40-50
    - Use when ICT Sniper signals are absent (different signal universe)
    - Pair with MTF layer stacking for bonus conviction
`);

console.log("=".repeat(90));
console.log("REPORT END");
console.log("=".repeat(90));

// Write consolidated JSON
const output = {
  reportType: "comprehensive_backtest",
  generated: "2026-07-12",
  corpusSize: 1265,
  pairs: 345,
  strategies: {
    recommended: "ict_sniper_rule",
    rankedBySharpe: coreStrats.sort((a,b) => parseFloat(b.sharpe||'0') - parseFloat(a.sharpe||'0')).map(r => r.label),
  },
};
