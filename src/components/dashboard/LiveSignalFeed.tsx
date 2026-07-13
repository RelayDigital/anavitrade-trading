import { ChevronLeft, ChevronRight, RefreshCw, Trophy, Activity, Flame } from "lucide-react";

interface Signal {
  [key: string]: unknown;
  id?: number;
  signal?: number;
  marketName?: string;
  indicatorName?: string | null;
  period?: string;
  percentage24?: string | number | null;
  price?: string | number;
  minPrice?: string | number | null;
  maxPrice?: string | number | null;
  maxProfit?: string | number | null;
  maxProfitDuration?: string | null;
  signalDateUtc?: string | null;
  signalDate?: string | Date | number;
  qualityScore?: number;
  qualityTier?: string;
}

interface LiveSignalFeedProps {
  signals: Signal[];
  signalsLoading: boolean;
  signalsTotal: number;
  signalsMaxPage: number;
  signalPage: number;
  tierFilter: "all" | "A" | "B" | "C";
  signalPeriod: string;
  sortBy: "quality" | "date";
  winnerRankMap: Map<number, number>;
  SIGNALS_PER_PAGE: number;
  fmtPrice: (p: number) => string;
  fmtSignalDate: (utc: string | null | undefined, fallback: string | Date) => string;
  isWinner: (signal: number, pct: number | null) => boolean;
  onSetTierFilter: (t: "all" | "A" | "B" | "C") => void;
  onSetSignalPeriod: (p: string) => void;
  onSetSignalPage: (p: number) => void;
  onToggleSort: () => void;
  onRefresh: () => void;
}

const rankMedals = ["🥇", "🥈", "🥉"];

