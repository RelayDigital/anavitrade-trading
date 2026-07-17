/**
 * Standalone execution server for Anavitrade.
 *
 * Runs on a Hetzner VPS with static IPv4 for exchange API key IP whitelisting.
 * Polls the Cloudflare Worker for risk-approved execution_jobs (already validated
 * by the Worker-side decideExecution()), decrypts credentials locally, submits
 * orders to CEXes, and reports fills back to the Worker.
 *
 * Architecture:
 *   Worker (Edge)  ←HTTPS/x-internal-secret→  VPS (Hetzner Ashburn)
 *                                              ├─ Poll loop (every 5s) — risk-approved jobs
 *                                              ├─ CEX clients (binance.ts, bybit.ts, etc.)
 *                                              ├─ ONNX ML inference (CPU)
 *                                              ├─ Prometheus metrics (port 9090)
 *                                              └─ Emergency kill file
 *
 * RISK SAFETY: The VPS ONLY executes jobs that the Worker has already
 * risk-approved via decideExecution(). It polls /api/internal/risk-approved-jobs
 * which returns execution_jobs with riskApproved=true and status=queued.
 * The VPS no longer calls decideExecution() or computes sizing — those are
 * Worker responsibilities. This prevents the VPS from bypassing:
 *   - Global kill switch
 *   - Live-account status check
 *   - Copytrade opt-in
 *   - Daily-loss cap
 *   - Portfolio exposure cap
 *   - Max-leverage clamp
 *   - Per-connection kill switch
 *   - Circuit breaker
 *
 * Environment variables (.env):
 *   WORKER_URL             — Worker base URL (e.g. https://anavitrade-worker.workers.dev)
 *   INTERNAL_SECRET        — shared secret for VPS-to-Worker auth
 *   ENCRYPTION_KEY         — same key as Worker for local credential decryption
 *   PORT                   — metrics / health server (default 9090)
 *   POLL_INTERVAL_MS       — intent polling interval (default 5000)
 *   EXECUTION_MODE         — "testnet" | "production" | "disabled" (default "testnet")
 */

import * as crypto from "crypto";
import { createCexClient } from "../cex/factory";
import type { CexOrderRequest, CexOrderResult } from "../cex/clientTypes";

// ─── Types for internal API responses ────────────────────────────────────────

/** A risk-approved execution job returned by GET /api/internal/risk-approved-jobs.
 *  Includes pre-computed sizing from the Worker, encrypted credentials
 *  (decrypted on VPS only), and intent details for protective orders. */
interface RiskApprovedJob {
  jobId: number;
  tradeIntentId: number;
  userId: number;
  cexConnectionId: number;
  symbol: string;
  side: string;
  orderType: string;
  notionalUsd: string | null;
  quantity: string | null;
  leverage: number | null;
  limitPrice: string | null;
  idempotencyKey: string;
  // Connection fields (encrypted — VPS decrypts locally)
  connId: number;
  connExchange: string;
  connEncryptedApiKey: string;
  connEncryptedApiSecret: string;
  connEncryptedPassphrase: string | null;
  connKillSwitchActive: boolean | number;
  connLabel: string | null;
  // Intent fields (protective orders)
  intentStopLossPrice: string | null;
  intentTakeProfitPrice: string | null;
  intentTargetLeverage: number | null;
}

interface KillState {
  globalKill: boolean;
  perConnectionKills: Record<number, boolean>;
}

/**
 * Tracks an order submitted to exchange that hasn't filled yet.
 * Stores decrypted credentials to avoid re-fetching on each fill poll.
 *
 * SECURITY: Decrypted API keys live in the process heap for up to
 * `MAX_ORDER_POLLS * POLL_INTERVAL_MS` (~5 minutes by default). The VPS
 * is a dedicated private machine, so this is acceptable for MVP. For
 * production hardening, replace with Redis-backed ephemeral storage or
 * re-fetch credentials per-fill-poll from the Worker API.
 */
