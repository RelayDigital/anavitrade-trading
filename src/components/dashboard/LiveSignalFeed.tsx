import { ChevronLeft, ChevronRight, RefreshCw, Activity, ArrowUp, ArrowDown, Minus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatSignedPercent,
  parseOptionalNumber,
  UNAVAILABLE,
} from "@/components/performancePresentation";

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
  SIGNALS_PER_PAGE: number;
  fmtPrice: (p: number) => string;
  fmtSignalDate: (utc: string | null | undefined, fallback: string | Date) => string;
  onSetTierFilter: (t: "all" | "A" | "B" | "C") => void;
  onSetSignalPeriod: (p: string) => void;
  onSetSignalPage: (p: number) => void;
  onToggleSort: () => void;
  onRefresh: () => void;
}

type PreparedSignal = {
  sig: Signal;
  key: string;
  isBuy: boolean;
  isSell: boolean;
  pct: number | null;
  price: number | null;
  minP: number | null;
  maxP: number | null;
  maxProfit: number | null;
  dur: string | null;
  utcStr: string | null;
  fallbackDate: string | Date | null;
  pair: string;
  indicatorName: string | null;
  qualityScore: number | null;
  qualityTier: string | null;
};

function toDateFallback(value: Signal["signalDate"]): string | Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value);
  return null;
}

function DirectionBadge({ isBuy, isSell }: { isBuy: boolean; isSell: boolean }) {
  const Icon = isBuy ? ArrowUp : isSell ? ArrowDown : Minus;
  const label = isBuy ? "BUY" : isSell ? "SELL" : "NEUTRAL";
  return (
    <span
      className={`inline-flex min-h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-bold ${
        isBuy ? "bg-primary/15 text-primary" : isSell ? "bg-red-500/15 text-red-400" : "bg-muted text-muted-foreground"
      }`}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

function ScoreBadge({ tier, score }: { tier: string | null; score: number | null }) {
  if (tier === null && score === null) {
    return <span className="text-xs text-muted-foreground">{UNAVAILABLE}</span>;
  }
  const isGold = tier === "A";
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold"
        style={isGold ? {
          background: "oklch(0.82 0.16 85)",
          color: "oklch(0.15 0.014 260)",
          boxShadow: "0 0 8px oklch(0.82 0.16 85 / 0.4)",
        } : tier === "B" ? {
          background: "oklch(0.78 0.19 155 / 0.15)",
          color: "oklch(0.78 0.19 155)",
        } : {
          background: "oklch(0.24 0.015 260 / 0.4)",
          color: "oklch(0.60 0.015 260)",
        }}
      >
        {tier ?? "?"}
      </span>
      <span className={`text-xs font-mono tabular ${isGold ? "text-gold" : "text-muted-foreground"}`}>{score ?? UNAVAILABLE}</span>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <>
      <div className="space-y-3 p-3 md:hidden" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-36 rounded-xl" />
        ))}
      </div>
      <div className="hidden p-4 md:block" aria-hidden="true">
        <div className="space-y-3">
          {Array.from({ length: 7 }).map((_, index) => (
            <Skeleton key={index} className="h-12 rounded-lg" />
          ))}
        </div>
      </div>
    </>
  );
}

function SignalMobileCard({ row, fmtPrice, fmtSignalDate }: { row: PreparedSignal; fmtPrice: LiveSignalFeedProps["fmtPrice"]; fmtSignalDate: LiveSignalFeedProps["fmtSignalDate"] }) {
  const signalDate = row.fallbackDate === null && !row.utcStr
    ? UNAVAILABLE
    : fmtSignalDate(row.utcStr, row.fallbackDate ?? "");
  return (
    <article className="rounded-xl border border-border/40 bg-background/35 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0">
            <div className="font-mono text-sm font-bold text-foreground tabular">{row.pair}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{row.sig.indicatorName ?? "Signal"}</div>
          </div>
        </div>
        <DirectionBadge isBuy={row.isBuy} isSell={row.isSell} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-muted-foreground">Price</dt>
          <dd className="mt-1 font-mono text-foreground tabular">
            {row.price === null ? UNAVAILABLE : `$${fmtPrice(row.price)}`}
            <span className={`ml-1.5 font-medium ${row.pct !== null && row.pct < 0 ? "text-red-400" : "text-primary"}`}>
              {formatSignedPercent(row.pct, 2)}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Score</dt>
          <dd className="mt-1"><ScoreBadge tier={row.qualityTier} score={row.qualityScore} /></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Period</dt>
          <dd className="mt-1"><span className="rounded-md border border-border bg-background px-2 py-1 font-mono text-foreground">{row.sig.period}</span></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Reported favorable move</dt>
          <dd className="mt-1 font-mono font-semibold text-profit-green tabular">
            {formatSignedPercent(row.maxProfit, 2)}
          </dd>
        </div>
      </dl>

      <div className="mt-3 flex items-center justify-between border-t border-border/30 pt-3 text-xs text-muted-foreground">
        <span className="font-mono">{signalDate}</span>
        <span>{row.dur ?? UNAVAILABLE}</span>
      </div>
    </article>
  );
}

