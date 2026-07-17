import { Link } from "wouter";
import { motion } from "framer-motion";
import { Bell, Bot, CheckCircle2, Trophy, Star, Shield } from "lucide-react";
import { useSectionInView } from "../hooks/useSectionInView";
import { fadeUp, stagger } from "../hooks/motion";

/* ─── PRICING ─── */
export default function PricingSection() {
  const { ref, isInView } = useSectionInView();

  const tiers = [
    {
      id: "signals",
      label: "Signal Delivery",
      gold: false,
      icon: <Bell className="w-6 h-6" />,
      tagline: "Signals only — you decide when to act",
      price: "Free",
      priceSub: "to start",
      highlight: false,
      features: [
        "Live Buy / Sell / Hold signal feed",
        "5 technical indicators (Stochastic, MACD, CCI, Ichimoku, Trend Reversal)",
        "All timeframes: 5m → 1W",
        "Aster-routable USDT pairs returned by the configured signal provider",
        "Filter by signal type, timeframe, and pair",
        "Dashboard with portfolio overview",
        "Email alerts (coming soon)",
      ],
      cta: "Get Started Free",
      ctaHref: "/register",
      note: null,
    },
    {
      id: "automated",
      label: "Connected Execution",
      icon: <Bot className="w-6 h-6" />,
      tagline: "User-enabled execution on supported connections",
      price: "Contact Us",
      priceSub: "for access",
      highlight: true,
      gold: true,
      features: [
        "Everything in Signal Delivery",
        "Order routing where supported and explicitly enabled",
        "Trade-only API key or Ledger hardware wallet",
        "Configurable position sizing and supported exit-order controls",
        "Kill switch — pause execution instantly",
        "Aster DEX integration with wallet self-custody",
        "Priority support & onboarding",
      ],
      cta: "Request Access",
      ctaHref: "/register",
      note: "Use trade-only credentials and verify connection permissions before enabling execution.",
    },
  ];

  return (
    <section id="pricing" className="py-32 relative section-divider">
      <div className="container relative z-10" ref={ref}>
        <motion.div
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
          variants={stagger}
          className="text-center mb-16"
        >
          <motion.span variants={fadeUp} transition={{ duration: 0.6 }} className="text-[0.7rem] font-medium tracking-[0.18em] uppercase mb-4 block" style={{ color: "oklch(0.68 0.20 220)" }}>
            Two Tiers
          </motion.span>
          <motion.h2 variants={fadeUp} transition={{ duration: 0.6 }} className="text-4xl sm:text-5xl font-heading font-medium tracking-[-0.035em] text-foreground mb-4">
            Choose How You Trade
          </motion.h2>
          <motion.p variants={fadeUp} transition={{ duration: 0.6 }} className="text-muted-foreground max-w-lg mx-auto">
            Start with signals and act manually. Connected execution is available only for supported, explicitly enabled configurations.
          </motion.p>
        </motion.div>

        <motion.div
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
          variants={stagger}
          className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto"
        >
          {tiers.map((tier, i) => (
            <motion.div
              key={tier.id}
              variants={fadeUp}
              transition={{ duration: 0.6, delay: i * 0.15 }}
              className={`relative rounded-2xl p-8 border transition-all duration-500 ${tier.gold ? "md:-mt-3 md:mb-3" : ""}`}
              style={tier.gold ? {
                background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.92), oklch(0.09 0.018 255 / 0.96))",
                borderColor: "oklch(0.82 0.16 85 / 0.35)",
                boxShadow: "0 0 0 1px oklch(0.82 0.16 85 / 0.10) inset, 0 0 50px oklch(0.82 0.16 85 / 0.10), 0 8px 40px oklch(0.07 0.015 255 / 0.5)",
                backdropFilter: "blur(20px)",
              } : {
                background: "linear-gradient(145deg, oklch(0.11 0.020 250 / 0.85), oklch(0.08 0.016 255 / 0.90))",
                borderColor: "oklch(0.60 0.22 220 / 0.18)",
                boxShadow: "0 0 0 1px oklch(0.60 0.22 220 / 0.06) inset, 0 8px 32px oklch(0.07 0.015 255 / 0.4)",
                backdropFilter: "blur(16px)",
              }}
            >
              {/* Gold ambient top glow for automated tier */}
              {tier.gold && (
                <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl">
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[200px] h-[80px] rounded-full blur-[40px]"
                    style={{ background: "oklch(0.82 0.16 85 / 0.12)" }} />
                </div>
              )}

              {tier.gold && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold shadow-lg"
                    style={{ background: "oklch(0.82 0.16 85)", color: "oklch(0.12 0.012 260)", boxShadow: "0 4px 20px oklch(0.82 0.16 85 / 0.4)" }}>
                    <Trophy className="w-3 h-3" /> Premium
                  </span>
                </div>
              )}
              {tier.highlight && !tier.gold && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary text-primary-foreground text-xs font-semibold shadow-lg shadow-primary/30">
                    <Star className="w-3 h-3 fill-current" /> Most Popular
                  </span>
                </div>
              )}

              <div className="relative z-10">
                <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-6"
                  style={tier.gold ? { background: "oklch(0.82 0.16 85 / 0.15)", color: "oklch(0.82 0.16 85)" } : { background: "oklch(0.20 0.018 260)", color: "oklch(0.60 0.015 260)" }}>
                  {tier.icon}
                </div>

                <h3 className="font-heading font-bold text-xl mb-1"
                  style={tier.gold ? { color: "oklch(0.88 0.18 85)" } : { color: "oklch(0.97 0.005 260)" }}>
                  {tier.label}
                </h3>
                <p className="text-sm text-muted-foreground mb-6">{tier.tagline}</p>

                <div className="mb-8">
                  <span className={`text-4xl font-heading font-bold ${
                    tier.gold ? "gold-shimmer-text" : tier.highlight ? "text-primary" : "text-foreground"
                  }`}>{tier.price}</span>
                  <span className="text-sm text-muted-foreground ml-2">{tier.priceSub}</span>
                </div>

                <ul className="space-y-3 mb-8">
                  {tier.features.map((f, fi) => (
                    <li key={fi} className="flex items-start gap-3">
                      <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0"
                        style={tier.gold ? { color: "oklch(0.82 0.16 85)" } : { color: "oklch(0.74 0.18 145 / 0.6)" }} />
                      <span className="text-sm text-muted-foreground">{f}</span>
                    </li>
                  ))}
                </ul>

                {tier.note && (
                  <p className="text-xs text-muted-foreground/70 mb-6 flex items-center gap-1.5">
                    <Shield className="w-3.5 h-3.5 shrink-0 text-primary/50" />
                    {tier.note}
                  </p>
                )}

                <Link href={tier.ctaHref}>
                  <button
                    className="w-full h-[3.1rem] rounded-[100px] font-medium text-sm transition-transform active:scale-[0.98]"
                    style={tier.gold ? {
                      fontFamily: "var(--font-heading)",
                      background: "oklch(0.82 0.16 85)",
                      color: "oklch(0.12 0.012 260)",
                      boxShadow: "inset 0 1px 0 oklch(1 0 0 / 0.35), 0 4px 20px oklch(0.82 0.16 85 / 0.3)",
                    } : {
                      fontFamily: "var(--font-heading)",
                      color: "oklch(0.98 0.004 220)",
                      background: "transparent",
                      border: "1.4px solid oklch(1 0 0 / 0.14)",
                    }}
                  >
                    {tier.cta}
                  </button>
                </Link>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
