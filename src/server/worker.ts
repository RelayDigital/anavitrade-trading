import { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { z } from "zod";
import { appRouter } from "./routers";
import { createContext } from "./context";
import type { Env } from "./_core/env";
import { runCoinlegsScraper } from "./coinlegs-scraper";
import { generateSignals } from "./signals/generator";
import { validateSignalOutcomes, getOutcomeStats } from "./outcome/validator";
import { validateAllSignalOutcomes } from "./analysis/outcome/analyze-outcome";
import { crystallizeFees } from "./fee/engine";
import { setDbEnv } from "./db";
import { runAnalysisEngine } from "./analysis/engine";
import { querySignals, getSignalStats, compareSources } from "./analysis/query";
import { backfillCoinlegsToAnalysisSignals } from "./analysis/bridge";
import { runBacktest, compareToBaseline, DEFAULT_BACKTEST_CONFIG } from "./analysis/backtest";
import { runParameterSweep, selectOptimalParams, DEFAULT_SWEEP_CONFIG } from "./analysis/parameter-sweep";
import { runPaperEngine, validatePaperOutcomes } from "./analysis/paper-trade";
import { runMirror, compareWithCoinlegs } from "./analysis/mirror/engine";
import { runAsterLiveProof } from "./aster/liveProof";
import { verifyGlobalKill } from "./execution/riskEngine";
import { claimExecutionJobs, LeaseConflictError, reportExecutionOutcome, type LeaseAction } from "./execution/lease";
import { createWorkerSecurityMiddleware } from "./security/workerMiddleware";
import { WorkerMetricsCollector, createMetricsEndpoint, createWorkerMetricsMiddleware } from "./observability/workerMetrics";

const ADMIN_ROUTE_PREFIXES = [
  "/api/analysis/", "/api/signals/backfill", "/api/signals/generate", "/api/scraper/",
  "/api/backtest/", "/api/paper-trade/", "/api/mirror/", "/api/engine/",
  "/api/outcome/validate", "/api/aster/live-proof", "/api/fee/",
] as const;
const metrics = new WorkerMetricsCollector({ knownRoutes: [
  "/api/health", "/api/live", "/metrics", "/api/trpc/*", "/api/internal/risk-approved-jobs",
  "/api/internal/report-execution", "/api/internal/pending-intents", "/api/internal/active-connections",
  "/api/internal/kill-state", "/api/internal/seed-klines",
] });

export const app = new Hono<{ Bindings: Env }>();

app.use("/*", createWorkerMetricsMiddleware(metrics));
app.use("/*", async (c, next) => createWorkerSecurityMiddleware({
  allowedOrigins: c.env.CORS_ALLOWED_ORIGINS ?? "",
  production: c.env.APP_ENVIRONMENT === "production",
  rateLimitBinding: c.env.RATE_LIMITER,
  machineSecrets: { internal: c.env.INTERNAL_SECRET, admin: c.env.ADMIN_API_KEY },
  adminRoutePrefixes: ADMIN_ROUTE_PREFIXES,
  metrics,
})(c, next));

app.use("/api/trpc/*", trpcServer({
  router: appRouter,
  endpoint: "/api/trpc",
  createContext: (opts, c) => createContext(c.env, opts, c),
}));

app.get("/api/live", (c) => c.json({ status: "ok" }));
app.get("/api/health", async (c) => {
  try {
    const schema = await c.env.DB.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'execution_jobs' LIMIT 1",
    ).first<{ ok: number }>();
    if (!schema) return c.json({ status: "unavailable" }, 503);
    await c.env.DB.prepare("SELECT leaseToken FROM execution_jobs LIMIT 1").first();
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch {
    return c.json({ status: "unavailable" }, 503);
  }
});
app.get("/metrics", (c, next) => createMetricsEndpoint(metrics, { token: c.env.METRICS_TOKEN ?? "" })(c, next));

/** Manual trigger — run full analysis engine (admin only). */
app.post("/api/analysis/run", async (c) => {
  try {
    setDbEnv(c.env);
    const result = await runAnalysisEngine();
    return c.json(result);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/* ─── Unified Signal Dashboard ─────────────────────────────────────── */

/** Query unified signals with filtering and pagination (public read-only). */
app.get("/api/signals", async (c) => {
  setDbEnv(c.env);
  const params = c.req.query();
  const result = await querySignals({
    source: params.source,
    tier: params.tier,
    timeframe: params.timeframe,
    symbol: params.symbol,
    direction: params.direction,
    minScore: params.minScore ? Number(params.minScore) : undefined,
    since: params.since ? Number(params.since) : undefined,
    until: params.until ? Number(params.until) : undefined,
    dispatched: params.dispatched !== undefined ? params.dispatched === "true" : undefined,
    limit: params.limit ? Number(params.limit) : 50,
    offset: params.offset ? Number(params.offset) : 0,
  });
  return c.json(result);
});

/** Aggregate signal stats (public). */
app.get("/api/signals/stats", async (c) => {
  setDbEnv(c.env);
  const since = c.req.query("since") ? Number(c.req.query("since")) : undefined;
  const stats = await getSignalStats(since);
  return c.json(stats);
});

/** Side-by-side comparison of Coinlegs vs ICR signal quality (public). */
app.get("/api/signals/compare", async (c) => {
  setDbEnv(c.env);
  const comparison = await compareSources();
  return c.json(comparison);
});

/** Trigger backfill of historical Coinlegs signals into analysis_signals (admin only). */
app.post("/api/signals/backfill", async (c) => {
  try {
    setDbEnv(c.env);
    const result = await backfillCoinlegsToAnalysisSignals();
    return c.json(result);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/** Manual trigger — run coinlegs scraper + dispatch. */
app.post("/api/scraper/run", async (c) => {
  try {
    setDbEnv(c.env);
    const result = await runCoinlegsScraper();
    return c.json(result);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/** Manual trigger — self-hosted native signal generator (no coinlegs dependency). */
app.post("/api/signals/generate", async (c) => {
  try {
    setDbEnv(c.env);
    const result = await generateSignals();
    return c.json(result);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/** Backfill historical signals — paginate the coinlegs API across a date range
 *  for market intelligence and outcome validation. */
app.post("/api/scraper/backfill", async (c) => {
  try {
    setDbEnv(c.env);
    const body = await c.req.json().catch(() => ({}));
    const startDate = body.startDate ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const endDate = body.endDate ?? new Date().toISOString();
    const pages = Math.min(body.pages ?? 1, 5);
    const results: any[] = [];
    for (let page = 0; page < pages; page++) {
      const res = await fetch("https://api.coinlegs.com/api/Exchange/SelectDetections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Exchg: "Binance", Market: "USDT",
          IncludeBuySignal: true, IncludeNeutralSignal: false, IncludeSellSignal: false,
          DetectionIds: [47, 9, 8, 46, 7],
          Periods: ["5m", "15m", "30m", "1h", "4h", "1d", "1w"],
          MarketName: "", __Key: "scraper", Sorting: {},
          StartDate: startDate, EndDate: endDate,
          Page: page, RowsInPage: 100,
        }),
      });
      if (!res.ok) {
        results.push({ page, error: `HTTP ${res.status}`, signals: 0 });
        continue;
      }
      const j = await res.json() as any;
      const signals = j?.Data?.Signals ?? j?.signals ?? [];
      // Persist the exact historical page that was fetched. Historical rows are
      // scored/bridged but never dispatched to execution.
      const inserted = await runCoinlegsScraper({
        signals: Array.isArray(signals) ? signals : [],
        source: `backfill:${page}`,
        dispatch: false,
      });
      results.push({ page, fetched: signals.length, dataKeys: Object.keys(j?.Data ?? {}), inserted: inserted.signalsInserted });
    }
    return c.json({ backfill: { startDate, endDate, pages, results } });
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/* ─── Backtest & Validation Harness ──────────────────────────────── */

/** Run a backtest on historical kline data (admin only). */
app.post("/api/backtest/run", async (c) => {
  try {
    setDbEnv(c.env);
    const body = await c.req.json();
    const config = { ...DEFAULT_BACKTEST_CONFIG, ...body };
    const result = await runBacktest(config);
    return c.json(result);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/** Run a parameter sweep (admin only, may be slow). */
app.post("/api/backtest/sweep", async (c) => {
  try {
    setDbEnv(c.env);
    const body = await c.req.json();
    const sweepConfig = { ...DEFAULT_SWEEP_CONFIG, ...body };
    const results = await runParameterSweep(sweepConfig);
    const optimal = selectOptimalParams(results, body.minSignals ?? 50);
    return c.json({ results, optimal });
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/** Compare ICR vs baseline MA crossover strategy (admin only). */
app.get("/api/backtest/compare", async (c) => {
  try {
    setDbEnv(c.env);
    const symbol = c.req.query("symbol") ?? "BTCUSDT";
    const timeframe = c.req.query("timeframe") ?? "4h";
    const lookbackBars = Number(c.req.query("lookbackBars") ?? 500);
    const result = await compareToBaseline(symbol, timeframe, lookbackBars);
    return c.json(result);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/** Run engine in paper-trading mode — records signals with dispatched=0 (admin only). */
app.post("/api/paper-trade/run", async (c) => {
  try {
    setDbEnv(c.env);
    const result = await runPaperEngine();
    return c.json(result);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/** Validate paper trade outcomes against actual Binance klines (admin only). */
app.get("/api/paper-trade/outcomes", async (c) => {
  try {
    setDbEnv(c.env);
    const trackHours = Number(c.req.query("trackHours") ?? 24);
    const result = await validatePaperOutcomes(trackHours);
    return c.json(result);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/* ─── Coinlegs Mirror ─────────────────────────────────────────────────────── */

/**
 * Run the Coinlegs mirror engine — detects buy signals locally on Binance
 * klines and compares against actual Coinlegs signals.
 *
 * Optional query params:
 *   symbols: comma-separated subset (default: full watchlist)
 *   timeframes: comma-separated subset (default: all 7)
 *   compare: "true" to run side-by-side comparison with DB Coinlegs signals
 *   since: ms timestamp for comparison window start (default: 2h ago)
 *
 * Admin-only.
 */
app.post("/api/mirror/run", async (c) => {
  try {
    setDbEnv(c.env);
    const q = c.req.query();

    const symbols = q.symbols
      ? q.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
      : undefined;
    const timeframes = q.timeframes
      ? q.timeframes.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;
    const doCompare = q.compare === "true";
    const since = q.since ? Number(q.since) : undefined;

    const startedAt = Date.now();
    const mirrorResults = await runMirror(symbols, timeframes);
    const elapsedMs = Date.now() - startedAt;

    const totalDetections = mirrorResults.reduce(
      (sum, r) => sum + r.detections.length,
      0,
    );
    const symbolsWithSignals = mirrorResults.filter(
      (r) => r.detections.length > 0,
    ).length;

    const response: Record<string, unknown> = {
      status: "success",
      elapsedMs,
      symbolsScanned: mirrorResults.length,
      symbolsWithSignals,
      totalDetections,
      results: mirrorResults.map((r) => ({
        symbol: r.symbol,
        timeframe: r.timeframe,
        detections: r.detections.map((d) => ({
          indicator: d.indicatorName,
          typeId: d.typeId,
          confidence: d.confidence,
          thesis: d.thesis,
          price: d.price,
          timestamp: d.candleTimestamp,
          score: r.scoredDetections.find(
            (sd) => sd.typeId === d.typeId,
          )?.score ?? null,
        })),
      })),
    };

    // Run comparison if requested (compares stored mirror detections against Coinlegs)
    if (doCompare) {
      const comparison = await compareWithCoinlegs(since);
      response.comparison = {
        precision: Math.round(comparison.precision * 100) / 100,
        recall: Math.round(comparison.recall * 100) / 100,
        f1: Math.round(comparison.f1 * 100) / 100,
        avgLeadTimeMs: Math.round(comparison.avgLeadTimeMs),
        medianLeadTimeMs: Math.round(comparison.medianLeadTimeMs),
        matchedCount: comparison.matched.length,
        ourOnlyCount: comparison.ourOnly.length,
        coinlegsOnlyCount: comparison.coinlegsOnly.length,
        // Show a few examples
        matches: comparison.matched.slice(0, 5).map((m) => ({
          ours: `${m.ours.symbol} ${m.ours.timeframe} ${m.ours.indicatorName}`,
          theirs: m.theirs,
          leadTimeMs: Math.round(m.leadTimeMs),
        })),
        ourOnly: comparison.ourOnly.slice(0, 5).map((d) =>
          `${d.symbol} ${d.timeframe} ${d.indicatorName}`,
        ),
        coinlegsOnly: comparison.coinlegsOnly.slice(0, 5),
      };
    }

    return c.json(response);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/**
 * Compare mirror detections against Coinlegs signals.
 * Reads from stored mirror detections in analysis_signals (source "coinlegs_mirror")
 * and Coinlegs signals from coinlegs_signals for the same time window.
 *
 * Query params:
 *   since: ms timestamp for comparison window start (default: 2h ago)
 *
 * Admin-only.
 */
app.get("/api/mirror/compare", async (c) => {
  try {
    setDbEnv(c.env);
    const since = c.req.query("since") ? Number(c.req.query("since")) : undefined;

    const comparison = await compareWithCoinlegs(since);

    return c.json({
      status: "success",
      comparison: {
        precision: Math.round(comparison.precision * 100) / 100,
        recall: Math.round(comparison.recall * 100) / 100,
        f1: Math.round(comparison.f1 * 100) / 100,
        avgLeadTimeMs: Math.round(comparison.avgLeadTimeMs),
        medianLeadTimeMs: Math.round(comparison.medianLeadTimeMs),
        matchedCount: comparison.matched.length,
        ourOnlyCount: comparison.ourOnly.length,
        coinlegsOnlyCount: comparison.coinlegsOnly.length,
        matches: comparison.matched.slice(0, 10).map((m) => ({
          ours: `${m.ours.symbol} ${m.ours.timeframe} ${m.ours.indicatorName}`,
          theirs: m.theirs,
          leadTimeMs: Math.round(m.leadTimeMs),
        })),
        ourOnly: comparison.ourOnly.slice(0, 10).map((d) =>
          `${d.symbol} ${d.timeframe} ${d.indicatorName}`,
        ),
        coinlegsOnly: comparison.coinlegsOnly.slice(0, 10),
      },
    });
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/** Engine health and aggregate stats (admin only). */
app.get("/api/engine/stats", async (c) => {
  try {
    setDbEnv(c.env);
    const stats = await getSignalStats();
    return c.json({
      ...stats,
      engine: "analysis-engine-v1",
    });
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/* ─── Outcome Validator ──────────────────────────────────────────── */

/** Manual trigger — validate signal outcomes against Binance klines. */
app.post("/api/outcome/validate", async (c) => {
  try {
    setDbEnv(c.env);
    const result = await validateSignalOutcomes();
    return c.json(result);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/** Dashboard stats — aggregate outcome validation metrics. */
app.get("/api/outcome/stats", async (c) => {
  try {
    setDbEnv(c.env);
    const result = await getOutcomeStats();
    return c.json(result);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});


/** Guarded real Aster proof: tiny non-marketable LIMIT order followed by cancel. */
app.post("/api/aster/live-proof", async (c) => {
  try {
    setDbEnv(c.env);
    const body = await c.req.json().catch(() => ({}));
    const result = await runAsterLiveProof({
      confirm: String(body.confirm ?? ""),
      account: String(body.account ?? ""),
      symbol: String(body.symbol ?? "BTCUSDT"),
      maxNotionalUsd: Number(body.maxNotionalUsd ?? 0),
      limitOffsetBps: Number(body.limitOffsetBps ?? 0),
      side: body.side === "SELL" ? "SELL" : "BUY",
    });
    return c.json({ status: "ok", result });
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message ?? String(e) }, 400);
  }
});

/* ─── Fee Engine ─────────────────────────────────────────────────── */

/** Protected admin endpoint – manually trigger fee crystallization. */
app.post("/api/fee/crystallize", async (c) => {
  try {
    setDbEnv(c.env);
    const result = await crystallizeFees();
    console.log("[fee-cron]", JSON.stringify(result));
    return c.json(result);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
});

/* --- Execution Server Internal API (VPS to Worker) --------------------
 * All endpoints require x-internal-secret header matching INTERNAL_SECRET.
 * The VPS fetches pending intents, active connections, kill state, and
 * reports execution results back.  Credentials are stored encrypted at rest
 * and decrypted ONLY on the VPS.  */

/** Return pending TradeIntents (status = "created") -- VPS polls this. */
app.get("/api/internal/pending-intents", async (c) => {
  try {
    setDbEnv(c.env);
    const { getDb } = await import("./db");
    const { tradeIntents } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const intents = await getDb().select().from(tradeIntents).where(eq(tradeIntents.status, "created")).limit(50);
    return c.json({ intents });
  } catch (e: any) { return c.json({ status: "error", message: e?.message }, 500); }
});

/**
 * Claim risk-approved CEX execution jobs before returning them to the VPS. The
 * lease prevents a second poller from receiving the same job concurrently.
 */
app.get("/api/internal/risk-approved-jobs", async (c) => {
  try {
    const actionValue = c.req.query("action") ?? "submit";
    if (actionValue !== "submit" && actionValue !== "reconcile") {
      return c.json({ status: "error", code: "invalid_lease_action" }, 400);
    }
    const action = actionValue as LeaseAction;
    const owner = c.env.EXECUTION_LEASE_OWNER?.trim() || "anavitrade-worker";
    const token = crypto.randomUUID();
    const claimed = await claimExecutionJobs(c.env.DB, { owner, action, token });
    if (claimed.length === 0) return c.json({ jobs: [] });

    const jobIds = claimed.map((job) => job.id);
    const placeholders = jobIds.map(() => "?").join(", ");
    const result = await c.env.DB.prepare(`
      SELECT execution_jobs.id AS jobId, execution_jobs.tradeIntentId, execution_jobs.userId,
        execution_jobs.cexConnectionId, execution_jobs.symbol, execution_jobs.side,
        execution_jobs.orderType, execution_jobs.notionalUsd, execution_jobs.quantity,
        execution_jobs.leverage, execution_jobs.limitPrice, execution_jobs.idempotencyKey,
        execution_jobs.orderId, execution_jobs.leaseToken, execution_jobs.leaseAttempt,
        execution_jobs.leaseExpiresAt, execution_jobs.leaseAction,
        cex_connections.id AS connId, cex_connections.exchange AS connExchange,
        cex_connections.encryptedApiKey AS connEncryptedApiKey,
        cex_connections.encryptedApiSecret AS connEncryptedApiSecret,
        cex_connections.encryptedPassphrase AS connEncryptedPassphrase,
        cex_connections.killSwitchActive AS connKillSwitchActive, cex_connections.label AS connLabel,
        trade_intents.stopLossPrice AS intentStopLossPrice,
        trade_intents.takeProfitPrice AS intentTakeProfitPrice,
        trade_intents.targetLeverage AS intentTargetLeverage
      FROM execution_jobs
      INNER JOIN cex_connections ON execution_jobs.cexConnectionId = cex_connections.id
      INNER JOIN trade_intents ON execution_jobs.tradeIntentId = trade_intents.id
      WHERE execution_jobs.id IN (${placeholders}) AND execution_jobs.leaseToken = ?
        AND execution_jobs.leaseOwner = ? AND execution_jobs.leaseAction = ?
      ORDER BY execution_jobs.queuedAt ASC, execution_jobs.id ASC
    `).bind(...jobIds, token, owner, action).all<Record<string, unknown>>();
    return c.json({ jobs: result.results ?? [] });
  } catch {
    return c.json({ status: "error", code: "execution_claim_unavailable" }, 500);
  }
});

/** Active CEX connections with encrypted credentials (VPS decrypts locally). */
app.get("/api/internal/active-connections", async (c) => {
  try {
    setDbEnv(c.env);
    const { getDb } = await import("./db");
    const { cexConnections } = await import("../drizzle/schema");
    const { and, eq } = await import("drizzle-orm");
    const rows = await getDb().select().from(cexConnections)
      .where(and(eq(cexConnections.status, "active"), eq(cexConnections.copytradeEnabled, true)));
    const connections = rows.map((r) => ({
      id: r.id, userId: r.userId, exchange: r.exchange,
      encryptedApiKey: r.encryptedApiKey, encryptedApiSecret: r.encryptedApiSecret,
      encryptedPassphrase: r.encryptedPassphrase, killSwitchActive: r.killSwitchActive, label: r.label,
    }));
    return c.json({ connections });
  } catch (e: any) { return c.json({ status: "error", message: e?.message }, 500); }
});

/** Kill switch state — reads global kill from DB (survives Worker restarts). */
app.get("/api/internal/kill-state", async (c) => {
  try {
    setDbEnv(c.env);
    const { getDb } = await import("./db");
    const { cexConnections } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const connections = await getDb().select({ id: cexConnections.id, killSwitchActive: cexConnections.killSwitchActive })
      .from(cexConnections).where(eq(cexConnections.status, "active"));
    const perConnectionKills: Record<number, boolean> = {};
    for (const c of connections) perConnectionKills[c.id] = Boolean(c.killSwitchActive);
    const globalKill = await verifyGlobalKill();
    return c.json({ globalKill, perConnectionKills });
  } catch (e: any) { return c.json({ status: "error", message: e?.message }, 500); }
});

const executionReportBase = z.object({
  reportId: z.string().min(1),
  jobId: z.number().int().positive(),
  leaseToken: z.string().min(1),
  leaseAttempt: z.number().int().positive(),
  stopLossOrderId: z.string().min(1).optional(),
  takeProfitOrderId: z.string().min(1).optional(),
  compensationState: z.enum(["completed", "failed"]).optional(),
  compensationOrderId: z.string().min(1).optional(),
});
const executionReportSchema = z.discriminatedUnion("status", [
  executionReportBase.extend({ status: z.literal("submitted"), orderId: z.string().min(1), errorCode: z.never().optional() }).strict(),
  executionReportBase.extend({ status: z.literal("filled"), orderId: z.string().min(1), errorCode: z.never().optional() }).strict(),
  executionReportBase.extend({ status: z.literal("protection_pending"), orderId: z.string().min(1), errorCode: z.never().optional() }).strict(),
  executionReportBase.extend({
    status: z.literal("protected"),
    orderId: z.string().min(1),
    errorCode: z.never().optional(),
    stopLossOrderId: z.string().min(1),
    takeProfitOrderId: z.string().min(1),
  }).strict(),
  executionReportBase.extend({ status: z.literal("failed"), orderId: z.string().min(1).optional(), errorCode: z.string().min(1) }).strict(),
  executionReportBase.extend({ status: z.literal("cancelled"), orderId: z.string().min(1).optional(), errorCode: z.string().min(1).optional() }).strict(),
  executionReportBase.extend({ status: z.literal("unresolved"), orderId: z.string().min(1).optional(), errorCode: z.string().min(1) }).strict(),
]);

/** VPS reports a result only for an active execution lease. */
app.post("/api/internal/report-execution", async (c) => {
  try {
    const body = await c.req.json().catch(() => undefined);
    const parsed = executionReportSchema.safeParse(body);
    if (!parsed.success) return c.json({ status: "error", code: "invalid_execution_report" }, 400);
    const report = await reportExecutionOutcome(c.env.DB, parsed.data);
    metrics.recordExecutionReport("success");
    if (parsed.data.status === "failed" || parsed.data.status === "unresolved") {
      metrics.recordExecutionFailure(parsed.data.errorCode ?? "unknown");
    }
    return c.json(report);
  } catch (error) {
    if (error instanceof LeaseConflictError) {
      metrics.recordExecutionReport("rejected");
      return c.json({ status: "error", code: "execution_lease_conflict" }, 409);
    }
    metrics.recordExecutionReport("failure");
    return c.json({ status: "error", code: "execution_report_unavailable" }, 500);
  }
});

/** VPS pushes klines — bypasses Cloudflare geo-block by fetching locally */
app.post("/api/internal/seed-klines", async (c) => {
  try {
    setDbEnv(c.env);
    const body = await c.req.json();
    const { upsertKlines } = await import("./analysis/kline-repository");
    const count = await upsertKlines(body.klines ?? []);
    return c.json({ status: "ok", inserted: count, total: (body.klines ?? []).length });
  } catch (e: any) { return c.json({ status: "error", message: e?.message }, 500); }
});

/* ── Cron throttle counter (persisted to D1 so it survives Worker restarts) ──
 * Prevents expensive jobs from running on every 60-second fire.  Read from
 * global_settings at the start of each cron run, write back at the end.
 * Reset at 2880 (~48h worth of fires) to avoid integer overflow. */
const CRON_COUNTER_KEY = "cron_counter";

async function loadCronCount(): Promise<number> {
  try {
    const db = (await import("./db")).getDb();
    const { eq } = await import("drizzle-orm");
    const { globalSettings } = await import("../drizzle/schema");
    const [row] = await db.select({ value: globalSettings.value })
      .from(globalSettings)
      .where(eq(globalSettings.key, CRON_COUNTER_KEY))
      .limit(1);
    if (row) return parseInt(row.value, 10) || 0;
  } catch { /* first run — no row yet */ }
  return 0;
}

async function saveCronCount(count: number): Promise<void> {
  try {
    const db = (await import("./db")).getDb();
    const { eq } = await import("drizzle-orm");
    const { globalSettings } = await import("../drizzle/schema");
    const [existing] = await db.select({ id: globalSettings.id })
      .from(globalSettings)
      .where(eq(globalSettings.key, CRON_COUNTER_KEY))
      .limit(1);
    if (existing) {
      await db.update(globalSettings).set({ value: String(count), updatedAt: Date.now() } as any)
        .where(eq(globalSettings.id, existing.id));
    } else {
      await db.insert(globalSettings).values({ key: CRON_COUNTER_KEY, value: String(count), updatedAt: Date.now() } as any)
        .onConflictDoNothing();
    }
  } catch { /* best-effort */ }
}

export default {
  fetch: app.fetch,
  /**
   * Cron trigger — fires every ~60 seconds.
   *
   * Job             | Interval    | Why
   * ----------------|-------------|----------------------
   * Native generator| every fire  | ~500ms local detection — PRIMARY
   * Coinlegs scrape | every fire  | ~300ms API call — SECONDARY
   * Demo sync       | every 5th   | DB batch (signals to demo accounts)
   * Analysis engine | every 5th   | ICR scoring + enrichment
   * Outcome val     | every 15th  | ~1s Binance kline API
   * Fee crystallize | once/day    | quarterly DB, 2&20 model
   */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    setDbEnv(env);
    const _cronCount = await loadCronCount() + 1;

    const results: Record<string, unknown> = {};

    // Native signal generator (every trigger — PRIMARY)
    try {
      const nativeResult = await generateSignals();
      console.log("[native-cron]", JSON.stringify({
        pairs: nativeResult.pairs, signals: nativeResult.signalsDetected,
        tierA: nativeResult.tierA, intents: nativeResult.intentsCreated,
      }));
      results.native = nativeResult;
    } catch (e: any) {
      console.warn("[native-cron] error:", e?.message);
      results.native = { error: e?.message };
    }

    // Coinlegs scraper (every trigger — secondary)
    // If coinlegs fails, fall back to the mirror engine for local detection + dispatch
    try {
      const scraperResult = await runCoinlegsScraper();
      console.log("[coinlegs-cron]", JSON.stringify({
        status: scraperResult.status,
        inserted: scraperResult.signalsInserted,
        intents: scraperResult.intentIds?.length ?? 0,
      }));
      results.scraper = scraperResult;
    } catch (e: any) {
      console.warn("[coinlegs-cron] error:", e?.message);
      console.log("[coinlegs-cron] coinlegs failed — falling back to mirror engine");
      try {
        const { runMirror, dispatchMirrorDetections } = await import("./analysis/mirror/engine");
        const mirrorResult = await runMirror();
        const dispatchResult = await dispatchMirrorDetections(mirrorResult);
        console.log("[mirror-fallback]", JSON.stringify({
          symbols: mirrorResult.length,
          dispatched: dispatchResult.dispatched,
          errors: dispatchResult.errors,
        }));
        results.mirror = { symbols: mirrorResult.length, ...dispatchResult };
      } catch (mErr: any) {
        console.warn("[mirror-fallback] mirror also failed:", mErr?.message);
      }
    }

    // Demo sync -- signals to demo accounts every 5th fire (~5 min)
    if (_cronCount % 5 === 0) {
      try {
        const { syncSignalsToDemoAccounts } = await import("./db");
        const demoResult = await syncSignalsToDemoAccounts();
        console.log("[demo-cron]", JSON.stringify(demoResult));
        results.demo = demoResult;
      } catch (e: any) {
        console.warn("[demo-cron] error:", e?.message);
      }
    }

    // Fee crystallization -- once per ~1440 fires (~24h at 60s interval)
    if (_cronCount % 1440 === 0) {
      const feeResult = await crystallizeFees();
      console.log("[fee-cron]", JSON.stringify(feeResult));
      results.fee = feeResult;
    }

    // Coinlegs outcome validation (tracks claimed maxProfit vs actual) -- every 15th fire
    if (_cronCount % 15 === 0) {
      try {
        const outcomeResult = await validateSignalOutcomes();
        console.log("[outcome-cron]", JSON.stringify({
          validated: outcomeResult.signalsValidated,
          accuracy: outcomeResult.accuracyPct,
          warnings: outcomeResult.warnings,
        }));
        results.outcome = outcomeResult;
      } catch (e: any) {
        console.warn("[outcome-cron] error:", e?.message);
      }
    }

    // Analysis outcome validation (tracks every dispatched signal's SL/TP hit) -- every 15th fire
    if (_cronCount % 15 === 0) {
      try {
        const analysisOutcome = await validateAllSignalOutcomes(50, 48);
        if (analysisOutcome.validated > 0) {
          console.log("[analysis-outcome-cron]", JSON.stringify({
            validated: analysisOutcome.validated,
            winRate: analysisOutcome.winRate,
            avgR: analysisOutcome.avgR,
            bySource: analysisOutcome.bySource,
          }));
        }
        results.analysisOutcome = analysisOutcome;
      } catch (e: any) {
        console.warn("[analysis-outcome-cron] error:", e?.message);
      }
    }

    // Analysis engine (ICR scoring) -- every 5th fire (~5 min at 60s interval)
    if (_cronCount % 5 === 0) {
      try {
        const analysisResult = await runAnalysisEngine();
        console.log("[analysis-cron]", JSON.stringify(analysisResult));
        results.analysis = analysisResult;
      } catch (e: any) {
        console.warn("[analysis-cron] error:", e?.message);
      }
    }

    // Prevent unbounded growth of the throttle counter
    const finalCount = _cronCount >= 2880 ? 1 : _cronCount;
    await saveCronCount(finalCount);

    console.log("[anavitrade-cron]", JSON.stringify(results));
  },
};
