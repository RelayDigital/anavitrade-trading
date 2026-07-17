import { Link } from "wouter";
import { motion } from "framer-motion";
import { ArrowRight, Activity, Clock, Award } from "lucide-react";
import { trpc } from "@/lib/trpc";
import TradeChartSnapshot from "@/components/TradeChartSnapshot";
import SectionHeader from "../primitives/SectionHeader";
import Reveal from "../primitives/Reveal";
import Explainer from "../primitives/Explainer";
import { cappedDelay } from "../hooks/motion";
import {
  formatSignedPercent,
  parseOptionalNumber,
  SCORING_PRESENTATION,
  UNAVAILABLE,
} from "@/components/performancePresentation";

const tierMeta: Record<string, { label: string; hint: string; color: string; bg: string; border: string }> = {
  A: {
    label: "Tier A",
    hint: "Tier A is assigned from the pre-entry signal score.",
    color: "oklch(0.82 0.16 85)",
    bg: "oklch(0.82 0.16 85 / 0.12)",
    border: "oklch(0.82 0.16 85 / 0.35)",
  },
  B: {
    label: "Tier B",
    hint: "Tier B is assigned from the pre-entry signal score.",
    color: "oklch(0.72 0.18 145)",
    bg: "oklch(0.72 0.18 145 / 0.10)",
    border: "oklch(0.72 0.18 145 / 0.30)",
  },
  C: {
    label: "Tier C",
    hint: "Tier C is assigned from the pre-entry signal score.",
    color: "oklch(0.65 0.12 220)",
    bg: "oklch(0.65 0.12 220 / 0.10)",
    border: "oklch(0.65 0.12 220 / 0.25)",
  },
};

/* ─── RECENT WINS (was Bangers) ───
   Asymmetric editorial layout: one big featured win on the left with a live
   mini-chart, and a light feed of recent ones on the right. Human framing,
   count-up numbers, and a "live" pulse to sell the real-time feel. */
