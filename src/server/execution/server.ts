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
 *   EXECUTION_MODE         — "testnet" | "production" | "disabled" (default "disabled")
 */

import * as crypto from "crypto";
import { fileURLToPath } from "node:url";
import { createCexClient } from "../cex/factory";
import { assertAutomatedExecutionSupported } from "../cex/registry";
import type {
  CexClient,
  CexCredentials,
  CexOrderRequest,
  CexOrderResult,
  ExchangeEnvironment,
} from "../cex/clientTypes";
import { CexProtectionError } from "../cex/clientTypes";
import { parseExecutionMode, reconcileExactOrder, type ExecutionMode } from "./outcomes";

// ─── Types for internal API responses ────────────────────────────────────────

/** A risk-approved execution job returned by GET /api/internal/risk-approved-jobs.
 *  Includes pre-computed sizing from the Worker, encrypted credentials
 *  (decrypted on VPS only), and intent details for protective orders. */
export interface RiskApprovedJob {
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
  orderId?: string | null;
  leaseToken: string;
  leaseAttempt: number;
  leaseExpiresAt: number;
  leaseAction: "submit" | "reconcile";
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

export type ExecutionReportStatus =
  | "submitted"
  | "filled"
  | "protection_pending"
  | "protected"
  | "failed"
  | "cancelled"
  | "unresolved";

export type ExecutionReport = {
  reportId: string;
  jobId: number;
  leaseToken: string;
  leaseAttempt: number;
  status: ExecutionReportStatus;
  orderId?: string;
  errorCode?: string;
  stopLossOrderId?: string;
  takeProfitOrderId?: string;
  compensationState?: "completed" | "failed";
  compensationOrderId?: string;
};

// ─── Config ────────────────────────────────────────────────────────────────

const {
  WORKER_URL,
  INTERNAL_SECRET,
  ENCRYPTION_KEY,
  PORT = "9090",
  POLL_INTERVAL_MS = "5000",
  EXECUTION_MODE = "disabled",
} = process.env;

const executionMode = parseExecutionMode(EXECUTION_MODE);

const isDirectExecution = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];

