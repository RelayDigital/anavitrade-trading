/**
 * Unit tests for the runner exit policy (R1.2). Covers:
 *   - ratchet never loosens (long & short),
 *   - trail arms EXACTLY at +4R, never before,
 *   - no early-breakeven code path (stop stays at the swing stop until armed),
 *   - trail / stop / time exits and their realized R,
 *   - time exits booked as 0R LOSSES in metrics.
 *
 * Run with: npx tsx src/server/analysis/exits/runner-exit-policy.test.ts
 */

import { test, report, assertEqual, assertOk } from "./test-harness";
import {
  advanceRatchetTrail,
  initRatchet,
  simulateRunnerExit,
  summarizeRunnerExits,
  DEFAULT_RUNNER_EXIT_CONFIG,
  type RunnerExitConfig,
  type RunnerExitResult,
} from "./runner-exit-policy";
import { makeCandle, makeSeries } from "./test-candle-factory";

const ENTRY = 100;
const INITIAL_STOP = 90; // risk = 10
const RISK = ENTRY - INITIAL_STOP;
const CFG: RunnerExitConfig = { ...DEFAULT_RUNNER_EXIT_CONFIG }; // 5 ATR, arm@+4R, exh 0.7

// ── Ratchet: arming threshold + no early breakeven ──────────────────────────

test("ratchet arms EXACTLY at +4R and never moves the stop to breakeven before", () => {
  let state = initRatchet(ENTRY, INITIAL_STOP);

  // +3.0R — must NOT arm and must NOT touch the stop (no breakeven).
  state = advanceRatchetTrail(
    state,
    makeCandle({ high: 130, low: 130, close: 130, atr14: 2 }),
    ENTRY,
    RISK,
    "long",
    CFG,
  );
  assertEqual(state.armed, false, "+3R must not arm");
  assertEqual(state.stopPrice, INITIAL_STOP, "no BE: stop stays at swing stop");

  // +3.99R — still below the +4R arm threshold.
  state = advanceRatchetTrail(
    state,
    makeCandle({ high: 139.9, low: 139.9, close: 139.9, atr14: 2 }),
    ENTRY,
    RISK,
    "long",
    CFG,
  );
  assertEqual(state.armed, false, "+3.99R must not arm");
  assertEqual(state.stopPrice, INITIAL_STOP, "still no BE before arming");

  // +4.0R exactly — arms now.
  state = advanceRatchetTrail(
    state,
    makeCandle({ high: 140, low: 140, close: 140, atr14: 2 }),
    ENTRY,
    RISK,
    "long",
    CFG,
  );
  assertEqual(state.armed, true, "+4R arms the trail");
  // extreme 140, 5·ATR(2) = 10 → 130; min(130, close 140) = 130.
  assertOk(Math.abs(state.stopPrice - 130) < 1e-9, `stop ${state.stopPrice}`);
});

test("long ratchet never loosens across new highs and pullbacks", () => {
  let state = initRatchet(ENTRY, INITIAL_STOP);
  const bars = [
    { high: 140, low: 140, close: 140, atr14: 2 }, // arms → 130
    { high: 145, low: 145, close: 145, atr14: 2 }, // → 135
    { high: 145, low: 141, close: 142, atr14: 2 }, // no new high, pullback
    { high: 143, low: 141, close: 143, atr14: 2 }, // lower high
  ];
  let prev = state.stopPrice;
  for (const b of bars) {
    state = advanceRatchetTrail(state, makeCandle(b), ENTRY, RISK, "long", CFG);
    assertOk(
      state.stopPrice >= prev - 1e-9,
      `stop loosened: ${state.stopPrice} < ${prev}`,
    );
    prev = state.stopPrice;
  }
});

test("short ratchet never loosens (stop only moves down)", () => {
  const entry = 100;
  const initialStop = 110; // risk 10
  const risk = 10;
  let state = initRatchet(entry, initialStop);
  const bars = [
    { high: 60, low: 60, close: 60, atr14: 2 }, // favR (100-60)/10 = 4 → arms; 60+10=70
    { high: 55, low: 55, close: 55, atr14: 2 }, // → 65
    { high: 59, low: 55, close: 58, atr14: 2 }, // bounce, no new low
  ];
  let prev = state.stopPrice;
  for (const b of bars) {
    state = advanceRatchetTrail(state, makeCandle(b), entry, risk, "short", CFG);
    assertOk(
      state.stopPrice <= prev + 1e-9,
      `short stop loosened: ${state.stopPrice} > ${prev}`,
    );
    prev = state.stopPrice;
  }
});

