import { Link } from "wouter";
import { motion } from "framer-motion";
import { ArrowRight, ChevronDown } from "lucide-react";
import { useState } from "react";
import HeroWidget from "@/components/HeroWidget";
import TypewriterHeading from "@/components/TypewriterHeading";
import { trpc } from "@/lib/trpc";
import { formatSignedPercent, UNAVAILABLE } from "@/components/performancePresentation";

/* ─── HERO ───
   Extracted verbatim from Home.tsx. The user loves this section — do NOT
   restyle. It stays byte-for-byte identical to the original implementation. */
export default function HeroSection() {
  const { data: stats } = trpc.signals.stats.useQuery();
  const { data: demoStats } = trpc.demo.getPublicDemoStats.useQuery();
  const [typingDone, setTypingDone] = useState(false);

  return (
    <section className="relative min-h-screen flex items-center pt-20 overflow-hidden">
      {/* Video background layer */}
      <video
        autoPlay muted loop playsInline
        className="absolute inset-0 w-full h-full object-cover opacity-40"
        style={{ objectPosition: "70% center" }}
        src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260622_204221_5339e40b-e73d-4ab0-9c65-79c18c66fd50.mp4"
      />

      {/* Ethereal azure background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* Mesh grid */}
        <div className="absolute inset-0 mesh-grid opacity-60" />
        {/* Primary azure orb — top left */}
        <div className="orb-azure" style={{ width: 700, height: 700, top: "-15%", left: "-10%" }} />
        {/* Cyan orb — bottom right */}
        <div className="orb-cyan" style={{ width: 600, height: 600, bottom: "-10%", right: "-5%" }} />
        {/* Small azure accent — center right */}
        <div className="orb-azure" style={{ width: 300, height: 300, top: "40%", right: "20%", opacity: 0.6 }} />
        {/* Scan line */}
        <div className="absolute left-0 right-0 h-px animate-scan"
          style={{ background: "linear-gradient(90deg, transparent, oklch(0.60 0.22 220 / 0.15), transparent)" }} />
      </div>

      <div className="container relative z-10">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-8 items-center">
          {/* Left: Copy */}
          <motion.div
            initial={{ opacity: 0, x: -40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, ease: [0.23, 1, 0.32, 1] }}
          >
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.6 }}
              className="inline-flex items-center gap-2.5 pl-3 pr-4 py-1.5 mb-9"
              style={{
                border: "1px solid oklch(1 0 0 / 0.10)",
                background: "oklch(1 0 0 / 0.03)",
                borderRadius: "100px",
                backdropFilter: "blur(12px)",
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "oklch(0.72 0.20 195)", boxShadow: "0 0 8px oklch(0.72 0.20 195 / 0.8)" }} />
              <span className="text-[0.7rem] font-medium tracking-[0.18em] uppercase" style={{ color: "oklch(0.75 0.02 240)", fontFamily: "var(--font-heading)" }}>Signals &amp; Automated Trading</span>
            </motion.div>

            {/* Typewriter — authentic Anavitrade copy, swaps to static display when done.
                Light weight (500) + soft arctic gradient = premium, not "AI-bold". */}
            {typingDone ? (
              <h1 className="text-[2.75rem] sm:text-6xl lg:text-[5.25rem] font-heading font-medium leading-[0.98] tracking-[-0.04em] mb-7">
                <span className="text-arctic">Simple and<br />Secure</span><br />
                <span style={{ color: "oklch(0.98 0.004 220)" }}>Quantitative<br />Trading</span>
              </h1>
            ) : (
              <TypewriterHeading
                segments={[
                  { text: "Simple and\nSecure\n", color: "transparent" },
                  { text: "Quantitative\nTrading", color: "oklch(0.98 0.004 220)" },
                ]}
                speed={35}
                delay={300}
                onDone={() => setTypingDone(true)}
                className="text-[2.75rem] sm:text-6xl lg:text-[5.25rem] font-medium leading-[0.98] tracking-[-0.04em] mb-7"
              />
            )}

            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4, duration: 0.6 }}
              className="text-lg leading-relaxed max-w-lg mb-10"
              style={{ color: "oklch(0.72 0.02 240)" }}
            >
              Review scored trade signals from our quantitative engine, or configure execution on a supported venue when execution is available and explicitly enabled.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6, duration: 0.6 }}
              className="flex flex-wrap gap-3.5"
            >
              <Link href="/demo">
                <button className="btn-hairline group h-[3.4rem] px-8 text-[0.95rem]">
                  View Live Demo
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                </button>
              </Link>
              <a href="#about">
                <button className="btn-obsidian h-[3.4rem] px-8 text-[0.95rem]">
                  Learn More
                </button>
              </a>
            </motion.div>

            {/* Stats row — live from DB. Quiet, light-weight, one gold accent only. */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1, duration: 0.8 }}
              className="grid grid-cols-3 gap-3 sm:gap-10 mt-14 pt-8"
              style={{ borderTop: "1px solid oklch(1 0 0 / 0.06)" }}
            >
              <div className="min-w-0">
                <p className="text-xl sm:text-[1.75rem] font-heading font-medium break-words" style={{ color: "oklch(0.98 0.004 220)" }}>
                  {stats?.totalSignals != null ? Number(stats.totalSignals).toLocaleString() : UNAVAILABLE}
                </p>
                <p className="text-xs mt-1" style={{ color: "oklch(0.6 0.02 240)" }}>Signals Scored</p>
              </div>
              <div className="min-w-0">
                <p className="text-xl sm:text-[1.75rem] font-heading font-medium break-words gold-shimmer-text">
                  {Number(demoStats?.tradeCount ?? 0) > 0 ? formatSignedPercent(demoStats?.totalReturnPct) : UNAVAILABLE}
                </p>
                <p className="text-xs mt-1" style={{ color: "oklch(0.6 0.02 240)" }}>Modeled July Scenario</p>
              </div>
              <div className="min-w-0">
                <p className="text-xl sm:text-[1.75rem] font-heading font-medium break-words" style={{ color: "oklch(0.98 0.004 220)" }}>
                  {Number(demoStats?.tradeCount ?? 0) > 0 ? formatSignedPercent(demoStats?.bestPnlPct) : UNAVAILABLE}
                </p>
                <p className="text-xs mt-1" style={{ color: "oklch(0.6 0.02 240)" }}>Largest Modeled Move</p>
              </div>
            </motion.div>

            {/* Simulated data disclaimer */}
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1.2, duration: 0.6 }}
              className="text-[10px] text-muted-foreground/40 mt-4 text-left"
            >
              Modeled historical scenario based on recorded signals. Past results do not predict future performance.
            </motion.p>
          </motion.div>

          {/* Right: iPhone Widget on a realistic float shadow */}
          <div className="flex justify-center lg:justify-end">
            <div className="shadow-float rounded-[44px]">
              <HeroWidget />
            </div>
          </div>
        </div>
      </div>

      {/* Scroll indicator */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.5 }}
        className="absolute bottom-8 left-1/2 -translate-x-1/2"
      >
        <motion.div
          animate={{ y: [0, 8, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          <ChevronDown className="w-5 h-5 text-muted-foreground/50" />
        </motion.div>
      </motion.div>
    </section>
  );
}
