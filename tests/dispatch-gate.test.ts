/**
 * Unit tests for the ordered dispatch gate (PRD R1.1 / R1.3).
 *
 * Run:  npx tsx tests/dispatch-gate.test.ts
 *
 * No test runner is configured in this repo (see package.json scripts, which
 * invoke plain node/tsx scripts), so these tests use node:assert and exit
 * non-zero on failure — matching the tests/*.mjs convention.
 */

import assert from "node:assert/strict";
import {
  evaluateDispatchGate,
  GATE_CONFIG,
  ML_THRESHOLD,
  ML_CONFIRM_THRESHOLD,
  computeAtrPct,
  computeRsi14,
  computeConfirmationPrice,
  isBullRegime,
  type GateInput,
} from "../src/server/signals/dispatch-gate.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    console.error(`  ✗ ${name}\n    ${e?.message}`);
    process.exitCode = 1;
  }
}

/** A fully-passing input; individual tests override one field at a time. */
function base(overrides: Partial<GateInput> = {}): GateInput {
  return {
    symbol: "SOLUSDT",
    direction: "long",
    tierScore: 85,
    atrPct4h: 3.5,
    rsi14: 50,
    bullRegime: true,
    mlScore: 0.9,
    mlThreshold: ML_THRESHOLD,
    mlUnreachable: false,
    marketDataAvailable: true,
    ...overrides,
  };
}

console.log("dispatch-gate: threshold sourced from model card =", ML_THRESHOLD);

/* ── Baseline ── */
test("passes when all gates clear (live, full size)", () => {
  const d = evaluateDispatchGate(base());
  assert.equal(d.approved, true);
  assert.equal(d.paperOnly, false);
  assert.equal(d.gateResult, "passed");
  assert.equal(d.sizeFactor, 1);
  assert.equal(d.entryMode, "market");
});

/* ── 1. Universe gate ── */
test("rejects majors (BTC/ETH/BNB) at the universe gate", () => {
  for (const sym of ["BTCUSDT", "ETHUSDT", "BNBUSDT", "btcusdt"]) {
    const d = evaluateDispatchGate(base({ symbol: sym }));
    assert.equal(d.approved, false);
    assert.equal(d.gateResult, "universe");
  }
});

test("rejects 4h ATR% below minimum at the universe gate", () => {
  const d = evaluateDispatchGate(base({ atrPct4h: GATE_CONFIG.minAtrPct4h - 0.01 }));
  assert.equal(d.gateResult, "universe");
});

test("universe gate precedes tier gate (major + low tier -> universe)", () => {
  const d = evaluateDispatchGate(base({ symbol: "ETHUSDT", tierScore: 10 }));
  assert.equal(d.gateResult, "universe");
});

/* ── R1.3 fail-closed ── */
test("fails closed to ml_unreachable when market data unavailable", () => {
  const d = evaluateDispatchGate(base({ marketDataAvailable: false }));
  assert.equal(d.approved, false);
  assert.equal(d.gateResult, "ml_unreachable");
});

test("majors still rejected as universe even without market data", () => {
  const d = evaluateDispatchGate(base({ symbol: "BTCUSDT", marketDataAvailable: false }));
  assert.equal(d.gateResult, "universe");
});

/* ── 2. Tier gate ── */
test("Tier A (>=80) proceeds past the tier gate", () => {
  const d = evaluateDispatchGate(base({ tierScore: 80 }));
  assert.equal(d.gateResult, "passed");
});

test("Tier B (65-79) is paper-only, not dispatched", () => {
  const d = evaluateDispatchGate(base({ tierScore: 70 }));
  assert.equal(d.approved, false);
  assert.equal(d.paperOnly, true);
  assert.equal(d.gateResult, "tier_b_paper");
});

test("Tier C (<65) is rejected", () => {
  const d = evaluateDispatchGate(base({ tierScore: 50 }));
  assert.equal(d.approved, false);
  assert.equal(d.paperOnly, false);
  assert.equal(d.gateResult, "tier_c_reject");
});

test("tier gate precedes rsi gate (tier B + extended rsi -> tier_b_paper)", () => {
  const d = evaluateDispatchGate(base({ tierScore: 70, rsi14: 90 }));
  assert.equal(d.gateResult, "tier_b_paper");
});