const REQUIRED = ["WORKER_URL", "INTERNAL_SECRET", "ENCRYPTION_KEY"];
if (isDirectExecution) {
  for (const key of REQUIRED) {
    if (!process.env[key]) {
      console.error(`[exec-server] FATAL: ${key} is not set`);
      process.exit(1);
    }
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

const BOUNDED_ERROR_CODES = new Set([
  "connection_kill_switch",
  "invalid_notional",
  "zero_quantity",
  "duplicate_in_flight",
  "unsupported_exchange",
  "exchange_rejected",
  "order_submission_failed",
  "duplicate_order_unresolved",
  "fill_not_confirmed",
  "exchange_reconcile_error",
  "protection_failed_compensated",
  "protection_failed_uncompensated",
  "protection_contract_missing",
  "execution_error",
]);

export function boundedExecutionErrorCode(value: unknown, fallback = "execution_error"): string {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return BOUNDED_ERROR_CODES.has(candidate) ? candidate : fallback;
}

export function buildExecutionReportId(
  jobId: number,
  leaseAttempt: number,
  status: ExecutionReportStatus,
  orderId?: string | null,
  errorCode?: string | null,
  details?: Pick<ExecutionReport, "stopLossOrderId" | "takeProfitOrderId" | "compensationState" | "compensationOrderId">,
): string {
  const outcome = JSON.stringify({
    jobId,
    leaseAttempt,
    status,
    orderId: orderId ?? null,
    errorCode: errorCode ?? null,
    stopLossOrderId: details?.stopLossOrderId ?? null,
    takeProfitOrderId: details?.takeProfitOrderId ?? null,
    compensationState: details?.compensationState ?? null,
    compensationOrderId: details?.compensationOrderId ?? null,
  });
  return `execution-${crypto.createHash("sha256").update(outcome).digest("hex")}`;
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

export type EncryptedExecutionCredentials = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string | null;
};

export type ExecutionJobPreparationDependencies = {
  decryptKey: (ciphertext: string, encryptionKey: string) => Promise<string>;
  createClient: (exchange: string, credentials: CexCredentials) => CexClient;
};

export type ExecutionJobPreparation =
  | { status: "disabled"; mode: "disabled" }
  | {
    status: "ready";
    mode: Exclude<ExecutionMode, "disabled">;
    environment: ExchangeEnvironment;
    apiKey: string;
    apiSecret: string;
    passphrase: string | undefined;
    client: CexClient;
  };

/**
 * Validate mode and exchange capability before materializing any credential
 * or exchange client. Dependencies make this ordering directly testable.
 */
export async function prepareExecutionJob(
  modeValue: unknown,
  exchange: string,
  encrypted: EncryptedExecutionCredentials,
  encryptionKey: string,
  dependencies: ExecutionJobPreparationDependencies = {
    decryptKey,
    createClient: createCexClient,
  },
): Promise<ExecutionJobPreparation> {
  const mode = parseExecutionMode(modeValue);
  if (mode === "disabled") return { status: "disabled", mode };

  const environment: ExchangeEnvironment = mode;
  assertAutomatedExecutionSupported(exchange, environment);

  const apiKey = await dependencies.decryptKey(encrypted.apiKey, encryptionKey);
  const apiSecret = await dependencies.decryptKey(encrypted.apiSecret, encryptionKey);
  const passphrase = encrypted.passphrase
    ? await dependencies.decryptKey(encrypted.passphrase, encryptionKey)
    : undefined;
  const credentials: CexCredentials = { apiKey, apiSecret, environment };
  if (passphrase !== undefined) credentials.passphrase = passphrase;
  const client = dependencies.createClient(exchange, credentials);

  return { status: "ready", mode, environment, apiKey, apiSecret, passphrase, client };
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
let jobsClaimed = 0;
let staleLeasesReclaimed = 0;
let lastSuccessfulPollAt = 0;
let serverStart = Date.now();

export function renderExecutionMetrics(): string {
  const lines = [
    "# HELP execution_polls_total Total execution poll cycles.",
    "# TYPE execution_polls_total counter",
    `execution_polls_total ${pollCount}`,
    "# HELP execution_poll_duration_seconds Duration of the latest execution poll cycle.",
    "# TYPE execution_poll_duration_seconds gauge",
    `execution_poll_duration_seconds ${lastPollDuration / 1000}`,
    "# HELP execution_claimed_jobs_total Total submit and reconcile leases claimed.",
    "# TYPE execution_claimed_jobs_total counter",
    `execution_claimed_jobs_total ${jobsClaimed}`,
    "# HELP execution_submissions_total Total exchange submission attempts.",
    "# TYPE execution_submissions_total counter",
    `execution_submissions_total ${ordersSubmitted}`,
    "# HELP execution_fills_total Total exchange orders reconciled as filled.",
    "# TYPE execution_fills_total counter",
    `execution_fills_total ${ordersFilled}`,
    "# HELP execution_failures_total Total execution-service errors.",
    "# TYPE execution_failures_total counter",
    `execution_failures_total ${errorsTotal}`,
    "# HELP execution_stale_leases_reclaimed_total Total leases reclaimed after a prior attempt.",
    "# TYPE execution_stale_leases_reclaimed_total counter",
    `execution_stale_leases_reclaimed_total ${staleLeasesReclaimed}`,
    "# HELP execution_inflight_orders Current orders awaiting reconciliation.",
    "# TYPE execution_inflight_orders gauge",
    `execution_inflight_orders ${ordersTracked}`,
    "# HELP execution_last_success_timestamp_seconds Unix timestamp of the last successful poll cycle.",
    "# TYPE execution_last_success_timestamp_seconds gauge",
    `execution_last_success_timestamp_seconds ${lastSuccessfulPollAt ? lastSuccessfulPollAt / 1000 : 0}`,
  ];
  return `${lines.join("\n")}\n`;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: healthy ? "ok" : "starting",
      uptime: Math.floor((Date.now() - serverStart) / 1000),
      mode: executionMode,
      pollCount,
      ordersSubmitted,
      ordersFilled,
      ordersRejected,
      ordersTracked,
      errorsTotal,
      degraded: lastError !== null,
      lastPollDuration,
    }));
    return;
  }
  if (req.url === "/metrics" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(renderExecutionMetrics());
    return;
  }
  res.writeHead(404);
  res.end();
});

