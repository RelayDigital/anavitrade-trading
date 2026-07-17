import { motion, useReducedMotion } from "framer-motion";
import { useSectionInView } from "../hooks/useSectionInView";
import { ArrowUpRight, Globe, BarChart3, Hash, Shield, TrendingUp } from "lucide-react";

const exchanges = [
  { name: "Binance", icon: <BarChart3 className="w-5 h-5" />, accent: "oklch(0.75 0.18 85)" },
  { name: "Coinbase", icon: <Shield className="w-5 h-5" />, accent: "oklch(0.60 0.22 220)" },
  { name: "Kraken", icon: <Globe className="w-5 h-5" />, accent: "oklch(0.72 0.20 195)" },
  { name: "Bybit", icon: <TrendingUp className="w-5 h-5" />, accent: "oklch(0.82 0.16 85)" },
  { name: "OKX", icon: <Hash className="w-5 h-5" />, accent: "oklch(0.68 0.20 220)" },
];

export default function LogoBar() {
  const { ref, isInView } = useSectionInView();
  const prefersReduced = useReducedMotion();

  return (
    <section className="py-16 relative overflow-hidden" ref={ref}>
      {/* Subtle top & bottom ambient glow */}
      <div className="absolute top-0 left-0 right-0 h-px" style={{ background: "linear-gradient(90deg, transparent, oklch(0.60 0.22 220 / 0.25), transparent)" }} />
      <div className="absolute bottom-0 left-0 right-0 h-px" style={{ background: "linear-gradient(90deg, transparent, oklch(0.60 0.22 220 / 0.15), transparent)" }} />

      <motion.div
        initial={{ opacity: 0 }}
        animate={isInView ? { opacity: 1 } : {}}
        transition={{ duration: 0.8 }}
        className="container"
      >
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="text-center text-xs text-muted-foreground/50 uppercase tracking-[0.2em] mb-8"
        >
          Market venues represented in the trading ecosystem
        </motion.p>

        <div className="flex flex-wrap items-center justify-center gap-4">
          {exchanges.map((ex, i) => (
            <motion.div
              key={ex.name}
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.15 + i * 0.08 }}
              className="group relative"
            >
              {/* Hover glow aura */}
              <motion.div
                className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                style={{
                  background: `radial-gradient(ellipse at center, ${ex.accent}22 0%, transparent 70%)`,
                }}
              />

              <div
                className="relative flex items-center gap-3 px-5 py-3.5 rounded-2xl border transition-all duration-300 group-hover:-translate-y-0.5 cursor-default"
                style={{
                  background: "linear-gradient(145deg, oklch(0.11 0.020 250 / 0.6), oklch(0.08 0.016 255 / 0.7))",
                  borderColor: "oklch(0.60 0.22 220 / 0.12)",
                }}
                onMouseEnter={(e) => {
                  if (prefersReduced) return;
                  const el = e.currentTarget;
                  el.style.borderColor = `${ex.accent}55`;
                  el.style.boxShadow = `0 0 30px ${ex.accent}15, 0 0 0 1px ${ex.accent}20 inset`;
                }}
                onMouseLeave={(e) => {
                  const el = e.currentTarget;
                  el.style.borderColor = "oklch(0.60 0.22 220 / 0.12)";
                  el.style.boxShadow = "none";
                }}
              >
                {/* Icon */}
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-300 group-hover:scale-110"
                  style={{
                    background: `${ex.accent}18`,
                    color: ex.accent,
                  }}
                >
                  {ex.icon}
                </div>
                {/* Name */}
                <span
                  className="text-sm font-heading font-semibold tracking-wide transition-all duration-300"
                  style={{ color: "oklch(0.60 0.02 240)" }}
                >
                  {ex.name}
                </span>
                {/* Hover arrow */}
                <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground/30 group-hover:text-muted-foreground/70 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </div>
            </motion.div>
          ))}
        </div>

        {/* Live counter */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : {}}
          transition={{ duration: 0.6, delay: 0.8 }}
          className="text-center mt-8"
        >
          <span
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-medium"
            style={{
              background: "oklch(0.74 0.18 145 / 0.08)",
              border: "1px solid oklch(0.74 0.18 145 / 0.2)",
              color: "oklch(0.74 0.18 145)",
            }}
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            Connection and execution availability depend on provider, venue, and account configuration
          </span>
        </motion.div>
      </motion.div>
    </section>
  );
}
