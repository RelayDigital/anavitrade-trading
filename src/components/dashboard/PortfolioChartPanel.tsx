import { motion } from "framer-motion";
import { RefreshCw, BarChart3, Activity, TrendingUp, TrendingDown, Wallet } from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, ReferenceLine,
  BarChart, Bar, Cell,
} from "recharts";

interface ExchangeBalance {
  exchange: string;
  equityUsd: number;
  availableUsd: number;
}

interface PortfolioChartPanelProps {
  isDemoMode: boolean;
  anyConnected: boolean;
  demoPortfolioSeries: { label?: string; value: number }[] | undefined;
  portfolioData: { label?: string; day?: string; value: number }[];
  demoStartingCapital: number;
  totalPnl: number;
  pnlPct: string;
  syncPending: boolean;
  onSync: () => void;
  /** Live mode: exchange balances from unified CEX balance */
  liveBalances?: ExchangeBalance[];
  /** Live mode: total equity across all connected exchanges */
  liveTotalEquity?: number;
}

const EXCHANGE_COLORS: Record<string, string> = {
  binance: "#F0B90B",
  bybit: "#F7A600",
  okx: "#000000",
  coinbase: "#0052FF",
  kraken: "#5741D9",
  kucoin: "#009E73",
  gateio: "#D32F2F",
  bitunix: "#00A86B",
};

function exchangeColor(name: string): string {
  const key = name.toLowerCase().replace(/[^a-z]/g, "");
  return EXCHANGE_COLORS[key] ?? "oklch(0.60 0.22 220)";
}

export default function PortfolioChartPanel({
  isDemoMode, anyConnected, demoPortfolioSeries, portfolioData,
  demoStartingCapital, totalPnl, pnlPct, syncPending, onSync,
  liveBalances, liveTotalEquity,
}: PortfolioChartPanelProps) {
  const hasLiveBalances = !isDemoMode && liveBalances && liveBalances.length > 0;
  const hasDemoData = isDemoMode && demoPortfolioSeries && demoPortfolioSeries.length > 0;

  return (
    <div className="lg:col-span-2 glass-card rounded-2xl p-6 relative overflow-hidden">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{isDemoMode ? "Demo Portfolio Growth" : "Portfolio"}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isDemoMode ? "Simulated equity curve from signal history" : (anyConnected ? `${liveBalances?.length ?? 0} exchange${(liveBalances?.length ?? 0) !== 1 ? "s" : ""} connected` : "Connect a wallet to see your real equity curve")}
          </p>
        </div>
        {isDemoMode && (
          <button
            onClick={onSync}
            disabled={syncPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all disabled:opacity-50"
            style={{ borderColor: "oklch(0.60 0.22 220 / 0.25)" }}
          >
            <RefreshCw className={`w-3 h-3 ${syncPending ? "animate-spin" : ""}`} />
            {syncPending ? "Syncing..." : "Sync Signals"}
          </button>
        )}
        {!isDemoMode && anyConnected && (
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 text-sm font-semibold ${totalPnl >= 0 ? "text-primary" : totalPnl > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
              {liveTotalEquity != null && liveTotalEquity > 0 ? (
                <span className="text-foreground">${liveTotalEquity.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
              ) : (
                <Activity className="w-4 h-4" />
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Live Mode: Exchange Balance Breakdown ── */}
      {hasLiveBalances ? (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={liveBalances} layout="vertical" margin={{ left: 48, right: 16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(1 0 0 / 0.06)" opacity={0.4} horizontal={false} />
            <XAxis type="number" tick={{ fill: "oklch(0.50 0.015 260)", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
            <YAxis type="category" dataKey="exchange" tick={{ fill: "oklch(0.50 0.015 260)", fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
            <Tooltip
              contentStyle={{ background: "oklch(0.10 0.018 250 / 0.96)", border: "1px solid oklch(0.60 0.22 220 / 0.25)", borderRadius: "12px", fontSize: "12px" }}
              labelStyle={{ color: "oklch(0.62 0.020 240)" }}
              formatter={(v: number, _name: string, props: any) => {
                const entry = props?.payload as ExchangeBalance | undefined;
                const avail = entry?.availableUsd ?? 0;
                return [`$${v.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, `Available: $${avail.toLocaleString("en-US", { minimumFractionDigits: 2 })}`];
              }}
            />
            <Bar dataKey="equityUsd" radius={[0, 6, 6, 0]} barSize={28}>
              {liveBalances.map((entry) => (
                <Cell key={entry.exchange} fill={exchangeColor(entry.exchange)} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : !isDemoMode && anyConnected ? (
        <div className="flex flex-col items-center justify-center h-[200px] gap-3 text-center">
          <Wallet className="w-8 h-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">Exchange balances loading…</p>
        </div>
      ) : null}

      {/* ── Demo Mode Chart ── */}
      {hasDemoData ? (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={demoPortfolioSeries}>
            <defs>
              <linearGradient id="demoGradChart" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="oklch(0.82 0.16 85)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="oklch(0.82 0.16 85)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(1 0 0 / 0.06)" opacity={0.4} />
            <XAxis dataKey="label" tick={{ fill: "oklch(0.50 0.015 260)", fontSize: 10 }} tickLine={false} axisLine={false} interval={6} />
            <YAxis domain={["dataMin", "dataMax"]} tick={{ fill: "oklch(0.50 0.015 260)", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
            <Tooltip
              contentStyle={{ background: "oklch(0.10 0.018 250 / 0.96)", border: "1px solid oklch(0.60 0.22 220 / 0.25)", borderRadius: "12px", fontSize: "12px" }}
              labelStyle={{ color: "oklch(0.62 0.020 240)" }}
              formatter={(v: number) => [`$${v.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, "Balance"]}
            />
            <ReferenceLine y={demoStartingCapital} stroke="oklch(1 0 0 / 0.15)" strokeDasharray="3 3" />
            <Area type="monotone" dataKey="value" stroke="oklch(0.82 0.16 85)" strokeWidth={2.5} fill="url(#demoGradChart)" dot={false} isAnimationActive animationDuration={1200} animationEasing="ease-out" />
          </AreaChart>
        </ResponsiveContainer>
      ) : null}

      {/* ── Empty states ── */}
      {isDemoMode && syncPending ? (
        <div className="flex items-center justify-center h-[200px] gap-2 text-muted-foreground">
          <RefreshCw className="w-5 h-5 animate-spin" />
          <span className="text-sm">Syncing demo signals...</span>
        </div>
      ) : isDemoMode && !hasDemoData ? (
        <div className="flex flex-col items-center justify-center h-[200px] gap-3 text-center">
          <BarChart3 className="w-8 h-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No demo trades yet. Click "Sync Signals" above to get started.</p>
        </div>
      ) : !isDemoMode && !anyConnected ? (
        <div className="flex flex-col items-center justify-center h-[200px] gap-3 text-center">
          <Activity className="w-8 h-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">Connect a wallet above to see your real equity curve</p>
        </div>
      ) : null}
    </div>
  );
}