interface InFlightOrder {
  idempotencyKey: string;
  orderId: string;
  exchange: string;
  symbol: string;
  userId: number;
  cexConnectionId: number;
  tradeIntentId: number;
  submittedAt: number;
  pollCount: number;
  apiKey: string;
  apiSecret: string;
  passphrase: string | undefined;
  testnet: boolean;
}

// ─── Config ────────────────────────────────────────────────────────────────

const {
  WORKER_URL,
  INTERNAL_SECRET,
  ENCRYPTION_KEY,
  PORT = "9090",
  POLL_INTERVAL_MS = "5000",
  EXECUTION_MODE = "testnet",
} = process.env;

const REQUIRED = ["WORKER_URL", "INTERNAL_SECRET", "ENCRYPTION_KEY"];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`[exec-server] FATAL: ${key} is not set`);
    process.exit(1);
  }
}

/** Maximum fill-poll cycles before giving up (60 x 5s = 5 min for MARKET, shorter for LIMIT). */
const MAX_ORDER_POLLS = 60;

// ─── Helpers ───────────────────────────────────────────────────────────────

function normaliseSide(side: string): "BUY" | "SELL" {
  return side.toUpperCase() === "SELL" ? "SELL" : "BUY";
}

function normaliseOrderType(t: string): "MARKET" | "LIMIT" {
  return t.toUpperCase() === "LIMIT" ? "LIMIT" : "MARKET";
}

// ─── Shared crypto (delegates to the extracted module at runtime) ──────────
// In production, this is imported from src/server/cex/crypto.ts.
// For now we inline the same AES-256-GCM logic so this file is self-contained.

