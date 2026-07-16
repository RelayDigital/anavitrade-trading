import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { AreaChart, Area, ResponsiveContainer, YAxis, Tooltip, ReferenceLine } from "recharts";
import { Activity } from "lucide-react";
import { trpc } from "@/lib/trpc";
import TradeChartSnapshot from "@/components/TradeChartSnapshot";
import { useSectionInView } from "../hooks/useSectionInView";
import SectionHeader from "../primitives/SectionHeader";
import Reveal from "../primitives/Reveal";
import AnimatedNumber from "../primitives/AnimatedNumber";
import Explainer from "../primitives/Explainer";

const MONTHS = [
  { key: "july", label: "July 2026", live: true },
  { key: "june", label: "June 2026", live: false },
  { key: "may", label: "May 2026", live: false },
  { key: "april", label: "April 2026", live: false },
] as const;

const START_BALANCE = 10000;

const TABS = [
  { key: "tierA", label: "Top picks", hint: "Tier A — our highest-confidence signals." },
  { key: "tierB", label: "Good picks", hint: "Tier B — solid signals that passed our checks." },
  { key: "filtered", label: "Signals we skipped", hint: "Tier C — low-quality signals our filter chose NOT to take. Shown for full honesty." },
] as const;

function EquityTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="px-3 py-2 rounded-lg text-xs tabular" style={{ background: "oklch(0.10 0.02 255 / 0.96)", border: "1px solid oklch(0.65 0.2 255 / 0.25)", backdropFilter: "blur(8px)", color: "white" }}>
      <p className="font-bold" style={{ color: "oklch(0.72 0.20 195)" }}>
        ${Number(payload[0].value).toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </p>
    </div>
  );
}

/* ─── PERFORMANCE (was JulyResults) ───
   The most defensible asset on the page, told for a beginner: "we followed our
   top picks with $10,000 — here's what happened." Leads with a rising equity
   curve and a big count-up number, then friendly trade cards. Keeps the honest
   "signals we skipped" story as a trust element, not a footnote. */
