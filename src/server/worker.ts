import { Hono } from "hono";
import { cors } from "hono/cors";
import { trpcServer } from "@hono/trpc-server";
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

const app = new Hono<{ Bindings: Env }>();

// One-time startup flag — warns if ADMIN_API_KEY is missing on first request.
let _adminKeyWarned = false;

app.use("/api/*", cors({
  origin: ["http://localhost:5174", "http://127.0.0.1:5174"],
  credentials: true,
}));

app.use("/api/trpc/*", trpcServer({
  router: appRouter,
  endpoint: "/api/trpc",
  createContext: (opts, c) => createContext(c.env, opts, c),
}));

app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

/** Require admin API key on the request — caller passes it as x-admin-api-key header. */
function requireAdminAuth(c: any, env: Env): Response | null {
  const apiKey = c.req.header("x-admin-api-key") ?? "";
  const expected = env.ADMIN_API_KEY ?? "";
  if (!expected) {
    if (!_adminKeyWarned) { _adminKeyWarned = true; console.warn("[startup] ADMIN_API_KEY is not set — admin endpoints will fail closed"); }
    return c.json({ status: "error", message: "ADMIN_API_KEY not configured on server" }, 500);
  }
  if (apiKey !== expected) {
    return c.json({ status: "error", message: "Unauthorized" }, 401);
  }
  return null;
}

/** Manual trigger — run full analysis engine (admin only). */
app.post("/api/analysis/run", async (c) => {
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
      const inserted = await runCoinlegsScraper(); // reuse the insert + score pipeline
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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
  const authErr = requireAdminAuth(c, c.env);
  if (authErr) return authErr;
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

/* ─── Fee Engine ─────────────────────────────────────────────────── */

/** Protected admin endpoint – manually trigger fee crystallization. */
app.post("/api/fee/crystallize", async (c) => {
  const apiKey = c.req.header("x-admin-api-key") ?? "";
  const expected = c.env.ADMIN_API_KEY ?? "";

  if (!expected || apiKey !== expected) {
    return c.json({ status: "error", message: "Unauthorized" }, 401);
  }

  try {
    setDbEnv(c.env);
    const result = await crystallizeFees();
    console.log("[fee-cron]", JSON.stringify(result));
    return c.json(result);
  } catch (e: any) {
    return c.json({ status: "error", message: e?.message }, 500);
  }
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