/* ── 3. RSI extension gate ── */
test("rejects long when RSI14 >= 70", () => {
  const d = evaluateDispatchGate(base({ direction: "long", rsi14: 70 }));
  assert.equal(d.gateResult, "rsi_extension");
});

test("rejects short when RSI14 <= 30", () => {
  const d = evaluateDispatchGate(base({ direction: "short", rsi14: 30 }));
  assert.equal(d.gateResult, "rsi_extension");
});

test("long with RSI just under 70 passes the rsi gate", () => {
  const d = evaluateDispatchGate(base({ direction: "long", rsi14: 69.9 }));
  assert.equal(d.gateResult, "passed");
});

test("short is unaffected by high RSI (only long is)", () => {
  const d = evaluateDispatchGate(base({ direction: "short", rsi14: 85 }));
  assert.equal(d.gateResult, "passed");
});

test("rsi gate precedes ml gate (extended rsi + good score -> rsi_extension)", () => {
  const d = evaluateDispatchGate(base({ rsi14: 75, mlScore: 0.99 }));
  assert.equal(d.gateResult, "rsi_extension");
});

/* ── 4. Regime gate (sizing only) ── */
test("long in non-bull regime gets half size (still approved)", () => {
  const d = evaluateDispatchGate(base({ direction: "long", bullRegime: false, rsi14: 40 }));
  assert.equal(d.approved, true);
  assert.equal(d.sizeFactor, GATE_CONFIG.regimeHalfSizeFactor);
});

test("long in bull regime gets full size", () => {
  const d = evaluateDispatchGate(base({ direction: "long", bullRegime: true }));
  assert.equal(d.sizeFactor, 1);
});

test("short keeps full size regardless of regime", () => {
  const d = evaluateDispatchGate(base({ direction: "short", bullRegime: false, rsi14: 50 }));
  assert.equal(d.approved, true);
  assert.equal(d.sizeFactor, 1);
});

/* ── 5. ML gate (fail closed) ── */
test("ml_unreachable when inference flagged unreachable", () => {
  const d = evaluateDispatchGate(base({ mlUnreachable: true }));
  assert.equal(d.gateResult, "ml_unreachable");
});

test("ml_unreachable when score is null", () => {
  const d = evaluateDispatchGate(base({ mlScore: null }));
  assert.equal(d.gateResult, "ml_unreachable");
});

test("rejects when score below threshold", () => {
  const d = evaluateDispatchGate(base({ mlScore: ML_THRESHOLD - 0.001 }));
  assert.equal(d.gateResult, "ml");
  assert.equal(d.approved, false);
});

/* ── Entry confirmation band (graduated conviction, ML → rules entry timing) ── */
test("score exactly at threshold is real edge but marginal -> limit_confirm, not market", () => {
  const d = evaluateDispatchGate(base({ mlScore: ML_THRESHOLD }));
  assert.equal(d.approved, true);
  assert.equal(d.gateResult, "passed_confirm");
  assert.equal(d.entryMode, "limit_confirm");
});

test("score just under the confirm threshold stays in the confirmation band", () => {
  const d = evaluateDispatchGate(base({ mlScore: ML_CONFIRM_THRESHOLD - 0.001 }));
  assert.equal(d.approved, true);
  assert.equal(d.gateResult, "passed_confirm");
  assert.equal(d.entryMode, "limit_confirm");
});

test("score at/above the confirm threshold dispatches at market (legacy behavior)", () => {
  const atThreshold = evaluateDispatchGate(base({ mlScore: ML_CONFIRM_THRESHOLD }));
  assert.equal(atThreshold.gateResult, "passed");
  assert.equal(atThreshold.entryMode, "market");

  const above = evaluateDispatchGate(base({ mlScore: 0.9 }));
  assert.equal(above.gateResult, "passed");
  assert.equal(above.entryMode, "market");
});

test("a custom mlConfirmThreshold overrides the default", () => {
  const d = evaluateDispatchGate(base({ mlScore: ML_THRESHOLD + 0.02, mlConfirmThreshold: ML_THRESHOLD + 0.01 }));
  assert.equal(d.gateResult, "passed");
  assert.equal(d.entryMode, "market");
});

