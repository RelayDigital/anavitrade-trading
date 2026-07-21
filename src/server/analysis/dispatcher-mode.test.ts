import assert from "node:assert/strict";
import test from "node:test";

import { isAutomatedSignalDispatchEnabled } from "./dispatcher";

test("automated signal dispatch is deny-by-default in production and testnet", () => {
  assert.equal(isAutomatedSignalDispatchEnabled({ APP_ENVIRONMENT: "production" }), false);
  assert.equal(isAutomatedSignalDispatchEnabled({ APP_ENVIRONMENT: "testnet" }), false);
  assert.equal(isAutomatedSignalDispatchEnabled({ APP_ENVIRONMENT: "testnet", AUTOMATED_SIGNAL_DISPATCH_ENABLED: "false" }), false);
});

test("automated signal dispatch requires an explicit enabled flag", () => {
  assert.equal(isAutomatedSignalDispatchEnabled({ APP_ENVIRONMENT: "testnet", AUTOMATED_SIGNAL_DISPATCH_ENABLED: "true" }), true);
  assert.equal(isAutomatedSignalDispatchEnabled({ APP_ENVIRONMENT: "production", AUTOMATED_SIGNAL_DISPATCH_ENABLED: "true" }), true);
});
