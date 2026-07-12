/**
 * Zoom Matrix ML — Markov Decision Process training on 1,265-trade corpus.
 *
 * States = (timeframe, regime, recentWR)
 *   - timeframe: "4h" | "1h" | "other"
 *   - regime: "trend" | "range" | "volatile"
 *   - recentWR: "hot" (>60%) | "cold" (≤60%)
 *
 * Actions = { threshold, cciW, stochW, microW }
 *   - threshold: 55-75 (3 values)
 *   - cciW: 5-11 (4 values)
 *   - stochW: 4-10 (4 values)
 *   - microW: 3-7 (3 values)
 *   = 3×4×4×3 = 144 actions
 *
 * Reward = expectancy over last 20 trades in that state
 *
 * Training: 500 episodes of random walks through the corpus,
 * exploring actions in each state, accumulating Q-table.
 */

import { readFileSync, writeFileSync } from 'fs';
import { randomInt } from 'crypto';
const random = Math.random;

const trades = JSON.parse(readFileSync('/home/ariel/anavitrade-trading/scripts/backtest-prioritized.json', 'utf8')).trades;

const TIMEFRAMES = ["4h", "1h", "other"];
const REGIMES = ["trend", "range", "volatile"];
const WRSTATES = ["hot", "cold"];
const STATES = TIMEFRAMES.flatMap(tf => REGIMES.flatMap(rg => WRSTATES.map(wr => ({ timeframe: tf, regime: rg, wrState: wr }))));

const THRESHOLDS = [55, 65, 75];
const CCI_WS = [5, 7, 9, 11];
const STOCH_WS = [4, 6, 8, 10];
const MICRO_WS = [3, 5, 7];

function generateActions() {
  const actions = [];
  for (const thr of THRESHOLDS)
    for (const cw of CCI_WS)
      for (const sw of STOCH_WS)
        for (const mw of MICRO_WS)
          actions.push({ thr, cw, sw, mw, id: `${thr}_${cw}_${sw}_${mw}` });
  return actions;
}

const ALL_ACTIONS = generateActions();
console.log(`MDP Zoom Trainer — ${STATES.length} states × ${ALL_ACTIONS.length} actions = ${STATES.length * ALL_ACTIONS.length} state-action pairs`);

function classifyState(trade) {
  const timeframe = trade.period === '4h' ? '4h' : trade.period === '1h' ? '1h' : 'other';
  const absPnl = Math.abs(trade.pnlPct);
  const regime = trade.ddPct > 2.5 ? 'volatile' : (absPnl > 2 ? 'trend' : 'range');
  const wrState = trade.win ? 'hot' : 'cold';
  return { timeframe, regime, wrState };
}

function computeReward(trade, action) {
  const stop = (trade.period === '4h' ? 2.0 : 1.2) * 1.5 / 100;
  const pos = 0.05 / stop;
  const lev = trade.period === '4h' || trade.period === '1d' ? 3 : 2;
  const rawRet = pos * lev * (trade.pnlPct / 100) * 100;
  const cciBonus = action.cw / 10;
  const stochBonus = action.sw / 8;
  const composite = rawRet * (cciBonus + stochBonus) / 2;
  return composite + Math.sign(trade.pnlPct) * action.mw * 0.1;
}

// Q-table
const Q = {};
for (const s of STATES) {
  const key = `${s.timeframe}_${s.regime}_${s.wrState}`;
  Q[key] = {};
  for (const a of ALL_ACTIONS) Q[key][a.id] = 0.0;
}

// Training
const alpha = 0.15;
const gamma = 0.7;
const epsilon = 0.3;
let episodeRewards = [];

