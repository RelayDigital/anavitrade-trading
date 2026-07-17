import assert from "node:assert/strict";
import test from "node:test";
import { validateSignalOutcomes } from "./validator";

const signalStart = 1_000_000;

function fakeDb(signal: Record<string, unknown>, updates: Array<Record<string, unknown>>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ all: async () => [signal] }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => { updates.push(values); },
      }),
    }),
  };
}

test("validates with the recorded entry price and exact outcome window", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  const db = fakeDb({
    id: 1, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "100", maxProfit: "10", maxProfitDuration: "1 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async (request: Record<string, unknown>) => {
      requests.push(request);
      return [{
        openTime: signalStart, closeTime: signalStart + 59_999,
        open: 99, high: 110, low: 90, close: 105, volume: 1,
      }];
    },
  });

  assert.equal(result.signalsValidated, 1);
  assert.deepEqual(requests, [{
    symbol: "BTC/USDT", interval: "1m", startTime: signalStart,
    endTime: signalStart + 60_000 - 1,
  }]);
  assert.deepEqual(updates, [{
    outcomeValidated: 1, actualMaxProfitPct: "10.0000",
    actualDrawdownPct: "10.0000", outcomeWarning: 0,
  }]);
});

test("skips signals whose exchange provenance is not supported by Binance data", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = fakeDb({
    id: 2, marketName: "BTC/USDT", exchg: "Bybit", period: "5m",
    price: "100", maxProfit: "10", maxProfitDuration: "1 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => { throw new Error("market data must not be requested"); },
  });

  assert.equal(result.signalsValidated, 0);
  assert.equal(result.errors, 1);
  assert.match(result.errorMessages[0], /unsupported provenance: Bybit/);
  assert.deepEqual(updates, []);
});

test("rejects an incomplete exact window without persisting a fabricated zero", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = fakeDb({
    id: 3, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "100", maxProfit: "10", maxProfitDuration: "2 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => [{
      openTime: signalStart, closeTime: signalStart + 59_999,
      open: 100, high: 100, low: 100, close: 100, volume: 1,
    }],
  });

  assert.equal(result.signalsValidated, 0);
  assert.equal(result.errors, 1);
  assert.match(result.errorMessages[0], /incomplete candle coverage/);
  assert.deepEqual(updates, []);
});

test("paginates exact-window requests until candle coverage is complete", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  const db = fakeDb({
    id: 4, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "100", maxProfit: "10", maxProfitDuration: "1999 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);
  const endTime = signalStart + 1_999 * 60_000;

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async (request: Record<string, unknown>) => {
      requests.push(request);
      const pageStart = Number(request.startTime);
      const offset = Math.floor((pageStart - signalStart) / 60_000);
      return Array.from({ length: 1_000 }, (_, index) => {
        const openTime = signalStart + (offset + index) * 60_000;
        return {
        openTime, closeTime: openTime + 59_999,
          open: 100, high: 110, low: 90, close: 100, volume: 1,
        };
      }).filter(kline => kline.openTime < endTime);
    },
  });

  assert.equal(result.signalsValidated, 1);
  assert.deepEqual(requests, [
      { symbol: "BTC/USDT", interval: "1m", startTime: signalStart, endTime: endTime - 1 },
    { symbol: "BTC/USDT", interval: "1m", startTime: signalStart + 60_000_000, endTime: endTime - 1 },
  ]);
  assert.equal(updates.length, 1);
});

test("excludes fetched candles that do not overlap the exact outcome window", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = fakeDb({
    id: 5, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "100", maxProfit: "10", maxProfitDuration: "1 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => [
      {
        openTime: signalStart - 120_000, closeTime: signalStart - 60_001,
        open: 100, high: 1_000, low: 1, close: 100, volume: 1,
      },
      {
        openTime: signalStart, closeTime: signalStart + 59_999,
        open: 100, high: 110, low: 90, close: 100, volume: 1,
      },
    ],
  });

  assert.equal(result.signalsValidated, 1);
  assert.equal(updates[0].actualMaxProfitPct, "10.0000");
  assert.equal(updates[0].actualDrawdownPct, "10.0000");
});

test("rejects a signal without a positive recorded entry price", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = fakeDb({
    id: 6, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "0", maxProfit: "10", maxProfitDuration: "1 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => [{
      openTime: signalStart, closeTime: signalStart + 60_000,
      open: 100, high: 110, low: 90, close: 100, volume: 1,
    }],
  });

  assert.equal(result.signalsValidated, 0);
  assert.equal(result.errors, 1);
  assert.match(result.errorMessages[0], /invalid recorded entry price/);
  assert.deepEqual(updates, []);
});

test("rejects malformed duration without fetching or persisting", async () => {
  const updates: Array<Record<string, unknown>> = [];
  let fetches = 0;
  const db = fakeDb({
    id: 7, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "100", maxProfit: "10", maxProfitDuration: "sometime",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => { fetches++; return []; },
  });

  assert.equal(result.signalsValidated, 0);
  assert.equal(result.errors, 1);
  assert.match(result.errorMessages[0], /invalid duration/);
  assert.equal(fetches, 0);
  assert.deepEqual(updates, []);
});

