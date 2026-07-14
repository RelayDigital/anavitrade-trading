import React, { useState, useMemo, useEffect, useRef } from "react";
import { Link, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import TradeChartSnapshot from "@/components/TradeChartSnapshot";
import { trpc } from "@/lib/trpc";
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer,
  Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";
import {
  TrendingUp, TrendingDown, DollarSign, Activity,
  ArrowLeft, RefreshCw, Zap, Clock, Radio, Wifi,
  ChevronDown, ChevronUp,
} from "lucide-react";
import { toast } from "sonner";

// ── Trade duration helper ─────────────────────────────────────────────────
function fmtDuration(openedAt: Date | null, closedAt: Date | null): string {
  if (!openedAt || !closedAt) return "";
  const ms = closedAt.getTime() - openedAt.getTime();
  if (ms <= 0) return "";
  const totalMins = Math.round(ms / 60000);
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

// Slide-in animation for new trade rows now lives in index.css (.trade-row-new)
// — out of module scope so this file stays Fast-Refresh-safe (no dev reloads).

// Tier badge colours
const TIER_COLORS: Record<string, string> = {
  A: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  B: "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30",
  C: "bg-slate-500/15 text-slate-400 border border-slate-500/30",
};

// Auto-poll interval: 30 seconds
const POLL_INTERVAL_MS = 30_000;

export default function DemoDashboard() {
  const params = useParams<{ token: string }>();
  const [tradeTab, setTradeTab] = useState<"closed" | "open">("closed");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // Track previously seen trade IDs to detect new arrivals
  const prevTradeIds = useRef<Set<number>>(new Set());
  // Track newly arrived trade IDs for animation
  const [newTradeIds, setNewTradeIds] = useState<Set<number>>(new Set());
  const [expandedTradeId, setExpandedTradeId] = useState<number | null>(null);

  const { data: account, isLoading, error } = trpc.demo.getByToken.useQuery(
    { token: params.token || "" },
    { enabled: !!params.token, refetchInterval: POLL_INTERVAL_MS }
  );

  const { data: backendTrades, refetch: refetchTrades } = trpc.demo.getTrades.useQuery(
    { token: params.token || "" },
    {
      enabled: !!params.token && !!account,
      refetchInterval: POLL_INTERVAL_MS,
    }
  );

  const { data: portfolioSeries, refetch: refetchSeries } = trpc.demo.getPortfolioSeries.useQuery(
    { token: params.token || "" },
    {
      enabled: !!params.token && !!account,
      refetchInterval: POLL_INTERVAL_MS,
    }
  );

  // Detect new trades and show toast + animate them
  useEffect(() => {
    if (!backendTrades) return;
    const currentIds = new Set<number>(backendTrades.map((t) => Number(t.id)));
    const arrived: number[] = [];
    currentIds.forEach((id) => {
      if (!prevTradeIds.current.has(id)) arrived.push(id);
    });
    if (arrived.length > 0 && prevTradeIds.current.size > 0) {
      // Only toast if we had previous data (not first load)
      const count = arrived.length;
      toast.success(
        `${count} new trade${count > 1 ? "s" : ""} applied to your portfolio`,
        { description: "Equity curve updated", duration: 4000 }
      );
      setNewTradeIds(new Set(arrived));
      // Clear animation class after 2s
      setTimeout(() => setNewTradeIds(new Set()), 2000);
    }
    prevTradeIds.current = currentIds;
    setLastUpdated(new Date());
  }, [backendTrades]);

  const triggerSync = trpc.demo.triggerSync.useMutation({
    onSuccess: (result) => {
      toast.success(
        `Sync complete — ${result.tradesCreated} new trade${result.tradesCreated !== 1 ? "s" : ""} applied`,
        { description: `${result.snapshotsWritten} equity snapshots written` }
      );
      refetchTrades();
      refetchSeries();
    },
    onError: (err) => toast.error(`Sync failed: ${err.message}`),
  });

  const startingCapital = account ? parseFloat(account.startingCapital) : 0;
  const currentBalance = account ? parseFloat(account.currentBalance) : startingCapital;

  // Build chart data from real portfolio snapshots
  const growthData = useMemo(() => {
    if (!portfolioSeries || portfolioSeries.length === 0) return [];
    return portfolioSeries.map((p) => ({
      timestamp: p.timestamp,
      label: p.label,
      value: p.value,
      tradeCount: p.tradeCount,
    }));
  }, [portfolioSeries]);

  const totalPnl = currentBalance - startingCapital;
  const pnlPercent = startingCapital > 0
    ? ((totalPnl / startingCapital) * 100).toFixed(2)
    : "0.00";

  // Closed trades from backend — sorted newest first
  const closedTrades = useMemo(() => {
    if (!backendTrades) return [];
    return backendTrades
      .filter((t) => t.status === "closed")
      .map((t) => ({
        id: t.id,
        pair: t.pair,
        side: t.side as "buy" | "sell",
        entryPrice: parseFloat(t.entryPrice),
        exitPrice: t.exitPrice ? parseFloat(t.exitPrice) : null,
        quantity: parseFloat(t.quantity),
        pnl: t.pnl ? parseFloat(t.pnl) : 0,
        pnlPct: t.pnlPct ? parseFloat(t.pnlPct) : 0,
        openedAt: t.openedAt ? new Date(t.openedAt) : null,
        closedAt: t.closedAt ? new Date(t.closedAt) : null,
        indicatorName: (t as any).indicatorName ?? null,
        period: (t as any).period ?? null,
        qualityScore: (t as any).qualityScore ?? null,
        qualityTier: (t as any).qualityTier ?? null,
      }));
  }, [backendTrades]);

  const openTrades = useMemo(() => {
    if (!backendTrades) return [];
    return backendTrades.filter((t) => t.status === "open");
  }, [backendTrades]);

  const displayTrades = tradeTab === "closed" ? closedTrades : openTrades;

  // Win rate from closed trades
  const winCount = closedTrades.filter((t) => t.pnl > 0).length;
  const winRate = closedTrades.length > 0
    ? ((winCount / closedTrades.length) * 100).toFixed(0)
    : null;

  // ── Summary statistics (computed from real closed trades + equity curve) ──
  const summaryStats = useMemo(() => {
    if (closedTrades.length === 0) return null;

    // Win rate
    const wins = closedTrades.filter((t) => t.pnl > 0);
    const winRatePct = (wins.length / closedTrades.length) * 100;

    // Average profit per trade (in USD)
    const totalPnlSum = closedTrades.reduce((acc, t) => acc + t.pnl, 0);
    const avgProfitUsd = totalPnlSum / closedTrades.length;

    // Average return % per trade
    const avgReturnPct = closedTrades.reduce((acc, t) => acc + t.pnlPct, 0) / closedTrades.length;

    // Maximum drawdown: walk the equity curve and find the deepest peak-to-trough
    let maxDrawdownPct = 0;
    if (growthData.length >= 2) {
      let peak = growthData[0].value;
      for (const point of growthData) {
        if (point.value > peak) peak = point.value;
        const dd = peak > 0 ? ((peak - point.value) / peak) * 100 : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }
    }

    // Best single trade
    const bestTrade = closedTrades.reduce(
      (best, t) => (t.pnlPct > best.pnlPct ? t : best),
      closedTrades[0]
    );

    // Profit factor: gross wins / gross losses
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const losses = closedTrades.filter((t) => t.pnl < 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;

    return { winRatePct, avgProfitUsd, avgReturnPct, maxDrawdownPct, bestTrade, profitFactor };
  }, [closedTrades, growthData]);

  // Chart domain
  const chartMin = growthData.length > 0
    ? Math.min(...growthData.map((d) => d.value)) * 0.98
    : startingCapital * 0.95;
  const chartMax = growthData.length > 0
    ? Math.max(...growthData.map((d) => d.value)) * 1.02
    : startingCapital * 1.15;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 rounded-full border-2 border-primary border-t-transparent animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading dashboard…</p>
        </div>
      </div>
    );
  }

  if (error || !account) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-foreground text-lg mb-4">Demo account not found</p>
          <Link href="/demo/signup">
            <Button className="bg-primary text-primary-foreground">Create New Demo Account</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-md sticky top-0 z-40">
        <div className="container flex items-center justify-between h-16">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center">
              <img
                src="/manus-storage/anavi-logo-wordmark_51f8821a.png"
                alt="@navi"
                className="h-8 w-auto object-contain"
                style={{ filter: "brightness(0) invert(1)" }}
              />
            </Link>
            <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-md font-medium">DEMO</span>
            {/* Live pulse indicator */}
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              <span className="text-xs text-green-400 font-medium hidden sm:block">LIVE</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="text-xs text-muted-foreground hidden md:block">
                Updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
            <span className="text-sm text-muted-foreground hidden sm:block">{account.username}</span>
            <Button
              variant="outline"
              size="sm"
              className="border-border text-foreground gap-1.5"
              onClick={() => triggerSync.mutate({ token: params.token || "" })}
              disabled={triggerSync.isPending}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${triggerSync.isPending ? "animate-spin" : ""}`} />
              {triggerSync.isPending ? "Syncing…" : "Sync"}
            </Button>
            <Link href="/">
              <Button variant="outline" size="sm" className="border-border text-foreground">
                <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="container py-8">
        {/* Stats Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            icon={<DollarSign className="w-5 h-5" />}
            label="Starting Capital"
            value={`$${startingCapital.toLocaleString()}`}
            color="text-foreground"
          />
          <StatCard
            icon={<Activity className="w-5 h-5" />}
            label="Current Balance"
            value={`$${currentBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
            color="text-primary"
            highlight={totalPnl > 0}
          />
          <StatCard
            icon={totalPnl >= 0 ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
            label="Total P&L"
            value={`${totalPnl >= 0 ? "+" : ""}$${Math.abs(totalPnl).toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
            sub={`${parseFloat(pnlPercent) >= 0 ? "+" : ""}${pnlPercent}%`}
            color={totalPnl >= 0 ? "text-green-400" : "text-red-400"}
          />
          <StatCard
            icon={<Zap className="w-5 h-5" />}
            label="Win Rate"
            value={winRate !== null ? `${winRate}%` : "—"}
            sub={closedTrades.length > 0 ? `${winCount}/${closedTrades.length} trades` : "No trades yet"}
            color={winRate !== null && parseInt(winRate) >= 50 ? "text-green-400" : "text-muted-foreground"}
          />
        </div>

        {/* Summary Statistics */}
        {summaryStats && (
          <div className="bg-card border border-border rounded-2xl p-6 mb-8">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="font-heading font-semibold text-foreground">Performance Summary</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {closedTrades.length} closed trades · 0.5% fixed-fractional sizing · compounded returns
                </p>
              </div>
              {summaryStats.winRatePct >= 60 && (
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-green-500/15 text-green-400 border border-green-500/30">
                  ↑ Strong edge detected
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <SummaryStatItem
                label="Win Rate"
                value={`${summaryStats.winRatePct.toFixed(1)}%`}
                sub={`${winCount}W / ${closedTrades.length - winCount}L — every signal counts`}
                positive={summaryStats.winRatePct >= 50}
                bar={summaryStats.winRatePct}
              />
              <SummaryStatItem
                label="Avg Profit / Trade"
                value={`${summaryStats.avgProfitUsd >= 0 ? "+" : ""}$${Math.abs(summaryStats.avgProfitUsd).toFixed(2)}`}
                sub={`${summaryStats.avgReturnPct >= 0 ? "+" : ""}${summaryStats.avgReturnPct.toFixed(2)}% per signal — it adds up fast`}
                positive={summaryStats.avgProfitUsd >= 0}
              />
              <SummaryStatItem
                label="Max Drawdown"
                value={summaryStats.maxDrawdownPct < 0.01 ? "<0.01%" : `-${summaryStats.maxDrawdownPct.toFixed(2)}%`}
                sub="Capital protected — risk is capped at 0.5% per entry"
                positive={summaryStats.maxDrawdownPct < 2}
                negative={summaryStats.maxDrawdownPct >= 2}
              />
              <SummaryStatItem
                label="Profit Factor"
                value={summaryStats.profitFactor != null ? summaryStats.profitFactor.toFixed(2) + "×" : "∞"}
                sub={summaryStats.profitFactor == null || summaryStats.profitFactor > 2 ? "Exceptional edge — wins dwarf losses" : "Gross wins ÷ gross losses"}
                positive={summaryStats.profitFactor == null || summaryStats.profitFactor >= 1}
              />
              <SummaryStatItem
                label="Best Trade"
                value={`+${summaryStats.bestTrade.pnlPct.toFixed(2)}%`}
                sub={`${summaryStats.bestTrade.pair} — one signal, real returns`}
                positive
              />
            </div>
          </div>
        )}

        {/* Growth Chart */}
        <div className="bg-card border border-border rounded-2xl p-6 mb-8">
          <div className="flex items-start justify-between mb-1">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-heading font-semibold text-foreground">Equity Curve</h3>
                <div className="flex items-center gap-1 text-xs text-green-400">
                  <Radio className="w-3 h-3" />
                  <span>Live</span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                {growthData.length > 1
                  ? `${growthData[0].label} → ${growthData[growthData.length - 1].label} · ${closedTrades.length} signals applied · 0.5% position sizing`
                  : "Click Sync to build your equity curve from historical signals"}
              </p>
            </div>
            <div className="text-right">
              {growthData.length > 0 && (
                <span className={`text-lg font-bold ${parseFloat(pnlPercent) >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {parseFloat(pnlPercent) >= 0 ? "+" : ""}{pnlPercent}%
                </span>
              )}
              {lastUpdated && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  <Clock className="w-3 h-3 inline mr-1" />
                  {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </p>
              )}
            </div>
          </div>

          {growthData.length < 2 ? (
            <div className="h-[280px] flex flex-col items-center justify-center text-center gap-4 border border-dashed border-border/50 rounded-xl mt-4">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <TrendingUp className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground mb-1">No equity data yet</p>
                <p className="text-xs text-muted-foreground max-w-xs">
                  Click <strong>Sync</strong> to apply all historical Tier A + B signals to your account.
                  The chart will show your real equity curve with 0.5% position sizing per trade.
                </p>
              </div>
              <Button
                size="sm"
                className="bg-primary text-primary-foreground"
                onClick={() => triggerSync.mutate({ token: params.token || "" })}
                disabled={triggerSync.isPending}
              >
                <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${triggerSync.isPending ? "animate-spin" : ""}`} />
                {triggerSync.isPending ? "Syncing signals…" : "Sync Historical Signals"}
              </Button>
            </div>
          ) : (
            <div className="h-[280px] mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={growthData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={totalPnl >= 0 ? "var(--color-primary)" : "var(--color-profit-red)"} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={totalPnl >= 0 ? "var(--color-primary)" : "var(--color-profit-red)"} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    domain={[chartMin, chartMax]}
                    tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) =>
                      v >= 1_000_000
                        ? `$${(v / 1_000_000).toFixed(1)}M`
                        : v >= 1000
                        ? `$${(v / 1000).toFixed(0)}k`
                        : `$${v.toFixed(0)}`
                    }
                    width={56}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-popover)",
                      border: "1px solid var(--color-border)",
                      borderRadius: "10px",
                      color: "white",
                      fontSize: "12px",
                      padding: "10px 14px",
                    }}
                    formatter={(value: number) => [
                      `$${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
                      "Balance",
                    ]}
                    labelFormatter={(label) => `📅 ${label}`}
                  />
                  {/* Dashed reference line at starting capital */}
                  <ReferenceLine
                    y={startingCapital}
                    stroke="var(--color-muted-foreground)"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                    label={{ value: "Start", fill: "var(--color-muted-foreground)", fontSize: 9, position: "insideTopLeft" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={totalPnl >= 0 ? "var(--color-primary)" : "var(--color-profit-red)"}
                    strokeWidth={2.5}
                    fill="url(#equityGradient)"
                    dot={false}
                    activeDot={{ r: 5, strokeWidth: 0 }}
                    isAnimationActive={true}
                    animationDuration={600}
                    animationEasing="ease-out"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Live Signal Feed */}
        <LiveSignalFeed token={params.token || ""} />

        {/* Trade History */}
        <div className="bg-card border border-border rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-heading font-semibold text-foreground">Trade History</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Simulated trades from real Tier A + B signals · 0.5% position size per entry
              </p>
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setTradeTab("closed")}
                className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-all ${
                  tradeTab === "closed"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground bg-secondary"
                }`}
              >
                Closed ({closedTrades.length})
              </button>
              <button
                onClick={() => setTradeTab("open")}
                className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-all ${
                  tradeTab === "open"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground bg-secondary"
                }`}
              >
                Open ({openTrades.length})
              </button>
            </div>
          </div>

          {displayTrades.length === 0 ? (
            <div className="py-16 text-center">
              <Clock className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                {tradeTab === "closed"
                  ? "No closed trades yet. Click Sync to apply historical signals."
                  : "No open trades — all signals are applied as closed simulated trades."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-2 text-muted-foreground font-medium">Pair</th>
                    <th className="text-left py-3 px-2 text-muted-foreground font-medium">Indicator</th>
                    <th className="text-left py-3 px-2 text-muted-foreground font-medium">TF</th>
                    <th className="text-left py-3 px-2 text-muted-foreground font-medium">Tier</th>
                    <th className="text-right py-3 px-2 text-muted-foreground font-medium">Entry</th>
                    <th className="text-right py-3 px-2 text-muted-foreground font-medium">Exit</th>
                    <th className="text-right py-3 px-2 text-muted-foreground font-medium">P&L</th>
                    <th className="text-right py-3 px-2 text-muted-foreground font-medium">Return</th>
                    <th className="text-right py-3 px-2 text-muted-foreground font-medium">Opened</th>
                    <th className="text-right py-3 px-2 text-muted-foreground font-medium">Closed</th>
                    <th className="text-right py-3 px-2 text-muted-foreground font-medium">Duration</th>
                    <th className="text-center py-3 px-2 text-muted-foreground font-medium w-12">Chart</th>
                  </tr>
                </thead>
                <tbody>
                  {(displayTrades as typeof closedTrades).map((t) => {
                    const isNew = newTradeIds.has(t.id);
                    return (
                      <React.Fragment key={t.id}>
                        <tr className={`border-b border-border/40 transition-all duration-700 ${
                          isNew
                            ? "bg-primary/10 animate-pulse"
                            : "hover:bg-secondary/20"
                        }`}>
                          <td className="py-3 px-2 font-medium text-foreground">
                            {isNew && (
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1.5 animate-ping" />
                            )}
                            {t.pair}
                          </td>
                          <td className="py-3 px-2 text-muted-foreground text-xs">{t.indicatorName ?? "—"}</td>
                          <td className="py-3 px-2 text-muted-foreground text-xs">{t.period ?? "—"}</td>
                          <td className="py-3 px-2">
                            {t.qualityTier ? (
                              <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${TIER_COLORS[t.qualityTier] ?? ""}`}>
                                {t.qualityTier}
                              </span>
                            ) : "—"}
                          </td>
                          <td className="py-3 px-2 text-right text-foreground font-mono text-xs">
                            ${t.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
                          </td>
                          <td className="py-3 px-2 text-right text-foreground font-mono text-xs">
                            {t.exitPrice != null
                              ? `$${t.exitPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
                              : "—"}
                          </td>
                          <td className={`py-3 px-2 text-right font-medium ${t.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {t.pnl >= 0 ? "+" : ""}${Math.abs(t.pnl).toFixed(2)}
                          </td>
                          <td className={`py-3 px-2 text-right text-xs font-medium ${t.pnlPct >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%
                          </td>
                          <td className="py-3 px-2 text-right text-muted-foreground text-xs whitespace-nowrap">
                            {t.openedAt ? (
                              <>
                                <div>{t.openedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
                                <div className="text-muted-foreground/50">{t.openedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                              </>
                            ) : "—"}
                          </td>
                          <td className="py-3 px-2 text-right text-muted-foreground text-xs whitespace-nowrap">
                            {t.closedAt ? (
                              <>
                                <div>{t.closedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
                                <div className="text-muted-foreground/50">{t.closedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                              </>
                            ) : <span className="text-amber-400/70">Open</span>}
                          </td>
                          <td className="py-3 px-2 text-right text-muted-foreground text-xs whitespace-nowrap">
                            {fmtDuration(t.openedAt, t.closedAt) || "—"}
                          </td>
                          <td className="py-3 px-2 text-center">
                            <button
                              className="text-muted-foreground hover:text-foreground transition-colors"
                              onClick={() => setExpandedTradeId(expandedTradeId === t.id ? null : t.id)}
                              aria-label={expandedTradeId === t.id ? "Collapse chart" : "Expand chart"}
                            >
                              {expandedTradeId === t.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            </button>
                          </td>
                        </tr>
                        {expandedTradeId === t.id && (
                          <tr className="border-b border-border/40 bg-secondary/10">
                            <td colSpan={12} className="py-3 px-4">
                              <TradeChartSnapshot
                                pair={t.pair}
                                entryPrice={t.entryPrice}
                                exitPrice={t.exitPrice}
                                period={t.period}
                                openedAt={t.openedAt}
                                closedAt={t.closedAt}
                                positive={t.pnl >= 0}
                                height={220}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function StatCard({
  icon, label, value, sub, color, highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  color: string;
  highlight?: boolean;
}) {
  return (
    <div className={`bg-card border rounded-xl p-5 transition-all duration-500 ${
      highlight ? "border-primary/40" : "border-border"
    }`}
      style={highlight ? { boxShadow: "0 0 20px oklch(0.65 0.2 255 / 0.12)" } : undefined}>
      <div className="flex items-center gap-2 mb-2">
        <div className="text-muted-foreground">{icon}</div>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={`text-xl font-heading font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Live Signal Feed ────────────────────────────────────────────────────────
function LiveSignalFeed({ token }: { token: string }) {
  const { data: signals } = trpc.demo.getRecentSignals.useQuery(
    { token },
    { enabled: !!token, refetchInterval: POLL_INTERVAL_MS }
  );

  if (!signals || signals.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-2xl p-6 mb-8">
      <div className="flex items-center gap-2 mb-4">
        <Wifi className="w-4 h-4 text-primary" />
        <h3 className="font-heading font-semibold text-foreground">Live Signal Feed</h3>
        <span className="relative flex h-2 w-2 ml-1">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
        </span>
        <span className="text-xs text-muted-foreground ml-auto">Latest {signals.length} signals · refreshes every 30s</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 px-2 text-muted-foreground font-medium">Pair</th>
              <th className="text-left py-2 px-2 text-muted-foreground font-medium">Indicator</th>
              <th className="text-left py-2 px-2 text-muted-foreground font-medium">TF</th>
              <th className="text-left py-2 px-2 text-muted-foreground font-medium">Tier</th>
              <th className="text-right py-2 px-2 text-muted-foreground font-medium">Price</th>
              <th className="text-right py-2 px-2 text-muted-foreground font-medium">Max Profit</th>
              <th className="text-right py-2 px-2 text-muted-foreground font-medium">Score</th>
              <th className="text-right py-2 px-2 text-muted-foreground font-medium">Date</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((s, i) => (
              <tr key={(s as any).rowKey ?? `${s.id}-${i}`} className="border-b border-border/40 hover:bg-secondary/20 transition-colors">
                <td className="py-2.5 px-2 font-medium text-foreground">{s.marketName}</td>
                <td className="py-2.5 px-2 text-muted-foreground text-xs">{s.indicatorShortName ?? "—"}</td>
                <td className="py-2.5 px-2 text-muted-foreground text-xs">{s.period ?? "—"}</td>
                <td className="py-2.5 px-2">
                  {s.qualityTier ? (
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${TIER_COLORS[s.qualityTier] ?? ""}`}>
                      {s.qualityTier}
                    </span>
                  ) : "—"}
                </td>
                <td className="py-2.5 px-2 text-right font-mono text-xs text-foreground">
                  ${parseFloat(s.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
                </td>
                <td className="py-2.5 px-2 text-right text-xs font-medium primary">
                  {s.maxProfit ? `+${parseFloat(s.maxProfit).toFixed(2)}%` : "—"}
                </td>
                <td className="py-2.5 px-2 text-right text-xs text-muted-foreground">
                  {s.qualityScore != null ? s.qualityScore.toFixed(1) : "—"}
                </td>
                <td className="py-2.5 px-2 text-right text-xs text-muted-foreground">
                  {s.signalDate
                    ? new Date(s.signalDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Summary Stat Item ───────────────────────────────────────────────────────
function SummaryStatItem({
  label,
  value,
  sub,
  positive,
  negative,
  bar,
}: {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean;
  negative?: boolean;
  bar?: number; // 0–100, renders a progress bar when provided
}) {
  const valueColor = negative
    ? "text-red-400"
    : positive
    ? "text-green-400"
    : "text-foreground";

  return (
    <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-heading font-bold ${valueColor}`}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground leading-tight">{sub}</span>}
      {bar !== undefined && (
        <div className="mt-1 h-1.5 rounded-full bg-border overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${positive ? "bg-green-500" : "bg-red-500"}`}
            style={{ width: `${Math.min(bar, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