// ── Full simulation: exit reasons + realized R ──────────────────────────────

test("big run then reversal → trail exit at a positive R", () => {
  const candles = makeSeries([
    { high: 101, low: 99, close: 100, atr14: 2 }, // idx0 entry bar
    { high: 120, low: 100, close: 120, atr14: 2 }, // +2R, not armed
    { high: 145, low: 136, close: 145, atr14: 2 }, // +4.5R arms → stop 135
    { high: 145, low: 142, close: 144, atr14: 2 }, // holds
    { high: 143, low: 130, close: 132, atr14: 2 }, // reversal → hits 135
  ]);
  const r = simulateRunnerExit(candles, 0, ENTRY, INITIAL_STOP, "long", CFG);
  assertEqual(r.exitReason, "trail");
  assertEqual(r.trailArmed, true);
  assertOk(r.realizedR > 0, `expected positive R, got ${r.realizedR}`);
  assertOk(Math.abs(r.realizedR - 3.5) < 1e-9, `R ${r.realizedR}`); // (135-100)/10
});

test("stop hit before the trail arms → reason 'stop', negative R", () => {
  const candles = makeSeries([
    { high: 101, low: 99, close: 100, atr14: 2 }, // idx0 entry bar
    { high: 105, low: 95, close: 100, atr14: 2 }, // +0.5R, not armed
    { high: 102, low: 88, close: 95, atr14: 2 }, // hits initial stop 90
  ]);
  const r = simulateRunnerExit(candles, 0, ENTRY, INITIAL_STOP, "long", CFG);
  assertEqual(r.exitReason, "stop");
  assertEqual(r.trailArmed, false);
  assertOk(Math.abs(r.realizedR - -1) < 1e-9, `R ${r.realizedR}`); // (90-100)/10
});

test("time cap reached with no trigger → reason 'time'", () => {
  const cfg: RunnerExitConfig = { ...CFG, maxBars: 3 };
  const candles = makeSeries([
    { high: 101, low: 99, close: 100, atr14: 2 }, // idx0 entry bar
    { high: 101, low: 99, close: 100, atr14: 2 },
    { high: 101, low: 99, close: 100, atr14: 2 },
    { high: 101, low: 99, close: 100, atr14: 2 }, // barsHeld 3 → time
  ]);
  const r = simulateRunnerExit(candles, 0, ENTRY, INITIAL_STOP, "long", cfg);
  assertEqual(r.exitReason, "time");
});

// ── Metrics: time exits are losses at 0R ────────────────────────────────────

function result(
  exitReason: RunnerExitResult["exitReason"],
  realizedR: number,
): RunnerExitResult {
  return {
    realizedR,
    barsHeld: 1,
    exitReason,
    trailArmed: exitReason === "trail",
    maxFavorableR: Math.max(0, realizedR),
    maxAdverseR: Math.min(0, realizedR),
    exitPrice: 0,
  };
}

test("summarizeRunnerExits books time exits as 0R losses", () => {
  const m = summarizeRunnerExits([
    result("trail", 5), // win +5
    result("stop", -1), // loss -1
    result("time", 2), // realized +2 but FORCED to 0R loss
  ]);
  assertEqual(m.trades, 3);
  assertEqual(m.wins, 1);
  assertEqual(m.losses, 2, "time exit counts as a loss");
  assertEqual(m.timeExits, 1);
  assertOk(Math.abs(m.totalR - 4) < 1e-9, `totalR ${m.totalR}`); // 5 - 1 + 0
  assertOk(Math.abs(m.winRate - 1 / 3) < 1e-9);
  assertOk(Math.abs(m.profitFactor - 5) < 1e-9, `PF ${m.profitFactor}`); // 5 / 1
});

report();