test("rejects negative claimed profit without fetching or persisting", async () => {
  const updates: Array<Record<string, unknown>> = [];
  let fetches = 0;
  const db = fakeDb({
    id: 8, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "100", maxProfit: "-1", maxProfitDuration: "1 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => { fetches++; return []; },
  });

  assert.equal(result.signalsValidated, 0);
  assert.equal(result.errors, 1);
  assert.match(result.errorMessages[0], /invalid claimed profit/);
  assert.equal(fetches, 0);
  assert.deepEqual(updates, []);
});

test("rejects nonfinite claimed profit without fetching or persisting", async () => {
  const updates: Array<Record<string, unknown>> = [];
  let fetches = 0;
  const db = fakeDb({
    id: 13, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "100", maxProfit: "Infinity", maxProfitDuration: "1 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => { fetches++; return []; },
  });

  assert.equal(result.signalsValidated, 0);
  assert.equal(result.errors, 1);
  assert.match(result.errorMessages[0], /invalid claimed profit/);
  assert.equal(fetches, 0);
  assert.deepEqual(updates, []);
});

test("rejects an invalid signal timestamp without fetching or persisting", async () => {
  const updates: Array<Record<string, unknown>> = [];
  let fetches = 0;
  const db = fakeDb({
    id: 14, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "100", maxProfit: "10", maxProfitDuration: "1 min",
    signalDate: "not-a-timestamp", scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => { fetches++; return []; },
  });

  assert.equal(result.signalsValidated, 0);
  assert.equal(result.errors, 1);
  assert.match(result.errorMessages[0], /invalid signal timestamp/);
  assert.equal(fetches, 0);
  assert.deepEqual(updates, []);
});

test("rejects an unsupported period without fetching or persisting", async () => {
  const updates: Array<Record<string, unknown>> = [];
  let fetches = 0;
  const db = fakeDb({
    id: 9, marketName: "BTC/USDT", exchg: "Binance", period: "2m",
    price: "100", maxProfit: "10", maxProfitDuration: "1 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => { fetches++; return []; },
  });

  assert.equal(result.signalsValidated, 0);
  assert.equal(result.errors, 1);
  assert.match(result.errorMessages[0], /unsupported period/);
  assert.equal(fetches, 0);
  assert.deepEqual(updates, []);
});

test("rejects a candle crossing the requested start boundary", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = fakeDb({
    id: 10, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "100", maxProfit: "10", maxProfitDuration: "1 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => [{
      openTime: signalStart - 1, closeTime: signalStart + 59_998,
      open: 100, high: 1_000, low: 1, close: 100, volume: 1,
    }],
  });

  assert.equal(result.signalsValidated, 0);
  assert.equal(result.errors, 1);
  assert.match(result.errorMessages[0], /boundary-crossing candle/);
  assert.deepEqual(updates, []);
});

test("rejects a candle crossing the requested end boundary", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = fakeDb({
    id: 11, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "100", maxProfit: "10", maxProfitDuration: "2 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => [
      {
        openTime: signalStart, closeTime: signalStart + 59_999,
        open: 100, high: 110, low: 90, close: 100, volume: 1,
      },
      {
        openTime: signalStart + 60_001, closeTime: signalStart + 120_000,
        open: 100, high: 1_000, low: 1, close: 100, volume: 1,
      },
    ],
  });

  assert.equal(result.signalsValidated, 0);
  assert.equal(result.errors, 1);
  assert.match(result.errorMessages[0], /boundary-crossing candle/);
  assert.deepEqual(updates, []);
});

test("rejects malformed fetched OHLC without persisting", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = fakeDb({
    id: 12, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "100", maxProfit: "10", maxProfitDuration: "1 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => [{
      openTime: signalStart, closeTime: signalStart + 59_999,
      open: 100, high: Number.NaN, low: 90, close: 100, volume: 1,
    }],
  });

  assert.equal(result.signalsValidated, 0);
  assert.equal(result.errors, 1);
  assert.match(result.errorMessages[0], /invalid candle/);
  assert.deepEqual(updates, []);
});

test("rejects duplicate exact-window candles from pagination", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = fakeDb({
    id: 15, marketName: "BTC/USDT", exchg: "Binance", period: "1m",
    price: "100", maxProfit: "10", maxProfitDuration: "1 min",
    signalDate: signalStart, scrapedAt: 0,
  }, updates);
  const candle = {
    openTime: signalStart, closeTime: signalStart + 59_999,
    open: 100, high: 110, low: 90, close: 100, volume: 1,
  };

  const result = await (validateSignalOutcomes as any)({
    db,
    fetchKlines: async () => [candle, candle],
  });

  assert.equal(result.signalsValidated, 0);
  assert.equal(result.errors, 1);
  assert.match(result.errorMessages[0], /duplicate or overlapping candle data/);
  assert.deepEqual(updates, []);
});
