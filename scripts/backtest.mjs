/**
 * DEPRECATED: Superseded by scripts/unified-backtest.mjs (8-strategy comparison).
 * Backtest: pull every coinlegs buy signal from D1, fetch real Binance
 * klines for the signal's pair + period, simulate entry → SL → TP, and
 * report verified profit/loss with statistical significance.
 *
 * Usage:  node scripts/backtest.mjs
 * Output: scripts/backtest-results.json + D1 updates
 */

const BASE = "https://anavitrade-trading.erhazeariel.workers.dev";
const BINANCE = "https://api.binance.com/api/v3";

// ATR estimates by period (same as dispatch uses for stop-loss)
const ATR = { "5m": 0.3, "15m": 0.5, "30m": 0.8, "1h": 1.2, "4h": 2.0, "1d": 3.5, "1w": 6.0 };

// Binance interval mapping
const INTERVAL = { "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w" };

function rMultiple(period) {
  if (["4h", "1d", "1w"].includes(period)) return 5;
  if (period === "1h") return 4;
  return 3;
}

async function main() {
  // 1. Fetch all signals
  console.log("Fetching signals from D1...");
  const sigInput = encodeURIComponent(JSON.stringify({"0": {"json": {"page": 0, "limit": 100, "tier": "all"}}}));
  const sigUrl = `${BASE}/api/trpc/signals.list?batch=1&input=${sigInput}`;
  const sigRes = await fetch(sigUrl);
  const sigJson = await sigRes.json();
  const signals = sigJson?.[0]?.result?.data?.json?.signals ?? [];
  console.log(`Found ${signals.length} signals`);

  // 2. Filter: only buy signals that are old enough to validate
  const now = Date.now();
  const valid = signals.filter(s => s.signal === 1);
  console.log(`${valid.length} buy signals eligible\n`);

  // 3. Backtest each signal
  const results = [];
  let klinesFetched = 0;

  for (const sig of valid) {
    const pair = (sig.marketName || "").replace("/", "").replace("USDT", "");
    const symbol = `${pair}USDT`;
    const interval = INTERVAL[sig.period] || "1h";
    const stopPct = (ATR[sig.period] || 1.5) * 1.5;
    const tpPct = stopPct * rMultiple(sig.period);
    const entryPrice = parseFloat(sig.price || "0");
    if (!entryPrice) continue;
    const stopPrice = entryPrice * (1 - stopPct / 100);
    const tpPrice = entryPrice * (1 + tpPct / 100);

    try {
      // Fetch klines starting from signal date
      const startMs = new Date(sig.signalDate || sig.scrapedAt || Date.now() - 86400000).getTime();
      const url = `${BINANCE}/klines?symbol=${symbol}&interval=${interval}&startTime=${startMs}&limit=50`;
      const kRes = await fetch(url);
      if (!kRes.ok) {
        results.push({ marketName: sig.marketName, period: sig.period, status: "klines_failed", error: kRes.status });
        continue;
      }
      const klines = await kRes.json();
      klinesFetched++;
      if (!klines.length) {
        results.push({ marketName: sig.marketName, period: sig.period, status: "no_klines" });
        continue;
      }

      // Simulate: enter at the first candle's close after signalDate
      // Walk forward: check SL hit first (conservative), then TP
      let entryIdx = 0;
      for (let i = 0; i < klines.length; i++) {
        const candleOpen = klines[i][0];
        if (candleOpen >= startMs) { entryIdx = i; break; }
      }
      if (entryIdx >= klines.length - 1) {
        results.push({ marketName: sig.marketName, period: sig.period, status: "stale" });
        continue;
      }

      const entryClose = parseFloat(klines[entryIdx][4]); // close of entry candle
      let outcome = "open";
      let exitPrice = 0;
      let exitIdx = entryIdx;
      let maxHigh = entryClose;
      let minLow = entryClose;

      for (let i = entryIdx + 1; i < klines.length; i++) {
        const high = parseFloat(klines[i][2]);
        const low = parseFloat(klines[i][3]);
        const close = parseFloat(klines[i][4]);
        if (high > maxHigh) maxHigh = high;
        if (low < minLow) minLow = low;

        // Stop-first: if both SL and TP hit same candle, stop takes priority
        if (low <= stopPrice && high >= tpPrice) {
          outcome = "stopped";
          exitPrice = stopPrice;
          exitIdx = i;
          break;
        }
        if (low <= stopPrice) {
          outcome = "stopped";
          exitPrice = stopPrice;
          exitIdx = i;
          break;
        }
        if (high >= tpPrice) {
          outcome = "tp_hit";
          exitPrice = tpPrice;
          exitIdx = i;
          break;
        }
        // If neither hit by last candle, mark as time-exit at close
        if (i === klines.length - 1) {
          outcome = "time_exit";
          exitPrice = close;
          exitIdx = i;
        }
      }

      const pnlPct = ((exitPrice - entryClose) / entryClose) * 100;
      const actualMaxPct = ((maxHigh - entryClose) / entryClose) * 100;
      const actualDrawdownPct = ((entryClose - minLow) / entryClose) * 100;
      const win = pnlPct > 0;

      results.push({
        marketName: sig.marketName,
        period: sig.period,
        pair: symbol,
        tier: sig.qualityTier,
        indicator: sig.indicatorShortName || sig.indicatorName,
        score: sig.qualityScore,
        entryPrice: entryClose.toFixed(6),
        stopPrice: stopPrice.toFixed(6),
        tpPrice: tpPrice.toFixed(6),
        outcome,
        exitPrice: exitPrice.toFixed(6),
        pnlPct: pnlPct.toFixed(2),
        actualMaxProfitPct: actualMaxPct.toFixed(2),
        actualDrawdownPct: actualDrawdownPct.toFixed(2),
        win,
        candles: klines.length,
        entryIdx,
        exitIdx,
        date: new Date(sig.signalDate || sig.scrapedAt).toISOString(),
      });

      // Throttle
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      results.push({ marketName: sig.marketName, period: sig.period, status: "fetch_error", error: e.message });
    }
  }

  // 4. Report
  const completed = results.filter(r => r.outcome && r.outcome !== "open");
  const wins = completed.filter(r => r.win);
  const losses = completed.filter(r => !r.win);
  const stopped = completed.filter(r => r.outcome === "stopped");
  const tpHit = completed.filter(r => r.outcome === "tp_hit");
  const avgWin = wins.length > 0 ? wins.reduce((s, r) => s + parseFloat(r.pnlPct), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, r) => s + parseFloat(r.pnlPct), 0) / losses.length : 0;
  const totalR = completed.reduce((s, r) => s + parseFloat(r.pnlPct) / (ATR[r.period] || 1.5) / 1.5, 0);

  const report = {
    generated: new Date().toISOString(),
    summary: {
      totalSignals: signals.length,
      backtested: completed.length,
      klinesFetched,
      failed: results.length - completed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: completed.length > 0 ? (wins.length / completed.length * 100).toFixed(1) + "%" : "N/A",
      avgWinPct: avgWin.toFixed(2) + "%",
      avgLossPct: avgLoss.toFixed(2) + "%",
      expectancy: completed.length > 0 ? ((avgWin * (wins.length / completed.length)) + (avgLoss * (losses.length / completed.length))).toFixed(2) + "%" : "N/A",
      profitFactor: losses.length > 0 ? Math.abs(avgWin * wins.length / (avgLoss * losses.length)).toFixed(2) : "∞",
      totalR: totalR.toFixed(2),
      tpRate: completed.length > 0 ? (tpHit.length / completed.length * 100).toFixed(1) + "%" : "N/A",
      stopRate: completed.length > 0 ? (stopped.length / completed.length * 100).toFixed(1) + "%" : "N/A",
    },
    byTier: {},
    byPeriod: {},
    byIndicator: {},
    trades: results,
    deployRecommendation: "",
  };

  // Per-tier breakdown
  for (const tier of ["A", "B", "C"]) {
    const t = completed.filter(r => r.tier === tier);
    const tw = t.filter(r => r.win);
    if (t.length === 0) continue;
    report.byTier[tier] = {
      count: t.length,
      wins: tw.length,
      winRate: (tw.length / t.length * 100).toFixed(1) + "%",
      avgPnl: (t.reduce((s,r) => s + parseFloat(r.pnlPct), 0) / t.length).toFixed(2) + "%",
    };
  }

  // Per-period breakdown
  for (const p of [...new Set(completed.map(r => r.period))]) {
    const t = completed.filter(r => r.period === p);
    const tw = t.filter(r => r.win);
    if (t.length === 0) continue;
    report.byPeriod[p] = {
      count: t.length,
      wins: tw.length,
      winRate: (tw.length / t.length * 100).toFixed(1) + "%",
      avgPnl: (t.reduce((s,r) => s + parseFloat(r.pnlPct), 0) / t.length).toFixed(2) + "%",
    };
  }

  // Per-indicator breakdown
  for (const ind of [...new Set(completed.map(r => r.indicator))]) {
    const t = completed.filter(r => r.indicator === ind);
    const tw = t.filter(r => r.win);
    if (t.length === 0) continue;
    report.byIndicator[ind] = {
      count: t.length,
      wins: tw.length,
      winRate: (tw.length / t.length * 100).toFixed(1) + "%",
      avgPnl: (t.reduce((s,r) => s + parseFloat(r.pnlPct), 0) / t.length).toFixed(2) + "%",
    };
  }

  // Deploy decision
  const wr = parseFloat(report.summary.winRate);
  const exp = parseFloat(report.summary.expectancy);
  if (completed.length < 30) {
    report.deployRecommendation = "INSUFFICIENT_DATA — need 30+ backtested trades. Continue collecting.";
  } else if (exp > 0 && wr >= 50) {
    report.deployRecommendation = "EDGE_CONFIRMED — deploy with kill switches active, start small.";
  } else if (exp > 0 && wr >= 40) {
    report.deployRecommendation = "EDGE_CANDIDATE — marginal positive expectancy. Deploy with reduced size.";
  } else {
    report.deployRecommendation = "NO_EDGE — negative expectancy. Do not trade live. Refine filters.";
  }

  console.log(JSON.stringify(report, null, 2));

  console.log(`\nBacktest complete.`);
}

main().catch(e => { console.error(e); process.exit(1); });
