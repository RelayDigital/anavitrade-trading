/**
 * Standalone execution server for Anavitrade.
 *
 * Runs on a Hetzner VPS with static IPv4 for exchange API key IP whitelisting.
 * Polls the Cloudflare Worker for pending TradeIntents, decrypts credentials
 * locally, submits orders to CEXes, and reports fills back to the Worker.
 *
 * Architecture:
 *   Worker (Edge)  ←HTTPS/x-internal-secret→  VPS (Hetzner Ashburn)
 *                                              ├─ Poll loop (every 5s)
 *                                              ├─ CEX clients (binance.ts, bybit.ts, etc.)
 *                                              ├─ ONNX ML inference (CPU)
 *                                              ├─ Prometheus metrics (port 9090)
 *                                              └─ Emergency kill file
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

// Types for internal API responses
interface PendingIntent {
  id: number;
  source: string;
  symbol: string;
  side: string;
  orderType: string;
  requestedNotionalUsd: string | null;
  targetLeverage: number | null;
  limitPrice: string | null;
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
  thesis: string | null;
  status: string;
}

interface EncryptedConnection {
  id: number;
  userId: number;
  exchange: string;
  encryptedApiKey: string;
  encryptedApiSecret: string;
  encryptedPassphrase: string | null;
  killSwitchActive: boolean | number;
  label: string | null;
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
/** Default position size as percentage of available balance when intent has no requestedNotionalUsd. */
const DEFAULT_POSITION_PCT = 10;

// ─── Helpers ───────────────────────────────────────────────────────────────

function normaliseSide(side: string): "BUY" | "SELL" {
  return side.toUpperCase() === "SELL" ? "SELL" : "BUY";
}

function normaliseOrderType(t: string): "MARKET" | "LIMIT" {
  return t.toUpperCase() === "LIMIT" ? "LIMIT" : "MARKET";
}

function computeQuantity(notionalUsd: number, price: number): string | null {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  const qty = (notionalUsd / price).toFixed(6);
  return Number(qty) > 0 ? qty : null;
}

/**
 * Fetch the current mark price for a symbol from Binance public API.
 * No auth required. Falls back to 0 if unavailable.
 */