export default function LiveSignalFeed({
  signals, signalsLoading, signalsTotal, signalsMaxPage,
  signalPage, tierFilter, signalPeriod, sortBy,
  winnerRankMap, SIGNALS_PER_PAGE,
  fmtPrice, fmtSignalDate, isWinner,
  onSetTierFilter, onSetSignalPeriod, onSetSignalPage, onToggleSort, onRefresh,
}: LiveSignalFeedProps) {
  return (
    <div className="glass-card rounded-2xl overflow-hidden border-border/50">
      {/* Header */}
      <div className="p-6 border-b border-border/30">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Live Signal Feed</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {signalsTotal > 0 ? `${signalsTotal.toLocaleString()} signals · Aster-routable USDT · Updated every 5 min` : "Loading signals..."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleSort}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
                sortBy === "quality"
                  ? "bg-gold-10/20 border-gold-30 text-gold shadow-[0_0_12px_oklch(0.82_0.16_85/0.15)]"
                  : "bg-background border-border text-muted-foreground hover:text-foreground hover:border-primary/50"
              }`}>
              <Trophy className={`w-3 h-3 ${sortBy === "quality" ? "trophy-pulse" : ""}`} />
              {sortBy === "quality" ? "Best First" : "Latest First"}
            </button>
            <button
              onClick={onRefresh}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-background border border-border text-xs text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all"
            >
              <RefreshCw className="w-3 h-3" />
              Refresh
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-0.5 p-1 rounded-lg bg-background border border-border">
            {(["all", "A", "B", "C"] as const).map((t) => (
              <button
                key={t}
                onClick={() => { onSetTierFilter(t); onSetSignalPage(0); }}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                  tierFilter === t
                    ? t === "A" ? "bg-gold text-black font-bold shadow-sm"
                      : t === "B" ? "bg-primary/20 text-primary shadow-sm"
                      : "bg-muted text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "all" ? "All" : `Tier ${t}`}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 p-1 rounded-lg bg-background border border-border">
            {(["all", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const).map((p) => (
              <button
                key={p}
                onClick={() => { onSetSignalPeriod(p); onSetSignalPage(0); }}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                  signalPeriod === p ? "bg-muted text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/40 bg-background/30">
              <th className="text-left text-xs text-muted-foreground font-medium py-3 px-3 w-8"></th>
              <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Signal</th>
              <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Period</th>
              <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Name</th>
              <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Date (UTC)</th>
              <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Price</th>
              <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Min / Max Price</th>
              <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Max Profit</th>
              <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Duration</th>
              <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Score</th>
            </tr>
          </thead>
          <tbody>
            {signalsLoading && (
              <tr>
                <td colSpan={10} className="py-10 text-center">
                  <div className="flex items-center justify-center gap-2 text-muted-foreground">
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span className="text-xs">Loading signals...</span>
                  </div>
                </td>
              </tr>
            )}

            {!signalsLoading && signals.map((sig, signalIndex) => {
              const isBuy = sig.signal === 1;
              const isSell = sig.signal === -1;
              const pct = sig.percentage24 != null ? parseFloat(String(sig.percentage24)) : null;
              const price = parseFloat(String(sig.price ?? 0));
              const minP = sig.minPrice != null ? parseFloat(String(sig.minPrice)) : null;
              const maxP = sig.maxPrice != null ? parseFloat(String(sig.maxPrice)) : null;
              const maxProfit = sig.maxProfit != null ? parseFloat(String(sig.maxProfit)) : null;
              const dur = sig.maxProfitDuration as string | null;
              const utcStr = sig.signalDateUtc as string | null;
              const pair = (sig.marketName ?? "").replace("USDT", "/USDT");
              const qualityScore = sig.qualityScore ?? 0;
              const qualityTier = sig.qualityTier ?? "C";
              const isGold = qualityTier === "A";
              const winner = isGold || isWinner(isBuy ? 1 : isSell ? -1 : 0, pct);
              const rank = winnerRankMap.get(sig.id ?? 0) ?? 0;

              return (
                <tr
                  key={`signal-${sig.id}-${signalIndex}`}
                  className={`border-b border-border/25 last:border-0 transition-colors ${winner ? "winner-row" : "hover:bg-background/40"}`}
                >
                  <td className="py-3 px-3 w-8">
                    {rank > 0 ? (
                      <span className={`text-sm ${rank === 1 ? "trophy-pulse inline-block" : ""}`}>
                        {rankMedals[rank - 1]}
                      </span>
                    ) : winner ? (
                      <Flame className="w-3.5 h-3.5" style={{ color: "oklch(0.82 0.16 85 / 0.6)" }} />
                    ) : null}
                  </td>
                  <td className="py-3 pr-4">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold ${
                      isBuy ? "bg-primary/15 text-primary" : isSell ? "bg-red-500/15 text-red-400" : "bg-muted text-muted-foreground"
                    }`}>
                      {isBuy ? "▲ BUY" : isSell ? "▼ SELL" : "■ NEUTRAL"}
                    </span>
                  </td>
                  <td className="py-3 pr-4">
                    <span className="px-2 py-0.5 rounded bg-background border border-border text-xs font-mono text-foreground">{sig.period}</span>
                  </td>
                  <td className="py-3 pr-4">
                    <div className={`font-mono text-xs font-bold ${winner ? "text-gold" : "text-foreground"}`}>{pair}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{sig.indicatorName}</div>
                  </td>
                  <td className="py-3 pr-4 text-xs text-muted-foreground whitespace-nowrap font-mono">
                    {fmtSignalDate(utcStr, sig.signalDate != null ? new Date(Number(sig.signalDate)) : new Date())}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-foreground whitespace-nowrap">
                    ${fmtPrice(price)}
                    {pct !== null && (
                      <span className={`ml-1.5 text-xs font-medium ${winner ? "text-gold" : pct >= 0 ? "text-primary" : "text-red-400"}`}>
                        {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-xs font-mono whitespace-nowrap">
                    {minP != null || maxP != null ? (
                      <span className="text-muted-foreground">
                        <span className="text-red-400/80">${minP != null ? fmtPrice(minP) : "—"}</span>
                        <span className="mx-1 text-border">/</span>
                        <span className="text-primary/80">${maxP != null ? fmtPrice(maxP) : "—"}</span>
                      </span>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="py-3 pr-4 text-xs font-mono font-semibold whitespace-nowrap">
                    {maxProfit != null ? (
                      <span style={winner ? { color: "oklch(0.82 0.16 85)" } : { color: "oklch(0.78 0.19 155)" }}>
                        +{maxProfit.toFixed(2)}%
                      </span>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="py-3 pr-4 text-xs text-muted-foreground whitespace-nowrap">
                    {dur ?? <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="py-3 pr-4 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="inline-flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold"
                        style={isGold ? {
                          background: "oklch(0.82 0.16 85)",
                          color: "oklch(0.15 0.014 260)",
                          boxShadow: "0 0 8px oklch(0.82 0.16 85 / 0.4)",
                        } : qualityTier === "B" ? {
                          background: "oklch(0.78 0.19 155 / 0.15)",
                          color: "oklch(0.78 0.19 155)",
                        } : {
                          background: "oklch(0.24 0.015 260 / 0.4)",
                          color: "oklch(0.60 0.015 260)",
                        }}
                      >
                        {qualityTier}
                      </span>
                      <span className="text-xs font-mono" style={isGold ? { color: "oklch(0.82 0.16 85)" } : { color: "oklch(0.50 0.015 260)" }}>
                        {qualityScore}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}

            {!signalsLoading && signals.length === 0 && (
              <tr>
                <td colSpan={10} className="py-14 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-border/30 flex items-center justify-center">
                      <Activity className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium text-foreground">No signals match your filters</p>
                    <p className="text-xs text-muted-foreground">
                      {tierFilter !== "all" ? `No Tier ${tierFilter} signals in this timeframe. Try a different tier or period.` : "Try changing the tier or timeframe filter."}
                    </p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {signalsTotal > SIGNALS_PER_PAGE && (
        <div className="flex items-center justify-between px-6 py-4 border-t border-border/40">
          <p className="text-xs text-muted-foreground">
            Showing {signalPage * SIGNALS_PER_PAGE + 1}–{Math.min((signalPage + 1) * SIGNALS_PER_PAGE, signalsTotal)} of {signalsTotal.toLocaleString()}
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onSetSignalPage(Math.max(0, signalPage - 1))}
              disabled={signalPage === 0}
              className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-3 py-1 text-xs text-foreground">{signalPage + 1} / {signalsMaxPage + 1}</span>
            <button
              onClick={() => onSetSignalPage(Math.min(signalsMaxPage, signalPage + 1))}
              disabled={signalPage >= signalsMaxPage}
              className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
