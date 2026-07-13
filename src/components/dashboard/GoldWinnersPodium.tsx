import { motion, AnimatePresence } from "framer-motion";
import { Trophy } from "lucide-react";

interface TopWinnerSignal {
  id?: number;
  marketName?: string;
  indicatorName?: string | null;
  period?: string;
  percentage24?: string | number | null;
  price?: string | number;
  maxProfit?: string | number | null;
  maxProfitDuration?: string | null;
}

interface GoldWinnersPodiumProps {
  topWinners: TopWinnerSignal[];
  fmtPrice: (p: number) => string;
}

const rankMedals = ["🥇", "🥈", "🥉"];

export default function GoldWinnersPodium({ topWinners, fmtPrice }: GoldWinnersPodiumProps) {
  return (
    <AnimatePresence>
      {topWinners.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
          className="mb-6"
        >
          <div className="relative rounded-2xl border border-gold-30 overflow-hidden bg-gradient-to-r from-card via-gold-10/10 to-card">
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[400px] h-[100px] rounded-full blur-[60px] bg-gold/10" />
            </div>
            <div className="relative z-10 p-6">
              <div className="flex items-center gap-2 mb-5">
                <Trophy className="w-4 h-4 trophy-pulse text-gold" />
                <h3 className="text-sm font-semibold text-foreground">Top Movers</h3>
                <span className="text-xs text-muted-foreground">— biggest Buy signals by 24h gain</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {topWinners.map((sig, i) => {
                  const pct = parseFloat(String(sig.percentage24));
                  const price = parseFloat(String(sig.price));
                  const pair = sig.marketName.replace("USDT", "/USDT");
                  const maxP = sig.maxProfit != null ? parseFloat(String(sig.maxProfit)) : null;
                  const dur = sig.maxProfitDuration;
                  return (
                    <motion.div
                      key={`winner-${sig.id}-${i}`}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: i * 0.08, duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
                      className="relative rounded-xl p-4 border"
                      style={i === 0 ? {
                        background: "linear-gradient(135deg, oklch(0.82 0.16 85 / 0.10), oklch(0.82 0.16 85 / 0.04))",
                        borderColor: "oklch(0.82 0.16 85 / 0.35)",
                        boxShadow: "0 0 0 1px oklch(0.82 0.16 85 / 0.15), 0 0 20px oklch(0.82 0.16 85 / 0.10)",
                      } : { background: "oklch(0.15 0.014 260)", borderColor: "oklch(0.24 0.015 260 / 0.4)" }}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <span className={`text-lg ${i === 0 ? "trophy-pulse inline-block" : ""}`}>{rankMedals[i]}</span>
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                          style={i === 0 ? { background: "oklch(0.82 0.16 85 / 0.15)", color: "oklch(0.82 0.16 85)" } : { background: "oklch(0.78 0.19 155 / 0.10)", color: "oklch(0.78 0.19 155)" }}>
                          +{pct.toFixed(2)}%
                        </span>
                      </div>
                      <div className={`font-mono font-bold text-base mb-1 ${i === 0 ? "gold-shimmer-text" : "text-foreground"}`}>{pair}</div>
                      <div className="text-xs text-muted-foreground mb-2">{sig.indicatorName} · {sig.period}</div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-mono text-foreground/70">${fmtPrice(price)}</span>
                        {maxP != null && (
                          <span className="font-semibold" style={{ color: "oklch(0.82 0.16 85)" }}>
                            +{maxP.toFixed(2)}% {dur ? `in ${dur}` : ""}
                          </span>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
