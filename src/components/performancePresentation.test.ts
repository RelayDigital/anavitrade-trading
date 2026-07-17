import assert from "node:assert/strict";
import test from "node:test";

import {
  SCORING_PRESENTATION,
  formatSignedPercent,
  parseOptionalNumber,
  selectTopBuyMovers,
} from "./performancePresentation";

test("unknown performance values are unavailable", () => {
  for (const value of [null, undefined, "", "not-a-number", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatSignedPercent(value), "Unavailable");
  }
});

test("known zero performance is neutral rather than a positive result", () => {
  assert.equal(formatSignedPercent(0), "0.0%");
  assert.equal(formatSignedPercent("0.00", 2), "0.00%");
});

test("known signed percentages preserve their direction", () => {
  assert.equal(formatSignedPercent(3.456, 2), "+3.46%");
  assert.equal(formatSignedPercent(-2.5), "-2.5%");
});

test("optional numeric parsing does not turn missing values into zero", () => {
  assert.equal(parseOptionalNumber(null), null);
  assert.equal(parseOptionalNumber(""), null);
  assert.equal(parseOptionalNumber("12.5"), 12.5);
});

test("top movers are ranked as movement, not as winners or quality outcomes", () => {
  const signals = [
    { id: 1, signal: 1, percentage24: 2, qualityTier: "A" },
    { id: 2, signal: -1, percentage24: 12, qualityTier: "A" },
    { id: 3, signal: 1, percentage24: 7, qualityTier: "C" },
    { id: 4, signal: 1, percentage24: 4, qualityTier: "B" },
  ];

  assert.deepEqual(selectTopBuyMovers(signals, 3).map((signal) => signal.id), [3, 4, 1]);
});

test("scoring presentation matches the server scoring model", () => {
  assert.equal(SCORING_PRESENTATION.maxScore, 80);
  assert.deepEqual(SCORING_PRESENTATION.sections.map(({ points }) => points), [40, 25, 15]);
  assert.deepEqual(SCORING_PRESENTATION.tiers, [
    { tier: "A", minimum: 55 },
    { tier: "B", minimum: 40 },
    { tier: "C", minimum: 0 },
  ]);
});