async function decryptKey(ciphertext: string, encryptionKey: string): Promise<string> {
  const secret = encryptionKey.slice(0, 32).padEnd(32, "0");
  const raw = Uint8Array.from(Buffer.from(ciphertext, "base64"));
  const iv = raw.slice(0, 12);
  const encrypted = raw.slice(12);
  // Use a WebCrypto-compatible wrapper if available, or Node's crypto
  // In Node 18+ we need subtle which is globalThis.crypto.subtle in Node 20+
  const subtle = (globalThis as any).crypto?.subtle;
  if (subtle) {
    const keyBytes = new TextEncoder().encode(secret);
    const key = await subtle.importKey("raw", keyBytes, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const decrypted = await subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
    return new TextDecoder().decode(decrypted);
  }
  throw new Error("WebCrypto.subtle not available — need Node 20+");
}

// ─── Internal API client ───────────────────────────────────────────────────

async function internalGet<T>(path: string): Promise<T> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    headers: { "x-internal-secret": INTERNAL_SECRET! },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Worker API ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function internalPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: "POST",
    headers: { "x-internal-secret": INTERNAL_SECRET!, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Worker API ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Health/Metrics HTTP server (Node built-in, no framework needed) ────────

import * as http from "http";

let healthy = false;
let pollCount = 0;
let lastPollDuration = 0;
let ordersSubmitted = 0;
let ordersFilled = 0;
let ordersRejected = 0;
let ordersTracked = 0;
let errorsTotal = 0;
let lastError: string | null = null;
let serverStart = Date.now();

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: healthy ? "ok" : "starting",
      uptime: Math.floor((Date.now() - serverStart) / 1000),
      mode: EXECUTION_MODE,
      pollCount,
      ordersSubmitted,
      ordersFilled,
      ordersRejected,
      ordersTracked,
      errorsTotal,
      lastError,
      lastPollDuration,
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(Number(PORT), () => {
  console.log(`[exec-server] Health/metrics server on :${PORT}`);
});

// ─── In-flight order tracking ──────────────────────────────────────────────

/** Orders that were submitted but not yet confirmed filled. */
const inFlightOrders = new Map<string, InFlightOrder>();

// ─── Main poll loop ────────────────────────────────────────────────────────

async function poll() {
  const start = Date.now();
  pollCount++;

  try {
    // 1. Fetch kill state
    const killState = await internalGet<KillState>("/api/internal/kill-state");
    if (killState.globalKill) {
      console.log("[exec-server] Global kill active — skipping poll cycle");
      await pollForFills();
      return;
    }

    // 2. Fetch risk-approved jobs (Worker already ran decideExecution)
    const { jobs } = await internalGet<{ jobs: RiskApprovedJob[] }>("/api/internal/risk-approved-jobs");
    if (!jobs || jobs.length === 0) {
      await pollForFills();
      return;
    }

    console.log(`[exec-server] Processing ${jobs.length} risk-approved job(s)`);

    // 3. Process each risk-approved job
    for (const job of jobs) {
      // Defense-in-depth: double-check per-connection kill switch
      if (killState.perConnectionKills[job.connId]) {
        console.log(`[exec-server] Job #${job.jobId}: connection #${job.connId} killed — skipping`);
        continue;
      }

      if (job.connKillSwitchActive) {
        console.log(`[exec-server] Job #${job.jobId}: connection #${job.connId} kill-switch active — skipping`);
        continue;
      }

      // Validate pre-computed sizing from the Worker
      const notionalStr = job.notionalUsd;
      const notionalUsd = notionalStr ? parseFloat(notionalStr) : 0;
      if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
        await internalPost("/api/internal/report-execution", {
          tradeIntentId: job.tradeIntentId,
          userId: job.userId,
          cexConnectionId: job.cexConnectionId,
          provider: job.connExchange,
          symbol: job.symbol,
          side: job.side,
          orderType: job.orderType,
          status: "skipped",
          errorMessage: "invalid_notional",
          idempotencyKey: job.idempotencyKey,
        });
        errorsTotal++;
        continue;
      }

      const quantity = job.quantity;
      if (!quantity || parseFloat(quantity) <= 0) {
        await internalPost("/api/internal/report-execution", {
          tradeIntentId: job.tradeIntentId,
          userId: job.userId,
          cexConnectionId: job.cexConnectionId,
          provider: job.connExchange,
          symbol: job.symbol,
          side: job.side,
          orderType: job.orderType,
          notionalUsd: notionalStr,
          status: "skipped",
          errorMessage: "zero_quantity",
          idempotencyKey: job.idempotencyKey,
        });
        errorsTotal++;
        continue;
      }

      const leverage = job.leverage ?? job.intentTargetLeverage ?? 3;

      try {
        // Decrypt credentials locally — NEVER sent over the wire
        const apiKey = await decryptKey(job.connEncryptedApiKey, ENCRYPTION_KEY!);
        const apiSecret = await decryptKey(job.connEncryptedApiSecret, ENCRYPTION_KEY!);
        const passphrase = job.connEncryptedPassphrase
          ? await decryptKey(job.connEncryptedPassphrase, ENCRYPTION_KEY!)
          : undefined;

        // ── Duplicate detection ──────────────────────────────────────────
        if (inFlightOrders.has(job.idempotencyKey)) {
          console.log(`[exec-server] Job #${job.jobId}: duplicate idempotencyKey already in-flight — skipping`);
          continue;
        }

        console.log(`[exec-server] Job #${job.jobId}: ${job.side} ${job.quantity} ${job.symbol} via ${job.connExchange} (conn #${job.connId}) [mode=${EXECUTION_MODE}] [notional=$${notionalUsd.toFixed(2)}]`);

        // ── EXECUTION_MODE guard ────────────────────────────────────────
        if (EXECUTION_MODE === "disabled") {
          await internalPost("/api/internal/report-execution", {
            tradeIntentId: job.tradeIntentId,
            userId: job.userId,
            cexConnectionId: job.cexConnectionId,
            provider: job.connExchange,
            symbol: job.symbol,
            side: job.side,
            orderType: job.orderType,
            notionalUsd: notionalStr,
            quantity,
            leverage,
            limitPrice: job.limitPrice ?? undefined,
            status: "queued",
            errorMessage: "EXECUTION_MODE=disabled",
            idempotencyKey: job.idempotencyKey,
          });
          continue;
        }

        // ── Build CEX client ────────────────────────────────────────────
        const isTestnet = EXECUTION_MODE === "testnet";
        const client = createCexClient(job.connExchange, {
          apiKey,
          apiSecret,
          passphrase,
          testnet: isTestnet,
        });

        // ── Set leverage (best-effort) ───────────────────────────────────
        if (leverage > 0) {
          try { await client.setLeverage(job.symbol, leverage); } catch { /* non-fatal */ }
        }

        // ── Submit order using Worker's pre-approved sizing ──────────────
        const orderReq: CexOrderRequest = {
          symbol: job.symbol,
          side: normaliseSide(job.side),
          type: normaliseOrderType(job.orderType),
          quantity,
          price: job.limitPrice ?? undefined,
          leverage,
          stopLossPrice: job.intentStopLossPrice ?? undefined,
          takeProfitPrice: job.intentTakeProfitPrice ?? undefined,
          clientOrderId: job.idempotencyKey,
        };

        let orderResult: CexOrderResult;
        try {
          orderResult = await client.placeOrder(orderReq);
          console.log(`[exec-server] Order submitted: ${orderResult.orderId} -> ${orderResult.status}`);
        } catch (e: any) {
          const errMsg = e?.message?.slice(0, 300) ?? "order_submission_failed";
          console.error(`[exec-server] Order submission failed for job #${job.jobId}: ${errMsg}`);

          if (isDuplicateError(errMsg)) {
            await reconcileDuplicateV2(
              job, apiKey, apiSecret, passphrase, isTestnet, notionalStr, quantity, leverage, errMsg,
            );
            continue;
          }

          ordersRejected++;
          ordersSubmitted++;

          await internalPost("/api/internal/report-execution", {
            tradeIntentId: job.tradeIntentId,
            userId: job.userId,
            cexConnectionId: job.cexConnectionId,
            provider: job.connExchange,
            symbol: job.symbol,
            side: job.side,
            orderType: job.orderType,
            notionalUsd: notionalStr,
            quantity,
            leverage,
            limitPrice: job.limitPrice ?? undefined,
            status: "rejected",
            errorMessage: errMsg,
            idempotencyKey: job.idempotencyKey,
          });
          errorsTotal++;
          lastError = errMsg;
          continue;
        }

        // ── Update local state BEFORE reporting to Worker ───────────────
        ordersSubmitted++;

        if (orderResult.status === "filled") {
          ordersFilled++;
          console.log(`[exec-server] Job #${job.jobId} filled immediately: ${orderResult.orderId}`);
        }

        // Track all non-rejected orders for fill polling
        inFlightOrders.set(job.idempotencyKey, {
          idempotencyKey: job.idempotencyKey,
          orderId: orderResult.orderId,
          exchange: job.connExchange,
          symbol: job.symbol,
          userId: job.userId,
          cexConnectionId: job.cexConnectionId,
          tradeIntentId: job.tradeIntentId,
          submittedAt: Date.now(),
          pollCount: 0,
          apiKey,
          apiSecret,
          passphrase,
          testnet: isTestnet,
        });
        ordersTracked = inFlightOrders.size;

        // ── Report result to Worker (best-effort; local state is already saved) ──
        try {
          await internalPost("/api/internal/report-execution", {
            tradeIntentId: job.tradeIntentId,
            userId: job.userId,
            cexConnectionId: job.cexConnectionId,
            provider: job.connExchange,
            symbol: job.symbol,
            side: job.side,
            orderType: job.orderType,
            notionalUsd: notionalStr,
            quantity,
            leverage,
            limitPrice: job.limitPrice ?? undefined,
            orderId: orderResult.orderId,
            status: orderResult.status,
            idempotencyKey: job.idempotencyKey,
          });
        } catch (reportErr: any) {
          console.warn(`[exec-server] Report-back POST failed for ${orderResult.orderId} (local state saved, poll will recover): ${(reportErr as any)?.message?.slice(0, 100)}`);
          errorsTotal++;
          lastError = (reportErr as any)?.message ?? String(reportErr);
        }
      } catch (e: any) {
        errorsTotal++;
        lastError = e?.message ?? String(e);
        console.error(`[exec-server] Error processing job #${job.jobId} conn #${job.connId}:`, e?.message);
      }
    }

    // 4. Poll for fills on in-flight orders
    await pollForFills();

    lastPollDuration = Date.now() - start;
  } catch (e: any) {
    errorsTotal++;
    lastError = e?.message ?? String(e);
    console.error("[exec-server] Poll error:", e?.message);
    lastPollDuration = Date.now() - start;
  }
}

/** Error message patterns that indicate a duplicate / already-existing order. */
function isDuplicateError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("duplicate order") ||
    lower.includes("order already exists") ||
    lower.includes("already placed") ||
    lower.includes("duplicate client order id") ||
    lower.includes("client order id already") ||
    lower.includes("order would immediately reduce")
  );
}

