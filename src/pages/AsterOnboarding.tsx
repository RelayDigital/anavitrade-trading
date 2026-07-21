import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { trpc } from "@/lib/trpc";
import {
  CheckCircle2,
  Loader2,
  Wallet,
  Shield,
  Zap,
  ExternalLink,
  Sparkles,
} from "lucide-react";
import { useAccount, useChainId } from "wagmi";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";
import WalletConnectModal from "@/components/WalletConnectModal";
import { signAsterRegistrationTypedData } from "@/lib/asterWalletSignature";

export default function AsterOnboarding() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const { address: wagmiAddress, connector } = useAccount();
  const chainId = useChainId();
  const { data: web3Session } = trpc.web3Wallet.getSession.useQuery();
  const { data: status, isLoading: statusLoading } = trpc.aster.getStatus.useQuery();
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [activated, setActivated] = useState(false);
  const [recentWalletAddress, setRecentWalletAddress] = useState<string | null>(null);
  const [isActivating, setIsActivating] = useState(false);

  const walletAddress = wagmiAddress ?? recentWalletAddress ?? web3Session?.walletAddress ?? null;
  const isActive = status?.status === "active";
  const walletReady = !!walletAddress && !!connector;

  const prepareRegistration = trpc.aster.prepareRegistration.useMutation();
  const saveWallet = trpc.web3Wallet.connect.useMutation();
  const completeRegistration = trpc.aster.completeRegistration.useMutation({
    onSuccess: () => {
      setActivated(true);
      toast.success("Aster execution activated!");
      utils.aster.getStatus.invalidate();
      utils.liveAccount.get.invalidate();
      setTimeout(() => navigate("/dashboard"), 1200);
    },
  });

  const ensureServerWalletSession = async (address: string, activeChainId: number) => {
    const currentWallet = address.toLowerCase();
    const savedWallet = web3Session?.walletAddress?.toLowerCase();
    const recentlySavedWallet = recentWalletAddress?.toLowerCase();
    if ((savedWallet === currentWallet || recentlySavedWallet === currentWallet) && web3Session?.chainId === activeChainId) {
      return;
    }

    await saveWallet.mutateAsync({
      walletAddress: address,
      walletType: "other",
      chainId: activeChainId,
      maxDailyLossPct: 5,
    });
    await utils.web3Wallet.getSession.invalidate();
  };

  const handleActivate = async () => {
    if (isActivating) return;
    const provider = await connector?.getProvider();
    const providerAccounts = provider
      ? await (provider as Parameters<typeof signAsterRegistrationTypedData>[0]["provider"]).request({ method: "eth_accounts" }).catch(() => [])
      : [];
    const providerAddress = Array.isArray(providerAccounts) && typeof providerAccounts[0] === "string" ? providerAccounts[0] : null;
    const signingAddress = providerAddress ?? wagmiAddress;
    const rawChainId = provider
      ? await (provider as Parameters<typeof signAsterRegistrationTypedData>[0]["provider"]).request({ method: "eth_chainId" }).catch(() => null)
      : null;
    const activeChainId = typeof rawChainId === "string"
      ? (rawChainId.toLowerCase().startsWith("0x") ? Number.parseInt(rawChainId, 16) : Number(rawChainId))
      : chainId;
    if (!provider || !signingAddress) {
      setShowWalletModal(true);
      return;
    }
    if (!Number.isInteger(activeChainId) || activeChainId <= 0) {
      toast.error("Your wallet network could not be read. Reconnect the wallet and try again.");
      return;
    }
    setIsActivating(true);
    try {
      await ensureServerWalletSession(signingAddress, activeChainId);
      const challenge = await prepareRegistration.mutateAsync();
      const signature = await signAsterRegistrationTypedData({
        provider: provider as Parameters<typeof signAsterRegistrationTypedData>[0]["provider"],
        account: signingAddress as `0x${string}`,
        signatureChainId: challenge.signatureChainId,
        typedData: challenge.typedData,
      });
      await completeRegistration.mutateAsync({
        activationMode: challenge.activationMode,
        endpoint: challenge.endpoint,
        signatureChainId: challenge.signatureChainId,
        params: challenge.params,
        signature,
      });
    } catch (e: any) {
      const message = String(e?.message ?? "");
      const rejected = /reject|denied|cancel|user refused/i.test(message);
      toast.error(rejected
        ? "Signing was cancelled. No Aster permissions changed."
        : message || "Failed to activate Aster.");
    } finally {
      setIsActivating(false);
    }
  };

  // Auto-close wallet modal once connected
  useEffect(() => {
    if (connector && walletAddress && showWalletModal) {
      setShowWalletModal(false);
    }
  }, [connector, walletAddress, showWalletModal]);

  return (
    <DashboardLayout variant="onboarding">
      <div className="max-w-lg mx-auto px-6 py-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
          className="text-center mb-10"
        >
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6 bg-primary/10 border border-primary/25">
            <Zap className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-3xl font-heading font-bold text-foreground mb-3">
            One-click Aster Activation
          </h1>
          <p className="text-muted-foreground leading-relaxed max-w-sm mx-auto">
            Connect your wallet and approve an Aster Agent signer. Your wallet signs the official Aster registration message; Anavitrade never signs this authorization on your behalf.
          </p>
        </motion.div>

        {/* Status card */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="glass-card rounded-2xl p-6 mb-8 border border-primary/18"
        >
          <div className="flex items-center gap-4 mb-6">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-primary/10 text-primary/70">
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
          <div className="p-4 rounded-xl mb-5 bg-white/3 border border-white/5">
            <div className="flex items-center gap-3">
              <Wallet className="w-5 h-5 text-muted-foreground" style={{ color: walletReady ? "var(--profit-green)" : undefined }} />
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
                  className="px-4 py-2 rounded-xl border text-xs font-semibold transition-all hover:bg-card border-primary/25"
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
              "A 30-day approval is set; renewal requires another wallet signature",
              "Your wallet reviews and signs Aster's register-and-approve Agent message",
              "The Agent never receives custody of your wallet or withdrawal access",
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary/60" />
                <span className="text-xs text-muted-foreground">{item}</span>
              </div>
            ))}
          </div>

          {/* CTA */}
          <button
            onClick={handleActivate}
            disabled={isActivating || saveWallet.isPending || prepareRegistration.isPending || completeRegistration.isPending || isActive || activated}
            className="w-full h-12 rounded-xl font-semibold text-sm transition-all disabled:opacity-50 relative overflow-hidden group font-heading"
            style={{
              color: saveWallet.isPending || prepareRegistration.isPending || completeRegistration.isPending ? "var(--color-foreground)" : "var(--color-background)",
              background: isActive
                ? "oklch(0.74 0.18 145 / 0.15)"
                : "var(--grad-arctic)",
              boxShadow: isActive ? "none" : "inset 0 1px 0 oklch(1 0 0 / 0.4), 0 4px 24px oklch(0.72 0.20 195 / 0.22)",
              border: isActive ? "1px solid oklch(0.74 0.18 145 / 0.3)" : "none",
            }}
          >
            {isActivating || saveWallet.isPending || prepareRegistration.isPending || completeRegistration.isPending ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Activating...
              </span>
            ) : isActive ? (
              <span className="flex items-center justify-center gap-2" style={{ color: "var(--profit-green)" }}>
                <CheckCircle2 className="w-4 h-4" />
                Already Active
              </span>
            ) : activated ? (
              <span className="flex items-center justify-center gap-2 text-background">
                <CheckCircle2 className="w-4 h-4" />
                Activated! Redirecting...
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2 group-hover:gap-3 transition-all">
                <Zap className="w-4 h-4" />
                {walletReady ? "Sign & Activate Aster" : "Connect Wallet & Activate"}
              </span>
            )}
          </button>

          <p className="text-[11px] text-muted-foreground/60 text-center mt-3">
            Aster Agent activation uses the typed-data signing domain (chain 56). This does not switch your wallet network, submit an order, or move funds.
          </p>
        </motion.div>

        {/* Trust badges */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="flex flex-wrap items-center justify-center gap-6 text-xs text-muted-foreground/50"
        >
          <span className="flex items-center gap-1.5"><Shield className="w-3.5 h-3.5" /> No withdrawal access</span>
          <span className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5" /> Restricted Agent execution</span>
          <span className="flex items-center gap-1.5"><ExternalLink className="w-3.5 h-3.5" /> Powered by Aster</span>
        </motion.div>
      </div>

      {/* Wallet connect modal */}
      <WalletConnectModal
        isOpen={showWalletModal}
        onClose={() => setShowWalletModal(false)}
        onConnected={(address) => {
          setRecentWalletAddress(address);
          setShowWalletModal(false);
          utils.web3Wallet.getSession.invalidate();
        }}
      />
    </DashboardLayout>
  );
}
