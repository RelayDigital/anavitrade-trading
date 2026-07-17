import assert from "node:assert/strict";
import test from "node:test";
import { setDbEnv } from "../db";
import { decideExecution, type PrefetchedUserData, type TradeIntentInput } from "./riskEngine";

const now = Date.now();

setDbEnv({
  DB: {
    prepare: () => ({
      bind() { return this; },
      all: async () => ({ results: [] }),
      raw: async () => [],
    }),
  },
} as any);

const intent: TradeIntentInput = {
  id: 1,
  symbol: "BTCUSDT",
  side: "BUY",
  orderType: "MARKET",
  requestedNotionalUsd: "100",
};

const connection = {
  id: 1,
  status: "active" as const,
  copytradeEnabled: true,
  killSwitchActive: false,
  consecutiveLosses: 0,
  circuitBreakerUntil: null,
  highWaterMark: null,
};

function prefetched(latestNav: { accountEquityUsd: string; snapshotAt: number } | null, openJobs: Array<{ notionalUsd: string | null }> = []): PrefetchedUserData {
  return {
    accounts: new Map([[1, {
      userId: 1,
      status: "active",
      killSwitchActive: false,
      maxLeverage: "10",
      maxPositionSizePct: "10",
      maxDailyLossPct: "5",
      maxTotalExposurePct: "25",
    } as any]]),
    navSnapshotsToday: new Map([[1, latestNav ? [latestNav as any] : []]]),
    openJobs: new Map([[1, openJobs]]),
    latestNav: new Map([[1, latestNav as any]]),
  };
}

test("automated execution fails closed when the latest NAV is absent, stale, invalid, or non-positive", async () => {
  const cases: Array<[string, { accountEquityUsd: string; snapshotAt: number } | null, string]> = [
    ["absent", null, "missing_nav"],
    ["stale", { accountEquityUsd: "1000", snapshotAt: now - 300_001 }, "stale_nav"],
    ["invalid", { accountEquityUsd: "NaN", snapshotAt: now }, "invalid_nav"],
    ["non-positive", { accountEquityUsd: "0", snapshotAt: now }, "non_positive_nav"],
  ];

  for (const [name, nav, reason] of cases) {
    const decision = await decideExecution(intent, 1, connection, prefetched(nav));
    assert.deepEqual(decision, { approved: false, reason }, name);
  }
});

test("leased and submitted jobs count toward portfolio exposure", async () => {
  const decision = await decideExecution(intent, 1, connection, prefetched(
    { accountEquityUsd: "1000", snapshotAt: now },
    [{ notionalUsd: "50" }, { notionalUsd: "200" }],
  ));

  assert.equal(decision.approved, false);
  assert.match(decision.reason, /^exposure_cap:/);
});
