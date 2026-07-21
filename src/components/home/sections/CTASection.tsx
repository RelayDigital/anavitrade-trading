import { useRef, useMemo } from "react";
import { Link } from "wouter";
import { motion, useScroll, useTransform, useReducedMotion } from "framer-motion";
import { ArrowRight, Sparkles } from "lucide-react";
import { useSectionInView } from "../hooks/useSectionInView";

/* ─── CTA (upgraded) ───
   Dramatic cinematic CTA with drifting gradient orbs, floating particle
   field, and parallax-aware glow that follows scroll. The final push. */
export default function CTASection() {
  const { ref, isInView } = useSectionInView();
  const prefersReduced = useReducedMotion();
  const innerRef = useRef<HTMLDivElement>(null);

  // Subtle scroll-responsive glow shift
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const glowX = useTransform(scrollYProgress, [0, 1], prefersReduced ? [50, 50] : [30, 70]);

  // Stable particle positions — deterministic IDs so particles persist across renders
  const particles = useMemo(() =>
    Array.from({ length: 20 }, (_, i) => ({
      id: i,
      x: ((i * 137.5 + 42) % 100),
      y: ((i * 97.3 + 13) % 100),
      size: 1.5 + ((i * 7) % 4),
      delay: (i * 0.27) % 4,
      duration: 3 + ((i * 1.3) % 4),
    })),
  []);

  return (
    <section className="py-28 relative overflow-hidden" ref={ref}>
      <div className="container">
        <motion.div
          ref={innerRef}
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.7, ease: [0.23, 1, 0.32, 1] }}
          className="relative rounded-3xl p-12 md:p-16 text-center overflow-hidden"
          style={{
            background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.88), oklch(0.09 0.018 255 / 0.94))",
            border: "1px solid oklch(0.60 0.22 220 / 0.20)",
            boxShadow: "0 0 0 1px oklch(0.60 0.22 220 / 0.06) inset, 0 0 80px oklch(0.60 0.22 220 / 0.08), 0 20px 60px oklch(0.07 0.015 255 / 0.5)",
            backdropFilter: "blur(24px)",
          }}
        >
          {/* Particle field */}
          {!prefersReduced && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              {particles.map((p) => (
                <motion.div
                  key={p.id}
                  className="absolute rounded-full"
                  style={{
                    left: `${p.x}%`,
                    top: `${p.y}%`,
                    width: p.size,
                    height: p.size,
                    background: "oklch(0.72 0.20 195 / 0.5)",
                    boxShadow: "0 0 4px oklch(0.72 0.20 195 / 0.4)",
                  }}
                  animate={{
                    y: [0, -15, 0],
                    opacity: [0.3, 0.8, 0.3],
                  }}
                  transition={{
                    duration: p.duration,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: p.delay,
                  }}
                />
              ))}
            </div>
          )}

          {/* Drifting gradient glow — follows scroll */}
          <motion.div
            className="absolute inset-0 pointer-events-none overflow-hidden rounded-3xl"
            style={{ x: useTransform(glowX, (v) => `${v - 50}%`) }}
          >
            <div
              className="absolute top-0 left-1/2 w-[600px] h-[250px] rounded-full blur-[100px]"
              style={{ background: "oklch(0.60 0.22 220 / 0.10)", x: "-50%" }}
            />
            <div
              className="absolute bottom-0 right-0 w-[300px] h-[200px] rounded-full blur-[80px]"
              style={{ background: "oklch(0.72 0.20 195 / 0.06)" }}
            />
            <div className="absolute top-0 left-0 right-0 h-px" style={{ background: "linear-gradient(to right, transparent, oklch(0.60 0.22 220 / 0.30), transparent)" }} />
          </motion.div>

          {/* Content */}
          <div className="relative z-10">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={isInView ? { opacity: 1, scale: 1 } : {}}
              transition={{ duration: 0.6, delay: 0.15 }}
            >
              <Sparkles className="w-8 h-8 mx-auto mb-6" style={{ color: "oklch(0.72 0.20 195 / 0.4)" }} />
            </motion.div>

            <h2 className="text-4xl sm:text-5xl font-heading font-medium tracking-[-0.035em] text-foreground mb-4">
              Start receiving signals today
            </h2>
            <p className="text-muted-foreground max-w-md mx-auto mb-8">
              Create a free account to explore market signals and research. Aster mainnet execution is enabled for the controlled pilot with capped tester order sizing.
            </p>
            <div className="flex flex-wrap gap-3.5 justify-center">
              <Link href="/register">
                <motion.button
                  whileHover={prefersReduced ? {} : { scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="group inline-flex items-center gap-2 h-[3.6rem] px-9 rounded-[100px] text-[1.02rem] font-medium transition-shadow"
                  style={{
                    fontFamily: "var(--font-heading)",
                    color: "oklch(0.14 0.02 255)",
                    background: "var(--grad-arctic)",
                    boxShadow: "inset 0 1px 0 oklch(1 0 0 / 0.4), 0 4px 24px oklch(0.72 0.20 195 / 0.22)",
                  }}
                >
                  Create Free Account
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-0.5 transition-transform" />
                </motion.button>
              </Link>
              <Link href="/login">
                <motion.button
                  whileHover={prefersReduced ? {} : { scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="btn-hairline h-[3.6rem] px-9 text-[1.02rem]"
                >
                  Sign In
                </motion.button>
              </Link>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
