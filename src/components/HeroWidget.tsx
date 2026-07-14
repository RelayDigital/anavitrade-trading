import { useMemo } from "react";
import { motion } from "framer-motion";
import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, Tooltip, ReferenceLine } from "recharts";
import { trpc } from "@/lib/trpc";
import { TrendingUp, Radio } from "lucide-react";

// ── Custom tooltip for the hero chart ─────────────────────────────────────
function HeroTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const val: number = payload[0].value;
  return (
    <div
      className="px-3 py-2 rounded-lg text-xs font-mono"
      style={{
        background: "oklch(0.10 0.02 255 / 0.95)",
        border: "1px solid oklch(0.65 0.2 255 / 0.25)",
        backdropFilter: "blur(8px)",
        color: "white",
      }}
    >
      <p className="text-[10px] text-white/50 mb-0.5">{label}</p>
      <p className="font-bold" style={{ color: "oklch(0.72 0.20 195)" }}>
        ${val.toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </p>
    </div>
  );
}

// ── Skeleton placeholder while data loads ─────────────────────────────────
function WidgetSkeleton() {
  return (
    <div className="iphone-frame">
      <div className="iphone-screen flex flex-col">
        <div className="h-8 shrink-0" />
        <div className="px-4 pt-3 pb-2 space-y-2 shrink-0">
          <div className="h-3 w-24 rounded bg-white/10 animate-pulse" />
          <div className="h-7 w-32 rounded bg-white/10 animate-pulse" />
          <div className="h-2 w-20 rounded bg-white/10 animate-pulse" />
        </div>
        <div className="px-2 flex-1 flex items-center justify-center">
          <div className="w-full h-[120px] rounded-lg bg-white/5 animate-pulse" />
        </div>
        <div className="px-4 pb-4 space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="flex justify-between">
              <div className="h-3 w-20 rounded bg-white/10 animate-pulse" />
              <div className="h-3 w-14 rounded bg-white/10 animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function HeroWidget() {
  // Fetch the public demo account info
  const { data: publicDemo } = trpc.demo.getPublicDemo.useQuery(undefined, {
    refetchInterval: 60_000, // refresh every minute
    staleTime: 30_000,
  });

  const token = publicDemo?.token ?? "";

  // Fetch the portfolio series (equity curve)
  const { data: portfolioSeries } = trpc.demo.getPortfolioSeries.useQuery(
    { token },
    { enabled: !!token, refetchInterval: 60_000, staleTime: 30_000 }
  );

  // Fetch recent trades for the trade list
  const { data: trades } = trpc.demo.getTrades.useQuery(
    { token },
    { enabled: !!token, refetchInterval: 60_000, staleTime: 30_000 }
  );

  const account = publicDemo?.account;
  const startingCapital = account ? parseFloat(account.startingCapital) : 10000;
  const currentBalance = account ? parseFloat(account.currentBalance) : startingCapital;
  const pnl = currentBalance - startingCapital;
  const pnlPct = startingCapital > 0 ? ((pnl / startingCapital) * 100) : 0;
  const isPositive = pnl >= 0;

  const chartData = useMemo(() => {
    if (!portfolioSeries || portfolioSeries.length === 0) return [];
    return portfolioSeries.map((p) => ({ label: p.label, value: p.value }));
  }, [portfolioSeries]);

  const chartMin = chartData.length > 0
    ? Math.min(...chartData.map(d => d.value)) * 0.985
    : startingCapital * 0.95;
  const chartMax = chartData.length > 0
    ? Math.max(...chartData.map(d => d.value)) * 1.015
    : startingCapital * 1.15;

  // Days active since Jul 1 2026 — computed unconditionally (hooks must not be after early return)
  const daysActive = useMemo(() => {
    const start = new Date("2026-07-01T00:00:00Z");
    const now = new Date();
    return Math.max(1, Math.floor((now.getTime() - start.getTime()) / 86400000) + 1);
  }, []);

  // Last 3 closed trades for the trade list
  const recentTrades = useMemo(() => {
    if (!trades) return [];
    return trades
      .filter(t => t.status === "closed")
      .slice(0, 3)
      .map(t => ({
        id: t.id,
        pair: t.pair.replace("USDT", "") + "/USDT",
        pnl: t.pnl ? parseFloat(t.pnl) : 0,
        pnlPct: t.pnlPct ? parseFloat(t.pnlPct) : 0,
        date: t.closedAt ? new Date(t.closedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "",
      }));
  }, [trades]);

  // Show skeleton while loading
  if (!publicDemo) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 40, rotateY: -5 }}
        animate={{ opacity: 1, y: 0, rotateY: 0 }}
        transition={{ duration: 1, delay: 0.3, ease: [0.23, 1, 0.32, 1] }}
        className="animate-float"
        style={{ perspective: "1000px" }}
      >
        <WidgetSkeleton />
      </motion.div>
    );
  }

  const azureColor = "oklch(0.65 0.2 255)";
  const cyanColor  = "oklch(0.72 0.20 195)";

  return (
    <motion.div
      initial={{ opacity: 0, y: 40, rotateY: -5 }}
      animate={{ opacity: 1, y: 0, rotateY: 0 }}
      transition={{ duration: 1, delay: 0.3, ease: [0.23, 1, 0.32, 1] }}
      className="animate-float"
      style={{ perspective: "1000px" }}
    >
      {/* iPhone Frame */}
      <div className="iphone-frame">
        <div className="iphone-screen flex flex-col">
          {/* Status bar spacer */}
          <div className="h-8 shrink-0" />

          {/* Header */}
          <div className="px-4 pt-2 pb-3 shrink-0">
            {/* Live badge */}
            <div className="flex items-center gap-1.5 mb-2">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
              </span>
              <span className="text-[9px] font-semibold text-green-400 tracking-widest uppercase">Live Demo</span>
              <Radio className="w-2.5 h-2.5 text-green-400 ml-0.5" />
            </div>

            {/* Balance */}
            <p className="text-[9px] text-white/40 mb-0.5">Portfolio Balance</p>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-white tracking-tight">
                ${currentBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
            </div>
            {/* P&L badge */}
            <div className="flex items-center gap-1.5 mt-1">
              <TrendingUp className="w-2.5 h-2.5" style={{ color: isPositive ? cyanColor : "oklch(0.6 0.2 25)" }} />
              <span
                className="text-[10px] font-semibold"
                style={{ color: isPositive ? cyanColor : "oklch(0.6 0.2 25)" }}
              >
                {isPositive ? "+" : ""}{pnlPct.toFixed(2)}%
              </span>
              <span className="text-[9px] text-white/30">
                ({isPositive ? "+" : ""}${Math.abs(pnl).toFixed(2)}) · Tier A
              </span>
              <span className="text-[9px] text-white/25 ml-auto">
                {daysActive}d live
              </span>
            </div>
          </div>

          {/* Equity curve chart */}
          <div className="px-1 shrink-0" style={{ height: 120 }}>
            {chartData.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="heroEquityGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={azureColor} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={azureColor} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" hide />
                  <YAxis domain={[chartMin, chartMax]} hide />
                  <Tooltip content={<HeroTooltip />} />
                  <ReferenceLine
                    y={startingCapital}
                    stroke={`${azureColor.replace(")", " / 0.2)")}`}
                    strokeDasharray="3 3"
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={azureColor}
                    strokeWidth={2}
                    fill="url(#heroEquityGrad)"
                    dot={false}
                    activeDot={{ r: 3, fill: cyanColor, strokeWidth: 0 }}
                    isAnimationActive
                    animationDuration={1000}
                    animationEasing="ease-out"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <div className="text-center">
                  <TrendingUp className="w-5 h-5 text-white/20 mx-auto mb-1" />
                  <p className="text-[9px] text-white/30">Syncing signals…</p>
                </div>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="mx-4 my-2 h-px bg-white/5 shrink-0" />

          {/* Recent trades */}
          <div className="px-4 flex-1 min-h-0 overflow-hidden">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[9px] font-semibold text-white/40 uppercase tracking-widest">Recent Trades</span>
              <span className="text-[9px] text-white/25">Tier A · 5% risk · 3×</span>
            </div>
            {recentTrades.length > 0 ? (
              recentTrades.map((t) => (
                <div key={t.id} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
                  <div>
                    <p className="text-[10px] font-semibold text-white/90">{t.pair}</p>
                    <p className="text-[8px] text-white/30">{t.date}</p>
                  </div>
                  <div className="text-right">
                    <p
                      className="text-[10px] font-bold"
                      style={{ color: t.pnl >= 0 ? cyanColor : "oklch(0.6 0.2 25)" }}
                    >
                      {t.pnl >= 0 ? "+" : ""}${Math.abs(t.pnl).toFixed(2)}
                    </p>
                    <p
                      className="text-[8px]"
                      style={{ color: t.pnl >= 0 ? "oklch(0.75 0.18 155)" : "oklch(0.6 0.2 25)" }}
                    >
                      {t.pnl >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <div className="py-3 text-center">
                <p className="text-[9px] text-white/25">Signals syncing…</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-4 pb-3 pt-1 shrink-0">
            <p className="text-[8px] text-white/20 text-center">
              Simulated · Real signals · Non-custodial
            </p>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
