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
  { q: "What is Anavitrade?", a: "Anavitrade is a non-custodial market-intelligence platform. You can explore signals and research in the dashboard, then authorize capped Aster mainnet execution for pilot tester accounts." },
  { q: "Can Anavitrade trade for me today?", a: "Yes, for approved pilot accounts that complete Aster authorization. Live order submission is enabled with capped tester sizing and risk controls." },
  { q: "Is my money safe?", a: "Anavitrade does not custody customer funds, request seed phrases, or request withdrawal permissions. Trading remains risky, and signals are not a guarantee of profit. Always review any action you choose to take." },
  { q: "Do I need to know anything about trading?", a: "You should understand the risks before trading. The dashboard is designed to make the research and risk context easier to review, but it does not replace your own decision-making or guarantee an outcome." },
  { q: "Can I try it before using real money?", a: "Yes. Create a free account to explore the dashboard and signal research. Aster authorization is separate, and live order sizing is capped for the pilot." },
  { q: "What is an API key?", a: "It is a credential an exchange can use to authorize trading permissions. Anavitrade does not request withdrawal permissions. Live API execution is limited to configured trade-only connections and pilot caps." },
  { q: "What if I use a Ledger hardware wallet?", a: "The wallet-based Aster authorization flow supports hardware wallets. Your seed phrase never leaves your device, and live pilot execution stays behind account authorization and risk controls." },
  { q: "What happens when the market gets crazy?", a: "The research and execution layers include risk controls and a kill switch, but no control can eliminate market risk. Pilot automation can be halted globally or per account." },
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