/**
 * When the exchange rejects with a "duplicate order" error, query the
 * exchange for existing position state instead of treating it as rejected.
 *
 * - If a position exists -> report as filled (the original order completed).
 * - If no position  -> track in inFlightOrders for fill polling.
 */
async function reconcileDuplicateV2(
  job: RiskApprovedJob,
  apiKey: string,
  apiSecret: string,
  passphrase: string | undefined,
  testnet: boolean,
  notionalStr: string | null,
  quantity: string,
  leverage: number,
  errMsg: string,
): Promise<void> {
  const idemKey = job.idempotencyKey;
  console.log(`[exec-server] Reconciling duplicate for ${idemKey} on ${job.connExchange}:${job.symbol}`);

  const syntheticOrderId = `reconciled:${idemKey}`;
  let foundPosition = false;

  try {
    const client = createCexClient(job.connExchange, { apiKey, apiSecret, passphrase, testnet });
    const positions = await client.getPositions(job.symbol);
    const position = positions.find((p) => p.symbol === job.symbol);

    if (position && Math.abs(position.sizeSigned) > 0) {
      foundPosition = true;
      ordersFilled++;
      ordersSubmitted++;

      // Track briefly so pollForFills can confirm, then auto-remove
      inFlightOrders.set(idemKey, {
        idempotencyKey: idemKey,
        orderId: syntheticOrderId,
        exchange: job.connExchange,
        symbol: job.symbol,
        userId: job.userId,
        cexConnectionId: job.cexConnectionId,
        tradeIntentId: job.tradeIntentId,
        submittedAt: Date.now(),
        pollCount: MAX_ORDER_POLLS - 1, // near-expired so poll cleans up fast
        apiKey,
        apiSecret,
        passphrase,
        testnet,
      });
      ordersTracked = inFlightOrders.size;

      await internalPost("/api/internal/report-execution", {
        tradeIntentId: job.tradeIntentId,
        userId: job.userId,
        cexConnectionId: job.cexConnectionId,
        provider: job.connExchange,
        symbol: job.symbol,
        side: job.side,
        orderType: job.orderType,
        notionalUsd: notionalStr,
        quantity,
        leverage,
        limitPrice: job.limitPrice ?? undefined,
        orderId: syntheticOrderId,
        status: "filled",
        errorMessage: `reconciled_duplicate: ${errMsg.slice(0, 100)}`,
        idempotencyKey: idemKey,
      });
      console.log(`[exec-server] Duplicate reconciled as filled: ${job.symbol} size=${position.sizeSigned}`);
      return;
    }
  } catch (e: any) {
    console.warn(`[exec-server] Position check during reconciliation failed: ${e?.message?.slice(0, 100)}`);
  }

  // No position found — order may still be pending (LIMIT order resting).
  // Track for fill polling so we don't lose it.
  ordersSubmitted++;

  inFlightOrders.set(idemKey, {
    idempotencyKey: idemKey,
    orderId: syntheticOrderId,
    exchange: job.connExchange,
    symbol: job.symbol,
    userId: job.userId,
    cexConnectionId: job.cexConnectionId,
    tradeIntentId: job.tradeIntentId,
    submittedAt: Date.now(),
    pollCount: 0,
    apiKey,
    apiSecret,
    passphrase,
    testnet,
  });
  ordersTracked = inFlightOrders.size;

  console.log(`[exec-server] Duplicate order reconciled, tracking for fill: ${job.symbol}${foundPosition ? " (position found)" : ""}`);
}

