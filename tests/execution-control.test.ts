import assert from "node:assert/strict";
import { resolveExecutionControl } from "../src/lib/executionControl";

const activeAster = resolveExecutionControl({
  asterConnected: true,
  web3Connected: true,
  asterKillSwitchActive: true,
  web3KillSwitchActive: false,
});

assert.deepEqual(activeAster, { target: "aster", killSwitchActive: true });

const walletOnly = resolveExecutionControl({
  asterConnected: false,
  web3Connected: true,
  asterKillSwitchActive: false,
  web3KillSwitchActive: true,
});

assert.deepEqual(walletOnly, { target: "web3", killSwitchActive: true });

console.log("EXECUTION_CONTROL_TEST_PASS");