export default function RecentWins() {
  const { data } = trpc.signals.topBangers.useQuery({ limit: 6 });
  const bangers = data ?? [];

  if (bangers.length === 0) return null;

  const [featured, ...feed] = bangers;
  const fTier = featured.qualityTier ?? "C";
  const fMeta = tierMeta[fTier] ?? tierMeta.C;
  const featuredMove = parseOptionalNumber(featured.maxProfit);

  return (
    <section id="bangers" className="py-24 relative section-divider">
      <div className="container">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-12">
          <SectionHeader
            eyebrow="Recent Signal Moves"
            title={<>Provider-reported<br className="hidden sm:block" /> favorable movement</>}
            subtitle="Historical favorable movement reported by the signal provider after Buy signals. These values are not realized account returns."
          />
          <Reveal delay={0.1} className="shrink-0">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs" style={{ background: "oklch(0.72 0.18 145 / 0.10)", border: "1px solid oklch(0.72 0.18 145 / 0.25)", color: "oklch(0.74 0.18 145)" }}>
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-70" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              Provider-reported data
            </span>
          </Reveal>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Featured win — the hero card */}
          <Reveal className="lg:col-span-5" y={30}>
            <div
              className="relative rounded-2xl p-6 h-full overflow-hidden flex flex-col"
              style={{
                background: "linear-gradient(135deg, oklch(0.12 0.022 250 / 0.85), oklch(0.09 0.018 255 / 0.92))",
                border: "1px solid oklch(0.82 0.16 85 / 0.30)",
                boxShadow: "0 0 0 1px oklch(0.82 0.16 85 / 0.08) inset, 0 0 50px oklch(0.82 0.16 85 / 0.07), 0 12px 40px oklch(0.07 0.015 255 / 0.45)",
                backdropFilter: "blur(16px)",
              }}
            >
              <div className="absolute top-0 left-0 right-0 h-[1px]" style={{ background: "linear-gradient(to right, transparent, oklch(0.82 0.16 85 / 0.6), transparent)" }} />

              <div className="flex items-start justify-between mb-5">
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <Activity className="w-4 h-4" style={{ color: fMeta.color }} />
                    <span className="text-xl font-heading font-bold text-foreground">
                      {featured.marketName.replace("USDT", "/USDT")}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1" style={{ background: fMeta.bg, color: fMeta.color, border: `1px solid ${fMeta.border}` }}>
                      {fMeta.label}
                      <Explainer text={fMeta.hint} label={fMeta.label} />
                    </span>
                    <span className="text-[10px] text-muted-foreground/60">{featured.indicatorShortName} · {featured.period}</span>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-4xl font-heading font-bold tabular" style={{ color: fMeta.color }}>
                    {formatSignedPercent(featuredMove)}
                  </p>
                  <p className="text-[10px] text-muted-foreground/50">reported favorable move</p>
                </div>
              </div>

              {/* Live mini chart */}
              <div className="rounded-lg overflow-hidden mb-4 flex-1 min-h-[150px]">
                <TradeChartSnapshot
                  pair={featured.marketName}
                  entryPrice={0}
                  exitPrice={null}
                  period={featured.period}
                  height={170}
                  showPrices={false}
                />
              </div>

              <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
                <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{featured.maxProfitDuration ?? "—"}</span>
                <span className="inline-flex items-center gap-1">
                  <Award className="w-3 h-3" />Score {featured.qualityScore ?? UNAVAILABLE}
                  <Explainer text={`Pre-entry score out of ${SCORING_PRESENTATION.maxScore}, based on indicator/timeframe, confluence, and entry-time momentum.`} label="Score" />
                </span>
              </div>
            </div>
          </Reveal>

          {/* Feed — recent runners-up */}
          <div className="lg:col-span-7 flex flex-col gap-3">
            {feed.map((s, i) => {
              const tier = s.qualityTier ?? "C";
              const meta = tierMeta[tier] ?? tierMeta.C;
              const reportedMove = parseOptionalNumber(s.maxProfit);
              return (
                <Reveal key={(s as any).rowKey ?? `${s.id}-${i}`} delay={cappedDelay(i, 0.07)} y={20}>
                  <div
                    className="group flex items-center gap-4 rounded-xl px-5 py-4 transition-all duration-300 hover:-translate-y-0.5"
                    style={{
                      background: "linear-gradient(145deg, oklch(0.11 0.020 250 / 0.7), oklch(0.08 0.016 255 / 0.8))",
                      border: "1px solid oklch(0.60 0.22 220 / 0.14)",
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-base font-heading font-bold text-foreground truncate">
                          {s.marketName.replace("USDT", "/USDT")}
                        </span>
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0" style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
                          {meta.label}
                        </span>
                      </div>
                      {/* progress bar */}
                      <div className="h-1 rounded-full overflow-hidden" style={{ background: "oklch(1 0 0 / 0.05)" }}>
                        <motion.div
                          initial={{ width: 0 }}
                          whileInView={{ width: `${reportedMove === null ? 0 : Math.min(Math.max((reportedMove / 40) * 100, 0), 100)}%` }}
                          viewport={{ once: true }}
                          transition={{ duration: 1, delay: 0.2 + cappedDelay(i, 0.07), ease: [0.23, 1, 0.32, 1] }}
                          className="h-full rounded-full"
                          style={{ background: meta.color }}
                        />
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground/50">
                        <span>{s.indicatorShortName} · {s.period}</span>
                        <span>·</span>
                        <span className="inline-flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{s.maxProfitDuration ?? "—"}</span>
                      </div>
                    </div>
                    <p className="text-2xl font-heading font-bold tabular shrink-0" style={{ color: meta.color }}>
                      {formatSignedPercent(reportedMove)}
                    </p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>

        <Reveal delay={0.2} className="text-center mt-10">
          <Link href="/register">
            <button className="btn-hairline group h-[3.2rem] px-7 text-[0.9rem]">
              <Activity className="w-4 h-4" />
              See the full live signal feed
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </button>
          </Link>
        </Reveal>
      </div>
    </section>
  );
}