/**
 * Check in-flight orders for fills by reading positions from the exchange.
 * Reports filled status back to the Worker and removes from tracking.
 */
async function pollForFills() {
  if (inFlightOrders.size === 0) return;

  const start = Date.now();
  let filledCount = 0;

  for (const [key, order] of inFlightOrders) {
    if (order.pollCount >= MAX_ORDER_POLLS) {
      console.log(`[exec-server] Fill poll exhausted for ${order.orderId} (${order.pollCount} polls) — dropping`);
      inFlightOrders.delete(key);
      ordersTracked = inFlightOrders.size;
      continue;
    }

    order.pollCount++;

    try {
      const client = createCexClient(order.exchange, {
        apiKey: order.apiKey,
        apiSecret: order.apiSecret,
        passphrase: order.passphrase,
        testnet: order.testnet,
      });

      const positions = await client.getPositions(order.symbol);
      const position = positions.find((p) => p.symbol === order.symbol);

      if (position && Math.abs(position.sizeSigned) > 0) {
        // Position exists — order is filled
        await internalPost("/api/internal/report-execution", {
          tradeIntentId: order.tradeIntentId,
          userId: order.userId,
          cexConnectionId: order.cexConnectionId,
          provider: order.exchange,
          symbol: order.symbol,
          side: position.sizeSigned > 0 ? "BUY" : "SELL",
          orderType: "MARKET",
          status: "filled",
          orderId: order.orderId,
          idempotencyKey: order.idempotencyKey,
        });

        inFlightOrders.delete(key);
        ordersTracked = inFlightOrders.size;
        ordersFilled++;
        filledCount++;
        console.log(`[exec-server] Order ${order.orderId} for ${order.symbol} confirmed filled (${order.pollCount} polls)`);
      }
    } catch (e: any) {
      console.warn(`[exec-server] Fill poll error for ${order.orderId} (${order.symbol}): ${e?.message?.slice(0, 100)}`);
    }
  }

  if (filledCount > 0) {
    console.log(`[exec-server] Fill poll: ${filledCount} filled, ${inFlightOrders.size} still tracking (${Date.now() - start}ms)`);
  }
}

