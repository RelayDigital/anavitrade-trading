import { Link } from "wouter";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, MessageCircle, Search, Maximize2, Minimize2 } from "lucide-react";
import { useState } from "react";
import Reveal from "../primitives/Reveal";
import { cappedDelay } from "../hooks/motion";

/* ─── FAQ ───
   Two-column editorial: a sticky "Questions?" heading + support CTA on the
   left, the accordion on the right. Plain-language answers, readable width. */
const FAQS = [
  { q: "What is Anavitrade?", a: "It's a trading platform that spots opportunities in the crypto market for you. You can simply receive the alerts and trade by hand, or switch on automation and let it place the trades for you — your choice." },
  { q: "What's the difference between the two tiers?", a: "Signal Delivery sends you clear Buy/Sell/Hold alerts and you decide what to do. Automated Trades connects to your account and does it all for you — how much to buy, when to take profit, and when to cut a loss." },
  { q: "Is my money safe?", a: "Yes. We can place trades but can never withdraw or move your funds — they never leave your own account. Everything sensitive is encrypted, and you can switch us off at any time." },
  { q: "Do I need to know anything about trading?", a: "No. That's the point. The engine handles the analysis and the discipline. You just choose how hands-on you want to be and watch it work from your dashboard." },
  { q: "Can I try it before using real money?", a: "Absolutely. Create a free account and explore the live signal feed and demo dashboard right away — no exchange connection and no card required." },
  { q: "What is an API key?", a: "It's a secure permission slip from your exchange that lets Anavitrade place trades on your behalf. You control what it can do — we only ever ask for trade access, never withdrawal access." },
  { q: "What if I use a Ledger hardware wallet?", a: "Fully supported. Your Ledger keeps your keys, we only get trade-only access, and your seed phrase never leaves your device. You can revoke access anytime from your own account." },
  { q: "What happens when the market gets crazy?", a: "The engine has built-in safety logic that shrinks position sizes or pauses trading during abnormal, high-risk conditions — helping protect you from flash crashes." },
];

export default function FAQSection() {
  const [expandedQuestions, setExpandedQuestions] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  const allExpanded = expandedQuestions.size === FAQS.length;

  const filteredFaqs = searchQuery.trim()
    ? FAQS.filter(faq => {
        const q = searchQuery.toLowerCase();
        return faq.q.toLowerCase().includes(q) || faq.a.toLowerCase().includes(q);
      })
    : FAQS;

  const toggleItem = (question: string) => {
    setExpandedQuestions(prev => {
      const next = new Set(prev);
      if (next.has(question)) next.delete(question);
      else next.add(question);
      return next;
    });
  };

  const toggleAll = () => {
    setExpandedQuestions(prev =>
      prev.size === FAQS.length
        ? new Set()
        : new Set(FAQS.map(f => f.q))
    );
  };

  const noResults = searchQuery.trim() && filteredFaqs.length === 0;

  return (
    <section id="faq" className="py-32 relative">
      <div className="container">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16">
          {/* Left: sticky heading + support */}
          <div className="lg:col-span-4">
            <div className="lg:sticky lg:top-28">
              <Reveal y={16} duration={0.5}>
                <span className="text-[0.7rem] font-medium tracking-[0.18em] uppercase text-electric mb-4 block">Support</span>
              </Reveal>
              <Reveal y={24} delay={0.05}>
                <h2 className="text-5xl sm:text-6xl lg:text-7xl font-heading font-medium tracking-[-0.035em] text-foreground mb-6 leading-tight">
                  Questions?
                </h2>
              </Reveal>
              <Reveal y={20} delay={0.1}>
                <p className="text-muted-foreground leading-relaxed mb-8 max-w-xs">
                  The short answers are here. Still unsure about something? We're happy to help.
                </p>
              </Reveal>
              <Reveal delay={0.15}>
                <Link href="/register">
                  <button className="btn-hairline h-11 px-5 text-sm">
                    <MessageCircle className="w-4 h-4" />
                    Talk to us
                  </button>
                </Link>
              </Reveal>
            </div>
          </div>

          {/* Right: accordion */}
          <div className="lg:col-span-8 space-y-3">
            {/* Search + Expand/Collapse controls */}
            <div className="flex items-center gap-3 mb-4">
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search FAQs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full h-10 pl-10 pr-4 text-sm bg-white/[0.03] border border-border/50 rounded-xl text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/30 focus:bg-white/[0.05] transition-colors"
                />
              </div>
              <button
                onClick={toggleAll}
                className="btn-hairline h-10 px-4 text-xs shrink-0 flex items-center gap-2"
              >
                {allExpanded ? (
                  <>
                    <Minimize2 className="w-3.5 h-3.5" />
                    Collapse All
                  </>
                ) : (
                  <>
                    <Maximize2 className="w-3.5 h-3.5" />
                    Expand All
                  </>
                )}
              </button>
            </div>

            {noResults ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No FAQs match your search. Try a different keyword.
              </p>
            ) : (
              filteredFaqs.map((faq, i) => (
                <Reveal key={faq.q} delay={cappedDelay(i, 0.05)}>
                  <FAQItem
                    question={faq.q}
                    answer={faq.a}
                    open={expandedQuestions.has(faq.q)}
                    onToggle={() => toggleItem(faq.q)}
                  />
                </Reveal>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function FAQItem({ question, answer, open, onToggle }: { question: string; answer: string; open: boolean; onToggle: () => void }) {
  return (
    <div className={`border rounded-xl overflow-hidden transition-colors duration-200 ${open ? "border-primary/20 bg-white/[0.02]" : "border-border/50 hover:border-border"}`}>
      <button onClick={onToggle} className="w-full flex items-center justify-between p-5 text-left" aria-expanded={open}>
        <span className="text-sm font-medium text-foreground pr-4">{question}</span>
        <motion.div animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}>
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="answer"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <p className="px-5 pb-5 text-sm text-muted-foreground leading-relaxed max-w-2xl">{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
