import assert from "node:assert/strict";
import test from "node:test";
import { parseExecutionMode, reconcileExactOrder, validateNavSnapshot } from "./outcomes";

test("execution mode parsing is strict", () => {
  assert.equal(parseExecutionMode("disabled"), "disabled");
  assert.equal(parseExecutionMode("testnet"), "testnet");
  assert.equal(parseExecutionMode("production"), "production");
  assert.throws(() => parseExecutionMode("prod"), /Unknown EXECUTION_MODE/);
  assert.throws(() => parseExecutionMode(""), /Unknown EXECUTION_MODE/);
});

test("NAV validation denies missing, invalid, non-positive, and stale values", () => {
  const now = 1_000_000;
  assert.equal(validateNavSnapshot(null, now).approved, false);
  assert.equal(validateNavSnapshot({ accountEquityUsd: "NaN", snapshotAt: now }, now).approved, false);
  assert.equal(validateNavSnapshot({ accountEquityUsd: "0", snapshotAt: now }, now).approved, false);
  assert.equal(validateNavSnapshot({ accountEquityUsd: "10", snapshotAt: now - 300_001 }, now).approved, false);
  assert.deepEqual(validateNavSnapshot({ accountEquityUsd: "10", snapshotAt: now }, now), {
    approved: true,
    equityUsd: 10,
  });
});

test("reconciliation uses exact IDs and never infers a fill from positions", async () => {
  let positionReads = 0;
  const unsupported = await reconcileExactOrder({
    getPositions: async () => { positionReads++; return [{ sizeSigned: 2 }]; },
  }, { symbol: "BTCUSDT", orderId: "42", clientOrderId: "client-42" });
  assert.deepEqual(unsupported, { status: "unresolved", reason: "exact_order_lookup_unsupported" });
  assert.equal(positionReads, 0);

  const matched = await reconcileExactOrder({
    getOrderByClientId: async (_symbol, id) => ({ orderId: "42", clientOrderId: id, status: "filled" }),
  }, { symbol: "BTCUSDT", clientOrderId: "client-42" });
  assert.equal(matched.status, "matched");
});