if (isDirectExecution) {
  server.listen(Number(PORT), () => {
    console.log(`[exec-server] Health/metrics server on :${PORT}`);
  });
}

// ─── Lease-aware poller ────────────────────────────────────────────────────

type LeaseOwnedOrder = {
  jobId: number;
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
  environment: ExchangeEnvironment;
  leaseToken: string;
  leaseAttempt: number;
  leaseExpiresAt: number;
  leaseAction: "submit" | "reconcile";
};

const leaseInFlightOrders = new Map<number, LeaseOwnedOrder>();

type ExecutionPollResponse = { jobs: RiskApprovedJob[] };

export type ExecutionPollDependencies = {
  mode?: ExecutionMode;
  get?: <T>(path: string) => Promise<T>;
  post?: (path: string, body: unknown) => Promise<unknown>;
  prepareJob?: typeof prepareExecutionJob;
  state?: Map<number, LeaseOwnedOrder>;
  now?: () => number;
};

function reportBody(
  job: Pick<RiskApprovedJob, "jobId" | "leaseToken" | "leaseAttempt">,
  status: ExecutionReportStatus,
  orderId?: string | null,
  errorCode?: string | null,
  details?: Pick<ExecutionReport, "stopLossOrderId" | "takeProfitOrderId" | "compensationState" | "compensationOrderId">,
): ExecutionReport {
  const body: ExecutionReport = {
    reportId: buildExecutionReportId(job.jobId, job.leaseAttempt, status, orderId, errorCode, details),
    jobId: job.jobId,
    leaseToken: job.leaseToken,
    leaseAttempt: job.leaseAttempt,
    status,
  };
  if (orderId) body.orderId = orderId;
  if (errorCode) body.errorCode = boundedExecutionErrorCode(errorCode);
  if (details?.stopLossOrderId) body.stopLossOrderId = details.stopLossOrderId;
  if (details?.takeProfitOrderId) body.takeProfitOrderId = details.takeProfitOrderId;
  if (details?.compensationState) body.compensationState = details.compensationState;
  if (details?.compensationOrderId) body.compensationOrderId = details.compensationOrderId;
  return body;
}

async function reportOutcome(
  post: (path: string, body: unknown) => Promise<unknown>,
  job: Pick<RiskApprovedJob, "jobId" | "leaseToken" | "leaseAttempt">,
  status: ExecutionReportStatus,
  orderId?: string | null,
  errorCode?: string | null,
  details?: Pick<ExecutionReport, "stopLossOrderId" | "takeProfitOrderId" | "compensationState" | "compensationOrderId">,
): Promise<void> {
  await post("/api/internal/report-execution", reportBody(job, status, orderId, errorCode, details));
}

function hasLease(job: Partial<RiskApprovedJob>): job is Pick<RiskApprovedJob, "jobId" | "leaseToken" | "leaseAttempt" | "leaseExpiresAt" | "leaseAction"> {
  return Number.isInteger(job.jobId)
    && typeof job.leaseToken === "string" && job.leaseToken.length > 0
    && Number.isInteger(job.leaseAttempt)
    && Number.isFinite(job.leaseExpiresAt)
    && (job.leaseAction === "submit" || job.leaseAction === "reconcile");
}

