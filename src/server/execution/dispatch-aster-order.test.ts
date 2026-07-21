import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAsterOrderValues } from "./dispatch";

const rules = {
  symbol: "DOGEUSDT",
  pricePrecision: 5,
  quantityPrecision: 0,
  tickSize: 0.00001,
  stepSize: 1,
  minQuantity: 1,
  minNotionalUsd: 5,
  multiplierDown: 0.9,
  multiplierUp: 1.1,
};

test("Aster automated order normalizes price and quantity to symbol rules", () => {
  const order = normalizeAsterOrderValues({
    notionalUsd: 6,
    referencePrice: 0.1234567,
    requestedLimitPrice: "0.1234567",
    side: "BUY",
    orderType: "LIMIT",
    rules,
  });
  assert.deepEqual(order, { quantity: "48", limitPrice: "0.12345", actualNotionalUsd: 5.9256 });
});

test("Aster automated order rejects a pilot notional below symbol minimum", () => {
  assert.equal(normalizeAsterOrderValues({
    notionalUsd: 4.99,
    referencePrice: 0.1,
    side: "BUY",
    orderType: "MARKET",
    rules,
  }), null);
});
