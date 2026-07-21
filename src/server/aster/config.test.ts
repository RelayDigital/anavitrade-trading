import assert from "node:assert/strict";
import test from "node:test";

import { parseAsterMaxOrderNotionalUsd, resolveAsterRegistrationSigningChainId } from "./config";

test("Aster tester notional cap accepts only positive finite values", () => {
  assert.equal(parseAsterMaxOrderNotionalUsd("100"), 100);
  assert.equal(parseAsterMaxOrderNotionalUsd("0"), 100);
  assert.equal(parseAsterMaxOrderNotionalUsd("-1"), 100);
  assert.equal(parseAsterMaxOrderNotionalUsd("not-a-number"), 100);
});

test("Aster registration signing chain follows the active activation mode", () => {
  assert.equal(resolveAsterRegistrationSigningChainId("production", true, 1666), 56);
  assert.equal(resolveAsterRegistrationSigningChainId("testnet", false, 714), 56);
  assert.equal(resolveAsterRegistrationSigningChainId("production", false, 1666), 1666);
});