export default function Performance() {
  const { ref, isInView } = useSectionInView();
  const { data, isLoading } = trpc.signals.julyResults.useQuery();
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]["key"]>("tierA");
  const [activeMonth, setActiveMonth] = useState<(typeof MONTHS)[number]["key"]>("july");

  // Rising equity curve derived from the taken trades, scaled to end exactly
  // at the API's reported P&L so the shape and the headline number agree.
  const curve = useMemo(() => {
    if (!data) return [] as { label: string; value: number }[];
    const taken = [...(data.wins ?? []), ...(data.nearFlat ?? [])]
      .filter((s) => s.signalDate)
      .sort((a, b) => new Date(a.signalDate!).getTime() - new Date(b.signalDate!).getTime());
    const rawTotal = taken.reduce((sum, s) => sum + Math.max(Number(s.maxProfit ?? 0), 0), 0) || 1;
    const targetPnl = data.summary.totalPnl;
    let run = 0;
    const pts = [{ label: "Start", value: START_BALANCE }];
    taken.forEach((s, i) => {
      run += Math.max(Number(s.maxProfit ?? 0), 0);
      pts.push({ label: `Trade ${i + 1}`, value: START_BALANCE + (run / rawTotal) * targetPnl });
    });
    return pts;
  }, [data]);

  const endBalance = curve.length ? curve[curve.length - 1].value : START_BALANCE;

  return (
    <section className="py-32 relative" ref={ref}>
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="orb-azure" style={{ width: 600, height: 600, top: "10%", right: "-15%", opacity: 0.3 }} />
      </div>

      <div className="container relative z-10">
        <SectionHeader
          align="center"
          eyebrow="Simulated Performance"
          title="We followed our top picks with $10,000"
          subtitle="Every signal our engine scored last month — the wins, the flat ones, and the low-quality signals we correctly skipped. All shown, nothing hidden."
          className="mb-12"
        />

        {/* Month selector */}
        <Reveal delay={0.1} className="flex flex-wrap gap-2 justify-center mb-12">
          {MONTHS.map((m) => (
            <button
              key={m.key}
              onClick={() => m.live && setActiveMonth(m.key)}
              disabled={!m.live}
              aria-disabled={!m.live}
              aria-pressed={activeMonth === m.key}
              className={`relative px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-semibold border transition-all duration-200 ${
                m.live
                  ? activeMonth === m.key
                    ? "bg-primary/20 text-primary border-primary/50 shadow-[0_0_12px_oklch(0.65_0.2_255/0.18)]"
                    : "bg-card/50 text-foreground border-border/50 hover:border-primary/40 cursor-pointer"
                  : "bg-card/20 text-muted-foreground/40 border-border/20 cursor-not-allowed"
              }`}
            >
              {m.label}
              {m.live && (
                <span className="absolute -top-1.5 -right-1.5 flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
                </span>
              )}
              {!m.live && <span className="ml-2 text-[10px] font-normal opacity-50">soon</span>}
            </button>
          ))}
        </Reveal>

        {activeMonth !== "july" && (
          <motion.div
            key={activeMonth}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="flex flex-col items-center justify-center py-24 gap-6 border border-dashed border-border/40 rounded-2xl"
          >
            <div className="w-14 h-14 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Activity className="w-7 h-7 text-primary" />
            </div>
            <div className="text-center max-w-sm">
              <p className="text-lg font-heading font-semibold text-foreground mb-2">
                {MONTHS.find((m) => m.key === activeMonth)?.label} — Track Record Building
              </p>
              <p className="text-sm text-muted-foreground">
                Our engine launched in July 2026. Older months will appear here as we build the verified track record. Check back soon.
              </p>
            </div>
            <button onClick={() => setActiveMonth("july")} className="px-5 py-2 rounded-xl text-sm font-semibold bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 transition-colors">
              View July 2026 Results →
            </button>
          </motion.div>
        )}

        {/* Loading state for July while julyResults is in flight (reachable
            because it sits OUTSIDE the `data &&` guard below). */}
        {activeMonth === "july" && !data && isLoading && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="h-44 rounded-2xl bg-card/40 animate-pulse" />
              <div className="h-44 rounded-2xl bg-card/40 animate-pulse" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-24 rounded-2xl bg-card/40 animate-pulse" />
              ))}
            </div>
          </div>
        )}

        {activeMonth === "july" && data && (
          <>
            {/* Hero: big number + equity curve */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8 items-stretch">
              <Reveal className="data-surface p-8 flex flex-col justify-center">
                <p className="text-sm text-muted-foreground mb-2">Starting with ${START_BALANCE.toLocaleString()}, following only the top picks…</p>
                <div className="flex items-end gap-4 flex-wrap">
                  <span className="text-5xl sm:text-6xl font-heading font-bold tabular" style={{ color: "oklch(0.74 0.18 145)" }}>
                    <AnimatedNumber value={endBalance} prefix="$" decimals={0} separator duration={1800} />
                  </span>
                  <span className="text-xl font-heading font-bold tabular mb-1.5" style={{ color: "oklch(0.74 0.18 145)" }}>
                    <AnimatedNumber value={data.summary.netReturn} prefix="+" suffix="%" decimals={1} delay={200} />
                  </span>
                </div>
                <p className="text-xs text-muted-foreground/60 mt-3 flex items-center gap-1.5">
                  Simulated with 5% risk per trade
                  <Explainer text="Each trade risks a small, fixed slice of the balance (5%), with 3× leverage — a disciplined, repeatable approach. Simulated on real signals; past results don't guarantee future ones." label="5% risk" />
                </p>
              </Reveal>

              <Reveal delay={0.1} className="data-surface p-4">
                <div style={{ height: 220 }}>
                  {curve.length > 1 && (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={curve} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="perfGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="oklch(0.74 0.18 145)" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="oklch(0.74 0.18 145)" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <YAxis domain={["dataMin", "dataMax"]} hide />
                        <Tooltip content={<EquityTooltip />} />
                        <ReferenceLine y={START_BALANCE} stroke="oklch(1 0 0 / 0.15)" strokeDasharray="3 3" />
                        <Area type="monotone" dataKey="value" stroke="oklch(0.74 0.18 145)" strokeWidth={2.5} fill="url(#perfGrad)" dot={false} isAnimationActive={isInView} animationDuration={1800} animationEasing="ease-out" />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </Reveal>
            </div>

            {/* Friendly summary chips */}
            <Reveal delay={0.15} className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
              {[
                { label: "Trades taken", value: <AnimatedNumber value={data.summary.totalTaken} />, hint: "Only Top and Good picks — never the skipped ones.", color: "text-foreground" },
                { label: "Money made", value: <AnimatedNumber value={data.summary.totalPnl} prefix="+$" decimals={0} separator />, hint: undefined, color: "text-green-400" },
                { label: "Best single pick", value: <AnimatedNumber value={data.summary.bestProfit} prefix="+" suffix="%" decimals={1} />, sub: data.summary.bestPair, color: "text-primary" },
                { label: "Low-quality signals skipped", value: <AnimatedNumber value={data.summary.filteredOutCount} />, hint: "Our filter said no to these — protecting the results.", color: "text-amber-400" },
              ].map((item, i) => (
                <div key={i} className="data-surface p-5 text-center">
                  <p className={`text-2xl font-heading font-bold tabular ${item.color}`}>{item.value}</p>
                  <p className="text-xs font-semibold text-foreground/80 mt-1 flex items-center justify-center gap-1">
                    {item.label}
                    {item.hint && <Explainer text={item.hint} label={item.label} />}
                  </p>
                  {item.sub && <p className="text-[10px] text-muted-foreground mt-0.5">{item.sub}</p>}
                </div>
              ))}
            </Reveal>

            {/* Tabs */}
            <div className="flex flex-wrap gap-2 mb-6 justify-center">
              {TABS.map((tab) => {
                const active = activeTab === tab.key;
                const colors: Record<string, string> = {
                  tierA: active ? "bg-amber-500/20 text-amber-400 border-amber-500/40" : "",
                  tierB: active ? "bg-primary/20 text-primary border-primary/40" : "",
                  filtered: active ? "bg-red-500/20 text-red-400 border-red-500/40" : "",
                };
                return (
                  <span key={tab.key} className="inline-flex items-center gap-1.5">
                    <button
                      onClick={() => setActiveTab(tab.key)}
                      aria-pressed={active}
                      className={`px-4 min-h-[40px] rounded-xl text-xs font-semibold border transition-all duration-200 ${
                        active ? colors[tab.key] : "bg-card/50 text-muted-foreground border-border/40 hover:border-border"
                      }`}
                    >
                      {tab.label}
                    </button>
                    <Explainer text={tab.hint} label={tab.label} />
                  </span>
                );
              })}
            </div>

            {/* Trade cards */}
            {isLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="h-24 rounded-xl bg-card/40 animate-pulse" />
                ))}
              </div>
            ) : (
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35 }}
                className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"
              >
                {(activeTab === "tierA"
                  ? (data.wins ?? []).filter((s) => s.qualityTier === "A")
                  : activeTab === "tierB"
                  ? [...(data.wins ?? []).filter((s) => s.qualityTier !== "A"), ...(data.nearFlat ?? [])]
                  : data.filteredOut ?? []
                ).map((signal, i) => {
                  const mp = signal.maxProfit !== null ? parseFloat(String(signal.maxProfit)) : 0;
                  const isWin = mp >= 2;
                  const isFiltered = activeTab === "filtered";
                  const signalDt = signal.signalDate ? new Date(signal.signalDate) : null;
                  const date = signalDt ? signalDt.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

                  return (
                    <motion.div
                      key={(signal as any).rowKey ?? `${signal.id}-${i}`}
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, delay: Math.min(i * 0.03, 0.5) }}
                      className={`rounded-xl p-4 border transition-all duration-200 hover:-translate-y-0.5 ${
                        isFiltered ? "bg-red-500/5 border-red-500/20" : isWin ? "bg-green-500/5 border-green-500/20" : "bg-amber-500/5 border-amber-500/20"
                      }`}
                    >
                      <div className="mb-2 -mx-1 rounded-lg overflow-hidden">
                        <TradeChartSnapshot
                          pair={signal.marketName}
                          entryPrice={0}
                          exitPrice={null}
                          period={signal.period}
                          openedAt={signalDt}
                          closedAt={signalDt ? new Date(signalDt.getTime() + 24 * 60 * 60 * 1000) : null}
                          height={100}
                          showPrices={false}
                        />
                      </div>
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="text-sm font-heading font-bold text-foreground leading-tight">
                            {signal.marketName?.replace("USDT", "")} <span className="text-muted-foreground font-normal">/ USDT</span>
                          </p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{signal.indicatorShortName} · {signal.period}</p>
                          {date && <p className="text-[10px] text-muted-foreground/60 mt-0.5">{date}</p>}
                        </div>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                          signal.qualityTier === "A" ? "bg-amber-500/20 text-amber-400" : signal.qualityTier === "B" ? "bg-primary/20 text-primary" : "bg-red-500/20 text-red-400"
                        }`}>
                          {signal.qualityTier}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground">Score {signal.qualityScore}</span>
                        <span className={`text-base font-heading font-bold tabular ${isFiltered ? "text-red-400" : isWin ? "text-green-400" : "text-amber-400"}`}>
                          {isFiltered ? "Skipped" : mp > 0 ? `+${mp.toFixed(2)}%` : "0.00%"}
                        </span>
                      </div>
                    </motion.div>
                  );
                })}
              </motion.div>
            )}

            <p className="text-center text-xs text-muted-foreground/50 mt-8 max-w-xl mx-auto">
              Results are simulated using 5% risk × 3× leverage on a $10,000 starting balance, on real signals our engine scored.
              Skipped signals are shown to prove what our quality filter correctly avoided. Past performance does not guarantee future results.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
