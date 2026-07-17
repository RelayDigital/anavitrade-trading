/**
 * Coinlegs signal scraper — fetches from the coinlegs API every 60 seconds,
 * scores every signal with the full 6‑component data‑derived algorithm, persists
 * to D1, and auto‑dispatches Tier‑A buy signals to all connected exchange
 * accounts (non‑custodial copytrading).  Target latency ≤60 s.
 *
 * Two sources, tried in order:
 *  1. Our CF proxy Worker (cached, camelCase, has signalId)
 *  2. Direct POST to api.coinlegs.com (always reachable, PascalCase, no native
 *     signalId — we derive a synthetic numeric dedup key)
 */
import { getDb, getRawD1 } from "./db";
import { coinlegsSignals, scraperRuns, tradeIntents } from "../drizzle/schema";
import { eq, desc, sql, inArray, and, gte } from "drizzle-orm";
import { createExecutionJobsForIntent } from "./execution/dispatch";
import { validateStructure, structuralConfidenceMultiplier } from "./smc/validator";
import { quickMtfAdjust } from "./signals/mtf-matrix";
import { scoreSignal } from "./analysis/scoring";

/* ─── Sources ─────────────────────────────────────────────────────────── */

const PROXY_URL = "https://coinlegs-worker.erhazeariel.workers.dev/latest";
const DIRECT_API = "https://api.coinlegs.com/api/Exchange/SelectDetections";
const DETECTION_IDS = [47, 9, 8, 46, 7];
/** Priority-ordered timeframe groups. 4h+1d MUST be fetched first because
 *  the coinlegs API returns exactly 20 signals per page regardless of
 *  RowsInPage, and calling all 7 timeframes simultaneously drowns 4h
 *  signals (70.7% WR) in 15m noise.  Each group gets its own page sweep. */
const TF_PRIORITY_GROUPS = [
  ["4h", "1d"],
  ["1h"],
  ["30m", "15m"],
];

/* ─── Helpers ──────────────────────────────────────────────────────────── */

type Raw = Record<string, unknown>;

function p<T = string>(raw: Raw, ...names: string[]): T | undefined {
  for (const n of names) if (raw[n] !== undefined) return raw[n] as T;
  return undefined;
}
function pn(raw: Raw, ...names: string[]): number {
  const v = p(raw, ...names);
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function dedupKey(raw: Raw): string {
  const market = p<string>(raw, "MarketName", "marketName", "ShortMarketName", "pair") ?? "";
  const period = p<string>(raw, "Period", "period") ?? "";
  const name = p<string>(raw, "Name", "indicatorName", "DisplayName") ?? "";
  return `${market}_${period}_${name}`;
}

function dedupNum(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Parse MaxProfitDuration → hours */
function durHours(d: string | null | undefined): number {
  if (!d) return 0;
  const s = d.toLowerCase().trim();
  const v = parseFloat(s.split(/\s+/)[0]);
  if (isNaN(v)) return 0;
  if (s.includes("day")) return v * 24;
  if (s.includes("hour") || s.includes("hr")) return v;
  if (s.includes("min")) return v / 60;
  return 0;
}

/* ─── Fetch ──────────────────────────────────────────────────────────────
 * 7‑min sliding window; first source = proxy, second = direct POST. */

function detectionWindow(): { start: string; end: string } {
  const now = new Date();
  return {
    start: new Date(now.getTime() - 60 * 60_000).toISOString(), // 1h for first seed, cron dedup handles rest
    end: now.toISOString(),
  };
}

async function fetchSignals(): Promise<{ signals: Raw[]; source: string; error?: string; detail?: string }> {
  // ── 1. proxy Worker ──
  try {
    const r = await fetch(PROXY_URL);
    if (r.ok) {
      const j = await r.json() as any;
      const arr = j?.signals ?? j ?? [];
      if (Array.isArray(arr) && arr.length > 0) return { signals: arr, source: "proxy" };
      return { signals: [], source: "proxy", error: "no signals", detail: `proxy returned ${arr.length} items` };
    }
  } catch (e: any) { /* fall through */ }

  // ── 2. direct API (TF-prioritized fetch) ──
  // Coinlegs returns exactly 20 signals per page regardless of RowsInPage.
  // Fetching all 7 timeframes simultaneously drowns 4h signals (70.7% WR)
  // in 15m noise.  Each priority group gets its own page sweep.
  try {
    const { start, end } = detectionWindow();
    const allSignals: Raw[] = [];
    for (const periods of TF_PRIORITY_GROUPS) {
      for (let page = 0; page < 3; page++) { // 3 pages per group, 60 signals max
        const r = await fetch(DIRECT_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            Exchg: "Binance", Market: "USDT",
            IncludeBuySignal: true, IncludeNeutralSignal: false, IncludeSellSignal: false,
            DetectionIds: DETECTION_IDS, Periods: periods,
            MarketName: "", __Key: "scraper", Sorting: {},
            StartDate: start, EndDate: end, Page: page, RowsInPage: 20,
          }),
        });
        if (!r.ok) break;
        const j = await r.json() as any;
        const arr = j?.Data?.Signals ?? j?.signals ?? [];
        if (!Array.isArray(arr) || !arr.length) break;
        allSignals.push(...arr);
      }
    }
    if (allSignals.length > 0) return { signals: allSignals, source: "direct" };
    return { signals: [], source: "direct", error: "no signals", detail: `all groups empty` };
  } catch (e: any) {
    return { signals: [], source: "none", error: "all sources failed", detail: e?.message };
  }
}

