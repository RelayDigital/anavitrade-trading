import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "wouter";
import {
  Shield, Lock, Zap, CheckCircle2, ChevronRight, ChevronLeft,
  HardDrive, Cpu, ArrowRight, Wifi, XCircle,
  TrendingUp, RefreshCw, Server, Smartphone
} from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import WalletConnectModal from "@/components/WalletConnectModal";

const steps = [
  { id: 1, title: "How It Works", subtitle: "The copytrade architecture" },
  { id: 2, title: "Your Security", subtitle: "What we can and cannot do" },
  { id: 3, title: "Risk Controls", subtitle: "You set the limits" },
  { id: 4, title: "Connect Wallet", subtitle: "Link your Ledger Nano" },
];

const architectureFlow = [
  {
    icon: <TrendingUp className="w-5 h-5" />,
    label: "Algo Signal",
    desc: "Anavitrade's quant engine generates a trade signal",
    color: "text-primary",
    bg: "oklch(0.60 0.22 220 /  0.1)",
    border: "oklch(0.60 0.22 220 /  0.2)",
  },
  {
    icon: <Server className="w-5 h-5" />,
    label: "Signal Router",
    desc: "Signal is encrypted and routed to your registered wallet address",
    color: "text-blue-400",
    bg: "rgba(59,130,246,0.1)",
    border: "rgba(59,130,246,0.2)",
  },
  {
    icon: <HardDrive className="w-5 h-5" />,
    label: "Your Ledger",
    desc: "Transaction appears on your Ledger screen for review",
    color: "text-white",
    bg: "rgba(255,255,255,0.08)",
    border: "rgba(255,255,255,0.15)",
  },
  {
    icon: <CheckCircle2 className="w-5 h-5" />,
    label: "Your Approval",
    desc: "You physically press confirm on the hardware device",
    color: "text-primary",
    bg: "oklch(0.60 0.22 220 /  0.1)",
    border: "oklch(0.60 0.22 220 /  0.2)",
  },
];

const cannotDo = [
  "Access, move, or withdraw your funds",
  "Sign transactions without your hardware approval",
  "View your private key or seed phrase",
  "Override your risk limits or kill switch",
  "Trade above your set position size cap",
  "Continue trading if you revoke access",
];

const canDo = [
  "Read your public wallet address",
  "Construct trade transactions for your review",
  "Send signal notifications to your device",
  "Show you performance analytics",
  "Pause signal routing on your command",
];