async function sha256(input: string): Promise<string> {
  const subtle = (globalThis as any).crypto?.subtle;
  if (subtle) {
    const buf = await subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback for older Node
  return crypto.createHash("sha256").update(input).digest("hex");
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`[exec-server] Starting...`);
  console.log(`[exec-server] Mode: ${EXECUTION_MODE}`);
  console.log(`[exec-server] Worker: ${WORKER_URL}`);
  console.log(`[exec-server] Poll interval: ${POLL_INTERVAL_MS}ms`);

  // Check Worker connectivity
  try {
    const health = await internalGet<any>("/api/health");
    console.log(`[exec-server] Worker health: ${JSON.stringify(health)}`);
  } catch (e: any) {
    console.error(`[exec-server] Worker unreachable: ${e?.message}`);
    process.exit(1);
  }

  healthy = true;

  // Start poll loop
  setInterval(poll, Number(POLL_INTERVAL_MS));

  // Start kline pipeline (hourly)
  const KLINES_INTERVAL_MS = Number(process.env.KLINES_INTERVAL_MS ?? "3600000"); // 1h default
  setInterval(runKlinePipeline, KLINES_INTERVAL_MS);

  // Run first poll + kline pipeline immediately
  poll();
  setTimeout(runKlinePipeline, 5000); // 5s delay so health check passes first

  // Graceful shutdown
  const shutdown = () => {
    console.log("[exec-server] Shutting down...");
    console.log(`[exec-server] In-flight at shutdown: ${inFlightOrders.size} orders`);
    healthy = false;
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error("[exec-server] Fatal:", e?.message);
  process.exit(1);
});