test("computeConfirmationPrice: long entry pulls back toward the stop (strictly between)", () => {
  const price = computeConfirmationPrice(100, 90, "long");
  assert.ok(price > 90 && price < 100, `expected 90 < ${price} < 100`);
  assert.equal(computeConfirmationPrice(100, 90, "long", 0), 100);
  assert.equal(computeConfirmationPrice(100, 90, "long", 1), 90);
});

test("computeConfirmationPrice: short entry pulls back toward the stop (strictly between)", () => {
  const price = computeConfirmationPrice(100, 110, "short");
  assert.ok(price > 100 && price < 110, `expected 100 < ${price} < 110`);
  assert.equal(computeConfirmationPrice(100, 110, "short", 0), 100);
  assert.equal(computeConfirmationPrice(100, 110, "short", 1), 110);
});

/* ── Indicator helpers ── */
test("computeRsi14: monotonic rising series -> RSI 100", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(computeRsi14(closes), 100);
});

test("computeRsi14: insufficient data -> neutral 50", () => {
  assert.equal(computeRsi14([1, 2, 3]), 50);
});

test("computeAtrPct: positive for volatile series, 0 when insufficient", () => {
  const highs: number[] = [], lows: number[] = [], closes: number[] = [];
  for (let i = 0; i < 30; i++) {
    const base = 100 + i;
    highs.push(base + 3); lows.push(base - 3); closes.push(base);
  }
  assert.ok(computeAtrPct(highs, lows, closes) > 0);
  assert.equal(computeAtrPct([1], [1], [1]), 0);
});

test("isBullRegime: rising series bull, falling series not", () => {
  const rising = Array.from({ length: 220 }, (_, i) => 100 + i);
  const falling = Array.from({ length: 220 }, (_, i) => 1000 - i);
  assert.equal(isBullRegime(rising), true);
  assert.equal(isBullRegime(falling), false);
  assert.equal(isBullRegime([1, 2, 3]), false); // insufficient data
});

/* ── 5. Judgment gate bypass (temporary kill switch, 2026-07-20) ── */
test("judgmentGateEnabled=false: dispatches on tier/structural quality alone, no ML score needed", () => {
  const d = evaluateDispatchGate(
    base({ judgmentGateEnabled: false, mlScore: null, mlUnreachable: true }),
  );
  assert.equal(d.approved, true);
  assert.equal(d.paperOnly, false);
  assert.equal(d.gateResult, "passed_no_judgment");
  assert.equal(d.entryMode, "market");
});

test("judgmentGateEnabled=false: still respects sizeFactor from the regime gate", () => {
  const d = evaluateDispatchGate(
    base({ judgmentGateEnabled: false, bullRegime: false, mlScore: null, mlUnreachable: true }),
  );
  assert.equal(d.approved, true);
  assert.equal(d.sizeFactor, GATE_CONFIG.regimeHalfSizeFactor);
});

test("judgmentGateEnabled=false: universe/tier/RSI gates still reject before reaching the bypass", () => {
  const majors = evaluateDispatchGate(base({ judgmentGateEnabled: false, symbol: "BTCUSDT" }));
  assert.equal(majors.gateResult, "universe");

  const tierC = evaluateDispatchGate(base({ judgmentGateEnabled: false, tierScore: 10 }));
  assert.equal(tierC.gateResult, "tier_c_reject");

  const extended = evaluateDispatchGate(
    base({ judgmentGateEnabled: false, rsi14: GATE_CONFIG.rsiMax }),
  );
  assert.equal(extended.gateResult, "rsi_extension");
});

test("judgmentGateEnabled undefined (default): mandatory ML/judgment gate unaffected", () => {
  // Every prior test in this file omits judgmentGateEnabled and still requires
  // a passing mlScore — this just makes the default explicit and pinned.
  const d = evaluateDispatchGate(base({ mlScore: null, mlUnreachable: true }));
  assert.equal(d.approved, false);
  assert.equal(d.gateResult, "ml_unreachable");
});

console.log(`\ndispatch-gate: ${passed} assertions passed${process.exitCode ? " (with failures)" : ""}`);
