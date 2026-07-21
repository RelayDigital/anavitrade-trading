/**
 * VPS-side kline ingestion cron.
 *
 * Fetches OHLCV klines from Binance (futures API) for configurable symbol lists
 * at 4h, 1h, AND 15m timeframes, then writes them to the Worker's D1 database via the
 * existing authenticated internal API path (`POST /api/internal/seed-klines`).
 *
 * This replaces the ad-hoc `scripts/seed-klines.mjs` approach:
 *   - Runs standalone as a VPS cron entry (no wrangler, no local SQL files)
 *   - Reuses INTERNAL_SECRET / WORKER_URL env vars already defined for server.ts
 *   - Small, iterative writes: each chunk is an HTTP POST with the same auth the
 *     execution poller uses for `/api/internal/risk-approved-jobs` etc.
 *   - Both 4h and 1h timeframes every run — the PRD says 1h SMC patterns fire ~4x
 *     more than 4h, and both are needed for MA99 warmup.
 *
 * Environment variables (.env):
 *   WORKER_URL              — Worker base URL (e.g. https://anavitrade.workers.dev)
 *   INTERNAL_SECRET         — shared secret for VPS-to-Worker auth
 *   KLINE_FETCH_LIMIT       — candles per symbol/timeframe; defaults to 5 for
 *                             recurring refreshes, set to 300 for warmup
 *   BINANCE_API_KEY         — optional, sent as X-MBX-APIKEY to bypass geo-block
 *
 * Standalone usage:
 *   node src/server/analysis/kline-cron.ts
 *
 * Cron entry (every 5 minutes):
 *   &#42;/5 &#42; &#42; &#42; &#42; cd /path/to/anavitrade-trading && /usr/bin/node src/server/analysis/kline-cron.ts >> /var/log/kline-cron.log 2>&1
 *
 * Programmatic usage:
 *   import { runKlineCron } from "./kline-cron";
 *   await runKlineCron();
 */

import { fileURLToPath } from "node:url";

// ─── Constants ──────────────────────────────────────────────────────────────

/** How often this script runs (controls backoff timeouts, not scheduling). */
export const CRON_INTERVAL_MS = 5 * 60 * 1000; // 5 min — matches `*/5 * * * *`

/** Max klines to fetch per symbol per timeframe per call (Binance kline limit). */
export const MAX_KLINES_PER_CALL = 300;

/** Batch size for writing to the Worker internal API in one POST.
 *  Kept well below the D1 999-variable limit (85 rows × 10 cols = 850 vars). */
export const CHUNK_SIZE = 85;

/** Delay between API POSTs to avoid flooding the Worker. */
export const POST_DELAY_MS = 1500;

/** Delay between Binance API calls for different symbols. */
export const FETCH_DELAY_MS = 150;

/** Max retries per chunk on transient HTTP errors. */
export const MAX_RETRIES = 3;

/** Base retry delay (exponential backoff). */
export const RETRY_BASE_MS = 1000;

/** Recurring refresh size; operating-depth warmup opts into MAX_KLINES_PER_CALL. */
export const DEFAULT_FETCH_LIMIT = 5;

/** Timeframes to fetch — 4h (MA99 warmup, structural) and 1h (SMC patterns). */
export const TIMEFRAMES = ["4h", "1h", "15m"] as const;

/** Default symbol list (static fallback if exchangeInfo fails). */
export const DEFAULT_SYMBOLS: readonly string[] = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT",
  "AVAXUSDT", "DOTUSDT", "LINKUSDT", "SUIUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT",
  "OPUSDT",
];

/** Kraken public OHLC symbols used only when Binance returns a regional 451.
 * The normalized output keeps the downstream USDT symbol contract, while the
 * cron log makes the alternate market-data provenance explicit. */
export const KRAKEN_PAIR_BY_SYMBOL: Readonly<Record<string, string>> = {
  BTCUSDT: "XBTUSD",
  ETHUSDT: "ETHUSD",
  BNBUSDT: "BNBUSD",
  SOLUSDT: "SOLUSD",
  XRPUSDT: "XXRPZUSD",
  ADAUSDT: "ADAUSD",
  DOGEUSDT: "XDGUSD",
  AVAXUSDT: "AVAXUSD",
  DOTUSDT: "DOTUSD",
  LINKUSDT: "LINKUSD",
  SUIUSDT: "SUIUSD",
  NEARUSDT: "NEARUSD",
  APTUSDT: "APTUSD",
  ARBUSDT: "ARBUSD",
  OPUSDT: "OPUSD",
};

