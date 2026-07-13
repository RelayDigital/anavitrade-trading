import { motion } from "framer-motion";
import { Clock, Loader2, CheckCircle2, Wallet, Zap, Sparkles } from "lucide-react";

interface ActivationCardProps {
  asterConnected: boolean;
  asterPending: boolean;
  web3Connected: boolean;
  web3Session: { walletAddress?: string | null } | undefined;
  showActivationPanel: boolean;
  activatePending: boolean;
  hasWalletAddress: boolean;
  onShowPanel: () => void;
  onHidePanel: () => void;
  onConnectWallet: () => void;
  onActivate: () => void;
  onShowWizard: () => void;
}

export default function ActivationCard({
  asterConnected, asterPending, web3Connected, web3Session,
  showActivationPanel, activatePending, hasWalletAddress,
  onShowPanel, onHidePanel, onConnectWallet, onActivate, onShowWizard,
}: ActivationCardProps) {
  if (asterConnected) return null;

  return (
    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
      {asterPending ? (
        <div className="p-5 rounded-2xl border bg-amber-400/5 border-amber-400/20">
          <div className="flex items-start gap-3">
            <Clock className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-1">Activation in progress</h3>
              <p className="text-xs text-muted-foreground">Setting up your execution environment...</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-6 rounded-2xl border border-primary/20 relative overflow-hidden"
          style={{ background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.88), oklch(0.09 0.018 255 / 0.94))" }}
        >
          <div className="absolute top-0 right-0 w-48 h-48 rounded-full blur-[80px] pointer-events-none bg-primary/10" />
          <div className="relative z-10 flex flex-col sm:flex-row items-start gap-5">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/30">
              <Zap className="w-6 h-6 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-heading font-semibold text-foreground mb-1">Activate DEX Execution</h3>
              <p className="text-xs text-muted-foreground leading-relaxed max-w-lg mb-4">
                Connect your wallet and activate Aster execution in one click. Your funds stay in your account — we never get withdrawal access.
              </p>

              {showActivationPanel ? (
                <div className="space-y-3">
                  {activatePending ? (
                    <div className="flex items-center gap-3 p-4 rounded-xl bg-primary/[0.05] border border-primary/[0.10]">
                      <Loader2 className="w-5 h-5 text-primary animate-spin" />
                      <div>
                        <p className="text-sm font-medium text-foreground">Activating...</p>
                        <p className="text-xs text-muted-foreground">Generating Agent signer & recording approvals</p>
                      </div>
                    </div>
                  ) : hasWalletAddress ? (
                    <div className="flex items-center gap-3">
                      <div className="flex-1 p-3 rounded-xl bg-green-500/10 border border-green-500/20">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 text-green-400" />
                          <span className="text-sm text-foreground">Wallet connected</span>
                          <span className="text-xs font-mono text-muted-foreground">
                            {web3Session?.walletAddress?.slice(0, 6)}...{web3Session?.walletAddress?.slice(-4)}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={onActivate}
                        disabled={activatePending}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-heading font-semibold transition-all disabled:opacity-50"
                        style={{ color: "oklch(0.14 0.02 255)", background: "var(--grad-arctic)", boxShadow: "inset 0 1px 0 oklch(1 0 0 / 0.4), 0 4px 24px oklch(0.72 0.20 195 / 0.22)" }}
                      >
                        <Zap className="w-3.5 h-3.5" /> Activate Now
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <button
                        onClick={onConnectWallet}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-xs font-semibold transition-all hover:bg-primary/90"
                      >
                        <Wallet className="w-3.5 h-3.5" /> Connect Wallet
                      </button>
                      <button
                        onClick={onHidePanel}
                        className="px-4 py-2.5 rounded-xl border border-primary/20 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Skip for now
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <button
                    onClick={onShowPanel}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-heading font-semibold transition-all"
                    style={{ color: "oklch(0.14 0.02 255)", background: "var(--grad-arctic)", boxShadow: "inset 0 1px 0 oklch(1 0 0 / 0.4), 0 4px 24px oklch(0.72 0.20 195 / 0.22)" }}
                  >
                    <Zap className="w-3.5 h-3.5" /> Activate Now
                  </button>
                  <button
                    onClick={onShowWizard}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-primary/20 text-xs font-medium text-foreground transition-all hover:bg-card"
                  >
                    <Sparkles className="w-3.5 h-3.5" /> Quick Start
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
