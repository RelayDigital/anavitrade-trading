import { useState, useEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Quote } from "lucide-react";
import SectionHeader from "../primitives/SectionHeader";
import Reveal from "../primitives/Reveal";

const testimonials = [
  {
    quote: "The automation trades for me and handles the scary days far better than I ever could by hand. I stopped losing sleep over market dumps. Support has been genuinely excellent too.",
    author: "Noah",
    role: "Crypto Investor",
    metric: "+34% in 6 months",
  },
  {
    quote: "It completely changed how I approach crypto. The discipline is the part I couldn't do myself — it just follows the plan, every time. Steady, calm growth since I connected my account.",
    author: "Sarah",
    role: "Day Trader",
    metric: "Running 14 months",
  },
  {
    quote: "I run a business and have zero time for charts. I set it up once and check the dashboard when I feel like it. That's the whole relationship — exactly what I wanted.",
    author: "Marcus",
    role: "Business Owner",
    metric: "Fully hands-off",
  },
];

const ROTATE_MS = 6000;

/* ── Staggered entrance variants for supporting cards ── */
const cardVariants = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: i * 0.12,
      duration: 0.5,
      ease: [0.23, 1, 0.32, 1] as const,
    },
  }),
};

/* ─── TESTIMONIALS ───
   Editorial: one large primary quote plus selectable supporting cards, with a
   quiet progress hairline instead of a generic dots carousel. */
export default function TestimonialsSection() {
  const [active, setActive] = useState(0);
  const prefersReduced = useReducedMotion();

  useEffect(() => {
    if (prefersReduced) return;
    const t = setInterval(() => setActive((a) => (a + 1) % testimonials.length), ROTATE_MS);
    return () => clearInterval(t);
  }, [prefersReduced]);

  return (
    <section id="testimonials" className="py-32 relative section-divider">
      {/* ── Background glow / orb behind the active testimonial ── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <AnimatePresence>
          <motion.div
            key={`glow-${active}`}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="absolute top-[45%] left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full"
            style={{
              background:
                "radial-gradient(ellipse, oklch(0.60 0.22 220 / 0.10) 0%, oklch(0.50 0.18 230 / 0.05) 40%, transparent 70%)",
            }}
          />
        </AnimatePresence>
      </div>

      <div className="container relative z-10">
        <SectionHeader align="center" eyebrow="Community" title="People who let it trade for them" className="mb-14" />

        <div className="max-w-4xl mx-auto">
          {/* ── Primary quote ── */}
          <Reveal>
            <div className="relative p-8 sm:p-12 rounded-3xl glass glow-border overflow-hidden">
              <Quote className="w-9 h-9 text-primary/20 mb-6" />
              <AnimatePresence mode="wait">
                <motion.div
                  key={active}
                  initial={{
                    opacity: 0,
                    y: 20,
                    scale: prefersReduced ? 1 : 0.96,
                  }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{
                    opacity: 0,
                    y: -20,
                    scale: prefersReduced ? 1 : 1.02,
                  }}
                  transition={{ duration: 0.45, ease: [0.23, 1, 0.32, 1] }}
                >
                  <p className="text-foreground/90 text-xl sm:text-2xl leading-relaxed font-heading font-medium tracking-[-0.01em] mb-8 min-h-[96px]">
                    {"“"}
                    {testimonials[active].quote}
                    {"”"}
                  </p>
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-full bg-primary/20 flex items-center justify-center">
                      <span className="text-primary font-semibold">{testimonials[active].author[0]}</span>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{testimonials[active].author}</p>
                      <p className="text-xs text-muted-foreground">{testimonials[active].role}</p>
                    </div>
                    <span className="ml-auto text-xs font-mono text-primary/80 bg-primary/5 px-3 py-1.5 rounded-full">
                      {testimonials[active].metric}
                    </span>
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>
          </Reveal>

          {/* Disclaimer */}
          <p className="text-xs text-muted-foreground/50 text-center mt-4 max-w-lg mx-auto">
            Testimonials reflect individual experiences and are not guaranteed, representative, or indicative of future performance or returns. Results shown are from simulated trading. Trading involves risk of loss.
          </p>

          {/* ── Selectable supporting cards with staggered reveal ── */}
          <motion.div
            className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4"
            initial={prefersReduced ? undefined : "hidden"}
            whileInView={prefersReduced ? undefined : "visible"}
            viewport={{ once: true, margin: "-40px" }}
          >
            {testimonials.map((t, i) => (
              <motion.button
                key={t.author}
                custom={i}
                variants={prefersReduced ? undefined : cardVariants}
                onClick={() => setActive(i)}
                aria-pressed={active === i}
                aria-label={`Show testimonial from ${t.author}`}
                className="text-left p-4 rounded-2xl border transition-all duration-300 relative overflow-hidden"
                style={
                  active === i
                    ? {
                        background: "oklch(0.60 0.22 220 / 0.08)",
                        borderColor: "oklch(0.60 0.22 220 / 0.35)",
                      }
                    : {
                        background: "oklch(0.10 0.018 250 / 0.6)",
                        borderColor: "oklch(0.20 0.025 240)",
                      }
                }
              >
                <p className="text-sm font-semibold text-foreground">{t.author}</p>
                <p className="text-[11px] text-muted-foreground mb-2">{t.role}</p>
                <p className="text-[11px] font-mono" style={{ color: "oklch(0.72 0.16 220)" }}>
                  {t.metric}
                </p>
                {/* Progress hairline on the active card */}
                {active === i && !prefersReduced && (
                  <motion.div
                    key={`bar-${active}`}
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: ROTATE_MS / 1000, ease: "linear" }}
                    className="absolute bottom-0 left-0 right-0 h-0.5 origin-left"
                    style={{ background: "oklch(0.60 0.22 220)" }}
                  />
                )}
                {/* Pulsing glow ring on the active card */}
                {active === i && !prefersReduced && (
                  <motion.div
                    className="absolute inset-0 rounded-2xl pointer-events-none"
                    animate={{
                      boxShadow: [
                        "inset 0 0 0px oklch(0.60 0.22 220 / 0)",
                        "inset 0 0 16px oklch(0.60 0.22 220 / 0.18)",
                        "inset 0 0 0px oklch(0.60 0.22 220 / 0)",
                      ],
                    }}
                    transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
              </motion.button>
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  );
}
