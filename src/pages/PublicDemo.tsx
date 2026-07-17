import { useState, useEffect, useMemo, useRef } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer,
  Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";
import {
  TrendingUp, TrendingDown, DollarSign, Activity,
  Zap,
  BarChart2, Shield, Radio, Wifi, Clock, ArrowUpRight, ArrowDownRight,
} from "lucide-react";
import { toast } from "sonner";
import TradeChartSnapshot from "@/components/TradeChartSnapshot";
import { formatSignedPercent, UNAVAILABLE } from "@/components/performancePresentation";

// Slide-in animation for new trade cards now lives in index.css (.trade-card-new)
// — keeping it out of module scope preserves Fast Refresh / avoids dev reloads.

const TIER_COLORS: Record<string, string> = {
  A: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  B: "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30",
  C: "bg-slate-500/15 text-slate-400 border border-slate-500/30",
};

const POLL_MS = 30_000;

// ── Stat card ──────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, color, highlight }: {
  icon: React.ReactNode; label: string; value: string;
  sub?: string; color?: string; highlight?: boolean;
}) {
  return (
    <div className={`glass-card p-4 rounded-xl border transition-all ${highlight ? "border-primary/40" : "border-border"}`}
      style={highlight ? { boxShadow: "0 0 16px oklch(0.65 0.2 255 / 0.12)" } : undefined}>
      <div className="flex items-center gap-2 mb-2 text-muted-foreground">{icon}<span className="text-xs font-medium uppercase tracking-wide">{label}</span></div>
      <div className={`text-xl font-bold font-mono ${color ?? "text-foreground"}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

// ── Summary stat item ──────────────────────────────────────────────────────
function SummaryStatItem({ label, value, sub, color, bar, barPct }: {
  label: string; value: string; sub: string; color?: string; bar?: boolean; barPct?: number;
}) {
  return (
    <div className="glass-card p-4 rounded-xl border border-border">
      <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wide font-medium">{label}</div>
      <div className={`text-2xl font-bold font-mono ${color ?? "text-foreground"}`}>{value}</div>
      {bar && barPct !== undefined && (
        <div className="mt-2 h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div className="h-full rounded-full bg-primary transition-all duration-700" style={{ width: `${Math.min(barPct, 100)}%` }} />
        </div>
      )}
      <div className="text-xs text-muted-foreground mt-1">{sub}</div>
    </div>
  );
}

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

// ── Trade card (mobile-first) ─────────────────────────────────────────────
function TradeCard({ trade, isNew }: {
  trade: {
    id: number; pair: string; pnl: number; pnlPct: number;
    openedAt: Date | null; closedAt: Date | null;
    indicatorName: string | null; period: string | null;
    qualityTier: string | null; qualityScore: number | null;
    entryPrice: number; exitPrice: number | null;
  };
  isNew: boolean;
}) {
  const positive = trade.pnl >= 0;
  const pnlColor = positive ? "text-green-400" : "text-red-400";
  const pnlBg = positive ? "bg-green-500/8 border-green-500/20" : "bg-red-500/8 border-red-500/20";

  return (
    <div className={`glass-card border rounded-xl p-4 transition-all ${pnlBg} ${isNew ? "trade-card-new" : ""}`}>
      {/* Top row: pair + tier + P&L */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          {isNew && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
          )}
          <span className="font-mono font-bold text-foreground text-base">{trade.pair}</span>
          {trade.qualityTier && (
            <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${TIER_COLORS[trade.qualityTier] ?? ""}`}>
              {trade.qualityTier}
            </span>
          )}
        </div>
        <div className="text-right">
          <div className={`text-lg font-bold font-mono ${pnlColor}`}>
            {positive ? "+" : ""}${Math.abs(trade.pnl).toFixed(2)}
          </div>
          <div className={`text-xs font-mono ${pnlColor}`}>
            {positive ? <ArrowUpRight className="w-3 h-3 inline" /> : <ArrowDownRight className="w-3 h-3 inline" />}
            {positive ? "+" : ""}{trade.pnlPct.toFixed(2)}%
          </div>
        </div>
      </div>

      {/* TradingView chart snapshot */}
      {trade.exitPrice !== null && (
        <div className="mb-3 -mx-1 rounded-lg overflow-hidden">
          <TradeChartSnapshot
            pair={trade.pair}
            entryPrice={trade.entryPrice}
            exitPrice={trade.exitPrice}
            period={trade.period}
            openedAt={trade.openedAt}
            closedAt={trade.closedAt}
            positive={trade.pnl >= 0}
            height={130}
          />
        </div>
      )}

      {/* Entry / Exit prices */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-white/[0.03] rounded-lg p-2.5">
          <div className="text-xs text-muted-foreground mb-0.5">Entry</div>
          <div className="font-mono text-sm text-foreground font-medium">
            ${trade.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
          </div>
        </div>
        <div className="bg-white/[0.03] rounded-lg p-2.5">
          <div className="text-xs text-muted-foreground mb-0.5">Exit</div>
          <div className={`font-mono text-sm font-medium ${pnlColor}`}>
            {trade.exitPrice !== null
              ? `$${trade.exitPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
              : "—"}
          </div>
        </div>
      </div>

      {/* Indicator + score row */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        {trade.indicatorName && (
          <span className="bg-white/5 px-1.5 py-0.5 rounded">{trade.indicatorName}</span>
        )}
        {trade.period && (
          <span className="bg-white/5 px-1.5 py-0.5 rounded">{trade.period}</span>
        )}
        {trade.qualityScore !== null && (
          <span className="text-muted-foreground/60 ml-auto">Score: {trade.qualityScore.toFixed(1)}</span>
        )}
      </div>

      {/* Entry / Exit timestamps + duration */}
      {(() => {
        const dur = fmtDuration(trade.openedAt, trade.closedAt);
        return (
          <>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-white/[0.02] rounded-lg px-2.5 py-1.5">
                <div className="text-muted-foreground/60 mb-0.5">Opened</div>
                {trade.openedAt ? (
                  <>
                    <div className="font-medium text-foreground">
                      {trade.openedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </div>
                    <div className="text-muted-foreground/70">
                      {trade.openedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </>
                ) : <div className="text-muted-foreground/40">—</div>}
              </div>
              <div className="bg-white/[0.02] rounded-lg px-2.5 py-1.5">
                <div className="text-muted-foreground/60 mb-0.5">Closed</div>
                {trade.closedAt ? (
                  <>
                    <div className="font-medium text-foreground">
                      {trade.closedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </div>
                    <div className="text-muted-foreground/70">
                      {trade.closedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </>
                ) : <div className="text-muted-foreground/40">Open</div>}
              </div>
            </div>
            {dur && (
              <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground/60">
                <Clock className="w-3 h-3" />
                <span>Duration: <span className="text-muted-foreground font-medium">{dur}</span></span>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

// ── Live Signal Feed ───────────────────────────────────────────────────────
function LiveSignalFeed({ token }: { token: string }) {
  const { data: signals } = trpc.demo.getRecentSignals.useQuery(
    { token },
    { enabled: !!token, refetchInterval: POLL_MS }
  );

  if (!signals || signals.length === 0) return null;

  return (
    <div className="glass-card border border-border rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border flex items-center gap-2">
        <Wifi className="w-4 h-4 text-primary" />
        <h2 className="font-heading font-semibold text-foreground">Live Signal Feed</h2>
        <span className="relative flex h-2 w-2 ml-1">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
        </span>
        <span className="text-xs text-muted-foreground ml-auto">Latest {signals.length} · refreshes every 30s</span>
      </div>
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              {["Pair", "Indicator", "TF", "Tier", "Price", "Reported Favorable Move", "Score", "Date"].map((h) => (
                <th key={h} className={`py-2.5 px-3 text-xs text-muted-foreground font-medium ${h === "Price" || h === "Reported Favorable Move" || h === "Score" || h === "Date" ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {signals.map((s, i) => (
              <tr key={(s as any).rowKey ?? `${s.id}-${i}`} className="border-b border-border/40 hover:bg-white/[0.02] transition-colors">
                <td className="py-2.5 px-3 font-mono font-semibold text-foreground">{s.marketName}</td>
                <td className="py-2.5 px-3 text-muted-foreground text-xs">{s.indicatorShortName ?? "—"}</td>
                <td className="py-2.5 px-3 text-muted-foreground text-xs">{s.period ?? "—"}</td>
                <td className="py-2.5 px-3">
                  {s.qualityTier && <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${TIER_COLORS[s.qualityTier] ?? ""}`}>{s.qualityTier}</span>}
                </td>
                <td className="py-2.5 px-3 text-right font-mono text-xs text-foreground">
                  ${parseFloat(s.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
                </td>
                <td className="py-2.5 px-3 text-right text-xs font-medium text-green-400">
                  {formatSignedPercent(s.maxProfit, 2)}
                </td>
                <td className="py-2.5 px-3 text-right text-xs text-muted-foreground">
                  {s.qualityScore != null ? s.qualityScore.toFixed(1) : UNAVAILABLE}
                </td>
                <td className="py-2.5 px-3 text-right text-xs text-muted-foreground whitespace-nowrap">
                  {s.signalDate ? (
                    <>
                      <div>{new Date(s.signalDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
                      <div className="text-muted-foreground/50">{new Date(s.signalDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                    </>
                  ) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Mobile cards */}
      <div className="md:hidden divide-y divide-border">
        {signals.slice(0, 10).map((s, i) => (
          <div key={(s as any).rowKey ?? `${s.id}-${i}`} className="p-3 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="font-mono font-semibold text-sm text-foreground">{s.marketName}</span>
                {s.qualityTier && <span className={`text-xs font-bold px-1 py-0.5 rounded ${TIER_COLORS[s.qualityTier] ?? ""}`}>{s.qualityTier}</span>}
              </div>
              <div className="text-xs text-muted-foreground">{s.indicatorShortName ?? "—"} · {s.period ?? "—"}</div>
            </div>
            <div className="text-right">
              <div className="text-xs font-mono text-foreground">${parseFloat(s.price).toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
              <div className="text-xs font-medium text-green-400">{formatSignedPercent(s.maxProfit, 2)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function PublicDemo() {
  const [tradeView, setTradeView] = useState<"cards" | "table">("cards");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const prevTradeIds = useRef<Set<number>>(new Set());
  const [newTradeIds, setNewTradeIds] = useState<Set<number>>(new Set());
  const [sortBy, setSortBy] = useState<"date" | "duration" | "pnl">("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleSort(col: typeof sortBy) {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortBy(col); setSortDir("desc"); }
  }

  const { data: publicDemo, isLoading: demoLoading } = trpc.demo.getPublicDemo.useQuery(undefined, {
    refetchInterval: POLL_MS,
  });

  const token = publicDemo?.token ?? "";

  const { data: backendTrades } = trpc.demo.getTrades.useQuery(
    { token },
    { enabled: !!token, refetchInterval: POLL_MS }
  );

  const { data: portfolioSeries } = trpc.demo.getPortfolioSeries.useQuery(
    { token },
    { enabled: !!token, refetchInterval: POLL_MS }
  );

  // Detect new trades → toast + animate
  useEffect(() => {
    if (!backendTrades) return;
    const currentIds = new Set<number>(backendTrades.map((t) => Number(t.id)));
    const arrived: number[] = [];
    currentIds.forEach((id) => { if (!prevTradeIds.current.has(id)) arrived.push(id); });
    if (arrived.length > 0 && prevTradeIds.current.size > 0) {
      toast.success(`${arrived.length} new trade${arrived.length > 1 ? "s" : ""} applied to portfolio`, {
        description: "Equity curve updated in real-time", duration: 4500,
      });
      setNewTradeIds(new Set(arrived));
      setTimeout(() => setNewTradeIds(new Set()), 3000);
    }
    prevTradeIds.current = currentIds;
    setLastUpdated(new Date());
  }, [backendTrades]);

  const account = publicDemo?.account;
  const startingCapital = account ? parseFloat(account.startingCapital) : 10000;
  const currentBalance = account ? parseFloat(account.currentBalance) : startingCapital;

  const growthData = useMemo(() => {
    if (!portfolioSeries || portfolioSeries.length === 0) return [];
    return portfolioSeries.map((p) => ({ timestamp: p.timestamp, label: p.label, value: p.value, tradeCount: p.tradeCount }));
  }, [portfolioSeries]);

  const totalPnl = currentBalance - startingCapital;
  const pnlPercent = startingCapital > 0 ? ((totalPnl / startingCapital) * 100).toFixed(2) : "0.00";

  const closedTrades = useMemo(() => {
    if (!backendTrades) return [];
    const mapped = backendTrades.filter((t) => t.status === "closed").map((t) => ({
      id: t.id,
      pair: t.pair,
      pnl: t.pnl ? parseFloat(t.pnl) : 0,
      pnlPct: t.pnlPct ? parseFloat(t.pnlPct) : 0,
      openedAt: t.openedAt ? new Date(t.openedAt) : null,
      closedAt: t.closedAt ? new Date(t.closedAt) : null,
      indicatorName: (t as any).indicatorName ?? null,
      period: (t as any).period ?? null,
      qualityTier: (t as any).qualityTier ?? null,
      qualityScore: (t as any).qualityScore ?? null,
      entryPrice: parseFloat(t.entryPrice),
      exitPrice: t.exitPrice ? parseFloat(t.exitPrice) : null,
    }));
    return [...mapped].sort((a, b) => {
      let cmp = 0;
      if (sortBy === "date") {
        cmp = (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0);
      } else if (sortBy === "duration") {
        const durA = a.openedAt && a.closedAt ? a.closedAt.getTime() - a.openedAt.getTime() : 0;
        const durB = b.openedAt && b.closedAt ? b.closedAt.getTime() - b.openedAt.getTime() : 0;
        cmp = durA - durB;
      } else if (sortBy === "pnl") {
        cmp = a.pnl - b.pnl;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [backendTrades, sortBy, sortDir]);

  const winCount = closedTrades.filter((t) => t.pnl > 0).length;

  const summaryStats = useMemo(() => {
    if (closedTrades.length === 0) return null;
    const wins = closedTrades.filter((t) => t.pnl > 0);
    const winRatePct = (wins.length / closedTrades.length) * 100;
    const avgProfitUsd = closedTrades.reduce((a, t) => a + t.pnl, 0) / closedTrades.length;
    const avgReturnPct = closedTrades.reduce((a, t) => a + t.pnlPct, 0) / closedTrades.length;
    let maxDrawdownPct = 0;
    if (growthData.length >= 2) {
      let peak = growthData[0].value;
      for (const p of growthData) {
        if (p.value > peak) peak = p.value;
        const dd = peak > 0 ? ((peak - p.value) / peak) * 100 : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }
    }
    const bestTrade = closedTrades.reduce((b, t) => (t.pnlPct > b.pnlPct ? t : b), closedTrades[0]);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const losses = closedTrades.filter((t) => t.pnl < 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;
    return { winRatePct, avgProfitUsd, avgReturnPct, maxDrawdownPct, bestTrade, profitFactor };
  }, [closedTrades, growthData]);

  const chartMin = growthData.length > 0 ? Math.min(...growthData.map((d) => d.value)) * 0.98 : startingCapital * 0.95;
  const chartMax = growthData.length > 0 ? Math.max(...growthData.map((d) => d.value)) * 1.02 : startingCapital * 1.15;

  const posSize = account ? parseFloat(account.positionSizePct ?? "5.00") : 5;
  const leverage = account ? parseFloat((account as any).leverage ?? "3.00") : 3;

  if (demoLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 rounded-full border-2 border-primary border-t-transparent animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading investor preview…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-md sticky top-0 z-40">
        <div className="container flex items-center justify-between h-16">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center">
              <img
                src="/manus-storage/anavi-logo-wordmark_51f8821a.png"
                alt="@navi"
                className="h-8 w-auto object-contain"
                style={{ filter: "brightness(0) invert(1)" }}
              />
            </Link>
            <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-md font-medium border border-primary/20">LIVE DEMO</span>
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              <span className="text-xs text-green-400 font-medium hidden sm:block">LIVE</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lastUpdated && (
              <span className="text-xs text-muted-foreground hidden lg:block">
                Updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
            <Button size="sm" className="btn-border-wrap bg-primary text-primary-foreground gap-1.5" asChild>
              <Link href="/register">
                <span className="hidden sm:inline">Get Started Free →</span>
                <span className="sm:hidden">Start</span>
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="container py-8 space-y-8">
        {/* Investor banner */}
        <div className="glass-card border border-primary/20 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <BarChart2 className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">
                Investor Preview — Tier A Strategy · $10,000 Starting Capital
              </p>
              <p className="text-xs text-muted-foreground">
                Real signals · {posSize.toFixed(1)}% capital risk · {leverage.toFixed(1)}× leverage · auto-updated every 5 minutes
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Shield className="w-3.5 h-3.5 text-green-400" />
            <span className="text-xs text-green-400 font-medium">Non-custodial · Read-only</span>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard icon={<DollarSign className="w-5 h-5" />} label="Starting Capital" value="$10,000" color="text-foreground" />
          <StatCard icon={<Activity className="w-5 h-5" />} label="Current Balance"
            value={`$${currentBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
            color="text-primary" highlight={totalPnl > 0} />
          <StatCard
            icon={totalPnl >= 0 ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
            label="Modeled P&L"
            value={`${totalPnl >= 0 ? "+" : ""}$${Math.abs(totalPnl).toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
            sub={`${parseFloat(pnlPercent) >= 0 ? "+" : ""}${pnlPercent}%`}
            color={totalPnl >= 0 ? "text-green-400" : "text-red-400"} />
          <StatCard icon={<Zap className="w-5 h-5" />} label="Win Rate"
            value={closedTrades.length > 0 ? `${((winCount / closedTrades.length) * 100).toFixed(0)}%` : "—"}
            sub={closedTrades.length > 0 ? `${winCount}W / ${closedTrades.length - winCount}L · ${closedTrades.length} modeled trades` : "Unavailable"}
            color={winCount / closedTrades.length >= 0.5 ? "text-green-400" : "text-muted-foreground"} />
        </div>

        {/* Summary stats */}
        {summaryStats && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading font-semibold text-foreground">Performance Summary</h2>
              {summaryStats.winRatePct >= 60 && (
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-green-500/15 text-green-400 border border-green-500/30">
                  ↑ Strong edge detected
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              <SummaryStatItem label="Win Rate" value={`${summaryStats.winRatePct.toFixed(0)}%`}
                sub="every signal counts" color="text-green-400" bar barPct={summaryStats.winRatePct} />
              <SummaryStatItem label="Avg Profit / Trade"
                value={`${summaryStats.avgProfitUsd >= 0 ? "+" : ""}$${Math.abs(summaryStats.avgProfitUsd).toFixed(2)}`}
                sub={`${summaryStats.avgReturnPct >= 0 ? "+" : ""}${summaryStats.avgReturnPct.toFixed(2)}% avg — it adds up fast`}
                color="text-primary" />
              <SummaryStatItem label="Max Drawdown"
                value={summaryStats.maxDrawdownPct < 0.01 ? "<0.01%" : `-${summaryStats.maxDrawdownPct.toFixed(2)}%`}
                sub={`Historical scenario using ${posSize.toFixed(1)}% risk per entry`}
                color="text-amber-400" />
              <SummaryStatItem label="Profit Factor"
                value={summaryStats.profitFactor === null ? "∞" : summaryStats.profitFactor.toFixed(2) + "×"}
                sub="Exceptional edge — wins dwarf losses" color="text-cyan-400" />
              <SummaryStatItem label="Best Trade"
                value={`+${summaryStats.bestTrade.pnlPct.toFixed(2)}%`}
                sub={`${summaryStats.bestTrade.pair} — modeled historical scenario`}
                color="text-amber-300" />
            </div>
          </div>
        )}

        {/* Equity curve */}
        <div className="glass-card border border-border rounded-xl p-6 relative overflow-hidden">
          {/* Subtle decorative orbit ring */}
          <div className="absolute -bottom-48 -right-48 w-[500px] h-[500px] rounded-full border pointer-events-none opacity-[0.06]"
            style={{
              borderColor: "color-mix(in srgb, var(--color-primary) 30%, transparent)",
              animation: "spinRight 80s linear infinite",
            }} />
          <div className="absolute -bottom-56 -right-56 w-[650px] h-[650px] rounded-full border pointer-events-none opacity-[0.04]"
            style={{
              borderColor: "color-mix(in srgb, var(--color-primary) 20%, transparent)",
              animation: "spinLeft 100s linear infinite",
            }} />
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-heading font-semibold text-foreground">Portfolio Equity Curve</h2>
                <div className="flex items-center gap-1 text-xs text-green-400">
                  <Radio className="w-3 h-3" /><span>Live</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {growthData.length > 1
                  ? `${growthData[0].label} → ${growthData[growthData.length - 1].label} · ${closedTrades.length} Tier A signals · ${posSize.toFixed(1)}% risk × ${leverage.toFixed(1)}× leverage`
                  : "Historical scenario data is unavailable"}
              </p>
            </div>
            <div className="text-right flex-shrink-0">
              {growthData.length > 0 && (
                <span className={`text-lg font-bold font-mono ${parseFloat(pnlPercent) >= 0 ? "text-green-400" : "text-red-400"}`}>
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
          {growthData.length > 1 ? (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={growthData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="pubGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(1 0 0 / 0.04)" />
                <XAxis dataKey="label" tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis domain={[chartMin, chartMax]} tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }} tickLine={false} axisLine={false}
                  tickFormatter={(v) => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`} width={56} />
                <Tooltip
                  contentStyle={{ background: "var(--color-popover)", border: "1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)", borderRadius: "8px", color: "white", fontSize: "12px" }}
                  formatter={(v: number) => [`$${v.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, "Balance"]}
                  labelFormatter={(l) => `📅 ${l}`}
                />
                <ReferenceLine y={startingCapital} stroke="color-mix(in srgb, var(--color-primary) 30%, transparent)" strokeDasharray="4 4"
                  label={{ value: "Start $10k", fill: "var(--color-primary)", fontSize: 10, position: "insideTopLeft" }} />
                {/* Strategy launch annotation — vertical line at Jul 1 */}
                {growthData.length > 0 && (() => {
                  const jul1Label = growthData.find(d => d.label === "Jul 1")?.label;
                  return jul1Label ? (
                    <ReferenceLine x={jul1Label} stroke="color-mix(in srgb, var(--color-profit-green) 60%, transparent)" strokeDasharray="3 3"
                      label={{ value: "Strategy launched", fill: "var(--color-profit-green)", fontSize: 9, position: "insideTopRight" }} />
                  ) : null;
                })()}
                <Area type="monotone" dataKey="value" stroke="var(--color-primary)" strokeWidth={2.5}
                  fill="url(#pubGradient)" dot={false} activeDot={{ r: 4, fill: "var(--color-primary)" }}
                  isAnimationActive animationDuration={600} animationEasing="ease-out" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[280px] flex flex-col items-center justify-center text-center gap-4 border border-dashed border-border/50 rounded-xl">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <TrendingUp className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground mb-1">Equity curve loading…</p>
                <p className="text-xs text-muted-foreground max-w-xs">
                  Historical scenario data is currently unavailable.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Live Signal Feed */}
        <LiveSignalFeed token={token} />

        {/* Trade History */}
        <div className="glass-card border border-border rounded-xl overflow-hidden">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="font-heading font-semibold text-foreground">Trade History</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Modeled historical scenario from recorded Tier A signals · {posSize.toFixed(1)}% capital risk × {leverage.toFixed(1)}× leverage
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground hidden sm:block">{closedTrades.length} closed</span>
              {/* View toggle: cards / table */}
              <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
                <button
                  onClick={() => setTradeView("cards")}
                  className={`px-2.5 py-1 text-xs rounded-md transition-all ${tradeView === "cards" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Cards
                </button>
                <button
                  onClick={() => setTradeView("table")}
                  className={`px-2.5 py-1 text-xs rounded-md transition-all ${tradeView === "table" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Table
                </button>
              </div>
            </div>
          </div>

          {closedTrades.length === 0 ? (
            <div className="py-16 text-center">
              <Clock className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Historical scenario trades are unavailable</p>
            </div>
          ) : tradeView === "cards" ? (
            /* Mobile-first card grid */
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {closedTrades.map((t) => (
                <TradeCard key={t.id} trade={t} isNew={newTradeIds.has(t.id)} />
              ))}
            </div>
          ) : (
            /* Desktop table view */
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    {["Pair", "Tier", "Indicator", "TF", "Entry Price", "Exit Price", "Opened", "Closed", "Duration", "Modeled P&L", "Modeled Return"].map((h) => {
                      const sortKey = h === "Duration" ? "duration" : h === "Modeled P&L" ? "pnl" : h === "Closed" ? "date" : null;
                      const isActive = sortKey && sortBy === sortKey;
                      return (
                        <th
                          key={h}
                          onClick={sortKey ? () => toggleSort(sortKey as typeof sortBy) : undefined}
                          className={`py-3 px-3 text-xs font-medium select-none ${["Entry Price", "Exit Price", "Opened", "Closed", "Duration", "Modeled P&L", "Modeled Return"].includes(h) ? "text-right" : "text-left"} ${sortKey ? "cursor-pointer hover:text-foreground transition-colors" : ""} ${isActive ? "text-primary" : "text-muted-foreground"}`}
                        >
                          {h}{isActive ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {closedTrades.map((t) => (
                    <tr key={t.id} className={`border-b border-border/50 hover:bg-white/[0.02] transition-colors ${newTradeIds.has(t.id) ? "trade-card-new" : ""}`}>
                      <td className="px-3 py-3 font-mono font-semibold text-foreground">{t.pair}</td>
                      <td className="px-3 py-3">
                        {t.qualityTier && <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${TIER_COLORS[t.qualityTier] ?? ""}`}>{t.qualityTier}</span>}
                      </td>
                      <td className="px-3 py-3 text-muted-foreground text-xs">{t.indicatorName ?? "—"}</td>
                      <td className="px-3 py-3 text-muted-foreground text-xs">{t.period ?? "—"}</td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-muted-foreground">
                        ${t.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-muted-foreground">
                        {t.exitPrice ? `$${t.exitPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}` : "—"}
                      </td>
                      <td className={`px-3 py-3 text-right font-mono font-semibold ${t.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {t.pnl >= 0 ? "+" : ""}${Math.abs(t.pnl).toFixed(2)}
                      </td>
                      <td className={`px-3 py-3 text-right font-mono text-xs ${t.pnlPct >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%
                      </td>
                      <td className="px-3 py-3 text-right text-muted-foreground text-xs whitespace-nowrap">
                        {t.openedAt ? (
                          <>
                            <div>{t.openedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
                            <div className="text-muted-foreground/50">{t.openedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                          </>
                        ) : "—"}
                      </td>
                      <td className="px-3 py-3 text-right text-muted-foreground text-xs whitespace-nowrap">
                        {t.closedAt ? (
                          <>
                            <div>{t.closedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
                            <div className="text-muted-foreground/50">{t.closedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                          </>
                        ) : <span className="text-amber-400/70">Open</span>}
                      </td>
                      <td className="px-3 py-3 text-right text-muted-foreground text-xs whitespace-nowrap">
                        {fmtDuration(t.openedAt, t.closedAt) || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Leverage Disclaimer Banner */}
        <div className="flex items-start gap-3 px-5 py-4 rounded-xl border" style={{ background: "oklch(0.60 0.22 50 / 0.06)", borderColor: "oklch(0.60 0.22 50 / 0.25)" }}>
          <div className="flex-shrink-0 mt-0.5">
            <Shield className="w-4 h-4" style={{ color: "oklch(0.75 0.18 50)" }} />
          </div>
          <div className="text-xs leading-relaxed" style={{ color: "oklch(0.75 0.18 50)" }}>
            <span className="font-semibold">Risk Disclosure:</span>{" "}
            This demo uses <span className="font-semibold">{leverage.toFixed(1)}× leverage</span> and{" "}
            <span className="font-semibold">{posSize.toFixed(1)}% capital risk per trade</span>. Trading with leverage amplifies both gains and losses.
            Results shown are simulated from real signals on a $10,000 starting balance.
            Past performance is not indicative of future results. Capital is at risk.
          </div>
        </div>

        {/* CTA */}
        <div className="glass-card border border-primary/20 rounded-xl p-8 text-center">
          <h2 className="font-heading text-2xl font-bold gradient-text mb-2">Ready to trade with real capital?</h2>
          <p className="text-muted-foreground mb-6 max-w-md mx-auto">
            Create your account and connect your Aster account. Your signals start flowing immediately.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button size="lg" className="bg-primary text-primary-foreground" asChild>
              <Link href="/register">Create Free Account →</Link>
            </Button>
            <Button size="lg" variant="outline" className="border-border text-foreground" asChild>
              <Link href="/">Learn More</Link>
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
