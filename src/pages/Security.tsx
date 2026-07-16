import { motion } from "framer-motion";
import { Link } from "wouter";
import {
  Shield, Lock, Key, HardDrive, Zap, Eye, AlertTriangle,
  CheckCircle2, XCircle, ArrowRight, Server, Wifi, RefreshCw
} from "lucide-react";

function fadeUp(delay = 0) {
  return {
    initial: { opacity: 0, y: 24 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true as const },
    transition: { duration: 0.55, delay },
  };
}

export default function Security() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <div className="border-b border-border/50 px-6 py-4 sticky top-0 z-40 bg-background/80 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer">
              <div className="w-8 h-8 rounded-xl bg-primary flex items-center justify-center font-bold text-primary-foreground text-sm">@</div>
              <span className="font-heading font-bold text-foreground">Anavitrade</span>
            </div>
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden sm:flex items-center gap-1.5 text-xs text-primary border border-primary/20 bg-primary/5 px-3 py-1.5 rounded-full">
              <Lock className="w-3 h-3" /> Non-Custodial · 256-bit Encrypted
            </span>
            <Link href="/onboarding/ledger">
              <button className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all">
                Get Started <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </Link>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-20">
        {/* Hero */}
        <motion.div {...fadeUp()} className="text-center mb-20">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-primary/20 bg-primary/5 text-primary text-sm font-medium mb-6">
            <Shield className="w-4 h-4" /> Security & Trust Model
          </div>
          <h1 className="text-4xl sm:text-5xl font-heading font-extrabold text-foreground mb-6 leading-tight">
            Your funds never leave<br />
            <span className="text-primary">your hardware wallet.</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Anavitrade is a signal router, not a custodian. We construct trade transactions and deliver them to your Ledger for review. Your device is the only thing that can sign and broadcast — if you don't press confirm, nothing happens.
          </p>
        </motion.div>

        {/* The Golden Rule */}
        <motion.div {...fadeUp(0.1)} className="p-8 rounded-3xl border border-primary/20 bg-primary/5 mb-16">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-2xl bg-primary/20 flex items-center justify-center shrink-0">
              <Shield className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-heading font-bold text-foreground mb-2">The Golden Rule</h2>
              <p className="text-muted-foreground leading-relaxed text-base">
                Anavitrade <strong className="text-foreground">never holds your private keys, seed phrase, or withdrawal permissions.</strong> We operate exclusively on trade-execution signals. Your Ledger hardware wallet remains the sole signing authority for every transaction — we are the messenger, not the bank.
              </p>
            </div>
          </div>
        </motion.div>

        {/* How the copytrade signal flow works */}
        <motion.div {...fadeUp(0.15)} className="mb-16">
          <h2 className="text-2xl font-heading font-bold text-foreground mb-2">How the Copytrade Signal Flow Works</h2>
          <p className="text-muted-foreground mb-8">Every trade follows this exact path — no exceptions, no shortcuts.</p>

          <div className="space-y-3">
            {[
              {
                step: "01",
                icon: <Server className="w-5 h-5" />,
                title: "Algo Signal Generated",
                desc: "Anavitrade's quantitative engine identifies a trade opportunity and constructs a signed signal payload with pair, side, size, stop-loss, and take-profit parameters.",
                color: "text-primary",
                bg: "bg-primary/10",
              },
              {
                step: "02",
                icon: <Wifi className="w-5 h-5" />,
                title: "Encrypted Routing",
                desc: "The signal is encrypted in transit over a TLS channel and routed to your registered wallet address. Only your wallet address is stored — never your private key.",
                color: "text-blue-400",
                bg: "bg-blue-400/10",
              },
              {
                step: "03",
                icon: <HardDrive className="w-5 h-5" />,
                title: "Transaction Appears on Your Ledger Screen",
                desc: "The full transaction details — asset, amount, direction, fees — are displayed on your Ledger's physical screen for your review before any signing occurs.",
                color: "text-amber-400",
                bg: "bg-amber-400/10",
              },
              {
                step: "04",
                icon: <CheckCircle2 className="w-5 h-5" />,
                title: "You Physically Approve",
                desc: "You press the physical confirm button on your Ledger device. Only then is the transaction signed and broadcast to the network. Reject it at any time — no consequences.",
                color: "text-primary",
                bg: "bg-primary/10",
              },
              {
                step: "05",
                icon: <Eye className="w-5 h-5" />,
                title: "Execution Confirmed & Logged",
                desc: "Once broadcast, the trade appears in your Anavitrade dashboard with full execution details, P&L, and audit trail. You retain full on-chain visibility at all times.",
                color: "text-purple-400",
                bg: "bg-purple-400/10",
              },
            ].map((item, i) => (
              <motion.div
                key={item.step}
                {...fadeUp(0.05 * i)}
                className="flex items-start gap-5 p-5 rounded-2xl bg-card border border-border/50 hover:border-border transition-colors"
              >
                <div className={`w-10 h-10 rounded-xl ${item.bg} flex items-center justify-center shrink-0 ${item.color}`}>
                  {item.icon}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-1">
                    <span className="text-xs font-mono text-muted-foreground">{item.step}</span>
                    <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* What Anavitrade can and cannot do */}
        <motion.div {...fadeUp(0.2)} className="mb-16">
          <h2 className="text-2xl font-heading font-bold text-foreground mb-2">What Anavitrade Can and Cannot Do</h2>
          <p className="text-muted-foreground mb-8">A precise breakdown of the permissions model.</p>

          <div className="grid md:grid-cols-2 gap-6">
            <div className="p-6 rounded-2xl bg-primary/5 border border-primary/20">
              <div className="flex items-center gap-2 mb-5">
                <CheckCircle2 className="w-5 h-5 text-primary" />
                <h3 className="font-semibold text-foreground">Anavitrade CAN</h3>
              </div>
              <ul className="space-y-3">
                {[
                  "Construct and route trade signal payloads to your wallet",
                  "Display trade details on your Ledger screen for review",
                  "Monitor open positions and portfolio performance",
                  "Pause signal routing instantly via the kill switch",
                  "Enforce your configured risk limits (max position size, daily loss cap)",
                  "Provide a full audit log of all signals dispatched",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <CheckCircle2 className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <div className="p-6 rounded-2xl bg-red-500/5 border border-red-500/20">
              <div className="flex items-center gap-2 mb-5">
                <XCircle className="w-5 h-5 text-red-400" />
                <h3 className="font-semibold text-foreground">Anavitrade CANNOT</h3>
              </div>
              <ul className="space-y-3">
                {[
                  "Access, store, or transmit your private key or seed phrase",
                  "Sign or broadcast any transaction without your physical approval",
                  "Withdraw funds from your wallet under any circumstances",
                  "Execute trades beyond your configured risk parameters",
                  "Override or bypass the kill switch once activated",
                  "Access any wallet functionality beyond trade execution",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </motion.div>

        {/* Kill Switch */}
        <motion.div {...fadeUp(0.25)} className="mb-16">
          <h2 className="text-2xl font-heading font-bold text-foreground mb-2">The Kill Switch</h2>
          <p className="text-muted-foreground mb-8">Your emergency stop — always one click away.</p>

          <div className="grid sm:grid-cols-3 gap-4">
            {[
              {
                icon: <Zap className="w-5 h-5" />,
                title: "Instant Halt",
                desc: "Activating the kill switch immediately stops all signal routing. No new trade signals will be dispatched to your wallet until you resume.",
                color: "text-primary",
                bg: "bg-primary/10",
              },
              {
                icon: <RefreshCw className="w-5 h-5" />,
                title: "Reversible at Any Time",
                desc: "The kill switch is not a permanent action. You can resume copytrade at any time from your dashboard with a single click.",
                color: "text-blue-400",
                bg: "bg-blue-400/10",
              },
              {
                icon: <AlertTriangle className="w-5 h-5" />,
                title: "Permanent Revocation",
                desc: "If you want to fully disconnect, wallet revocation removes your address from the system entirely. This cannot be undone — a fresh connection is required to restart.",
                color: "text-amber-400",
                bg: "bg-amber-400/10",
              },
            ].map((item) => (
              <div key={item.title} className="p-5 rounded-2xl bg-card border border-border/50">
                <div className={`w-10 h-10 rounded-xl ${item.bg} flex items-center justify-center mb-4 ${item.color}`}>
                  {item.icon}
                </div>
                <h3 className="text-sm font-semibold text-foreground mb-2">{item.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Risk Controls */}
        <motion.div {...fadeUp(0.3)} className="mb-16">
          <h2 className="text-2xl font-heading font-bold text-foreground mb-2">Configurable Risk Controls</h2>
          <p className="text-muted-foreground mb-8">Set hard limits that Anavitrade will never exceed — enforced server-side before any signal is dispatched.</p>

          <div className="grid sm:grid-cols-2 gap-4">
            {[
              {
                icon: <Key className="w-5 h-5 text-primary" />,
                title: "Maximum Position Size",
                desc: "Cap the maximum USD value of any single trade signal. No single position will ever exceed your configured threshold.",
              },
              {
                icon: <AlertTriangle className="w-5 h-5 text-amber-400" />,
                title: "Daily Loss Limit",
                desc: "Set a maximum daily drawdown percentage. If the portfolio crosses this threshold, signal routing is automatically suspended until the next trading day.",
              },
              {
                icon: <Shield className="w-5 h-5 text-blue-400" />,
                title: "Trade-Only Permissions",
                desc: "Your API wallet connection is scoped exclusively to trade execution. Withdrawal, transfer, and account-management permissions are never requested.",
              },
              {
                icon: <Eye className="w-5 h-5 text-purple-400" />,
                title: "Full Audit Trail",
                desc: "Every signal dispatched, every kill switch toggle, and every revocation event is logged with timestamp and IP address for your review.",
              },
            ].map((item) => (
              <div key={item.title} className="flex items-start gap-4 p-5 rounded-2xl bg-card border border-border/50">
                <div className="w-9 h-9 rounded-xl bg-card border border-border flex items-center justify-center shrink-0">
                  {item.icon}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-1">{item.title}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Safe Operating Rules */}
        <motion.div {...fadeUp(0.35)} className="mb-16 p-8 rounded-3xl border border-border/50 bg-card">
          <h2 className="text-xl font-heading font-bold text-foreground mb-6">Safe Operating Rules</h2>
          <div className="space-y-4">
            {[
              { rule: "Never share your seed phrase with anyone — including Anavitrade support. We will never ask for it.", critical: true },
              { rule: "Never share your private key. Anavitrade only requires your public wallet address for signal routing.", critical: true },
              { rule: "Review every transaction on your Ledger screen before pressing confirm. Check the asset, amount, and direction.", critical: true },
              { rule: "Start with conservative risk settings. Use the max position size and daily loss limit controls during your first month.", critical: false },
              { rule: "Keep your Ledger firmware updated. Security patches are released regularly by Ledger — always run the latest version.", critical: false },
              { rule: "Use the kill switch if you are travelling, offline for extended periods, or uncertain about market conditions.", critical: false },
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${item.critical ? "bg-red-500/10" : "bg-primary/10"}`}>
                  {item.critical
                    ? <AlertTriangle className="w-3 h-3 text-red-400" />
                    : <CheckCircle2 className="w-3 h-3 text-primary" />}
                </div>
                <p className={`text-sm leading-relaxed ${item.critical ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                  {item.rule}
                </p>
              </div>
            ))}
          </div>
        </motion.div>

        {/* CTA */}
        <motion.div {...fadeUp(0.4)} className="text-center py-12 rounded-3xl border border-primary/20 bg-primary/5">
          <h2 className="text-2xl font-heading font-bold text-foreground mb-3">Ready to get started?</h2>
          <p className="text-muted-foreground mb-8 max-w-md mx-auto">
            Connect your Ledger Nano and start the guided onboarding wizard. Your funds stay on your device — always.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/onboarding/ledger">
              <button className="flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-all">
                Connect Ledger <ArrowRight className="w-4 h-4" />
              </button>
            </Link>
            <Link href="/">
              <button className="px-6 py-3 rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-card transition-all font-medium">
                Back to Home
              </button>
            </Link>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
