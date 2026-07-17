import { useRef, useCallback } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Bell, Bot, Shield, Sparkles, Zap } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatSignedPercent, UNAVAILABLE } from "@/components/performancePresentation";
import Reveal from "../primitives/Reveal";
import Explainer from "../primitives/Explainer";
import { cappedDelay } from "../hooks/motion";

type Benefit = {
  icon: React.ReactNode;
  title: string;
  desc: React.ReactNode;
  tag: string;
  gold?: boolean;
  accentColor: string;
  span?: "full" | "half";
  stat?: { value: string; label: string };
};

/* ─── HOW IT HELPS (bento upgrade) ───
   Asymmetric bento grid with 3D perspective tilt on hover, glass
   biome-like cards, and staggered scroll reveals. Replaces the old
   hairline-divided list with an Awwwards-caliber layout. */
export default function HowItHelps() {
  const prefersReduced = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const { data: signalStats } = trpc.signals.stats.useQuery();
  const { data: demoStats } = trpc.demo.getPublicDemoStats.useQuery();

  const benefits: Benefit[] = [
    {
      icon: <Bell className="w-5 h-5" />,
      title: "You get the signals",
      desc: "Clear Buy, Sell, and Hold alerts land on your dashboard with the price and timing. Act whenever you like — you're always in control.",
      tag: "You stay in control",
      accentColor: "oklch(0.60 0.22 220)",
      span: "half",
      stat: { value: "User-directed", label: "signal review" },
    },
    {
      icon: <Bot className="w-5 h-5" />,
      title: "Configure connected execution",
      desc: "On supported connections, you can explicitly enable order routing and configure sizing and exit controls. Availability depends on venue and account setup.",
      tag: "User-enabled",
      gold: true,
      accentColor: "oklch(0.82 0.16 85)",
      span: "half",
      stat: { value: "Configurable", label: "risk inputs" },
    },
    {
      icon: <Shield className="w-5 h-5" />,
      title: "Your money stays yours",
      desc: (
        <>
          We can place trades but never withdraw. Your funds never leave your own account, and you can switch us off in one tap.{" "}
          <Explainer text="Non-custodial means we never hold or move your money — we only send trade instructions to your exchange." label="non-custodial" />
        </>
      ),
      tag: "Non-custodial",
      accentColor: "oklch(0.72 0.20 195)",
      span: "half",
      stat: { value: "Zero", label: "access to funds" },
    },
    {
      icon: <Zap className="w-5 h-5" />,
      title: "Monitor supported markets",
      desc: "Signal and execution availability varies by configured provider, venue, market, and account permissions.",
      tag: "Provider-dependent",
      accentColor: "oklch(0.68 0.20 220)",
      span: "half",
      stat: { value: "Variable", label: "market coverage" },
    },
  ];

  return (
    <section id="about" className="py-32 relative overflow-hidden" ref={sectionRef}>
      {/* Background glow */}
      <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] rounded-full pointer-events-none"
        style={{ background: "radial-gradient(circle, oklch(0.60 0.22 220 / 0.08) 0%, transparent 60%)" }} />
      <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: "radial-gradient(circle, oklch(0.72 0.20 195 / 0.06) 0%, transparent 60%)" }} />

      <div className="container relative z-10">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16">
          {/* Left: editorial statement (sticky on desktop) */}
          <div className="lg:col-span-5">
            <div className="lg:sticky lg:top-28">
              <Reveal y={16} duration={0.5}>
                <span className="text-[0.7rem] font-medium tracking-[0.18em] uppercase text-electric mb-5 block">
                  Why Anavitrade
                </span>
              </Reveal>
              <Reveal y={28} delay={0.05}>
                <h2 className="text-display text-foreground mb-6">
                  Trading,<br />without the<br />
                  <span className="text-arctic">hard part.</span>
                </h2>
              </Reveal>
              <Reveal y={20} delay={0.1}>
                <p className="text-muted-foreground leading-relaxed max-w-md mb-8">
                  No charts to stare at. No jargon to learn. Our engine does the analysis and the discipline — you just choose how involved you want to be.
                </p>
              </Reveal>

              {/* Live stats mini rail */}
              <Reveal y={16} delay={0.15}>
                <div className="flex gap-6 p-4 rounded-xl" style={{ background: "oklch(1 0 0 / 0.03)", border: "1px solid oklch(1 0 0 / 0.06)" }}>
                  <div>
                    <p className="text-xl font-heading font-bold text-foreground tabular">
                      {signalStats?.totalSignals != null ? Number(signalStats.totalSignals).toLocaleString() : UNAVAILABLE}
                    </p>
                    <p className="text-[11px] text-muted-foreground/60">Signals scored</p>
                  </div>
                  <div className="w-px" style={{ background: "oklch(1 0 0 / 0.06)" }} />
                  <div>
                    <p className="text-xl font-heading font-bold text-foreground tabular">Configured</p>
                    <p className="text-[11px] text-muted-foreground/60">Provider coverage</p>
                  </div>
                  <div className="w-px" style={{ background: "oklch(1 0 0 / 0.06)" }} />
                  <div>
                    <p className="text-xl font-heading font-bold gold-shimmer-text tabular">
                      {Number(demoStats?.tradeCount ?? 0) > 0 ? formatSignedPercent(demoStats?.totalReturnPct) : UNAVAILABLE}
                    </p>
                    <p className="text-[11px] text-muted-foreground/60">Modeled scenario</p>
                  </div>
                </div>
              </Reveal>
            </div>
          </div>

          {/* Right: bento grid */}
          <div id="why-choose" className="lg:col-span-7 scroll-mt-28">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {benefits.map((b, i) => (
                <Reveal key={b.title} delay={cappedDelay(i, 0.1)} y={24} className={b.span === "full" ? "sm:col-span-2" : ""}>
                  <TiltCard gold={b.gold} accentColor={b.accentColor} prefersReduced={prefersReduced}>
                    {/* Icon */}
                    <div className="flex items-center gap-3 mb-4">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center"
                        style={b.gold
                          ? { background: "oklch(0.82 0.16 85 / 0.15)", color: "oklch(0.82 0.16 85)", border: "1px solid oklch(0.82 0.16 85 / 0.30)" }
                          : { background: `${b.accentColor}18`, color: b.accentColor, border: `1px solid ${b.accentColor}30` }}
                      >
                        {b.icon}
                      </div>
                      <span
                        className="text-[11px] font-medium px-2.5 py-0.5 rounded-full"
                        style={b.gold
                          ? { background: "oklch(0.82 0.16 85 / 0.10)", color: "oklch(0.82 0.16 85)" }
                          : { background: `${b.accentColor}15`, color: b.accentColor }}
                      >
                        {b.tag}
                      </span>
                    </div>

                    {/* Title */}
                    <h3
                      className="font-heading font-semibold text-lg mb-2"
                      style={b.gold ? { color: "oklch(0.88 0.18 85)" } : { color: "oklch(0.97 0.005 260)" }}
                    >
                      {b.title}
                    </h3>

                    {/* Description */}
                    <p className="text-sm text-muted-foreground leading-relaxed">{b.desc}</p>

                    {/* Stat chip */}
                    {b.stat && (
                      <div className="mt-4 pt-4" style={{ borderTop: "1px solid oklch(1 0 0 / 0.05)" }}>
                        <div className="flex items-center gap-2">
                          <Sparkles className="w-3.5 h-3.5" style={{ color: b.accentColor }} />
                          <span className="text-xs font-semibold tabular" style={{ color: b.accentColor }}>
                            {b.stat.value}
                          </span>
                          <span className="text-[11px] text-muted-foreground/50">{b.stat.label}</span>
                        </div>
                      </div>
                    )}
                  </TiltCard>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─── 3D PERSPECTIVE TILT CARD ───
   Subtle tilt on hover that follows the cursor. Falls back to a flat
   glass card when prefers-reduced-motion is set. */
function TiltCard({
  children,
  gold,
  accentColor,
  prefersReduced,
}: {
  children: React.ReactNode;
  gold?: boolean;
  accentColor: string;
  prefersReduced: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (prefersReduced || !cardRef.current) return;
      const rect = cardRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = ((y - centerY) / centerY) * -6;
      const rotateY = ((x - centerX) / centerX) * 6;
      cardRef.current.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
    },
    [prefersReduced],
  );

  const handleMouseLeave = useCallback(() => {
    if (!cardRef.current) return;
    cardRef.current.style.transform = "perspective(800px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)";
  }, []);

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="relative rounded-2xl p-6 transition-transform duration-200 ease-out cursor-default h-full overflow-hidden group"
      style={gold
        ? {
            background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.88), oklch(0.09 0.018 255 / 0.94))",
            border: "1px solid oklch(0.82 0.16 85 / 0.25)",
            boxShadow: "0 0 0 1px oklch(0.82 0.16 85 / 0.08) inset, 0 0 40px oklch(0.82 0.16 85 / 0.08), 0 12px 40px oklch(0.07 0.015 255 / 0.4)",
            backdropFilter: "blur(16px)",
          }
        : {
            background: "linear-gradient(145deg, oklch(0.11 0.020 250 / 0.8), oklch(0.08 0.016 255 / 0.88))",
            border: "1px solid oklch(0.60 0.22 220 / 0.12)",
            boxShadow: "0 0 0 1px oklch(0.60 0.22 220 / 0.05) inset, 0 8px 32px oklch(0.07 0.015 255 / 0.35)",
            backdropFilter: "blur(14px)",
          }}
    >
      {/* Hover ambient glow */}
      <motion.div
        className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
        style={{
          background: `radial-gradient(ellipse at 50% 50%, ${accentColor}15 0%, transparent 70%)`,
        }}
      />

      {/* Top hairline */}
      <div
        className="absolute top-0 left-0 right-0 h-px opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{ background: `linear-gradient(90deg, transparent, ${accentColor}60, transparent)` }}
      />

      <div className="relative z-10">{children}</div>
    </div>
  );
}