async function fetchTickerPrice(symbol: string): Promise<number> {
  const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
  if (res.ok) {
    const data = (await res.json()) as { price?: string };
    return parseFloat(data.price ?? "0");
  }
  return 0;
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
      return;
    }

    // 2. Fetch pending intents
    const { intents } = await internalGet<{ intents: PendingIntent[] }>("/api/internal/pending-intents");
    if (intents.length === 0) {
      // Still poll for fills on in-flight orders even without new intents
      await pollForFills();
      return;
    }

    // 3. Fetch active connections with encrypted credentials
    const { connections } = await internalGet<{ connections: EncryptedConnection[] }>("/api/internal/active-connections");
    if (connections.length === 0) {
      console.log("[exec-server] No active connections — skipping", intents.length, "intents");
      await pollForFills();
      return;
    }

    // 4. Process each intent
    for (const intent of intents) {
      // Check connection-level kill
      const eligibleConns = connections.filter((c) => !killState.perConnectionKills[c.id]);
      if (eligibleConns.length === 0) {
        console.log(`[exec-server] Intent #${intent.id}: all connections killed — skipping`);
        continue;
      }

      for (const conn of eligibleConns) {
        try {
          // Decrypt credentials locally — NEVER sent over the wire
          const apiKey = await decryptKey(conn.encryptedApiKey, ENCRYPTION_KEY!);
          const apiSecret = await decryptKey(conn.encryptedApiSecret, ENCRYPTION_KEY!);
          const passphrase = conn.encryptedPassphrase
            ? await decryptKey(conn.encryptedPassphrase, ENCRYPTION_KEY!)
            : undefined;

          const idempotencyKey = await sha256(`vps:${conn.userId}:${intent.id}:${conn.id}`);

          console.log(`[exec-server] Intent #${intent.id}: ${intent.side} ${intent.symbol} via ${conn.exchange} (conn #${conn.id}) [mode=${EXECUTION_MODE}]`);

          // ── EXECUTION_MODE guard ────────────────────────────────────────
          if (EXECUTION_MODE === "disabled") {
            // Dry-run mode: report as queued without calling any exchange
            await internalPost("/api/internal/report-execution", {
              tradeIntentId: intent.id,
              userId: conn.userId,
              cexConnectionId: conn.id,
              provider: conn.exchange,
              symbol: intent.symbol,
              side: intent.side,
              orderType: intent.orderType,
              notionalUsd: intent.requestedNotionalUsd ?? undefined,
              quantity: undefined,
              leverage: intent.targetLeverage ?? undefined,
              limitPrice: intent.limitPrice ?? undefined,
              status: "queued",
              errorMessage: "EXECUTION_MODE=disabled",
              idempotencyKey,
            });
            continue;
          }

          // ── Build CEX client ────────────────────────────────────────────
          const isTestnet = EXECUTION_MODE === "testnet";
          const client = createCexClient(conn.exchange, {
            apiKey,
            apiSecret,
            passphrase,
            testnet: isTestnet,
          });

          // ── Sizing ──────────────────────────────────────────────────────
          let notionalUsd = intent.requestedNotionalUsd
            ? parseFloat(intent.requestedNotionalUsd)
            : 0;

          if (notionalUsd <= 0) {
            try {
              const balance = await client.validateAndReadBalance();
              const available = balance.availableUsd || balance.equityUsd;
              if (available > 0) {
                notionalUsd = available * (DEFAULT_POSITION_PCT / 100);
                console.log(`[exec-server] Sized ${intent.symbol}: ${DEFAULT_POSITION_PCT}% of $${available.toFixed(2)} = $${notionalUsd.toFixed(2)}`);
              }
            } catch (e: any) {
              console.warn(`[exec-server] Balance fetch failed for conn #${conn.id}: ${e?.message?.slice(0, 100)}`);
            }
          }

          if (notionalUsd <= 0) {
            await internalPost("/api/internal/report-execution", {
              tradeIntentId: intent.id,
              userId: conn.userId,
              cexConnectionId: conn.id,
              provider: conn.exchange,
              symbol: intent.symbol,
              side: intent.side,
              orderType: intent.orderType,
              status: "skipped",
              errorMessage: "cannot_determine_notional",
              idempotencyKey,
            });
            continue;
          }

          // ── Price for quantity calculation ──────────────────────────────
          let price = intent.limitPrice ? parseFloat(intent.limitPrice) : 0;
          if (price <= 0) {
            price = await fetchTickerPrice(intent.symbol);
          }

          if (price <= 0) {
            await internalPost("/api/internal/report-execution", {
              tradeIntentId: intent.id,
              userId: conn.userId,
              cexConnectionId: conn.id,
              provider: conn.exchange,
              symbol: intent.symbol,
              side: intent.side,
              orderType: intent.orderType,
              notionalUsd: notionalUsd.toFixed(2),
              status: "skipped",
              errorMessage: "unable_to_resolve_price",
              idempotencyKey,
            });
            continue;
          }

          const quantity = computeQuantity(notionalUsd, price);
          if (!quantity) {
            await internalPost("/api/internal/report-execution", {
              tradeIntentId: intent.id,
              userId: conn.userId,
              cexConnectionId: conn.id,
              provider: conn.exchange,
              symbol: intent.symbol,
              side: intent.side,
              orderType: intent.orderType,
              notionalUsd: notionalUsd.toFixed(2),
              status: "skipped",
              errorMessage: "zero_quantity",
              idempotencyKey,
            });
            continue;
          }

          // ── Submit order ────────────────────────────────────────────────
          // Set leverage first (best-effort)
          if (intent.targetLeverage) {
            try { await client.setLeverage(intent.symbol, intent.targetLeverage); } catch { /* non-fatal */ }
          }

          const orderReq: CexOrderRequest = {
            symbol: intent.symbol,
            side: normaliseSide(intent.side),
            type: normaliseOrderType(intent.orderType),
            quantity,
            price: intent.limitPrice ?? undefined,
            leverage: intent.targetLeverage ?? undefined,
            stopLossPrice: intent.stopLossPrice ?? undefined,
            takeProfitPrice: intent.takeProfitPrice ?? undefined,
            clientOrderId: idempotencyKey,
          };

          let orderResult: CexOrderResult;
          try {
            orderResult = await client.placeOrder(orderReq);
            console.log(`[exec-server] Order submitted: ${orderResult.orderId} -> ${orderResult.status}`);
          } catch (e: any) {
            const errMsg = e?.message?.slice(0, 300) ?? "order_submission_failed";
            console.error(`[exec-server] Order submission failed for intent #${intent.id}: ${errMsg}`);
            ordersRejected++;
            ordersSubmitted++;

            await internalPost("/api/internal/report-execution", {
              tradeIntentId: intent.id,
              userId: conn.userId,
              cexConnectionId: conn.id,
              provider: conn.exchange,
              symbol: intent.symbol,
              side: intent.side,
              orderType: intent.orderType,
              notionalUsd: notionalUsd.toFixed(2),
              quantity,
              leverage: intent.targetLeverage ?? undefined,
              limitPrice: intent.limitPrice ?? undefined,
              status: "rejected",
              errorMessage: errMsg,
              idempotencyKey,
            });
            errorsTotal++;
            lastError = errMsg;
            continue;
          }

          // ── Report initial result ───────────────────────────────────────
          await internalPost("/api/internal/report-execution", {
            tradeIntentId: intent.id,
            userId: conn.userId,
            cexConnectionId: conn.id,
            provider: conn.exchange,
            symbol: intent.symbol,
            side: intent.side,
            orderType: intent.orderType,
            notionalUsd: notionalUsd.toFixed(2),
            quantity,
            leverage: intent.targetLeverage ?? undefined,
            limitPrice: intent.limitPrice ?? undefined,
            orderId: orderResult.orderId,
            status: orderResult.status,
            idempotencyKey,
          });

          ordersSubmitted++;

          if (orderResult.status === "filled") {
            ordersFilled++;
            console.log(`[exec-server] Intent #${intent.id} filled immediately: ${orderResult.orderId}`);
          } else if (orderResult.status === "accepted") {
            // Track for fill polling (LIMIT orders or slow fills)
            inFlightOrders.set(idempotencyKey, {
              idempotencyKey,
              orderId: orderResult.orderId,
              exchange: conn.exchange,
              symbol: intent.symbol,
              userId: conn.userId,
              cexConnectionId: conn.id,
              tradeIntentId: intent.id,
              submittedAt: Date.now(),
              pollCount: 0,
              apiKey,
              apiSecret,
              passphrase,
              testnet: isTestnet,
            });
            ordersTracked = inFlightOrders.size;
            console.log(`[exec-server] Intent #${intent.id} accepted, tracking for fill: ${orderResult.orderId}`);
          }
        } catch (e: any) {
          errorsTotal++;
          lastError = e?.message ?? String(e);
          console.error(`[exec-server] Error processing intent #${intent.id} conn #${conn.id}:`, e?.message);
        }
      }
    }

    // 5. Poll for fills on in-flight orders
    await pollForFills();

    lastPollDuration = Date.now() - start;
  } catch (e: any) {
    errorsTotal++;
    lastError = e?.message ?? String(e);
    console.error("[exec-server] Poll error:", e?.message);
    lastPollDuration = Date.now() - start;
  }
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