/* ── Kline Pipeline (VPS → Worker → D1 → Analysis Engine) ────────────────
 * Fetches klines from Binance on VPS (no geo-block), pushes to Worker for
 * D1 storage, then triggers analysis engine. */

const BINANCE_URL = "https://fapi.binance.com";
const KLINE_PAIRS = 15;
const KLINE_BARS = 200;
const KLINE_TIMEFRAME = "4h";
const KLINES_CHUNK = 85;

async function fetchBinanceKlines(symbol: string, interval: string, limit: number): Promise<any[]> {
  const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
  const headers: Record<string, string> = {};
  const apiKey = (process.env.BINANCE_API_KEY ?? "").trim();
  if (apiKey) headers["X-MBX-APIKEY"] = apiKey;
  const res = await fetch(`${BINANCE_URL}/fapi/v1/klines?${params}`, { headers });
  if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol}`);
  return (await res.json()).map((k: any) => ({
    symbol, timeframe: interval,
    timestamp: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5],
  }));
}

async function fetchTopSymbols(limit: number): Promise<string[]> {
  try {
    const headers: Record<string, string> = {};
    const apiKey = (process.env.BINANCE_API_KEY ?? "").trim();
    if (apiKey) headers["X-MBX-APIKEY"] = apiKey;
    const res = await fetch(`${BINANCE_URL}/fapi/v1/exchangeInfo`, { headers });
    if (!res.ok) throw new Error(`exchangeInfo ${res.status}`);
    const data = await res.json() as any;
    return (data.symbols ?? [])
      .filter((s: any) => s.symbol?.endsWith("USDT") && s.status === "TRADING" && s.contractType === "PERPETUAL")
      .sort((a: any, b: any) => (parseFloat(b.volume24h || "0") - parseFloat(a.volume24h || "0")))
      .slice(0, limit)
      .map((s: any) => s.symbol);
  } catch (e) {
    console.warn("[kline-pipeline] exchangeInfo failed, using static list:", (e as Error).message);
    return ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT","DOGEUSDT",
      "AVAXUSDT","DOTUSDT","LINKUSDT","SUIUSDT","NEARUSDT","APTUSDT","ARBUSDT","OPUSDT"];
  }
}

async function runKlinePipeline() {
  const start = Date.now();
  console.log("[kline-pipeline] Starting...");
  try {
    const symbols = await fetchTopSymbols(KLINE_PAIRS);
    let total = 0;
    for (const symbol of symbols) {
      try {
        const klines = await fetchBinanceKlines(symbol, KLINE_TIMEFRAME, KLINE_BARS);
        for (let i = 0; i < klines.length; i += KLINES_CHUNK) {
          const chunk = klines.slice(i, i + KLINES_CHUNK);
          await internalPost("/api/internal/seed-klines", { klines: chunk });
          total += chunk.length;
        }
      } catch (e) { /* individual symbol failure is non-fatal */ }
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`[kline-pipeline] Done: ${total} klines in ${Date.now() - start}ms — triggering analysis`);
    if (process.env.ADMIN_API_KEY) {
      await fetch(`${WORKER_URL}/api/analysis/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-api-key": process.env.ADMIN_API_KEY! },
      }).catch(() => {});
    }
  } catch (e: any) {
    console.error("[kline-pipeline] Error:", e?.message);
    errorsTotal++;
    lastError = e?.message ?? String(e);
  }
}
