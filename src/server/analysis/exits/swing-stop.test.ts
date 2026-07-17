/**
 * Unit tests for the swing-pivot initial stop — focus on the NO-LOOKAHEAD
 * confirmation lag. Run with:  npx tsx src/server/analysis/exits/swing-stop.test.ts
 */

import { test, report, assertEqual, assertOk } from "./test-harness";
import { computeSwingInitialStop } from "./swing-stop";
import { makeSeries } from "./test-candle-factory";

const CONFIG = { confirmationBars: 3, atrOffset: 0.2, lookback: 50 };

// A single, unambiguous swing low sits at index 3 (low = 5), with 3 strictly
// higher lows on each side. atr14 = 1 everywhere → offset = 0.2.
//   idx:   0   1   2   3    4   5   6   7
//   low:  10   9   8   5    8   9  10  10
function pivotSeries() {
  const lows = [10, 9, 8, 5, 8, 9, 10, 10];
  return makeSeries(
    lows.map((low) => ({ low, high: low + 20, close: low + 10, atr14: 1 })),
  );
}

test("swing low is NOT usable until confirmationBars have elapsed (no lookahead)", () => {
  const candles = pivotSeries();
  const entryPrice = 30; // above the pivot low (5) → protective/positive-risk

  // Entry at idx 5 = only 2 bars after the pivot at idx 3 → NOT yet confirmed.
  const early = computeSwingInitialStop(candles, 5, entryPrice, "long", CONFIG);
  assertEqual(
    early.method,
    "atr_fallback",
    "pivot must not be visible before its 3rd confirming bar",
  );
  assertEqual(early.pivotIdx, null);

  // Entry at idx 6 = exactly 3 bars after the pivot → now confirmed & usable.
  const ready = computeSwingInitialStop(candles, 6, entryPrice, "long", CONFIG);
  assertEqual(ready.method, "swing_pivot");
  assertEqual(ready.pivotIdx, 3);
});

test("long stop = nearest confirmed swing low − 0.2·ATR", () => {
  const candles = pivotSeries();
  const res = computeSwingInitialStop(candles, 6, 30, "long", CONFIG);
  // pivot low 5, atr 1, offset 0.2 → 5 − 0.2 = 4.8
  assertEqual(res.pivotPrice, 5);
  assertOk(Math.abs(res.stopPrice - 4.8) < 1e-9, `stop ${res.stopPrice}`);
  assertOk(res.stopPrice < 30, "stop below entry → positive risk");
});

test("short stop = nearest confirmed swing high + 0.2·ATR", () => {
  // Mirror: a single swing HIGH at idx 3 (high = 95).
  //   idx:    0   1   2   3    4   5   6   7
  //   high:  90  91  92  95   92  91  90  90
  const highs = [90, 91, 92, 95, 92, 91, 90, 90];
  const candles = makeSeries(
    highs.map((high) => ({ high, low: high - 20, close: high - 10, atr14: 1 })),
  );
  const res = computeSwingInitialStop(candles, 6, 70, "short", CONFIG);
  assertEqual(res.method, "swing_pivot");
  assertEqual(res.pivotIdx, 3);
  assertEqual(res.pivotPrice, 95);
  // 95 + 0.2·1 = 95.2
  assertOk(Math.abs(res.stopPrice - 95.2) < 1e-9, `stop ${res.stopPrice}`);
  assertOk(res.stopPrice > 70, "stop above entry → positive risk");
});

test("falls back to an ATR stop when no confirmed pivot is in range", () => {
  // Monotone lows → no local minimum → no pivot at all.
  const candles = makeSeries(
    [20, 19, 18, 17, 16, 15, 14].map((low) => ({
      low,
      high: low + 20,
      close: low + 10,
      atr14: 1,
    })),
  );
  const res = computeSwingInitialStop(candles, 6, 30, "long", CONFIG);
  assertEqual(res.method, "atr_fallback");
  assertOk(res.stopPrice < 30, "fallback stop still below entry");
});

report();