export default function LiveSignalFeed({
  signals, signalsLoading, signalsTotal, signalsMaxPage,
  signalPage, tierFilter, signalPeriod, sortBy,
  SIGNALS_PER_PAGE,
  fmtPrice, fmtSignalDate,
  onSetTierFilter, onSetSignalPeriod, onSetSignalPage, onToggleSort, onRefresh,
}: LiveSignalFeedProps) {
  const preparedSignals: PreparedSignal[] = signals.map((sig, signalIndex) => {
    const isBuy = sig.signal === 1;
    const isSell = sig.signal === -1;
    const pct = parseOptionalNumber(sig.percentage24);
    const price = parseOptionalNumber(sig.price);
    const minP = parseOptionalNumber(sig.minPrice);
    const maxP = parseOptionalNumber(sig.maxPrice);
    const maxProfit = parseOptionalNumber(sig.maxProfit);
    const dur = sig.maxProfitDuration as string | null;
    const utcStr = sig.signalDateUtc as string | null;
    const pair = (sig.marketName ?? "").replace("USDT", "/USDT");
    const qualityScore = parseOptionalNumber(sig.qualityScore);
    const qualityTier = sig.qualityTier ?? null;

    return {
      sig,
      key: `signal-${sig.id ?? "new"}-${signalIndex}`,
      isBuy,
      isSell,
      pct,
      price,
      minP,
      maxP,
      maxProfit,
      dur,
      utcStr,
      fallbackDate: toDateFallback(sig.signalDate),
      indicatorName: sig.indicatorName ?? null,
      pair,
      qualityScore,
      qualityTier,
    };
  });

  return (
    <section className="glass-card rounded-2xl overflow-hidden border-border/50" aria-labelledby="live-signal-feed-title" aria-busy={signalsLoading}>
      <div className="p-4 sm:p-6 border-b border-border/30">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 id="live-signal-feed-title" className="text-sm font-semibold text-foreground">Live Signal Feed</h3>
            <p className="text-xs text-muted-foreground mt-0.5" aria-live="polite">
              {signalsLoading
                ? "Loading latest Aster-routable signals"
                : signalsTotal > 0
                  ? `${signalsTotal.toLocaleString()} signals · Aster-routable USDT · Updated every 5 min`
                  : "No matching signals"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleSort}
              aria-pressed={sortBy === "quality"}
              className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
                sortBy === "quality"
                  ? "bg-gold-10/20 border-gold-30 text-gold shadow-[0_0_12px_oklch(0.82_0.16_85/0.15)]"
                  : "bg-background border-border text-muted-foreground hover:text-foreground hover:border-primary/50"
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              {sortBy === "quality" ? "Score First" : "Latest First"}
            </button>
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs text-muted-foreground transition-all hover:border-primary/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${signalsLoading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <div className="inline-flex min-w-max items-center gap-0.5 rounded-lg border border-border bg-background p-1">
              {(["all", "A", "B", "C"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => { onSetTierFilter(t); onSetSignalPage(0); }}
                  aria-pressed={tierFilter === t}
                  className={`min-h-11 rounded-md px-3 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
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
          </div>
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <div className="inline-flex min-w-max items-center gap-0.5 rounded-lg border border-border bg-background p-1">
              {(["all", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const).map((period) => (
                <button
                  key={period}
                  type="button"
                  onClick={() => { onSetSignalPeriod(period); onSetSignalPage(0); }}
                  aria-pressed={signalPeriod === period}
                  className={`min-h-11 rounded-md px-3 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
                    signalPeriod === period ? "bg-muted text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {period}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {signalsLoading ? (
        <FeedSkeleton />
      ) : preparedSignals.length > 0 ? (
        <>
          <div className="space-y-3 p-3 md:hidden">
            {preparedSignals.map((row) => (
              <SignalMobileCard key={row.key} row={row} fmtPrice={fmtPrice} fmtSignalDate={fmtSignalDate} />
            ))}
          </div>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/40 bg-background/30">
                  <th className="whitespace-nowrap py-3 pr-4 text-left text-xs font-medium text-muted-foreground" scope="col">Signal</th>
                  <th className="whitespace-nowrap py-3 pr-4 text-left text-xs font-medium text-muted-foreground" scope="col">Period</th>
                  <th className="whitespace-nowrap py-3 pr-4 text-left text-xs font-medium text-muted-foreground" scope="col">Name</th>
                  <th className="whitespace-nowrap py-3 pr-4 text-left text-xs font-medium text-muted-foreground" scope="col">Date</th>
                  <th className="whitespace-nowrap py-3 pr-4 text-left text-xs font-medium text-muted-foreground" scope="col">Price</th>
                  <th className="whitespace-nowrap py-3 pr-4 text-left text-xs font-medium text-muted-foreground" scope="col">Min / Max Price</th>
                  <th className="whitespace-nowrap py-3 pr-4 text-left text-xs font-medium text-muted-foreground" scope="col">Reported favorable move</th>
                  <th className="whitespace-nowrap py-3 pr-4 text-left text-xs font-medium text-muted-foreground" scope="col">Duration</th>
                  <th className="whitespace-nowrap py-3 pr-4 text-left text-xs font-medium text-muted-foreground" scope="col">Score</th>
                </tr>
              </thead>
              <tbody>
                {preparedSignals.map((row) => (
                  <tr
                    key={row.key}
                    className="border-b border-border/25 transition-colors last:border-0 hover:bg-background/40"
                  >
                    <td className="py-3 pr-4"><DirectionBadge isBuy={row.isBuy} isSell={row.isSell} /></td>
                    <td className="py-3 pr-4">
                      <span className="rounded border border-border bg-background px-2 py-1 text-xs font-mono text-foreground">{row.sig.period}</span>
                    </td>
                    <td className="py-3 pr-4">
                      <div className="font-mono text-xs font-bold text-foreground tabular">{row.pair}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{row.sig.indicatorName}</div>
                    </td>
                    <td className="whitespace-nowrap py-3 pr-4 text-xs font-mono text-muted-foreground tabular">
                      {row.fallbackDate === null && !row.utcStr ? UNAVAILABLE : fmtSignalDate(row.utcStr, row.fallbackDate ?? "")}
                    </td>
                    <td className="whitespace-nowrap py-3 pr-4 text-xs font-mono text-foreground tabular">
                      {row.price === null ? UNAVAILABLE : `$${fmtPrice(row.price)}`}
                      <span className={`ml-1.5 text-xs font-medium ${row.pct !== null && row.pct < 0 ? "text-red-400" : "text-primary"}`}>
                        {formatSignedPercent(row.pct, 2)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-3 pr-4 text-xs font-mono tabular">
                      {row.minP != null || row.maxP != null ? (
                        <span className="text-muted-foreground">
                          <span className="text-red-400/80">{row.minP != null ? `$${fmtPrice(row.minP)}` : UNAVAILABLE}</span>
                          <span className="mx-1 text-border">/</span>
                          <span className="text-primary/80">{row.maxP != null ? `$${fmtPrice(row.maxP)}` : UNAVAILABLE}</span>
                        </span>
                      ) : <span className="text-muted-foreground/40">{UNAVAILABLE}</span>}
                    </td>
                    <td className="whitespace-nowrap py-3 pr-4 text-xs font-mono font-semibold tabular">
                      <span className="text-profit-green">{formatSignedPercent(row.maxProfit, 2)}</span>
                    </td>
                    <td className="whitespace-nowrap py-3 pr-4 text-xs text-muted-foreground">
                      {row.dur ?? <span className="text-muted-foreground/40">{UNAVAILABLE}</span>}
                    </td>
                    <td className="whitespace-nowrap py-3 pr-4"><ScoreBadge tier={row.qualityTier} score={row.qualityScore} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="px-4 py-14 text-center" aria-live="polite">
          <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-border/30">
              <Activity className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">No signals match your filters</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {tierFilter !== "all" ? `No Tier ${tierFilter} signals in this timeframe. Try a different tier or period.` : "Try changing the tier or timeframe filter."}
            </p>
          </div>
        </div>
      )}

      {signalsTotal > SIGNALS_PER_PAGE && (
        <div className="flex flex-col gap-3 border-t border-border/40 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Showing {signalPage * SIGNALS_PER_PAGE + 1}-{Math.min((signalPage + 1) * SIGNALS_PER_PAGE, signalsTotal)} of {signalsTotal.toLocaleString()}
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSetSignalPage(Math.max(0, signalPage - 1))}
              disabled={signalPage === 0}
              aria-label="Previous signal page"
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-border text-muted-foreground transition-all hover:border-primary/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-20 px-3 py-1 text-center text-xs text-foreground">{signalPage + 1} / {signalsMaxPage + 1}</span>
            <button
              type="button"
              onClick={() => onSetSignalPage(Math.min(signalsMaxPage, signalPage + 1))}
              disabled={signalPage >= signalsMaxPage}
              aria-label="Next signal page"
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-border text-muted-foreground transition-all hover:border-primary/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