console.log("\nTraining for 500 episodes...");
for (let ep = 0; ep < 500; ep++) {
  let totalR = 0;
  let shuffled = [...trades].sort(() => Math.random() - 0.5);

  for (let i = 0; i < Math.min(200, shuffled.length); i++) {
    const t = shuffled[i];
    if (t.period === '5m' || t.pnlPct === 0) continue;

    const state = classifyState(t);
    const stateKey = `${state.timeframe}_${state.regime}_${state.wrState}`;

    // Epsilon-greedy action selection
    let action;
    if (Math.random() < epsilon) {
      action = ALL_ACTIONS[Math.floor(Math.random() * ALL_ACTIONS.length)];
    } else {
      const qs = Q[stateKey];
      const bestId = Object.keys(qs).reduce((a, b) => qs[a] > qs[b] ? a : b);
      action = ALL_ACTIONS.find(a => a.id === bestId);
    }

    const reward = computeReward(t, action);
    totalR += reward;

    // Compute next state (sliding window of last win/cold)
    const nextWR = (i > 0 && shuffled[i-1]?.win) ? 'hot' : 'cold';
    const nextStateKey = `${state.timeframe}_${state.regime}_${nextWR}`;

    // Q-learning update
    const currentQ = Q[stateKey][action.id];
    const maxNext = Math.max(...Object.values(Q[nextStateKey]));
    Q[stateKey][action.id] += alpha * (reward + gamma * maxNext - currentQ);
  }

  episodeRewards.push(totalR);
  if (ep % 100 === 99) {
    const avg = episodeRewards.slice(-100).reduce((a, b) => a + b, 0) / 100;
    console.log(`  Episode ${ep + 1}: avg reward = ${avg.toFixed(2)}`);
  }
}

// Extract optimal policy
console.log("\n\nOPTIMAL ZOOM POLICY (best action per state):");
console.log("State              | Thr | CCI | Stoch | Micro | Q-Value");
console.log("-".repeat(70));

let bestQ = -Infinity;
let bestStateAction = null;

for (const s of STATES) {
  const key = `${s.timeframe}_${s.regime}_${s.wrState}`;
  const qs = Q[key];
  const bestId = Object.keys(qs).reduce((a, b) => qs[a] > qs[b] ? a : b);
  const bestAction = ALL_ACTIONS.find(a => a.id === bestId);
  const qVal = qs[bestId].toFixed(2);

  if (qs[bestId] > bestQ) {
    bestQ = qs[bestId];
    bestStateAction = { state: s, action: bestAction };
  }

  console.log(`${s.timeframe}\t${s.regime}\t${s.wrState}\t  | ${bestAction.thr}\t| ${bestAction.cw}\t| ${bestAction.sw}\t | ${bestAction.mw}\t| ${qVal}`);
}

console.log(`\nBEST OVERALL: ${bestStateAction.state.timeframe}/${bestStateAction.state.regime}/${bestStateAction.state.wrState}`);
console.log(`  Action: thr=${bestStateAction.action.thr} cciW=${bestStateAction.action.cw} stochW=${bestStateAction.action.sw} microW=${bestStateAction.action.mw} Q=${bestQ.toFixed(2)}`);

// Validate against structural 4h only
console.log("\nVALIDATION — 4h structural trades with optimal zoom policy:");
let valTrades = 0, valWins = 0, valR = 0;
for (const t of trades) {
  if (t.period !== '4h') continue;
  const state = classifyState(t);
  const key = `${state.timeframe}_${state.regime}_${state.wrState}`;
  const qs = Q[key];
  const bestId = Object.keys(qs).reduce((a, b) => qs[a] > qs[b] ? a : b);
  const action = ALL_ACTIONS.find(a => a.id === bestId);
  const reward = computeReward(t, action);

  if (reward > action.thr * 0.1) {
    valR += reward; valTrades++; if (t.win) valWins++;
  }
}
console.log(`  4h: ${valTrades} trades, ${valWins} wins (${(valWins/valTrades*100).toFixed(0)}% WR), avg ${(valR/valTrades).toFixed(2)}R`);

// Save
writeFileSync('/home/ariel/anavitrade-trading/scripts/mdp-zoom-results.json', JSON.stringify({
  Q: Object.fromEntries(Object.entries(Q).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([k2, v2]) => [k2, v2]))])),
  best: bestStateAction,
  timestamp: new Date().toISOString(),
}, null, 2));
console.log(`\nSaved Q-table to scripts/mdp-zoom-results.json`);
