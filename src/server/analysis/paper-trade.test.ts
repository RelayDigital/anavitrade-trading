import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePaperOutcome } from "./paper-trade";

const candles = (rows: Array<[number, number, number]>) => rows.map(([high, low, close], index) => ({
  openTime: 1_000 + index * 60_000,
  high,
  low,
  close,
}));

test("paper outcome uses conservative stop-first handling for an ambiguous candle", () => {
  const result = evaluatePaperOutcome({
    direction: "long",
    entry: 100,
    stopLoss: 90,
    takeProfit: 130,
    candles: candles([[131, 89, 110]]),
  });

  assert.equal(result?.status, "stop");
  assert.ok((result?.outcomeR ?? 0) < -1);
});

test("paper outcome records the configured target in R after costs", () => {
  const result = evaluatePaperOutcome({
    direction: "short",
    entry: 100,
    stopLoss: 110,
    takeProfit: 70,
    candles: candles([[105, 69, 75]]),
  });

  assert.equal(result?.status, "target");
  assert.equal(result?.grossOutcomeR, 3);
  assert.ok((result?.outcomeR ?? 0) < 3);
});

test("paper outcome marks a horizon close-to-market result when no bracket level is touched", () => {
  const result = evaluatePaperOutcome({
    direction: "long",
    entry: 100,
    stopLoss: 90,
    takeProfit: 130,
    candles: candles([[105, 97, 104], [108, 99, 106]]),
  });

  assert.equal(result?.status, "time");
  assert.ok((result?.grossOutcomeR ?? 0) > 0);
});