function isDuplicateError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("duplicate order")
    || lower.includes("order already exists")
    || lower.includes("already placed")
    || lower.includes("duplicate client order id")
    || lower.includes("client order id already")
    || lower.includes("order would immediately reduce");
}

async function bestEffortReport(
  post: (path: string, body: unknown) => Promise<unknown>,
  job: Pick<RiskApprovedJob, "jobId" | "leaseToken" | "leaseAttempt">,
  status: ExecutionReportStatus,
  orderId?: string | null,
  errorCode?: string | null,
  details?: Pick<ExecutionReport, "stopLossOrderId" | "takeProfitOrderId" | "compensationState" | "compensationOrderId">,
): Promise<boolean> {
  try {
    await reportOutcome(post, job, status, orderId, errorCode, details);
    return true;
  } catch (error: any) {
    errorsTotal++;
    lastError = error?.message ?? String(error);
    console.warn(`[exec-server] Report-back failed for job #${job.jobId}: ${String(lastError).slice(0, 120)}`);
    return false;
  }
}

function leaseOwnedOrder(
  job: RiskApprovedJob,
  prepared: Extract<ExecutionJobPreparation, { status: "ready" }>,
  orderId: string,
  now: number,
  previous?: LeaseOwnedOrder,
): LeaseOwnedOrder {
  return {
    jobId: job.jobId,
    idempotencyKey: job.idempotencyKey,
    orderId,
    exchange: job.connExchange,
    symbol: job.symbol,
    userId: job.userId,
    cexConnectionId: job.cexConnectionId,
    tradeIntentId: job.tradeIntentId,
    submittedAt: previous?.submittedAt ?? now,
    pollCount: previous?.pollCount ?? 0,
    apiKey: prepared.apiKey,
    apiSecret: prepared.apiSecret,
    passphrase: prepared.passphrase,
    environment: prepared.environment,
    leaseToken: job.leaseToken,
    leaseAttempt: job.leaseAttempt,
    leaseExpiresAt: job.leaseExpiresAt,
    leaseAction: job.leaseAction,
  };
}

