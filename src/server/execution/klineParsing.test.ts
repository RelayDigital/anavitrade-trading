import assert from "node:assert/strict";
import test from "node:test";
import { parseBinanceKlines } from "./server";
import * as executionServer from "./server";

test("parses valid Binance kline arrays into seed payloads", () => {
  assert.deepEqual(
    parseBinanceKlines("BTCUSDT", "4h", [[
      1_720_000_000_000,
      "60000.10",
      "61000.20",
      "59000.30",
      "60500.40",
      "123.45",
      1_720_014_399_999,
      "0",
      42,
      "0",
      "0",
      "0",
    ]]),
    [{
      symbol: "BTCUSDT",
      timeframe: "4h",
      timestamp: 1_720_000_000_000,
      open: "60000.10",
      high: "61000.20",
      low: "59000.30",
      close: "60500.40",
      volume: "123.45",
    }],
  );
});

test("rejects malformed or non-array Binance kline JSON", () => {
  assert.throws(() => parseBinanceKlines("BTCUSDT", "4h", { code: -1121 }), /Invalid Binance kline payload/);
  assert.throws(() => parseBinanceKlines("BTCUSDT", "4h", [[1_720_000_000_000, "1", "2"]]), /Invalid Binance kline payload/);
});

test("does not trigger analysis when no klines were seeded", async () => {
  const seeded: unknown[][] = [];
  let analysisRequests = 0;

  await (executionServer as any).runKlinePipeline({
    fetchTopSymbols: async () => ["BTCUSDT"],
    fetchKlines: async () => [],
    seedKlines: async (klines: unknown[]) => { seeded.push(klines); },
    triggerAnalysis: async () => { analysisRequests++; },
    wait: async () => {},
  });

  assert.equal(seeded.length, 0);
  assert.equal(analysisRequests, 0);
});

test("triggers analysis once after positive kline seeding", async () => {
  const seeded: unknown[][] = [];
  let analysisRequests = 0;

  await (executionServer as any).runKlinePipeline({
    fetchTopSymbols: async () => ["BTCUSDT"],
    fetchKlines: async () => parseBinanceKlines("BTCUSDT", "4h", [[
      1_720_000_000_000, "60000", "61000", "59000", "60500", "10",
    ]]),
    seedKlines: async (klines: unknown[]) => { seeded.push(klines); },
    triggerAnalysis: async () => { analysisRequests++; },
    wait: async () => {},
  });

  assert.equal(seeded.reduce((total, chunk) => total + chunk.length, 0), 1);
  assert.equal(analysisRequests, 1);
});
