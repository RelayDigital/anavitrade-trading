import { Fragment, useState, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Radio, Database, Brain, Zap, ChevronDown, Sparkles } from "lucide-react";
import SectionHeader from "../primitives/SectionHeader";
import Reveal from "../primitives/Reveal";
import { cappedDelay } from "../hooks/motion";

type Stage = {
  icon: React.ReactNode;
  title: string;
  desc: string;
  meta: string;
  detail: string;
  indicatorCount: number;
};

/* ─── SIGNAL PIPELINE (upgraded) ───
   Glowing animated pipeline with particle packets, interactive expand
   on each stage for more detail, and a live counter at the end showing
   engine activity. The pipeline-track pulses with azure light as packets
   travel stage → stage. */
export default function SignalPipeline() {
  const prefersReduced = useReducedMotion();
  const [expandedStage, setExpandedStage] = useState<number | null>(null);

  const stages: Stage[] = [
    {
      icon: <Radio className="w-5 h-5" />,
      title: "We watch the market",
      desc: "Our engine scans exchanges around the clock — prices, volume, and big-money moves.",
      meta: "50+ live data feeds",
      detail: "Every tick from 5 major exchanges flows through our ingestion layer. Price, volume, order book imbalance, and funding rates — all normalized and deduplicated in real time.",
      indicatorCount: 5,
    },
    {
      icon: <Database className="w-5 h-5" />,
      title: "We spot the setup",
      desc: "It reads momentum and patterns across every timeframe to find real opportunities.",
      meta: "5 indicators, 7 timeframes",
      detail: "Stochastic, MACD, CCI, Ichimoku, and Trend Reversal across 5m → 1W. Each indicator votes independently — a signal only fires when enough confluence builds up.",
      indicatorCount: 7,
    },
    {
      icon: <Brain className="w-5 h-5" />,
      title: "We pick the trade",
      desc: "It sets a clear entry, a profit target, and a safety net to limit the downside.",
      meta: "Entry · target · stop-loss",
      detail: "Position sizing and protective levels are evaluated against configured risk controls before an execution can be submitted. Unsupported exchange capabilities are denied.",
      indicatorCount: 3,
    },
    {
      icon: <Zap className="w-5 h-5" />,
      title: "We place it for you",
      desc: "The trade goes straight to your exchange automatically — no button-mashing.",
      meta: "Capability gated",
      detail: "The execution layer submits the order via API or your connected Ledger. A kill switch lets you pause everything instantly. Every trade is logged to your dashboard before the confirmation email arrives.",
      indicatorCount: 1,
    },
  ];

  return (
    <section id="strategy" className="py-32 relative overflow-hidden">
      {/* Ambient background glow */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[800px] h-[400px] rounded-full pointer-events-none"
        style={{ background: "radial-gradient(ellipse, oklch(0.60 0.22 220 / 0.06) 0%, transparent 60%)" }} />

      <div className="container relative z-10">
        <SectionHeader
          align="center"
          eyebrow="How it works"
          title="From market signal to done — automatically"
          subtitle="Signals move through validation, risk checks, and capability-gated execution. Click any step for the technical detail."
          className="mb-16"
        />

        {/* Desktop: horizontal pipeline (lg+ only) */}
        <div className="hidden lg:flex items-start justify-center">
          {stages.map((stage, i) => (
            <Fragment key={stage.title}>
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ duration: 0.6, delay: i * 0.15, ease: [0.23, 1, 0.32, 1] }}
                className="w-[210px] shrink-0 text-center px-3"
              >
                <button
                  onClick={() => setExpandedStage(expandedStage === i ? null : i)}
                  className="w-full text-left group"
                >
                  {/* Animated icon container */}
                  <div className="relative mx-auto w-14 h-14 mb-4">
                    {/* Pulse ring */}
                    <motion.div
                      animate={prefersReduced ? {} : { scale: [1, 1.2, 1], opacity: [0.3, 0.1, 0.3] }}
                      transition={{ duration: 3, repeat: Infinity, ease: "easeInOut", delay: i * 0.4 }}
                      className="absolute inset-0 rounded-full"
                      style={{
                        background: i === 3
                          ? "oklch(0.72 0.20 195 / 0.2)"
                          : "oklch(0.60 0.22 220 / 0.2)",
                      }}
                    />
                    <div
                      className="relative w-14 h-14 rounded-full flex items-center justify-center text-primary mx-auto transition-all duration-300 group-hover:scale-110"
                      style={{
                        background: "linear-gradient(180deg, oklch(0.60 0.22 220 / 0.20), oklch(0.60 0.22 220 / 0.05))",
                        border: "1px solid oklch(0.60 0.22 220 / 0.25)",
                      }}
                    >
                      {stage.icon}
                    </div>
                  </div>

                  <span className="text-[10px] text-muted-foreground/50 font-mono block mt-2 mb-1">STEP {i + 1}</span>
                  <h4 className="font-heading font-semibold text-foreground mb-2 transition-colors duration-300 group-hover:text-primary">
                    {stage.title}
                  </h4>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-3">{stage.desc}</p>

                  {/* Meta chip */}
                  <span
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full tabular transition-all duration-300 group-hover:bg-primary/15"
                    style={{
                      background: "oklch(0.60 0.22 220 / 0.10)",
                      color: "oklch(0.77 0.17 220)",
                      border: "1px solid oklch(0.60 0.22 220 / 0.20)",
                    }}
                  >
                    <Sparkles className="w-3 h-3" />
                    {stage.meta}
                  </span>
                </button>

                {/* Expanded detail */}
                <AnimatePresence>
                  {expandedStage === i && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.3 }}
                      className="overflow-hidden mt-3"
                    >
                      <div
                        className="p-3 rounded-xl text-xs leading-relaxed text-muted-foreground text-left"
                        style={{
                          background: "oklch(0.60 0.22 220 / 0.06)",
                          border: "1px solid oklch(0.60 0.22 220 / 0.12)",
                        }}
                      >
                        {stage.detail}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Dot indicator for expandable detail */}
                {expandedStage === i && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="mt-3 flex justify-center"
                  >
                    <span className="text-[10px] text-muted-foreground/40 flex items-center gap-1">
                      <ChevronDown className="w-3 h-3" />
                      click to collapse
                    </span>
                  </motion.div>
                )}
              </motion.div>

              {/* Pipeline connector with glowing particle */}
              {i < stages.length - 1 && (
                <div className="relative flex-1 max-w-[90px] mt-9 mx-2">
                  {/* Track */}
                  <div className="absolute top-1/2 left-0 right-0 h-[2px] rounded-full -translate-y-1/2"
                    style={{ background: "linear-gradient(90deg, oklch(0.60 0.22 220 / 0.30), oklch(0.60 0.22 220 / 0.05))" }} />
                  {/* Glowing packet */}
                  <motion.div
                    className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full"
                    style={{
                      background: "oklch(0.72 0.20 195)",
                      boxShadow: "0 0 10px oklch(0.72 0.20 195 / 0.6), 0 0 20px oklch(0.72 0.20 195 / 0.3)",
                    }}
                    initial={{ left: 0 }}
                    animate={prefersReduced ? {} : { left: ["0%", "100%"] }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: "linear", delay: i * 0.6 }}
                  />
                  {/* Second packet for continuous flow */}
                  <motion.div
                    className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full"
                    style={{
                      background: "oklch(0.60 0.22 220)",
                      boxShadow: "0 0 8px oklch(0.60 0.22 220 / 0.4)",
                    }}
                    initial={{ left: "-20%" }}
                    animate={prefersReduced ? {} : { left: ["-20%", "120%"] }}
                    transition={{ duration: 2.2, repeat: Infinity, ease: "linear", delay: i * 0.6 + 0.6 }}
                  />
                </div>
              )}
            </Fragment>
          ))}
        </div>

        {/* Mobile & tablet: vertical pipeline with particle track */}
        <div className="lg:hidden max-w-md mx-auto">
          {stages.map((stage, i) => (
            <motion.div
              key={stage.title}
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: "-30px" }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
            >
              <div className="flex items-start gap-4 pb-8 relative">
                {i < stages.length - 1 && (
                  <div className="absolute left-6 top-12 bottom-0 w-px overflow-hidden">
                    <motion.div
                      className="w-full h-full"
                      style={{
                        background: "linear-gradient(to bottom, oklch(0.60 0.22 220 / 0.4), oklch(0.60 0.22 220 / 0.05))",
                      }}
                    />
                    {/* Moving particle along the line */}
                    <motion.div
                      className="absolute left-1/2 -translate-x-1/2 w-2 h-2 rounded-full"
                      style={{
                        background: "oklch(0.72 0.20 195)",
                        boxShadow: "0 0 8px oklch(0.72 0.20 195 / 0.6)",
                      }}
                      animate={prefersReduced ? {} : { top: ["0%", "100%"] }}
                      transition={{ duration: 2, repeat: Infinity, ease: "linear", delay: i * 0.5 }}
                    />
                  </div>
                )}
                <button
                  onClick={() => setExpandedStage(expandedStage === i ? null : i)}
                  className="group flex items-start gap-4 flex-1 text-left"
                >
                  <div
                    className="relative w-12 h-12 rounded-full flex items-center justify-center text-primary shrink-0 transition-all duration-300 group-hover:scale-110"
                    style={{
                      background: "linear-gradient(180deg, oklch(0.60 0.22 220 / 0.20), oklch(0.60 0.22 220 / 0.05))",
                      border: "1px solid oklch(0.60 0.22 220 / 0.25)",
                    }}
                  >
                    {stage.icon}
                  </div>
                  <div className="pt-1 flex-1">
                    <span className="text-[10px] text-muted-foreground/50 font-mono">STEP {i + 1}</span>
                    <h4 className="font-heading font-semibold text-foreground mt-0.5 mb-1.5 transition-colors group-hover:text-primary">{stage.title}</h4>
                    <p className="text-sm text-muted-foreground leading-relaxed mb-2">{stage.desc}</p>
                    <span
                      className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full tabular"
                      style={{
                        background: "oklch(0.60 0.22 220 / 0.10)",
                        color: "oklch(0.77 0.17 220)",
                        border: "1px solid oklch(0.60 0.22 220 / 0.20)",
                      }}
                    >
                      <Sparkles className="w-3 h-3" />
                      {stage.meta}
                    </span>

                    {/* Expandable detail */}
                    <AnimatePresence>
                      {expandedStage === i && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.3 }}
                          className="overflow-hidden mt-3"
                        >
                          <div
                            className="p-3 rounded-xl text-xs leading-relaxed text-muted-foreground"
                            style={{
                              background: "oklch(0.60 0.22 220 / 0.06)",
                              border: "1px solid oklch(0.60 0.22 220 / 0.12)",
                            }}
                          >
                            {stage.detail}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </button>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Engine activity pulse at the bottom */}
        <Reveal delay={0.4} className="text-center mt-12">
          <div
            className="inline-flex items-center gap-3 px-5 py-2.5 rounded-full"
            style={{
              background: "oklch(0.60 0.22 220 / 0.06)",
              border: "1px solid oklch(0.60 0.22 220 / 0.15)",
            }}
          >
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
            </span>
            <span className="text-xs text-muted-foreground/80">
              Engine running · <span className="text-primary font-semibold tabular">50+</span> feeds · <span className="text-primary font-semibold tabular">35</span> indicators · <span className="text-primary font-semibold tabular">7</span> timeframes
            </span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
