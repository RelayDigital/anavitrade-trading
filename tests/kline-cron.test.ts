/**
 * Tests for kline-cron.ts — VPS-side kline ingestion.
 *
 * All network calls are mocked; no real Binance or Worker traffic.
 *
 * Run: npx tsx --test tests/kline-cron.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  CHUNK_SIZE,
  DEFAULT_SYMBOLS,
  MAX_KLINES_PER_CALL,
  MAX_RETRIES,
  POST_DELAY_MS,
  RETRY_BASE_MS,
  TIMEFRAMES,
  TOP_SYMBOLS_COUNT,
  parseBinanceKlines,
  parseKrakenKlines,
  runKlineCron,
  postKlinesToWorker,
} from "../src/server/analysis/kline-cron";
import type {
  BinanceKline,
  FetchKlinesFn,
  FetchSymbolsFn,
  PostKlinesFn,
  SeedKlinesResponse,
  WaitFn,
  KlineCronResult,
} from "../src/server/analysis/kline-cron";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeKline(
  symbol: string,
  timeframe: string,
  timestamp: number,
): BinanceKline {
  return {
    symbol,
    timeframe,
    timestamp,
    open: "50000.00",
    high: "51000.00",
    low: "49000.00",
    close: "50500.00",
    volume: "1000.5",
  };
}

function makeKlines(
  symbol: string,
  timeframe: string,
  count: number,
  startTs = 1_000_000_000_000,
): BinanceKline[] {
  const result: BinanceKline[] = [];
  const intervalMs = timeframe === "4h" ? 4 * 60 * 60 * 1000 : 60 * 60 * 1000;
  for (let i = 0; i < count; i++) {
    result.push(makeKline(symbol, timeframe, startTs + i * intervalMs));
  }
  return result;
}

// ─── parseBinanceKlines ──────────────────────────────────────────────────────

test("kline-cron parseBinanceKlines: valid payload", () => {
  const raw = [
    [1000000000000, "50000", "51000", "49000", "50500", "1000.5", 1000000059999, "50000", 200, "50000", "50500", "0"],
    [1000003600000, "50500", "51500", "49500", "51000", "2000.0", 1000003659999, "51000", 300, "51000", "50500", "0"],
  ];
  const result = parseBinanceKlines("BTCUSDT", "1h", raw);
  assert.equal(result.length, 2);
  assert.equal(result[0].symbol, "BTCUSDT");
  assert.equal(result[0].timeframe, "1h");
  assert.equal(result[0].timestamp, 1000000000000);
  assert.equal(result[0].open, "50000");
  assert.equal(result[0].high, "51000");
  assert.equal(result[0].close, "50500");
  assert.equal(result[1].timestamp, 1000003600000);
});

test("kline-cron parseBinanceKlines: empty array", () => {
  const result = parseBinanceKlines("ETHUSDT", "4h", []);
  assert.deepEqual(result, []);
});

test("kline-cron parseBinanceKlines: rejects non-array", () => {
  assert.throws(() => parseBinanceKlines("X", "1h", null), /Invalid Binance kline payload/);
  assert.throws(() => parseBinanceKlines("X", "1h", "foo"), /Invalid Binance kline payload/);
  assert.throws(() => parseBinanceKlines("X", "1h", {}), /Invalid Binance kline payload/);
});

test("kline-cron parseBinanceKlines: rejects malformed row", () => {
  assert.throws(() => parseBinanceKlines("X", "1h", [["a", "b"]]), /Invalid Binance kline payload/);
  assert.throws(() => parseBinanceKlines("X", "1h", [[1, 2, 3, 4, 5, 6]]), /Invalid Binance kline payload/);
  assert.throws(() => parseBinanceKlines("X", "1h", [[1, "a", "b", "c", "d", "e", "f"]]), /Invalid Binance kline payload/);
});

test("kline-cron parseKrakenKlines: normalizes closed OHLC rows", () => {
  const payload = {
    error: [],
    result: {
      XXBTZUSD: [
        [1700000000, "50000", "51000", "49000", "50500", "50250", "1000", 10],
        [1700003600, "50500", "51500", "49500", "51000", "51000", "2000", 20],
        [1700007200, "51000", "52000", "50000", "51500", "51500", "3000", 30],
      ],
      last: 1700007200,
    },
  };
  const result = parseKrakenKlines("BTCUSDT", "1h", payload, 300);
  assert.equal(result.length, 2);
  assert.equal(result[0].symbol, "BTCUSDT");
  assert.equal(result[0].timeframe, "1h");
  assert.equal(result[0].timestamp, 1700000000000);
  assert.equal(result[1].volume, "2000");
});

// ─── runKlineCron ────────────────────────────────────────────────────────────

test("kline-cron runKlineCron: writes klines for both timeframes", async () => {
  const symbols = ["BTCUSDT", "ETHUSDT"];
  const writtenChunks: BinanceKline[][] = [];

  const fetchSymbols: FetchSymbolsFn = async () => symbols;
  const fetchKlines: FetchKlinesFn = async (symbol, interval) =>
    makeKlines(symbol, interval, 10);
  const postKlines: PostKlinesFn = async (klines) => {
    writtenChunks.push([...klines]);
    return { status: "ok", inserted: klines.length, total: klines.length };
  };
  const wait: WaitFn = async () => {};

  const result = await runKlineCron({
    workerUrl: "https://test.workers.dev",
    internalSecret: "test-secret",
    fetchSymbols,
    fetchKlines,
    postKlines,
    wait,
  });

  // 2 symbols × 3 timeframes × 10 klines each = 60 klines
  assert.equal(result.totalFetched, 60);
  assert.equal(result.totalWritten, 60);
  assert.deepEqual(result.symbols, symbols);

  // Each chunk should be ≤ CHUNK_SIZE
  for (const chunk of writtenChunks) {
    assert.ok(chunk.length <= CHUNK_SIZE);
  }

  // Breakdown should show per-timeframe counts
  for (const tf of TIMEFRAMES) {
    assert.equal(result.breakdown[tf].fetched, 20);
    assert.equal(result.breakdown[tf].written, 20);
  }

  assert.equal(result.errors.length, 0);
  assert.ok(result.durationMs >= 0);
});

test("kline-cron runKlineCron: handles empty symbol list", async () => {
  const fetchSymbols: FetchSymbolsFn = async () => [];
  const result = await runKlineCron({
    workerUrl: "https://test.workers.dev",
    internalSecret: "test-secret",
    fetchSymbols,
    wait: async () => {},
  });

  assert.equal(result.totalFetched, 0);
  assert.equal(result.totalWritten, 0);
  assert.deepEqual(result.symbols, []);
  assert.equal(result.errors.length, 0);
});

test("kline-cron runKlineCron: uses default symbols when exchangeInfo fails", async () => {
  const fetchSymbols: FetchSymbolsFn = async () => {
    throw new Error("exchangeInfo down");
  };

  const fetchKlines: FetchKlinesFn = async () => [];

  const result = await runKlineCron({
    workerUrl: "https://test.workers.dev",
    internalSecret: "test-secret",
    fetchSymbols,
    fetchKlines,
    wait: async () => {},
  });

  // Falls back to DEFAULT_SYMBOLS
  assert.ok(result.symbols.length > 0);
  assert.equal(result.symbols[0], DEFAULT_SYMBOLS[0]);
  // Should have recorded the error
  assert.ok(result.errors.some((e) => e.includes("exchangeInfo")));
});

test("kline-cron runKlineCron: retries on transient POST failure", async () => {
  const symbols = ["BTCUSDT"];
  const tfCallCount: Record<string, number> = {};
  let firstTfSucceeded = false;

  const fetchSymbols: FetchSymbolsFn = async () => symbols;
  const fetchKlines: FetchKlinesFn = async (symbol, interval) =>
    makeKlines(symbol, interval, 5);

  const postKlines: PostKlinesFn = async (klines) => {
    const tf = klines[0]?.timeframe ?? "unknown";
    tfCallCount[tf] = (tfCallCount[tf] ?? 0) + 1;
    const count = tfCallCount[tf];
    // Fail first attempt of each timeframe, succeed on retry
    if (count === 1) {
      throw new Error("Service unavailable");
    }
    if (count === 2) {
      firstTfSucceeded = true;
    }
    return { status: "ok", inserted: klines.length, total: klines.length };
  };

  const wait: WaitFn = async () => {};

  const result = await runKlineCron({
    workerUrl: "https://test.workers.dev",
    internalSecret: "test-secret",
    fetchSymbols,
    fetchKlines,
    postKlines,
    wait,
  });

  // Each timeframe should have been retried exactly once
  assert.equal(tfCallCount["4h"], 2, "4h should have 1 retry");
  assert.equal(tfCallCount["1h"], 2, "1h should have 1 retry");
  assert.equal(tfCallCount["15m"], 2, "15m should have 1 retry");
  assert.ok(firstTfSucceeded, "POST should have succeeded after retry");
  // 1 symbol x 3 timeframes x 5 klines = 15
  assert.equal(result.totalWritten, 15);
  assert.equal(result.errors.length, 0);
});

test("kline-cron runKlineCron: exhausts retries without success", async () => {
  const symbols = ["BTCUSDT"];

  const fetchSymbols: FetchSymbolsFn = async () => symbols;
  const fetchKlines: FetchKlinesFn = async (symbol, interval) =>
    makeKlines(symbol, interval, 5);

  const tfAttempts: Record<string, number> = {};
  const postKlines: PostKlinesFn = async (klines) => {
    const tf = klines[0]?.timeframe ?? "unknown";
    tfAttempts[tf] = (tfAttempts[tf] ?? 0) + 1;
    throw new Error("Persistent failure");
  };

  const wait: WaitFn = async () => {};

  const result = await runKlineCron({
    workerUrl: "https://test.workers.dev",
    internalSecret: "test-secret",
    fetchSymbols,
    fetchKlines,
    postKlines,
    wait,
  });

  // Each timeframe should have attempted MAX_RETRIES times
  assert.equal(tfAttempts["4h"], MAX_RETRIES, `4h: expected ${MAX_RETRIES} attempts, got ${tfAttempts["4h"]}`);
  assert.equal(tfAttempts["1h"], MAX_RETRIES, `1h: expected ${MAX_RETRIES} attempts, got ${tfAttempts["1h"]}`);
  // Written should be 0 because all retries failed
  assert.equal(result.totalWritten, 0);
  // Should have recorded the error
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0].includes("Persistent failure"));
});

test("kline-cron runKlineCron: recovers from individual fetch failures", async () => {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

  const fetchSymbols: FetchSymbolsFn = async () => symbols;
  const fetchKlines: FetchKlinesFn = async (symbol, interval) => {
    if (symbol === "ETHUSDT") {
      throw new Error(`Binance error for ${symbol}`);
    }
    return makeKlines(symbol, interval, 3);
  };

  const posted: BinanceKline[] = [];
  const postKlines: PostKlinesFn = async (klines) => {
    posted.push(...klines);
    return { status: "ok", inserted: klines.length, total: klines.length };
  };

  const wait: WaitFn = async () => {};

  const result = await runKlineCron({
    workerUrl: "https://test.workers.dev",
    internalSecret: "test-secret",
    fetchSymbols,
    fetchKlines,
    postKlines,
    wait,
  });

  // ETHUSDT failures are non-fatal; the other 2 symbols × 3 timeframes × 3 klines = 18
  assert.equal(result.totalFetched, 18);
  assert.equal(result.totalWritten, 18);
  // Should have recorded the ETHUSDT error
  assert.ok(result.errors.some((e) => e.includes("ETHUSDT")));
  // No SOLUSDT or BTCUSDT errors
  assert.ok(!result.errors.some((e) => e.includes("SOLUSDT")));
});

test("kline-cron runKlineCron: idempotent writes (INSERT OR IGNORE)", async () => {
  const symbols = ["BTCUSDT"];

  const fetchSymbols: FetchSymbolsFn = async () => symbols;
  // Return overlapping timestamps to simulate re-fetching same data
  const base = makeKlines("BTCUSDT", "4h", 3, 1_000_000_000_000);
  const fetchKlines: FetchKlinesFn = async () => [...base];

  const inserted: number[] = [];
  const postKlines: PostKlinesFn = async (klines) => {
    const count = klines.length;
    inserted.push(count);
    // The Worker's INSERT OR IGNORE returns changes=0 for duplicates
    // But since our mock can't simulate that, we just confirm data is sent
    return { status: "ok", inserted: count, total: count };
  };

  const wait: WaitFn = async () => {};

  // Run twice — idempotent means no errors
  const r1 = await runKlineCron({
    workerUrl: "https://test.workers.dev",
    internalSecret: "test-secret",
    fetchSymbols,
    fetchKlines,
    postKlines,
    wait,
  });
  const r2 = await runKlineCron({
    workerUrl: "https://test.workers.dev",
    internalSecret: "test-secret",
    fetchSymbols,
    fetchKlines,
    postKlines,
    wait,
  });

  // Both runs should succeed without errors. 3 klines x 3 timeframes (4h, 1h, 15m)
  // per symbol, since fetchKlines here ignores the requested interval.
  assert.equal(r1.errors.length, 0);
  assert.equal(r2.errors.length, 0);
  assert.equal(r1.totalWritten, 9);
  assert.equal(r2.totalWritten, 9);
});

test("kline-cron runKlineCron: chunking respects CHUNK_SIZE", async () => {
  const symbols = ["BTCUSDT"];
  const chunkSizes: number[] = [];

  const fetchSymbols: FetchSymbolsFn = async () => symbols;
  // Fetch more klines than one chunk can hold
  const fetchKlines: FetchKlinesFn = async (symbol, interval) =>
    makeKlines(symbol, interval, CHUNK_SIZE * 2 + 10);

  const postKlines: PostKlinesFn = async (klines) => {
    chunkSizes.push(klines.length);
    return { status: "ok", inserted: klines.length, total: klines.length };
  };

  const wait: WaitFn = async () => {};

  const result = await runKlineCron({
    workerUrl: "https://test.workers.dev",
    internalSecret: "test-secret",
    fetchSymbols,
    fetchKlines,
    postKlines,
    wait,
  });

  // 1 symbol × 3 timeframes: each timeframe produces CHUNK_SIZE*2+10 klines
  // Expect: chunk 1 = 85, chunk 2 = 85, chunk 3 = 10 (for each timeframe)
  // So 3 POSTs per timeframe = 9 total
  assert.equal(chunkSizes.length, 9);
  // All chunks except possibly the last should be exactly CHUNK_SIZE
  for (let i = 0; i < chunkSizes.length; i++) {
    if ((i + 1) % 3 === 0) {
      // Last chunk (every 3rd) has remainder
      assert.equal(chunkSizes[i], 10);
    } else {
      assert.equal(chunkSizes[i], CHUNK_SIZE);
    }
  }

  const totalExpected = (CHUNK_SIZE * 2 + 10) * 3; // 3 timeframes
  assert.equal(result.totalFetched, totalExpected);
  assert.equal(result.totalWritten, totalExpected);
});

// ─── postKlinesToWorker ──────────────────────────────────────────────────────

test("kline-cron postKlinesToWorker: uses correct URL and auth headers", async () => {
  const originalFetch = globalThis.fetch;

  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = "";

  try {
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedBody = (init?.body as string) ?? "";
      return new Response(JSON.stringify({ status: "ok", inserted: 5, total: 5 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const klines = makeKlines("BTCUSDT", "1h", 5);
    const result = await postKlinesToWorker(
      klines,
      "https://my-worker.workers.dev",
      "my-secret-key",
    );

    assert.equal(result.status, "ok");
    assert.equal(result.inserted, 5);

    // Verify URL
    assert.equal(capturedUrl, "https://my-worker.workers.dev/api/internal/seed-klines");

    // Verify auth header
    assert.equal(capturedHeaders["x-internal-secret"], "my-secret-key");
    assert.equal(capturedHeaders["Content-Type"], "application/json");

    // Verify body contains klines
    const bodyParsed = JSON.parse(capturedBody);
    assert.ok(Array.isArray(bodyParsed.klines));
    assert.equal(bodyParsed.klines.length, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("kline-cron postKlinesToWorker: throws on non-200", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      return new Response("Unauthorized", {
        status: 401,
        statusText: "Unauthorized",
      });
    };

    await assert.rejects(
      () =>
        postKlinesToWorker(
          makeKlines("BTCUSDT", "1h", 1),
          "https://bad.workers.dev",
          "wrong-secret",
        ),
      /Worker API 401/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Constants sanity ────────────────────────────────────────────────────────

test("kline-cron constants are sensible", () => {
  assert.ok(CHUNK_SIZE > 0 && CHUNK_SIZE <= 100, "CHUNK_SIZE should be positive and ≤ 100");
  assert.ok(MAX_KLINES_PER_CALL >= CHUNK_SIZE, "MAX_KLINES_PER_CALL should be at least CHUNK_SIZE");
  assert.ok(MAX_RETRIES >= 1, "MAX_RETRIES should be at least 1");
  assert.ok(POST_DELAY_MS >= 0, "POST_DELAY_MS should be non-negative");
  assert.ok(RETRY_BASE_MS >= 100, "RETRY_BASE_MS should give meaningful backoff");
  assert.equal(TIMEFRAMES.length, 3);
  assert.ok(TIMEFRAMES.includes("4h"), "Should include 4h");
  assert.ok(TIMEFRAMES.includes("1h"), "Should include 1h");
  assert.equal(TOP_SYMBOLS_COUNT, DEFAULT_SYMBOLS.length);
  assert.equal(DEFAULT_SYMBOLS.length, 15);
});
