import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { trpc } from "@/lib/trpc";
import {
  CheckCircle2,
  Loader2,
  Wallet,
  Shield,
  Zap,
  ExternalLink,
  ArrowLeft,
  Sparkles,
} from "lucide-react";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import WalletConnectModal from "@/components/WalletConnectModal";

/* ─── ONE-CLICK ASTER ACTIVATION ───
   User connects their web3 wallet → clicks "Activate" →
   platform handles everything (prepares agent, records approvals).
   No copy-pasting, no navigating to Aster's website, no multi-step form. */
export default function AsterOnboarding() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const { address: wagmiAddress, isConnected } = useAccount();
  const { data: web3Session } = trpc.web3Wallet.getSession.useQuery();
  const { data: status, isLoading: statusLoading } = trpc.aster.getStatus.useQuery();
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [activated, setActivated] = useState(false);

  const walletAddress = web3Session?.walletAddress ?? wagmiAddress ?? null;
  const isActive = status?.status === "active";
  const walletReady = !!walletAddress;

  const activate = trpc.aster.activateWithWallet.useMutation({
    onSuccess: () => {
      setActivated(true);
      toast.success("Aster execution activated!");
      utils.aster.getStatus.invalidate();
      utils.liveAccount.get.invalidate();
      setTimeout(() => navigate("/dashboard"), 1200);
    },
    onError: (e) => toast.error(e.message || "Failed to activate Aster."),
  });

  const handleActivate = () => {
    if (!walletAddress) {
      setShowWalletModal(true);
      return;
    }
    activate.mutate({ walletAddress });
  };

  // Auto-close wallet modal once connected
  useEffect(() => {
    if (walletAddress && showWalletModal) {
      setShowWalletModal(false);
    }
  }, [walletAddress, showWalletModal]);

  return (
    <div className="min-h-screen bg-background">
      {/* Back nav */}
      <div className="border-b px-6 py-4" style={{ borderColor: "oklch(0.60 0.22 220 / 0.12)" }}>
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <Link href="/dashboard">
            <button className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" /> Dashboard
            </button>
          </Link>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Zap className="w-4 h-4 text-primary" /> Aster DEX
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-6 py-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
          className="text-center mb-10"
        >
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6"
            style={{ background: "linear-gradient(135deg, oklch(0.60 0.22 220 / 0.20), oklch(0.60 0.22 220 / 0.05))", border: "1px solid oklch(0.60 0.22 220 / 0.25)" }}>
            <Zap className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-3xl font-heading font-bold text-foreground mb-3">
            One-click Aster Activation
          </h1>
          <p className="text-muted-foreground leading-relaxed max-w-sm mx-auto">
            Connect your wallet and activate DEX execution in a single step. No copy-pasting, no multi-page forms.
          </p>
        </motion.div>

        {/* Status card */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="rounded-2xl p-6 mb-8 border"
          style={{
            background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.85), oklch(0.09 0.018 255 / 0.90))",
            borderColor: "oklch(0.60 0.22 220 / 0.18)",
            backdropFilter: "blur(16px)",
          }}
        >
          <div className="flex items-center gap-4 mb-6">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: "oklch(0.60 0.22 220 / 0.12)", color: "oklch(0.68 0.22 220)" }}>
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Execution Status</h3>
              {statusLoading ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                </p>
              ) : isActive ? (
                <p className="text-xs text-green-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Active — ready for DEX execution
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Not yet activated</p>
              )}
            </div>
          </div>

          {/* Wallet status */}
          <div className="p-4 rounded-xl mb-5" style={{ background: "oklch(1 0 0 / 0.03)", border: "1px solid oklch(1 0 0 / 0.06)" }}>
            <div className="flex items-center gap-3">
              <Wallet className="w-5 h-5" style={{ color: walletReady ? "oklch(0.74 0.18 145)" : "oklch(0.50 0.015 260)" }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {walletReady ? "Wallet Connected" : "No wallet connected"}
                </p>
                {walletAddress && (
                  <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">
                    {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
                  </p>
                )}
              </div>
              {!walletReady && (
                <button
                  onClick={() => setShowWalletModal(true)}
                  className="px-4 py-2 rounded-xl border text-xs font-semibold transition-all hover:bg-card"
                  style={{ borderColor: "oklch(0.60 0.22 220 / 0.25)" }}
                >
                  Connect
                </button>
              )}
            </div>
          </div>

          {/* What happens — transparency */}
          <div className="space-y-2 mb-6">
            {[
              "Anavitrade generates a dedicated Agent signer for your account",
              "The Agent can place and cancel Aster perp orders only — no withdrawal access",
              "A 30-day approval is set (auto-renewable)",
              "Your wallet address is registered as your Aster account",
              "Zero-custody — funds never leave your account",
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "oklch(0.60 0.22 220 / 0.6)" }} />
                <span className="text-xs text-muted-foreground">{item}</span>
              </div>
            ))}
          </div>

          {/* CTA */}
          <button
            onClick={handleActivate}
            disabled={activate.isPending || isActive || activated}
            className="w-full h-12 rounded-xl font-semibold text-sm transition-all disabled:opacity-50 relative overflow-hidden group"
            style={{
              fontFamily: "var(--font-heading)",
              color: activate.isPending ? "oklch(0.98 0.004 220)" : "oklch(0.14 0.02 255)",
              background: isActive
                ? "oklch(0.74 0.18 145 / 0.15)"
                : "var(--grad-arctic)",
              boxShadow: isActive ? "none" : "inset 0 1px 0 oklch(1 0 0 / 0.4), 0 4px 24px oklch(0.72 0.20 195 / 0.22)",
              border: isActive ? "1px solid oklch(0.74 0.18 145 / 0.3)" : "none",
            }}
          >
            {activate.isPending ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Activating...
              </span>
            ) : isActive ? (
              <span className="flex items-center justify-center gap-2" style={{ color: "oklch(0.74 0.18 145)" }}>
                <CheckCircle2 className="w-4 h-4" />
                Already Active
              </span>
            ) : activated ? (
              <span className="flex items-center justify-center gap-2" style={{ color: "oklch(0.14 0.02 255)" }}>
                <CheckCircle2 className="w-4 h-4" />
                Activated! Redirecting...
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2 group-hover:gap-3 transition-all">
                <Zap className="w-4 h-4" />
                {walletReady ? "Activate Aster Execution" : "Connect Wallet & Activate"}
              </span>
            )}
          </button>

          {!walletReady && (
            <p className="text-[11px] text-muted-foreground/60 text-center mt-3">
              You'll be prompted to connect your wallet. Only a signature is requested — no transactions, no gas fees.
            </p>
          )}
        </motion.div>

        {/* Trust badges */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="flex flex-wrap items-center justify-center gap-6 text-xs text-muted-foreground/50"
        >
          <span className="flex items-center gap-1.5"><Shield className="w-3.5 h-3.5" /> No withdrawal access</span>
          <span className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5" /> Under 50ms execution</span>
          <span className="flex items-center gap-1.5"><ExternalLink className="w-3.5 h-3.5" /> Powered by Aster</span>
        </motion.div>
      </div>

      {/* Wallet connect modal */}
      <WalletConnectModal
        isOpen={showWalletModal}
        onClose={() => setShowWalletModal(false)}
        onConnected={() => {
          utils.web3Wallet.getSession.invalidate();
        }}
      />
    </div>
  );
}
