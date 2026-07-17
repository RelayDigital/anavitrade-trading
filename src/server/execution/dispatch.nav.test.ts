import assert from "node:assert/strict";
import test from "node:test";
import { refreshCexNavBeforeAutomatedDispatch } from "./dispatch";

const connection = (userId: number, exchange = "binance") => ({ userId, exchange });

test("automated CEX dispatch refreshes NAV once per user after capability checks and denies every connection for a failed user", async () => {
  const events: string[] = [];
  const readiness = await refreshCexNavBeforeAutomatedDispatch([
    connection(1),
    connection(1),
    connection(2),
  ], {
    assertAutomatedExecution: (exchange, environment) => {
      events.push(`assert:${exchange}:${environment}`);
    },
    refreshNav: async (userId) => {
      events.push(`refresh:${userId}`);
      if (userId === 2) throw new Error("CEX_NAV_REFRESH_CONNECTION_FAILED");
    },
  });

  assert.deepEqual([...readiness.readyUserIds], [1]);
  assert.equal(readiness.failures.get(2), "CEX_NAV_REFRESH_CONNECTION_FAILED");
  assert.deepEqual(events, [
    "assert:binance:production",
    "assert:binance:production",
    "refresh:1",
    "assert:binance:production",
    "refresh:2",
  ]);
});

test("an unsupported exchange is denied before automated dispatch can refresh credentials or create a client", async () => {
  let refreshCalls = 0;
  const readiness = await refreshCexNavBeforeAutomatedDispatch([connection(7, "unsupported")], {
    assertAutomatedExecution: () => { throw new Error("CEX_AUTOMATED_EXECUTION_UNSUPPORTED"); },
    refreshNav: async () => { refreshCalls += 1; },
  });

  assert.equal(refreshCalls, 0);
  assert.equal(readiness.failures.get(7), "CEX_AUTOMATED_EXECUTION_UNSUPPORTED");
});