/** Number of top USDT perpetuals to fetch from exchangeInfo. */
export const TOP_SYMBOLS_COUNT = 15;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BinanceKline {
  symbol: string;
  timeframe: string;
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface SeedKlinesResponse {
  status: string;
  inserted?: number;
  total?: number;
  message?: string;
}

export interface KlineCronResult {
  /** Total klines written across all symbols and timeframes. */
  totalWritten: number;
  /** Total klines fetched from Binance (before dedup). */
  totalFetched: number;
  /** Symbols processed. */
  symbols: string[];
  /** Per-timeframe breakdown. */
  breakdown: Record<string, { fetched: number; written: number }>;
  /** Duration in ms. */
  durationMs: number;
  /** Any errors encountered (non-fatal). */
  errors: string[];
}

export type FetchKlinesFn = (
  symbol: string,
  interval: string,
  limit: number,
) => Promise<BinanceKline[]>;

export type FetchSymbolsFn = (limit: number) => Promise<string[]>;

export type PostKlinesFn = (klines: BinanceKline[]) => Promise<SeedKlinesResponse>;

export type WaitFn = (ms: number) => Promise<void>;

export interface KlineCronDependencies {
  workerUrl?: string;
  internalSecret?: string;
  binanceApiKey?: string;
  fetchSymbols?: FetchSymbolsFn;
  fetchKlines?: FetchKlinesFn;
  postKlines?: PostKlinesFn;
  wait?: WaitFn;
}

// ─── Default implementations (live Binance API + Worker POST) ────────────────

const BINANCE_FAPI = "https://fapi.binance.com";

/**
 * Parse Binance kline API response into our internal shape.
 * Mirrors parseBinanceKlines() in server.ts.
 */
export function parseBinanceKlines(
  symbol: string,
  interval: string,
  payload: unknown,
): BinanceKline[] {
  if (!Array.isArray(payload)) throw new Error("Invalid Binance kline payload");

  const isNumericString = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && Number.isFinite(Number(v));

  return payload.map((row) => {
    if (
      !Array.isArray(row)
      || row.length < 6
      || typeof row[0] !== "number"
      || !Number.isFinite(row[0])
      || !isNumericString(row[1])
      || !isNumericString(row[2])
      || !isNumericString(row[3])
      || !isNumericString(row[4])
      || !isNumericString(row[5])
    ) {
      throw new Error("Invalid Binance kline payload");
    }

    return {
      symbol,
      timeframe: interval,
      timestamp: row[0],
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
    };
  });
}

/** Parse Kraken's OHLC response while retaining our normalized symbol shape. */
export function parseKrakenKlines(
  symbol: string,
  interval: string,
  payload: unknown,
  limit = MAX_KLINES_PER_CALL,
): BinanceKline[] {
  if (!payload || typeof payload !== "object") throw new Error("Invalid Kraken OHLC payload");
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object") throw new Error("Invalid Kraken OHLC payload");
  const rows = Object.entries(result).find(([key, value]) => key !== "last" && Array.isArray(value))?.[1];
  if (!Array.isArray(rows)) throw new Error("Invalid Kraken OHLC payload");

  return rows
    .slice(0, -1) // Kraken includes the currently-forming candle as the last row.
    .slice(-Math.min(limit, MAX_KLINES_PER_CALL))
    .map((row) => {
      if (!Array.isArray(row) || row.length < 7) throw new Error("Invalid Kraken OHLC payload");
      const values = row.slice(0, 7).map(Number);
      if (values.some((value) => !Number.isFinite(value))) throw new Error("Invalid Kraken OHLC payload");
      return {
        symbol,
        timeframe: interval,
        timestamp: values[0] * 1000,
        open: String(row[1]),
        high: String(row[2]),
        low: String(row[3]),
        close: String(row[4]),
        volume: String(row[6]),
      };
    });
}

/**
 * Fetch klines from Binance Futures API for a single symbol/interval.
 */
export async function fetchBinanceKlines(
  symbol: string,
  interval: string,
  limit: number,
  apiKey?: string,
): Promise<BinanceKline[]> {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(Math.min(limit, MAX_KLINES_PER_CALL)),
  });
  const headers: Record<string, string> = {};
  if (apiKey) headers["X-MBX-APIKEY"] = apiKey;
  const url = `${BINANCE_FAPI}/fapi/v1/klines?${params}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Binance ${res.status} for ${symbol} ${interval}: ${body.slice(0, 200)}`);
  }
  return parseBinanceKlines(symbol, interval, await res.json());
}

