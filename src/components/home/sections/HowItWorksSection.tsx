import { useRef } from "react";
import { Link } from "wouter";
import { motion, useScroll, useTransform, useReducedMotion } from "framer-motion";
import { ArrowRight, UserPlus, SlidersHorizontal, LineChart, Sparkles, CheckCircle2 } from "lucide-react";
import SectionHeader from "../primitives/SectionHeader";
import Reveal from "../primitives/Reveal";
import { cappedDelay } from "../hooks/motion";

/* ─── HOW IT WORKS (cinematic timeline upgrade) ───
   Asymmetric layout: sticky numbered progression on the left, animated
   step cards on the right that reveal as you scroll. Each step draws in
   with a progress hairline, and the active step pulses subtly. */
export default function HowItWorksSection() {
  const prefersReduced = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);

  const steps = [
    {
      icon: <UserPlus className="w-5 h-5" />,
      title: "Sign up free",
      desc: "Create an account in a minute and explore market signals and research in the demo dashboard — no exchange or card needed to start.",
      perks: ["No credit card", "Instant access", "Research dashboard"],
      gradient: "linear-gradient(135deg, oklch(0.60 0.22 220 / 0.20), oklch(0.60 0.22 220 / 0.04))",
      accentColor: "oklch(0.60 0.22 220)",
    },
    {
      icon: <SlidersHorizontal className="w-5 h-5" />,
      title: "Review the research",
      desc: "Use the signal context and risk levels to inform your own decisions. Aster mainnet automation is enabled for authorized pilot accounts with capped order sizing.",
      perks: ["Signal context", "Risk visibility", "Automation controls"],
      gradient: "linear-gradient(135deg, oklch(0.72 0.20 195 / 0.20), oklch(0.72 0.20 195 / 0.04))",
      accentColor: "oklch(0.72 0.20 195)",
    },
    {
      icon: <LineChart className="w-5 h-5" />,
      title: "Follow the evidence",
      desc: "Follow signals, authorization status, and any connected Aster activity from one clear dashboard. No profitability promises or black boxes.",
      perks: ["Signal history", "Validation status", "Risk controls"],
      gradient: "linear-gradient(135deg, oklch(0.82 0.16 85 / 0.18), oklch(0.82 0.16 85 / 0.03))",
      accentColor: "oklch(0.82 0.16 85)",
    },
  ];

  return (
    <section className="py-32 relative overflow-hidden" ref={sectionRef}>
      {/* Background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="orb-azure" style={{ width: 500, height: 500, top: "20%", left: "-10%", opacity: 0.25 }} />
        <div className="orb-cyan" style={{ width: 400, height: 400, bottom: "10%", right: "-5%", opacity: 0.2 }} />
      </div>

      <div className="container relative z-10">
        <SectionHeader
          align="center"
          eyebrow="Getting Started"
          title="Up and running in three steps"
          subtitle="From account creation to transparent signal research — no complexity, no friction."
          className="mb-16"
        />

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16">
          {/* Left: sticky step tracker */}
          <div className="lg:col-span-4">
            <div className="lg:sticky lg:top-28 space-y-6">
              {steps.map((step, i) => (
                <motion.div
                  key={step.title}
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: i * 0.15 }}
                  className="flex items-center gap-4"
                >
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center shrink-0 text-[16px] font-bold tabular"
                    style={{
                      background: step.accentColor === "oklch(0.82 0.16 85)"
                        ? "linear-gradient(135deg, oklch(0.82 0.16 85 / 0.20), oklch(0.82 0.16 85 / 0.05))"
                        : "linear-gradient(135deg, oklch(0.60 0.22 220 / 0.20), oklch(0.60 0.22 220 / 0.05))",
                      border: `1px solid ${step.accentColor}40`,
                      color: step.accentColor,
                    }}
                  >
                    {i + 1}
                  </div>
                  <div className="hidden lg:block">
                    <p className="text-xs font-semibold" style={{ color: step.accentColor }}>STEP {i + 1}</p>
                    <p className="text-sm text-foreground/60">{step.title}</p>
                  </div>
                </motion.div>
              ))}

              {/* Progress indicator */}
              <div className="hidden lg:block ml-6 mt-4">
                <div className="flex gap-2">
                  {steps.map((_, i) => (
                    <div
                      key={i}
                      className="h-1 rounded-full transition-all duration-500"
                      style={{
                        width: 30,
                        background: i === 0
                          ? "oklch(0.60 0.22 220 / 0.5)"
                          : i === 1
                          ? "oklch(0.72 0.20 195 / 0.5)"
                          : "oklch(0.82 0.16 85 / 0.5)",
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Right: animated step cards */}
          <div className="lg:col-span-8 space-y-6">
            {steps.map((step, i) => (
              <motion.div
                key={step.title}
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.7, delay: i * 0.1, ease: [0.23, 1, 0.32, 1] }}
                className="relative group"
              >
                {/* Connector line */}
                {i < steps.length - 1 && (
                  <div className="absolute left-10 top-20 bottom-0 w-px"
                    style={{ background: `linear-gradient(to bottom, ${step.accentColor}40, transparent)` }} />
                )}

                <div
                  className="relative rounded-2xl p-6 lg:p-8 transition-all duration-500 overflow-hidden"
                  style={{
                    background: "linear-gradient(145deg, oklch(0.11 0.020 250 / 0.75), oklch(0.08 0.016 255 / 0.85))",
                    border: "1px solid oklch(0.60 0.22 220 / 0.12)",
                    backdropFilter: "blur(14px)",
                  }}
                >
                  {/* Hover glow */}
                  <motion.div
                    className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
                    style={{ background: `radial-gradient(ellipse at 30% 50%, ${step.accentColor}12 0%, transparent 70%)` }}
                  />

                  {/* Top gradient border on hover */}
                  <div
                    className="absolute top-0 left-0 right-0 h-px opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                    style={{ background: `linear-gradient(90deg, transparent, ${step.accentColor}50, transparent)` }}
                  />

                  <div className="relative z-10 flex items-start gap-5">
                    {/* Icon */}
                    <div
                      className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 transition-all duration-300 group-hover:scale-110 group-hover:shadow-lg"
                      style={{
                        background: step.gradient,
                        border: `1px solid ${step.accentColor}35`,
                        color: step.accentColor,
                        boxShadow: `0 0 20px ${step.accentColor}10`,
                      }}
                    >
                      {step.icon}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="text-[10px] font-mono font-medium text-muted-foreground/50">STEP {i + 1}</span>
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: `${step.accentColor}15`, color: step.accentColor }}>
                          ~{i === 0 ? "1 min" : i === 1 ? "5 min" : "ongoing"}
                        </span>
                      </div>
                      <h3
                        className="font-heading font-semibold text-xl mb-2"
                        style={{ color: i === 2 ? "oklch(0.88 0.18 85)" : "oklch(0.97 0.005 260)" }}
                      >
                        {step.title}
                      </h3>
                      <p className="text-sm text-muted-foreground leading-relaxed mb-4 max-w-xl">{step.desc}</p>

                      {/* Perks */}
                      <div className="flex flex-wrap gap-2">
                        {step.perks.map((perk) => (
                          <span
                            key={perk}
                            className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full"
                            style={{
                              background: `${step.accentColor}10`,
                              border: `1px solid ${step.accentColor}20`,
                              color: step.accentColor,
                            }}
                          >
                            <CheckCircle2 className="w-3 h-3" />
                            {perk}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <Reveal delay={0.3} className="text-center mt-12">
          <div className="flex flex-col sm:flex-row gap-3.5 justify-center">
            <Link href="/demo">
              <button className="group inline-flex items-center gap-2 h-[3.4rem] px-8 rounded-[100px] text-[0.95rem] font-medium transition-transform active:scale-[0.98]"
                style={{ fontFamily: "var(--font-heading)", color: "oklch(0.14 0.02 255)", background: "var(--grad-arctic)", boxShadow: "inset 0 1px 0 oklch(1 0 0 / 0.4), 0 4px 24px oklch(0.72 0.20 195 / 0.22)" }}>
                View Live Demo
                <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </Link>
            <Link href="/register">
              <button className="btn-obsidian h-[3.4rem] px-8 text-[0.95rem]">
                <Sparkles className="w-4 h-4" />
                Create Free Account
              </button>
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