async function processLeaseSubmit(
  job: RiskApprovedJob,
  killState: KillState,
  mode: Exclude<ExecutionMode, "disabled">,
  post: (path: string, body: unknown) => Promise<unknown>,
  prepareJob: typeof prepareExecutionJob,
  state: Map<number, LeaseOwnedOrder>,
  now: () => number,
): Promise<void> {
  if (!hasLease(job) || job.leaseAction !== "submit") return;
  if (killState.perConnectionKills[job.connId] || job.connKillSwitchActive) {
    await bestEffortReport(post, job, "failed", null, "connection_kill_switch");
    return;
  }

  const notional = job.notionalUsd ? Number(job.notionalUsd) : 0;
  if (!Number.isFinite(notional) || notional <= 0) {
    errorsTotal++;
    await bestEffortReport(post, job, "failed", null, "invalid_notional");
    return;
  }
  const quantity = job.quantity;
  if (!quantity || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    errorsTotal++;
    await bestEffortReport(post, job, "failed", null, "zero_quantity");
    return;
  }
  if ([...state.values()].some((order) => order.jobId === job.jobId || order.idempotencyKey === job.idempotencyKey)) {
    await bestEffortReport(post, job, "failed", null, "duplicate_in_flight");
    return;
  }

  try {
    const prepared = await prepareJob(
      mode,
      job.connExchange,
      { apiKey: job.connEncryptedApiKey, apiSecret: job.connEncryptedApiSecret, passphrase: job.connEncryptedPassphrase },
      ENCRYPTION_KEY ?? "",
    );
    if (prepared.status === "disabled") return;
    const leverage = job.leverage ?? job.intentTargetLeverage ?? 3;
    if (leverage > 0) {
      try { await prepared.client.setLeverage(job.symbol, leverage); } catch { /* best effort */ }
    }
    const request: CexOrderRequest = {
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

    let result: CexOrderResult;
    try {
      result = await prepared.client.placeOrder(request);
    } catch (error: any) {
      if (error instanceof CexProtectionError) {
        const stopLoss = error.outcome.protection.stopLoss;
        const takeProfit = error.outcome.protection.takeProfit;
        const compensationState = error.outcome.compensation.state;
        const emergencyClose = error.outcome.compensation.emergencyClose;
        ordersSubmitted++;
        ordersRejected++;
        errorsTotal++;
        await bestEffortReport(
          post,
          job,
          "failed",
          error.outcome.entryOrderId,
          compensationState === "completed"
            ? "protection_failed_compensated"
            : "protection_failed_uncompensated",
          {
            stopLossOrderId: stopLoss.status === "accepted" ? stopLoss.orderId : undefined,
            takeProfitOrderId: takeProfit.status === "accepted" ? takeProfit.orderId : undefined,
            compensationState,
            compensationOrderId: emergencyClose.status === "accepted" ? emergencyClose.orderId : undefined,
          },
        );
        return;
      }
      const message = String(error?.message ?? "order_submission_failed").slice(0, 300);
      if (isDuplicateError(message)) {
        ordersSubmitted++;
        errorsTotal++;
        // A duplicate response does not prove that the entry or its protection
        // exists. Stop automatic retries and require exact operational repair.
        await bestEffortReport(post, job, "failed", null, "duplicate_order_unresolved");
        return;
      }
      ordersSubmitted++;
      ordersRejected++;
      errorsTotal++;
      lastError = message;
      await bestEffortReport(post, job, "failed", null, "order_submission_failed");
      return;
    }

    ordersSubmitted++;
    if (result.status === "rejected") {
      ordersRejected++;
      await bestEffortReport(post, job, "failed", result.orderId, "exchange_rejected");
      return;
    }
    if (result.protection?.status === "protected") {
      ordersFilled++;
      await bestEffortReport(post, job, "protected", result.orderId, null, {
        stopLossOrderId: result.protection.stopLossOrderId,
        takeProfitOrderId: result.protection.takeProfitOrderId,
      });
      return;
    }

    // Enabled automated adapters must return durable protection identifiers.
    ordersRejected++;
    errorsTotal++;
    await bestEffortReport(post, job, "failed", result.orderId, "protection_contract_missing");
    return;
  } catch (error: any) {
    errorsTotal++;
    lastError = error?.message ?? String(error);
    await bestEffortReport(post, job, "failed", null, "unsupported_exchange");
  }
}

async function processLeaseReconcile(
  job: RiskApprovedJob,
  mode: Exclude<ExecutionMode, "disabled">,
  post: (path: string, body: unknown) => Promise<unknown>,
  prepareJob: typeof prepareExecutionJob,
  state: Map<number, LeaseOwnedOrder>,
  now: () => number,
): Promise<void> {
  if (!hasLease(job) || job.leaseAction !== "reconcile") return;
  const previous = state.get(job.jobId);
  const orderId = job.orderId ?? previous?.orderId;
  if (!orderId) {
    await bestEffortReport(post, job, "unresolved", null, "fill_not_confirmed");
    return;
  }

  try {
    const prepared = await prepareJob(
      mode,
      job.connExchange,
      { apiKey: job.connEncryptedApiKey, apiSecret: job.connEncryptedApiSecret, passphrase: job.connEncryptedPassphrase },
      ENCRYPTION_KEY ?? "",
    );
    if (prepared.status === "disabled") return;
    const current = leaseOwnedOrder(job, prepared, orderId, now(), previous);
    current.pollCount++;
    state.set(job.jobId, current);
    if (current.pollCount > MAX_ORDER_POLLS) {
      await bestEffortReport(post, job, "unresolved", orderId, "fill_not_confirmed");
      state.delete(job.jobId);
      ordersTracked = state.size;
      return;
    }

    const exact = await reconcileExactOrder(prepared.client, {
      symbol: job.symbol,
      orderId,
      clientOrderId: job.idempotencyKey,
    });
    const exactStatus = exact.status === "matched" ? String(exact.order.status ?? "").toUpperCase() : "";
    if (exact.status === "matched" && exactStatus === "FILLED") {
      if (await bestEffortReport(post, job, "filled", orderId)) {
        state.delete(job.jobId);
        ordersFilled++;
        ordersTracked = state.size;
      }
      return;
    }
    if (exact.status === "matched" && ["CANCELED", "CANCELLED", "REJECTED", "EXPIRED"].includes(exactStatus)) {
      await bestEffortReport(post, job, "failed", orderId, "exchange_rejected");
      state.delete(job.jobId);
      ordersTracked = state.size;
      return;
    }
    await bestEffortReport(post, job, "unresolved", orderId, "fill_not_confirmed");
  } catch (error: any) {
    errorsTotal++;
    lastError = error?.message ?? String(error);
    await bestEffortReport(post, job, "unresolved", orderId, "exchange_reconcile_error");
  }
}

export async function runExecutionPoll(dependencies: ExecutionPollDependencies = {}): Promise<void> {
  const start = Date.now();
  pollCount++;
  const mode = dependencies.mode ?? executionMode;
  const get = dependencies.get ?? internalGet;
  const post = dependencies.post ?? internalPost;
  const state = dependencies.state ?? leaseInFlightOrders;
  const prepareJob = dependencies.prepareJob ?? prepareExecutionJob;
  const now = dependencies.now ?? (() => Date.now());
  let cycleSucceeded = false;

  try {
    const killState = await get<KillState>("/api/internal/kill-state");
    if (killState.globalKill) {
      console.log("[exec-server] Global kill active — skipping poll cycle");
      cycleSucceeded = true;
      return;
    }
    // Disabled mode must not claim submit or reconcile leases.
    if (mode === "disabled") {
      cycleSucceeded = true;
      return;
    }

    const submitResponse = await get<ExecutionPollResponse>("/api/internal/risk-approved-jobs?action=submit");
    jobsClaimed += submitResponse.jobs?.length ?? 0;
    staleLeasesReclaimed += (submitResponse.jobs ?? []).filter((job) => job.leaseAttempt > 1).length;
    for (const job of submitResponse.jobs ?? []) {
      await processLeaseSubmit(job, killState, mode, post, prepareJob, state, now);
    }
    const reconcileResponse = await get<ExecutionPollResponse>("/api/internal/risk-approved-jobs?action=reconcile");
    jobsClaimed += reconcileResponse.jobs?.length ?? 0;
    staleLeasesReclaimed += (reconcileResponse.jobs ?? []).filter((job) => job.leaseAttempt > 1).length;
    for (const job of reconcileResponse.jobs ?? []) {
      await processLeaseReconcile(job, mode, post, prepareJob, state, now);
    }
    ordersTracked = state.size;
    cycleSucceeded = true;
  } catch (error: any) {
    errorsTotal++;
    lastError = error?.message ?? String(error);
    console.error("[exec-server] Poll error:", lastError);
  } finally {
    lastPollDuration = Date.now() - start;
    if (cycleSucceeded) {
      lastSuccessfulPollAt = now();
      lastError = null;
    }
  }
}

async function poll() {
  await runExecutionPoll();
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`[exec-server] Starting...`);
  console.log(`[exec-server] Mode: ${executionMode}`);
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
    console.log(`[exec-server] In-flight at shutdown: ${leaseInFlightOrders.size} orders`);
    healthy = false;
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (isDirectExecution) {
  main().catch((e) => {
    console.error("[exec-server] Fatal:", e?.message);
    process.exit(1);
  });
}

/* ── Kline Pipeline (VPS → Worker → D1 → Analysis Engine) ────────────────
 * Fetches klines from Binance on VPS (no geo-block), pushes to Worker for
 * D1 storage, then triggers analysis engine. */

const BINANCE_URL = "https://fapi.binance.com";
const KLINE_PAIRS = 15;
const KLINE_BARS = 200;
const KLINE_TIMEFRAME = "4h";
const KLINES_CHUNK = 85;

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

export function parseBinanceKlines(symbol: string, interval: string, payload: unknown): BinanceKline[] {
  if (!Array.isArray(payload)) throw new Error("Invalid Binance kline payload");

  return payload.map((row) => {
    if (!Array.isArray(row)
      || row.length < 6
      || typeof row[0] !== "number"
      || !Number.isFinite(row[0])
      || typeof row[1] !== "string"
      || typeof row[2] !== "string"
      || typeof row[3] !== "string"
      || typeof row[4] !== "string"
      || typeof row[5] !== "string") {
      throw new Error("Invalid Binance kline payload");
    }

    return {
      symbol, timeframe: interval,
      timestamp: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5],
    };
  });
}