/** Fetch normalized candles from Kraken for regional Binance fallback. */
export async function fetchKrakenKlines(
  symbol: string,
  interval: string,
  limit: number,
): Promise<BinanceKline[]> {
  const pair = KRAKEN_PAIR_BY_SYMBOL[symbol];
  if (!pair) throw new Error(`No Kraken fallback pair for ${symbol}`);
  const krakenInterval = interval === "4h" ? "240" : interval === "1h" ? "60" : interval === "15m" ? "15" : undefined;
  if (!krakenInterval) throw new Error(`No Kraken fallback interval for ${interval}`);
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${krakenInterval}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kraken ${res.status} for ${symbol} ${interval}`);
  return parseKrakenKlines(symbol, interval, await res.json(), limit);
}

/** Prefer Binance provenance; use Kraken only for the known 451 geo-block. */
export async function fetchMarketKlines(
  symbol: string,
  interval: string,
  limit: number,
  apiKey?: string,
): Promise<BinanceKline[]> {
  try {
    return await fetchBinanceKlines(symbol, interval, limit, apiKey);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (!message.includes("Binance 451") && !message.includes("restricted location")) throw error;
    console.warn(`[kline-cron] Binance restricted; using Kraken fallback for ${symbol} ${interval}`);
    return fetchKrakenKlines(symbol, interval, limit);
  }
}

/**
 * Fetch top USDT perpetual pairs by 24h volume.
 */
export async function fetchTopSymbols(
  limit: number,
  apiKey?: string,
): Promise<string[]> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["X-MBX-APIKEY"] = apiKey;
    const res = await fetch(`${BINANCE_FAPI}/fapi/v1/exchangeInfo`, { headers });
    if (!res.ok) throw new Error(`exchangeInfo ${res.status}`);
    const data = (await res.json()) as any;
    return (data.symbols ?? [])
      .filter(
        (s: any) =>
          s.symbol?.endsWith("USDT")
          && s.status === "TRADING"
          && s.contractType === "PERPETUAL",
      )
      .sort(
        (a: any, b: any) =>
          parseFloat(b.volume24h || "0") - parseFloat(a.volume24h || "0"),
      )
      .slice(0, limit)
      .map((s: any) => s.symbol);
  } catch (e) {
    console.warn(
      "[kline-cron] exchangeInfo failed, using static list:",
      (e as Error).message,
    );
    return [...DEFAULT_SYMBOLS].slice(0, limit);
  }
}

/**
 * Post a chunk of klines to the Worker's internal seed-klines endpoint.
 */
export async function postKlinesToWorker(
  klines: BinanceKline[],
  workerUrl: string,
  internalSecret: string,
): Promise<SeedKlinesResponse> {
  const url = `${workerUrl.replace(/\/+$/, "")}/api/internal/seed-klines`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": internalSecret,
    },
    body: JSON.stringify({ klines }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const error = new Error(`Worker API ${res.status} on seed-klines: ${body.slice(0, 200)}`) as Error & { retryAfterMs?: number };
    const retryAfter = res.headers.get("retry-after");
    if (res.status === 429 && retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) error.retryAfterMs = seconds * 1000;
    }
    throw error;
  }
  return res.json() as Promise<SeedKlinesResponse>;
}

// ─── Core logic ─────────────────────────────────────────────────────────────

/**
 * Run one cycle of the kline ingestion cron.
 *
 * @param dependencies - Override live functions for testing.
 * @returns Summary result.
 */
export async function runKlineCron(
  dependencies: KlineCronDependencies = {},
): Promise<KlineCronResult> {
  const workerUrl =
    dependencies.workerUrl ?? process.env.WORKER_URL ?? "";
  const internalSecret =
    dependencies.internalSecret ?? process.env.INTERNAL_SECRET ?? "";
  const binanceApiKey =
    dependencies.binanceApiKey ?? process.env.BINANCE_API_KEY ?? "";
  const configuredLimit = Number.parseInt(process.env.KLINE_FETCH_LIMIT ?? String(DEFAULT_FETCH_LIMIT), 10);
  const fetchLimit = Number.isFinite(configuredLimit)
    ? Math.max(1, Math.min(MAX_KLINES_PER_CALL, configuredLimit))
    : DEFAULT_FETCH_LIMIT;

  const fetchSymbolsFn =
    dependencies.fetchSymbols ??
    ((limit: number) => fetchTopSymbols(limit, binanceApiKey));
  const fetchKlinesFn =
    dependencies.fetchKlines ??
    ((symbol: string, interval: string, limit: number) =>
      fetchMarketKlines(symbol, interval, limit, binanceApiKey));
  const postKlinesFn =
    dependencies.postKlines ??
    ((klines: BinanceKline[]) =>
      postKlinesToWorker(klines, workerUrl, internalSecret));
  const wait = dependencies.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const start = Date.now();
  const errors: string[] = [];
  const breakdown: Record<string, { fetched: number; written: number }> = {};

  for (const tf of TIMEFRAMES) {
    breakdown[tf] = { fetched: 0, written: 0 };
  }

  // Resolve symbol list
  let symbols: string[];
  try {
    symbols = await fetchSymbolsFn(TOP_SYMBOLS_COUNT);
  } catch (e: any) {
    errors.push(`fetchSymbols: ${e.message}`);
    symbols = [...DEFAULT_SYMBOLS].slice(0, TOP_SYMBOLS_COUNT);
  }

  let totalFetched = 0;
  let totalWritten = 0;

  for (const symbol of symbols) {
    for (const tf of TIMEFRAMES) {
      let klines: BinanceKline[] = [];
      try {
      klines = await fetchKlinesFn(symbol, tf, fetchLimit);
      } catch (e: any) {
        errors.push(`${symbol} ${tf} fetch: ${e.message}`);
        continue;
      }

      if (klines.length === 0) continue;

      totalFetched += klines.length;
      breakdown[tf].fetched += klines.length;

      // Write in chunks with retry
      for (let i = 0; i < klines.length; i += CHUNK_SIZE) {
        const chunk = klines.slice(i, i + CHUNK_SIZE);
        let inserted = 0;
        let lastError: string | undefined;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            const response = await postKlinesFn(chunk);
            inserted = response.inserted ?? 0;
            lastError = undefined;
            break; // success
          } catch (e: any) {
            lastError = e.message;
            if (attempt < MAX_RETRIES - 1) {
              const delay = e?.retryAfterMs ?? RETRY_BASE_MS * Math.pow(2, attempt);
              await wait(delay);
            }
          }
        }

        if (lastError) {
          errors.push(
            `${symbol} ${tf} chunk ${i / CHUNK_SIZE}: ${lastError}`,
          );
        }

        totalWritten += inserted;
        breakdown[tf].written += inserted;

        // Throttle between posts
        await wait(POST_DELAY_MS);
      }
    }

    // Throttle between symbols
    await wait(FETCH_DELAY_MS);
  }

  return {
    totalWritten,
    totalFetched,
    symbols,
    breakdown,
    durationMs: Date.now() - start,
    errors,
  };
}

// ─── Standalone entry point (for cron) ───────────────────────────────────────

async function main() {
  const isDirect = process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === process.argv[1];

  if (!isDirect) return;

  const missing: string[] = [];
  if (!process.env.WORKER_URL) missing.push("WORKER_URL");
  if (!process.env.INTERNAL_SECRET) missing.push("INTERNAL_SECRET");
  if (missing.length > 0) {
    console.error(`[kline-cron] FATAL: missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log(`[kline-cron] Starting at ${new Date().toISOString()}`);
  console.log(`[kline-cron] Timeframes: ${TIMEFRAMES.join(", ")}`);
  console.log(`[kline-cron] Worker: ${process.env.WORKER_URL}`);

  const result = await runKlineCron();

  console.log(
    `[kline-cron] Done: ${result.totalWritten}/${result.totalFetched} written across ${result.symbols.length} symbols in ${result.durationMs}ms`,
  );
  for (const tf of TIMEFRAMES) {
    const b = result.breakdown[tf];
    console.log(`[kline-cron]   ${tf}: ${b.written}/${b.fetched}`);
  }
  if (result.errors.length > 0) {
    for (const err of result.errors.slice(0, 10)) {
      console.warn(`[kline-cron] WARN: ${err}`);
    }
    if (result.errors.length > 10) {
      console.warn(`[kline-cron]   ... and ${result.errors.length - 10} more`);
    }
  }

  process.exit(result.totalWritten > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[kline-cron] Fatal:", e?.message);
  process.exit(1);
});
