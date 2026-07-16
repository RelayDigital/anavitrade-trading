import { motion, useReducedMotion } from "framer-motion";
import { trpc } from "@/lib/trpc";

/* ─── SIGNAL TICKER ─── */
export default function SignalTicker() {
  const { data } = trpc.signals.topBangers.useQuery({ limit: 12 });
  const bangers = data ?? [];
  const prefersReduced = useReducedMotion();

  // Duplicate for seamless loop
  const items = [...bangers, ...bangers];

  if (bangers.length === 0) return null;

  return (
    <div className="relative overflow-hidden border-y py-3" style={{ borderColor: "oklch(0.60 0.22 220 / 0.18)", background: "oklch(0.60 0.22 220 / 0.03)" }}>
      {/* Top hairline glow */}
      <div className="absolute top-0 left-0 right-0 h-px" style={{ background: "linear-gradient(90deg, transparent, oklch(0.72 0.20 195 / 0.4), transparent)" }} />
      {/* Fade edges */}
      <div className="absolute left-0 top-0 bottom-0 w-24 z-20 pointer-events-none" style={{ background: "linear-gradient(to right, oklch(0.07 0.015 255), transparent)" }} />
      <div className="absolute right-0 top-0 bottom-0 w-20 z-10 pointer-events-none" style={{ background: "linear-gradient(to left, oklch(0.07 0.015 255), transparent)" }} />

      {/* LIVE chip */}
      <div className="absolute left-3 top-1/2 -translate-y-1/2 z-30 hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full" style={{ background: "oklch(0.07 0.015 255)", border: "1px solid oklch(0.72 0.18 145 / 0.3)" }}>
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-70" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
        </span>
        <span className="text-[9px] font-bold tracking-widest uppercase" style={{ color: "oklch(0.74 0.18 145)" }}>Live</span>
      </div>

      <motion.div
        className="flex gap-8 whitespace-nowrap"
        animate={prefersReduced ? undefined : { x: ["0%", "-50%"] }}
        transition={prefersReduced ? undefined : { duration: 35, repeat: Infinity, ease: "linear" }}
      >
        {items.map((s, i) => (
          <div key={i} className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-bold tracking-wide" style={{ color: "oklch(0.77 0.17 220)", fontFamily: "var(--font-heading)" }}>
              {s.marketName.replace("USDT", "/USDT")}
            </span>
            <span className="text-xs font-semibold" style={{ color: "oklch(0.72 0.20 195)" }}>
              +{Number(s.maxProfit).toFixed(1)}%
            </span>
            <span className="text-[10px] text-muted-foreground/50">{s.indicatorShortName} · {s.period}</span>
            <span className="text-muted-foreground/20 text-xs">·</span>
          </div>
        ))}
      </motion.div>
      <p className="text-[9px] text-muted-foreground/30 text-center mt-1">Simulated signals. Past results don't guarantee future ones.</p>
    </div>
  );
}