async function fetchBinanceKlines(symbol: string, interval: string, limit: number): Promise<BinanceKline[]> {
  const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
  const headers: Record<string, string> = {};
  const apiKey = (process.env.BINANCE_API_KEY ?? "").trim();
  if (apiKey) headers["X-MBX-APIKEY"] = apiKey;
  const res = await fetch(`${BINANCE_URL}/fapi/v1/klines?${params}`, { headers });
  if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol}`);
  return parseBinanceKlines(symbol, interval, await res.json());
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

export type KlinePipelineDependencies = {
  fetchTopSymbols?: (limit: number) => Promise<string[]>;
  fetchKlines?: (symbol: string, interval: string, limit: number) => Promise<BinanceKline[]>;
  seedKlines?: (klines: BinanceKline[]) => Promise<unknown>;
  triggerAnalysis?: () => Promise<unknown>;
  wait?: (ms: number) => Promise<void>;
};

export async function runKlinePipeline(dependencies: KlinePipelineDependencies = {}) {
  const start = Date.now();
  console.log("[kline-pipeline] Starting...");
  const fetchSymbols = dependencies.fetchTopSymbols ?? fetchTopSymbols;
  const fetchKlines = dependencies.fetchKlines ?? fetchBinanceKlines;
  const seedKlines = dependencies.seedKlines ?? (async (klines: BinanceKline[]) => {
    await internalPost("/api/internal/seed-klines", { klines });
  });
  const triggerAnalysis = dependencies.triggerAnalysis ?? (async () => {
    if (!process.env.ADMIN_API_KEY) return;
    await fetch(`${WORKER_URL}/api/analysis/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-api-key": process.env.ADMIN_API_KEY },
    }).catch(() => {});
  });
  const wait = dependencies.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    const symbols = await fetchSymbols(KLINE_PAIRS);
    let total = 0;
    for (const symbol of symbols) {
      try {
        const klines = await fetchKlines(symbol, KLINE_TIMEFRAME, KLINE_BARS);
        for (let i = 0; i < klines.length; i += KLINES_CHUNK) {
          const chunk = klines.slice(i, i + KLINES_CHUNK);
          await seedKlines(chunk);
          total += chunk.length;
        }
      } catch { /* individual symbol failure is non-fatal */ }
      await wait(200);
    }
    if (total === 0) {
      console.log(`[kline-pipeline] Done: 0 klines in ${Date.now() - start}ms — skipping analysis`);
      return;
    }
    console.log(`[kline-pipeline] Done: ${total} klines in ${Date.now() - start}ms — triggering analysis`);
    await triggerAnalysis();
  } catch (e: any) {
    console.error("[kline-pipeline] Error:", e?.message);
    errorsTotal++;
    lastError = e?.message ?? String(e);
  }
}