export default function LedgerOnboarding() {
  const [currentStep, setCurrentStep] = useState(1);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [maxPositionSize, setMaxPositionSize] = useState(10);
  const [maxDailyLoss, setMaxDailyLoss] = useState(5);
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);

  const handleNext = () => {
    if (currentStep < steps.length) setCurrentStep(currentStep + 1);
  };
  const handleBack = () => {
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  const handleWalletConnected = (address: string) => {
    setConnectedAddress(address);
    setWalletModalOpen(false);
  };

  return (
    <DashboardLayout variant="onboarding">
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Progress bar */}
        <div className="mb-10">
          <div className="flex items-center justify-between mb-3">
            {steps.map((s, i) => (
              <div key={s.id} className="flex items-center">
                <div className={`flex items-center gap-2 ${currentStep >= s.id ? "opacity-100" : "opacity-30"} transition-opacity`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                    currentStep > s.id
                      ? "bg-primary text-black"
                      : currentStep === s.id
                      ? "border-2 border-primary text-primary"
                      : "border border-white/20 text-white/30"
                  }`}>
                    {currentStep > s.id ? <CheckCircle2 className="w-4 h-4" /> : s.id}
                  </div>
                  <span className="hidden sm:block text-xs text-white/50">{s.title}</span>
                </div>
                {i < steps.length - 1 && (
                  <div className={`w-8 sm:w-16 h-px mx-2 sm:mx-3 transition-all ${currentStep > s.id ? "bg-primary/50" : "bg-white/8"}`} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Step content */}
        <AnimatePresence mode="wait">

          {/* Step 1: Architecture */}
          {currentStep === 1 && (
            <motion.div key="step1" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}>
              <div className="mb-8">
                <h1 className="text-3xl font-bold text-white mb-3">How Copytrade Works</h1>
                <p className="text-white/50 text-base leading-relaxed">
                  Anavitrade mirrors trade signals from its quantitative algorithm directly to your hardware wallet. Your funds never leave your Ledger — every transaction requires your physical confirmation.
                </p>
              </div>

              {/* Architecture flow */}
              <div className="space-y-3 mb-8">
                {architectureFlow.map((node, i) => (
                  <div key={i}>
                    <motion.div
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.1 }}
                      className="flex items-start gap-4 p-4 rounded-xl"
                      style={{ background: node.bg, border: `1px solid ${node.border}` }}
                    >
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${node.color}`}
                        style={{ background: node.bg, border: `1px solid ${node.border}` }}>
                        {node.icon}
                      </div>
                      <div>
                        <p className={`font-semibold text-sm ${node.color}`}>{node.label}</p>
                        <p className="text-white/50 text-sm mt-0.5">{node.desc}</p>
                      </div>
                    </motion.div>
                    {i < architectureFlow.length - 1 && (
                      <div className="flex justify-center my-1">
                        <ArrowRight className="w-4 h-4 text-white/20 rotate-90" />
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Key point */}
              <div className="rounded-xl p-5 border border-primary/12 bg-primary/5">
                <div className="flex items-start gap-3">
                  <Shield className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-primary font-semibold text-sm mb-1">The Golden Rule</p>
                    <p className="text-white/60 text-sm leading-relaxed">
                      Anavitrade is a <strong className="text-white">signal router, not a custodian.</strong> We construct the trade transaction and deliver it to your Ledger. Your hardware device is the only thing that can sign and broadcast it. If you don't press confirm, nothing happens.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Step 2: Security */}
          {currentStep === 2 && (
            <motion.div key="step2" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}>
              <div className="mb-8">
                <h1 className="text-3xl font-bold text-white mb-3">Your Security Guarantee</h1>
                <p className="text-white/50 text-base leading-relaxed">
                  We are transparent about exactly what Anavitrade can and cannot do. There are no exceptions to these rules — they are enforced at the cryptographic level by your hardware wallet.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 mb-8">
                {/* Cannot do */}
                <div className="rounded-xl p-5" style={{ background: "rgba(239,68,68,0.04)", border: "1px solid rgba(239,68,68,0.1)" }}>
                  <div className="flex items-center gap-2 mb-4">
                    <XCircle className="w-4 h-4 text-red-400" />
                    <p className="text-red-400 font-semibold text-sm uppercase tracking-wider">Anavitrade CANNOT</p>
                  </div>
                  <div className="space-y-2">
                    {cannotDo.map((item, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <XCircle className="w-3.5 h-3.5 text-red-400/60 mt-0.5 flex-shrink-0" />
                        <span className="text-white/50 text-sm">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Can do */}
                <div className="rounded-xl p-5 border border-primary/10 bg-primary/4">
                  <div className="flex items-center gap-2 mb-4">
                    <CheckCircle2 className="w-4 h-4 text-primary" />
                    <p className="text-primary font-semibold text-sm uppercase tracking-wider">Anavitrade CAN</p>
                  </div>
                  <div className="space-y-2">
                    {canDo.map((item, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-primary/60 mt-0.5 flex-shrink-0" />
                        <span className="text-white/50 text-sm">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Ledger hardware guarantee */}
              <div className="rounded-xl p-5 bg-white/3 border border-white/[0.07]">
                <div className="flex items-start gap-3">
                  <HardDrive className="w-5 h-5 text-white/60 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-white/80 font-semibold text-sm mb-1">Ledger's Hardware Guarantee</p>
                    <p className="text-white/40 text-sm leading-relaxed">
                      Ledger's Secure Element chip (CC EAL5+) ensures your private key is generated and stored in an isolated, tamper-proof environment. No software — including Anavitrade — can extract it. The chip physically cannot export private keys.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Step 3: Risk Controls */}
          {currentStep === 3 && (
            <motion.div key="step3" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}>
              <div className="mb-8">
                <h1 className="text-3xl font-bold text-white mb-3">Set Your Risk Limits</h1>
                <p className="text-white/50 text-base leading-relaxed">
                  You control the guardrails. Anavitrade will never execute a trade that exceeds your configured limits — even if the algo signal says otherwise.
                </p>
              </div>

              <div className="space-y-6 mb-8">
                {/* Max position size */}
                <div className="rounded-xl p-5 bg-white/3 border border-white/[0.07]">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-white font-semibold text-sm">Max Position Size</p>
                      <p className="text-white/40 text-xs mt-0.5">Maximum % of portfolio per single trade</p>
                    </div>
                    <div className="text-2xl font-bold text-primary">{maxPositionSize}%</div>
                  </div>
                  <input
                    type="range" min={1} max={50} value={maxPositionSize}
                    onChange={(e) => setMaxPositionSize(Number(e.target.value))}
                    className="w-full accent-primary"
                  />
                  <div className="flex justify-between text-xs text-white/20 mt-1">
                    <span>1% (Conservative)</span>
                    <span>50% (Aggressive)</span>
                  </div>
                </div>

                {/* Max daily loss */}
                <div className="rounded-xl p-5 bg-white/3 border border-white/[0.07]">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-white font-semibold text-sm">Max Daily Loss</p>
                      <p className="text-white/40 text-xs mt-0.5">Auto-pause copytrade if daily loss exceeds this</p>
                    </div>
                    <div className="text-2xl font-bold text-red-400">{maxDailyLoss}%</div>
                  </div>
                  <input
                    type="range" min={1} max={20} value={maxDailyLoss}
                    onChange={(e) => setMaxDailyLoss(Number(e.target.value))}
                    className="w-full accent-red-400"
                  />
                  <div className="flex justify-between text-xs text-white/20 mt-1">
                    <span>1% (Tight)</span>
                    <span>20% (Wide)</span>
                  </div>
                </div>

                {/* Kill switch info */}
                <div className="rounded-xl p-4 flex items-start gap-3" style={{ background: "rgba(251,191,36,0.05)", border: "1px solid rgba(251,191,36,0.12)" }}>
                  <Zap className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-amber-400 font-semibold text-sm mb-1">Emergency Kill Switch</p>
                    <p className="text-white/40 text-xs leading-relaxed">
                      A one-click kill switch is always visible on your dashboard. Activating it immediately halts all signal routing and prevents any new transactions from being sent to your wallet — no delay, no confirmation required.
                    </p>
                  </div>
                </div>

                {/* Revocation */}
                <div className="rounded-xl p-4 flex items-start gap-3 bg-white/3 border border-white/5">
                  <RefreshCw className="w-4 h-4 text-white/40 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-white/70 font-semibold text-sm mb-1">Instant Revocation</p>
                    <p className="text-white/40 text-xs leading-relaxed">
                      You can disconnect your wallet at any time from the Account Settings page. Revocation is immediate — no pending signals will be processed after you disconnect.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Step 4: Connect */}
          {currentStep === 4 && (
            <motion.div key="step4" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}>
              <div className="mb-8">
                <h1 className="text-3xl font-bold text-white mb-3">Connect Your Wallet</h1>
                <p className="text-white/50 text-base leading-relaxed">
                  You're ready to connect. We recommend Ledger Nano for maximum security — your private keys stay on the hardware device at all times.
                </p>
              </div>

              {connectedAddress ? (
                <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-8">
                  <div className="w-20 h-20 rounded-full mx-auto mb-5 flex items-center justify-center bg-primary/15 border-2 border-primary/30">
                    <CheckCircle2 className="w-10 h-10 text-primary" />
                  </div>
                  <h3 className="text-white font-bold text-xl mb-2">Wallet Connected!</h3>
                  <p className="text-white/40 text-sm mb-4">Your Ledger is now registered for copytrade signal routing.</p>
                  <div className="inline-block px-4 py-2 rounded-xl font-mono text-sm text-white/60 mb-8 bg-white/5 border border-white/8">
                    {connectedAddress.slice(0, 8)}...{connectedAddress.slice(-6)}
                  </div>
                  <div className="space-y-3 text-left rounded-xl p-5 mb-6 border border-primary/10 bg-primary/[0.04]">
                    <p className="text-primary font-semibold text-xs uppercase tracking-wider mb-3">Your settings are saved</p>
                    <div className="flex justify-between text-sm">
                      <span className="text-white/40">Max position size</span>
                      <span className="text-white font-medium">{maxPositionSize}%</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-white/40">Max daily loss</span>
                      <span className="text-white font-medium">{maxDailyLoss}%</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-white/40">Kill switch</span>
                      <span className="text-primary font-medium">Armed & ready</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-white/40">Copytrade status</span>
                      <span className="text-amber-400 font-medium">Awaiting algo signal wire-in</span>
                    </div>
                  </div>
                  <Link href="/dashboard">
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full py-4 rounded-xl text-black font-bold text-base flex items-center justify-center gap-2"
                      style={{ background: "linear-gradient(135deg, oklch(0.60 0.22 220), oklch(0.52 0.22 225))" }}
                    >
                      Go to Dashboard <ArrowRight className="w-5 h-5" />
                    </motion.button>
                  </Link>
                </motion.div>
              ) : (
                <>
                  {/* Wallet options summary */}
                  <div className="space-y-3 mb-6">
                    {[
                      {
                        icon: <HardDrive className="w-5 h-5" />,
                        name: "Ledger Nano X / S Plus",
                        desc: "Hardware wallet — private keys never leave the device",
                        badge: "Recommended",
                        badgeColor: "text-primary bg-primary/10",
                        primary: true,
                      },
                      {
                        icon: <Cpu className="w-5 h-5" />,
                        name: "MetaMask",
                        desc: "Browser extension wallet",
                        badge: null,
                        badgeColor: "",
                        primary: false,
                      },
                      {
                        icon: <Smartphone className="w-5 h-5" />,
                        name: "WalletConnect",
                        desc: "Any mobile wallet via QR code",
                        badge: null,
                        badgeColor: "",
                        primary: false,
                      },
                    ].map((w, i) => (
                      <div key={i} className={`flex items-center gap-4 p-4 rounded-xl ${w.primary ? "bg-primary/5 border border-primary/15" : "bg-white/3 border border-white/5"}`}>
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${w.primary ? "text-primary" : "text-white/40"} ${w.primary ? "bg-primary/10" : "bg-white/5"}`}>
                          {w.icon}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-white text-sm font-medium">{w.name}</span>
                            {w.badge && (
                              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${w.badgeColor}`}>{w.badge}</span>
                            )}
                          </div>
                          <p className="text-white/40 text-xs">{w.desc}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Final reassurance */}
                  <div className="rounded-xl p-4 mb-6 flex items-start gap-3 bg-primary/[0.04] border-primary/8">
                    <Shield className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                    <p className="text-white/50 text-xs leading-relaxed">
                      Connecting your wallet grants Anavitrade read-only access to your public address. <strong className="text-white/70">No funds can move without your physical confirmation on your Ledger device.</strong> You can revoke this connection at any time from Account Settings.
                    </p>
                  </div>

                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setWalletModalOpen(true)}
                    className="w-full py-4 rounded-xl text-black font-bold text-base flex items-center justify-center gap-2"
                    style={{ background: "linear-gradient(135deg, oklch(0.60 0.22 220), oklch(0.52 0.22 225))" }}
                  >
                    <Wifi className="w-5 h-5" />
                    Connect Wallet
                  </motion.button>
                </>
              )}
            </motion.div>
          )}

        </AnimatePresence>

        {/* Navigation */}
        {!(currentStep === 4 && connectedAddress) && (
          <div className="flex items-center justify-between mt-10">
            <button
              onClick={handleBack}
              disabled={currentStep === 1}
              className="flex items-center gap-2 px-5 py-3 rounded-xl text-white/50 text-sm font-medium transition-all hover:text-white disabled:opacity-20 disabled:cursor-not-allowed"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>

            <div className="flex items-center gap-3">
              {/* Always show a skip/dashboard escape route */}
              <Link href="/dashboard">
                <button className="px-4 py-3 rounded-xl text-white/30 text-sm hover:text-white/60 transition-colors">
                  {currentStep === 4 ? "Skip for now" : "Go to Dashboard"}
                </button>
              </Link>

              {currentStep < 4 && (
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleNext}
                  className="flex items-center gap-2 px-6 py-3 rounded-xl text-black font-semibold text-sm"
                  style={{ background: "linear-gradient(135deg, oklch(0.60 0.22 220), oklch(0.52 0.22 225))" }}
                >
                  Continue
                  <ChevronRight className="w-4 h-4" />
                </motion.button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Wallet connect modal */}
      <WalletConnectModal
        isOpen={walletModalOpen}
        onClose={() => setWalletModalOpen(false)}
        onConnected={handleWalletConnected}
      />
    </DashboardLayout>
  );
}
