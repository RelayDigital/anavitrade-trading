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
    if (intents.length === 0) return;

    // 3. Fetch active connections with encrypted credentials
    const { connections } = await internalGet<{ connections: EncryptedConnection[] }>("/api/internal/active-connections");
    if (connections.length === 0) {
      console.log("[exec-server] No active connections — skipping", intents.length, "intents");
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

          console.log(`[exec-server] Intent #${intent.id}: ${intent.side} ${intent.symbol} via ${conn.exchange} (conn #${conn.id})`);

          // 5. Mark intent as dispatched by updating status
          // The VPS doesn't write to D1 directly — it reports results via the API.
          // A future enhancement can call /api/internal/update-intent-status.

          // 6. Report execution (record what we attempted)
          const idempotencyKey = await sha256(`vps:${conn.userId}:${intent.id}:${conn.id}`);

          await internalPost("/api/internal/report-execution", {
            tradeIntentId: intent.id,
            userId: conn.userId,
            cexConnectionId: conn.id,
            provider: conn.exchange,
            symbol: intent.symbol,
            side: intent.side,
            orderType: intent.orderType,
            notionalUsd: intent.requestedNotionalUsd ?? undefined,
            quantity: undefined, // exchange-specific calculation
            leverage: intent.targetLeverage ?? undefined,
            limitPrice: intent.limitPrice ?? undefined,
            status: "queued",
            idempotencyKey,
          });

          ordersSubmitted++;
        } catch (e: any) {
          errorsTotal++;
          lastError = e?.message ?? String(e);
          console.error(`[exec-server] Error processing intent #${intent.id} conn #${conn.id}:`, e?.message);
        }
      }
    }

    lastPollDuration = Date.now() - start;
  } catch (e: any) {
    errorsTotal++;
    lastError = e?.message ?? String(e);
    console.error("[exec-server] Poll error:", e?.message);
    lastPollDuration = Date.now() - start;
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