/* ─── scoreSignal imported from ./analysis/scoring ───────────────────── */

export async function runCoinlegsScraper(input?: {
  signals: Record<string, unknown>[];
  source: string;
  dispatch?: boolean;
}) {
  let db: ReturnType<typeof getDb> | null = null;
  try { db = getDb(); } catch { /* env not set */ }
  if (!db) return { status: "error" as const, signalsFetched: 0, signalsInserted: 0, signalsDuplicate: 0, tierA: 0, tierB: 0, tierC: 0, intentIds: [] as number[], errorMessage: "No database" };

  const startedAt = new Date();
  let signalsFetched = 0, signalsInserted = 0, signalsDuplicate = 0, tierA = 0, tierB = 0;
  let status: "success" | "error" | "partial" = "success";
  let errorMessage: string | undefined;
  const tierASignals: { marketName: string; signalId: number; score: number; period: string; price: number; maxProfit: number; maxProfitDuration: string | null; leverage: number; indicatorName: string; pct24: number }[] = [];

  try {
    const fetched: { signals: Raw[]; source: string; error?: string; detail?: string } = input
      ? { signals: input.signals, source: input.source }
      : await fetchSignals();
    if (fetched.error && fetched.signals.length === 0) {
      const detail = fetched.detail ? ` [${fetched.source}] ${fetched.detail}` : "";
      throw new Error(fetched.error + detail);
    }
    signalsFetched = fetched.signals.length;
    console.log(`[CoinlegsScraper] source=${fetched.source} fetched=${fetched.signals.length}`);

    // --- Batch dedup: collect all signalId candidates, query DB once ---
    const signalCandidates: Array<{
      raw: Raw;
      sid: number;
      lookupId: number;
      dk: string;
    }> = [];

    for (const s of fetched.signals) {
      if (pn(s, "Signal", "signal") !== 1) { signalsDuplicate++; continue; }
      const sid = pn(s, "SignalId", "signalId");
      const dk  = sid > 0 ? String(sid) : dedupKey(s);
      if (!dk) continue;
      const lookupId = sid > 0 ? sid : dedupNum(dk);
      if (lookupId === 0) continue;
      signalCandidates.push({ raw: s, sid, lookupId, dk });
    }

    // Batch dedup query: chunk lookup IDs to stay under D1's 100-variable limit
    const last24h = Date.now() - 24 * 60 * 60 * 1000;
    let existingIds = new Set<number>();
    if (signalCandidates.length > 0) {
      const lookupIds = signalCandidates.map((c) => c.lookupId);
      for (let j = 0; j < lookupIds.length; j += 80) {
        const chunk = lookupIds.slice(j, j + 80);
        // Bypass Drizzle entirely — use raw D1 to avoid Date serialization bugs
        const d1 = getRawD1();
        const varCount = chunk.map(() => "?").join(",");
        const dupRows = await d1.prepare(
          `SELECT signalId FROM coinlegs_signals WHERE signalId IN (${varCount}) AND scrapedAt >= ?`
        ).bind(...chunk, last24h).all();
        for (const r of (dupRows?.results ?? [])) existingIds.add(Number(r.signalId));
      }
    }

    // Filter duplicates in-memory
    const newSignals = signalCandidates.filter((c) => {
      if (existingIds.has(c.lookupId)) { signalsDuplicate++; return false; }
      return true;
    });

    // Build insert rows and batch INSERT in chunks of 50
    const insertRows: Array<{
      raw: Raw; lookupId: number; sid: number;
      maxProfit: number; duration: string | null | undefined;
      period: string; indName: string; marketName: string;
      exchange: string; market: string; price: number;
      lastPrice: string | null; pct24Raw: number; pct24Str: string | null | undefined;
      dateStr: string | null | undefined; recStr: string | null | undefined;
      score: number; tier: "A" | "B" | "C";
    }> = [];

    for (const { raw: s, lookupId, sid } of newSignals) {
      const maxProfit  = pn(s, "MaxProfit", "maxProfit");
      const duration   = p<string>(s, "MaxProfitDuration", "maxProfitDuration");
      const period     = p<string>(s, "Period", "period") ?? "1h";
      const indName    = p<string>(s, "Name", "indicatorName", "DisplayName") ?? "";
      const marketName = p<string>(s, "MarketName", "marketName", "ShortMarketName") ?? p<string>(s, "pair", "pair") ?? "";
      const exchange   = p<string>(s, "Exchg", "exchange") ?? "Binance";
      const market     = p<string>(s, "Market", "market") ?? "USDT";
      const price      = pn(s, "Price", "price");
      const lastPrice  = p<string>(s, "LastPrice", "lastPrice") ?? null;
      const pct24Raw   = pn(s, "Percentage24", "percentage24");
      const pct24Str   = p<string>(s, "Percentage24", "percentage24");
      const dateStr    = p<string>(s, "SignalDateUTCString", "signalDateUtc");
      const recStr     = p<string>(s, "RecordDate", "recordDate") ?? dateStr;

      // Confluence = unique indicator types agreeing on this market + period.
      // Count from current batch + recent DB signals (1h window) to catch cross-run agreement.
      const sameGroup = fetched.signals.filter(x => {
        const m = p<string>(x, "MarketName", "marketName", "ShortMarketName") ?? p<string>(x, "pair");
        const pf = p<string>(x, "Period", "period");
        return m === marketName && pf === period;
      });
      const uniqueIndicators = new Set(sameGroup.map(x =>
        p<string>(x, "Name", "indicatorName", "DisplayName") ?? "").filter(Boolean));
      let confluenceCount = uniqueIndicators.size;

      // Also count recent DB signals for the same market+period (cross-batch confluence)
      if (marketName && period) {
        const recent = await db!.select().from(coinlegsSignals)
          .where(
            sql`${coinlegsSignals.marketName} = ${marketName}
                AND ${coinlegsSignals.period} = ${period}
                AND ${coinlegsSignals.scrapedAt} > ${Date.now() - 60 * 60_000}`
          )
          .all();
        recent.forEach(r => uniqueIndicators.add(r.indicatorName));
        confluenceCount = uniqueIndicators.size;
      }

      const { score, tier } = scoreSignal(confluenceCount, period, indName, pct24Raw || null);
      if (tier === "A") tierA++; else if (tier === "B") tierB++;

      insertRows.push({ raw: s, lookupId, sid, maxProfit, duration, period, indName, marketName, exchange, market, price, lastPrice, pct24Raw, pct24Str, dateStr, recStr, score, tier });
    }

    // Batch INSERT in chunks of 50
    const BATCH_SIZE = 50;
    for (let i = 0; i < insertRows.length; i += BATCH_SIZE) {
      const chunk = insertRows.slice(i, i + BATCH_SIZE);
      const values = chunk.map((r) => ({
        signalId: r.lookupId,
        exchg: r.exchange, marketName: r.marketName, market: r.market,
        indicatorName: r.indName, indicatorShortName: r.indName,
        typeId: 0, signal: 1, period: r.period,
        price: String(r.price),
        lastPrice: r.lastPrice ?? null,
        percentage24: r.pct24Str ? String(r.pct24Str) : null,
        minPrice: null, maxPrice: null,
        maxProfit: String(r.maxProfit),
        maxProfitDuration: r.duration ?? null,
        signalDate: Number(r.dateStr ? new Date(r.dateStr).getTime() : Date.now()),
        signalDateUtc: r.dateStr ?? null,
        recordDate: Number(r.recStr ? new Date(r.recStr).getTime() : Date.now()),
        qualityScore: r.score, qualityTier: r.tier,
        scrapedAt: Date.now(),
        outcomeValidated: 0, actualMaxProfitPct: null,
        actualDrawdownPct: null, outcomeWarning: 0,
      }));
      // Use getRawD1() to bypass Drizzle ORM Date serialization entirely.
      // Drizzle converts numbers to Date → ISO strings → D1 INTEGER reject.
      // Ensure ALL values are primitives (number | string | null) before binding.
      const rawD1 = getRawD1();
      if (!rawD1?.prepare) { throw new Error("RAW_D1_NOT_AVAILABLE"); }
      let insertedCount = 0;
      for (const row of values) {
        try {
          const r = row as Record<string, unknown>;
          const cols = Object.keys(r);
          const primitives = cols.map(c => {
            const v = r[c];
            return v instanceof Date ? v.getTime() : v;
          });
          const ph = cols.map(() => "?").join(",");
          const sql2 = `INSERT OR IGNORE INTO coinlegs_signals ("${cols.join('","')}") VALUES (${ph})`;
          const stmt = rawD1.prepare(sql2).bind(...primitives);
          await stmt.run();
          insertedCount++;
        } catch { /* best effort per row */ }
      }
      signalsInserted += insertedCount;
    }

    // Collect ALL Tier-A signals — quality filter runs in the SMC loop below.
    for (const r of input?.dispatch === false ? [] : insertRows) {
      if (r.tier === "A") {
        tierASignals.push({
          marketName: r.marketName, signalId: r.sid, score: r.score, period: r.period,
          price: r.price, maxProfit: r.maxProfit, maxProfitDuration: r.duration ?? null,
          leverage: r.period === "4h" || r.period === "1d" || r.period === "1w" ? 3 : 2,
          indicatorName: r.indName,
          pct24: r.pct24Raw ?? 0,
        });
      }
    }

    // Bridge newly inserted signals to unified analysis_signals table (non-blocking)
    const insertedSignalIds = insertRows.map((r) => r.lookupId);
    if (insertedSignalIds.length > 0) {
      try {
        const { bridgeCoinlegsSignals } = await import("./analysis/bridge");
        const bridgeResult = await bridgeCoinlegsSignals(insertedSignalIds);
        console.log(`[CoinlegsScraper] bridge: ${bridgeResult.bridged} bridged, ${bridgeResult.skipped} skipped, ${bridgeResult.errors} errors`);
      } catch (e: any) {
        console.warn("[CoinlegsScraper] bridge error (non-blocking):", e?.message);
      }
    }
  } catch (e: any) {
    status = "error";
    errorMessage = e?.message;
    console.error("[CoinlegsScraper]", e?.message);
  }

  const completedAt = new Date();
  const intentIds: number[] = [];

  let smcPassed = 0, smcRejected = 0;
  if (tierASignals.length > 0) {
    for (const sig of tierASignals) {
      try {
        // ── SMC Structural Gating ──
        const structuralRecheck = validateStructure({
          period: sig.period, price: sig.price || 0, pct24: 0,
          maxProfit: sig.maxProfit, maxProfitDuration: sig.maxProfitDuration,
          indicatorName: sig.indicatorName ?? "",
          confluenceCount: 1, marketName: sig.marketName,
        });

        if (!structuralRecheck.pass) {
          const failedGates = Object.values(structuralRecheck.gates).filter(g => !g.pass).map(g => g.reason);
          smcRejected++;
          console.log(`[CoinlegsScraper] SMC gate rejected ${sig.marketName} ${sig.period}: ${failedGates.join(", ")}`);
          continue;
        }
        smcPassed++;

        // ── Quality filter: timeframe × indicator quality (forward-only) ──
        // No maxProfit. No hindsight. Only things we know at signal time.
        // From 1,265-trade backtest: 4h = 70.7% WR, 1h = 58.1% WR.
        // MACD/Stochastic = strongest indicators. Struct TFs admit all indicators.
        const ind = (sig.indicatorName ?? "").toLowerCase();
        const isStructural = sig.period === "4h" || sig.period === "1d" || sig.period === "1w";
        const is1h = sig.period === "1h";
        const isTopIndicator = ind.includes("macd") || ind.includes("stochastic") || ind.includes("stoch");
        const isReversal = ind.includes("trend") || ind.includes("reversal");

        // Claude thesis: structural TF + top indicator = highest conviction.
        // Purely forward-looking — no outcome data, no maxProfit.
        const claudeThesisScore =
          (isStructural ? 10 : is1h ? 6 : 3) +
          (isTopIndicator ? 5 : isReversal ? 3 : 1);

        // Conviction → position sizing: ≥12 = 1.0x, ≥8 = 0.75x, else 0.5x
        const convictionMultiplier = claudeThesisScore >= 12 ? 1.0 : claudeThesisScore >= 8 ? 0.75 : 0.5;
        const qualityAllowed = true;
        const qualityReason = `thesis:${claudeThesisScore}(conv:${convictionMultiplier.toFixed(2)}) tf:${sig.period}`;
        const positionFactor = isStructural ? 1.0 : is1h ? 0.75 : 0.5;

        console.log(`[CoinlegsScraper] quality filter: ${sig.period} ${sig.indicatorName} → ${qualityReason}`);

        // ── Stop-loss: structural invalidation level from real klines ──
        // Fetch the actual candles for this pair+timeframe, find the nearest
        // swing low (the structural swept level), and place the stop 0.5% below
        // that level.  The trade is invalidated when price retraces through the
        // swept liquidity pool — not when an arbitrary ATR multiple fires.
        let sweepLow = sig.price || 0;
        try {
          const symbol = sig.marketName?.replace("/", "").replace("USDT", "") + "USDT";
          const interval = sig.period || "4h";
          const klines = await fetch(
            `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=30`
          ).then(r => r.json()).catch(() => []);
          if (Array.isArray(klines) && klines.length > 5) {
            // Find swing lows: candles where low[i] < low[i-1] AND low[i] < low[i+1]
            const lows = klines.map((k: any[]) => parseFloat(k[3]));
            const swingLows: number[] = [];
            for (let i = 1; i < lows.length - 1; i++) {
              if (lows[i] < lows[i-1] && lows[i] < lows[i+1]) swingLows.push(lows[i]);
            }
            if (swingLows.length > 0) {
              // The swept level is the most recent swing low (last one before signal)
              sweepLow = swingLows[swingLows.length - 1];
            }
          }
        } catch { /* fallback: use signal price as invalidation */ }

        const price = sig.price || 0;
        const stopPrice = price > 0 ? (Math.min(sweepLow, price * 0.98) * 0.995).toFixed(8) : null;
        const stopPct = price > 0 ? ((price - parseFloat(stopPrice || "0")) / price) * 100 : 1.5;

        // TP: next structural liquidity above. Swing highs serve as targets.
        // 5× stop distance on structural TFs, 3× on 1h, 2× on lower.
        const rMultiple = isStructural ? 5
                        : sig.period === "1h" ? 3
                        : 2;
        const tpPrice = price > 0 ? (price * (1 + (stopPct * rMultiple) / 100)).toFixed(8) : null;

        // ── MTF Matrix: HTF alignment adjustment ──
        // 4h overrules 1h overrules 15m. A 15m MACD cross when 4h is bearish
        // gets killed. A 4h signal with 1h+4h both bullish gets amplified.
        const mtfFactor = quickMtfAdjust(sig.period, sig.indicatorName ?? "");
        if (mtfFactor === 0) { smcRejected++; continue; } // HTF opposing → reject

        const confidence = structuralConfidenceMultiplier(structuralRecheck.score) * positionFactor * convictionMultiplier * mtfFactor;

        const intent = await db!.insert(tradeIntents).values({
          source: "coinlegs", externalSignalId: String(sig.signalId),
          symbol: sig.marketName.replace("/", ""), side: "buy", orderType: "market",
          targetLeverage: sig.leverage,
          limitPrice: price > 0 ? String(price) : null,
          stopLossPrice: stopPrice,
          takeProfitPrice: tpPrice,
          status: "created", createdBy: "scraper",
          requestedNotionalUsd: confidence < 1 ? String(Math.round(confidence * 100)) : null,
        } as any).returning().then(r => r[0]);

        if (intent) {
          const r = await createExecutionJobsForIntent(intent.id);
          intentIds.push(intent.id);
          console.log(`[CoinlegsScraper] ${sig.marketName} ${sig.period} S=${sig.score} SMC=${structuralRecheck.score} conf=${confidence.toFixed(2)} +${sig.maxProfit.toFixed(1)}% -> ${r.jobs.filter(j => j.status !== "duplicate" && j.status !== "skipped").length} jobs`);
        }
      } catch (e: any) { console.warn("[CoinlegsScraper] dispatch:", e?.message); }
    }
  }
  if (smcRejected > 0) console.log(`[CoinlegsScraper] SMC gating: ${smcPassed} passed, ${smcRejected} rejected`);
  // scraper_runs insert - raw D1 to avoid Drizzle Date serialization
  try {
    const now = Date.now();
    const d1 = getRawD1();
    const d1Started = startedAt instanceof Date ? startedAt.getTime() : Number(startedAt);
    const d1Completed = completedAt instanceof Date ? completedAt.getTime() : Number(completedAt);
    await d1.prepare("INSERT INTO scraper_runs (status,signalsFetched,signalsInserted,signalsDuplicate,tierA,tierB,tierC,errorMessage,startedAt,completedAt,durationMs) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(status,signalsFetched,signalsInserted,signalsDuplicate,tierA,tierB,Math.max(0,signalsInserted-tierA-tierB),errorMessage??null,d1Started,d1Completed,d1Completed-d1Started).run();
  } catch (e: any) { console.warn("[scraper] run log error:", String(e?.message).slice(0, 120)); }
}
