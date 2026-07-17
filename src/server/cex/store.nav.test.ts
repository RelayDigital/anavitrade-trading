import assert from "node:assert/strict";
import test from "node:test";
import {
  CexNavRefreshError,
  refreshCexNavSnapshot,
} from "./store";

const activeConnection = (id: number, exchange = "binance") => ({
  id,
  exchange,
  label: `${exchange}-${id}`,
  killSwitchActive: false,
});

test("a complete unified CEX refresh persists one provider-synced NAV and matching live-account cache", async () => {
  const persisted: Array<Record<string, unknown>> = [];
  const result = await refreshCexNavSnapshot(42, {
    dependencies: {
      loadActiveConnections: async () => [activeConnection(1), activeConnection(2)],
      readBalance: async (connection) => connection.id === 1
        ? { equityUsd: 100, availableUsd: 40 }
        : { equityUsd: 50, availableUsd: 10 },
      persist: async (snapshot) => { persisted.push(snapshot); },
    },
  });

  assert.equal(persisted.length, 1);
  assert.equal(result.totalEquityUsd, 150);
  assert.equal(result.totalAvailableUsd, 50);
  assert.deepEqual(persisted[0], {
    userId: 42,
    provider: "cex",
    source: "provider_sync",
    accountEquityUsd: "150.00",
    availableBalanceUsd: "50.00",
    snapshotAt: result.snapshotAt,
    linkedExchanges: [
      { exchange: "binance", label: "binance-1", error: false },
      { exchange: "binance", label: "binance-2", error: false },
    ],
    connectionEquities: [
      { connectionId: 1, equityUsd: "100.00" },
      { connectionId: 2, equityUsd: "50.00" },
    ],
  });
});

test("CEX NAV refresh fails closed without persisting a zero, partial, or invalid aggregate", async () => {
  const cases: Array<{
    name: string;
    connections: Array<ReturnType<typeof activeConnection>>;
    readBalance?: (connection: ReturnType<typeof activeConnection>) => Promise<{ equityUsd: number; availableUsd: number }>;
    code: string;
  }> = [
    { name: "no active connections", connections: [], code: "CEX_NAV_REFRESH_NO_ACTIVE_CONNECTIONS" },
    {
      name: "a failed active connection",
      connections: [activeConnection(1), activeConnection(2)],
      readBalance: async (connection) => {
        if (connection.id === 2) throw new Error("balance unavailable");
        return { equityUsd: 100, availableUsd: 50 };
      },
      code: "CEX_NAV_REFRESH_CONNECTION_FAILED",
    },
    {
      name: "non-finite totals",
      connections: [activeConnection(1)],
      readBalance: async () => ({ equityUsd: Number.POSITIVE_INFINITY, availableUsd: 50 }),
      code: "CEX_NAV_REFRESH_INVALID_TOTALS",
    },
    {
      name: "non-positive equity",
      connections: [activeConnection(1)],
      readBalance: async () => ({ equityUsd: 0, availableUsd: 0 }),
      code: "CEX_NAV_REFRESH_INVALID_TOTALS",
    },
  ];

  for (const scenario of cases) {
    let persisted = 0;
    await assert.rejects(
      refreshCexNavSnapshot(42, {
        dependencies: {
          loadActiveConnections: async () => scenario.connections,
          readBalance: scenario.readBalance ?? (async () => ({ equityUsd: 1, availableUsd: 1 })),
          persist: async () => { persisted += 1; },
        },
      }),
      (error: unknown) => error instanceof CexNavRefreshError && error.code === scenario.code,
      scenario.name,
    );
    assert.equal(persisted, 0, scenario.name);
  }
});
