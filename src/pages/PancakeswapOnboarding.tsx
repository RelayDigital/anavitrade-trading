import { useState, useEffect, useMemo } from "react";
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
import { useAccount, useChainId, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { bsc } from "wagmi/chains";
import { maxUint256 } from "viem";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";
import WalletConnectModal from "@/components/WalletConnectModal";
import { signPancakeswapPermitTypedData } from "@/lib/pancakeswapPermitSignature";

const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// USDT on BSC — matches the curated token list used for quoting/asset display.
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955" as const;
const DEFAULT_AMOUNT_CAP = "1000000000000000000000"; // 1000 USDT (18 decimals)

export default function PancakeswapOnboarding() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const { address: wagmiAddress, connector } = useAccount();
  const chainId = useChainId();
  const { data: config } = trpc.pancakeswap.getConfig.useQuery();
  const { data: status, isLoading: statusLoading } = trpc.pancakeswap.getStatus.useQuery(
    { tokenAddress: USDT_BSC },
    { enabled: !!wagmiAddress },
  );
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [activated, setActivated] = useState(false);
  const [isActivating, setIsActivating] = useState(false);

  const walletReady = !!wagmiAddress && !!connector;
  const isActive = status?.status === "active";
  const isBscChain = chainId === 56;

  const permit2Address = config?.permit2Address as `0x${string}` | undefined;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDT_BSC,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    args: wagmiAddress && permit2Address ? [wagmiAddress, permit2Address] : undefined,
    query: { enabled: !!wagmiAddress && !!permit2Address && isBscChain },
  });
  const permit2Approved = (allowance ?? 0n) >= BigInt(DEFAULT_AMOUNT_CAP);

  const { writeContractAsync, isPending: approvePending, data: approveHash } = useWriteContract();
  const { isLoading: approveConfirming } = useWaitForTransactionReceipt({ hash: approveHash });

  const prepareDelegation = trpc.pancakeswap.prepareDelegation.useMutation();
  const completeDelegation = trpc.pancakeswap.completeDelegation.useMutation({
    onSuccess: () => {
      setActivated(true);
      toast.success("PancakeSwap execution activated!");
      utils.pancakeswap.getStatus.invalidate();
      setTimeout(() => navigate("/dashboard"), 1200);
    },
  });

  const handleApprovePermit2 = async () => {
    if (!permit2Address) {
      toast.error("PancakeSwap is not configured yet.");
      return;
    }
    try {
      await writeContractAsync({
        address: USDT_BSC,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "approve",
        args: [permit2Address, maxUint256],
        chain: bsc,
        account: wagmiAddress,
      });
      toast.success("USDT approved for Permit2.");
      await refetchAllowance();
    } catch (e: any) {
      const message = String(e?.message ?? "");
      const rejected = /reject|denied|cancel|user refused/i.test(message);
      toast.error(rejected ? "Approval was cancelled." : "Failed to approve Permit2.");
    }
  };

  const handleActivate = async () => {
    if (isActivating) return;
    const provider = await connector?.getProvider();
    if (!provider || !wagmiAddress) {
      setShowWalletModal(true);
      return;
    }
    if (!isBscChain) {
      toast.error("Switch your wallet to BNB Smart Chain (BSC) before activating PancakeSwap.");
      return;
    }
    if (!permit2Approved) {
      toast.error("Approve USDT for Permit2 first.");
      return;
    }
    setIsActivating(true);
    try {
      const challenge = await prepareDelegation.mutateAsync({
        tokenAddress: USDT_BSC,
        amountCap: DEFAULT_AMOUNT_CAP,
      });
      const signature = await signPancakeswapPermitTypedData({
        provider: provider as Parameters<typeof signPancakeswapPermitTypedData>[0]["provider"],
        account: wagmiAddress as `0x${string}`,
        expectedTokenAddress: USDT_BSC,
        expectedSpenderAddress: challenge.spenderAddress,
        expectedAmountCap: DEFAULT_AMOUNT_CAP,
        typedData: challenge.typedData,
      });
      await completeDelegation.mutateAsync({ tokenAddress: USDT_BSC, signature });
    } catch (e: any) {
      const message = String(e?.message ?? "");
      const rejected = /reject|denied|cancel|user refused/i.test(message);
      toast.error(rejected
        ? "Signing was cancelled. No PancakeSwap permissions changed."
        : message || "Failed to activate PancakeSwap.");
    } finally {
      setIsActivating(false);
    }
  };

  useEffect(() => {
    if (connector && wagmiAddress && showWalletModal) setShowWalletModal(false);
  }, [connector, wagmiAddress, showWalletModal]);

  const busy = isActivating || prepareDelegation.isPending || completeDelegation.isPending;

  const steps = useMemo(() => [
    { label: "Connect wallet", done: walletReady },
    { label: "Approve USDT for Permit2 (one-time, on-chain)", done: permit2Approved },
    { label: "Sign capped, expiring delegation (off-chain, free)", done: isActive || activated },
  ], [walletReady, permit2Approved, isActive, activated]);

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
            PancakeSwap Execution
          </h1>
          <p className="text-muted-foreground leading-relaxed max-w-sm mx-auto">
            Grant a capped, expiring Permit2 allowance so Anavitrade can execute spot swaps on your behalf — non-custodial, revocable anytime.
          </p>
        </motion.div>

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
                  <CheckCircle2 className="w-3 h-3" /> Active — ready for PancakeSwap execution
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Not yet activated</p>
              )}
            </div>
          </div>

          <div className="p-4 rounded-xl mb-5 bg-white/3 border border-white/5">
            <div className="flex items-center gap-3">
              <Wallet className="w-5 h-5 text-muted-foreground" style={{ color: walletReady ? "var(--profit-green)" : undefined }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {walletReady ? "Wallet Connected" : "No wallet connected"}
                </p>
                {wagmiAddress && (
                  <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">
                    {wagmiAddress.slice(0, 6)}...{wagmiAddress.slice(-4)}
                    {walletReady && !isBscChain && " · switch to BSC"}
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

          <div className="space-y-2 mb-5">
            {steps.map((step, i) => (
              <div key={i} className="flex items-center gap-2.5">
                {step.done ? (
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-green-400" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 shrink-0 text-primary/60" />
                )}
                <span className={`text-xs ${step.done ? "text-foreground" : "text-muted-foreground"}`}>{step.label}</span>
              </div>
            ))}
          </div>

          {walletReady && isBscChain && !permit2Approved && !isActive && (
            <button
              onClick={handleApprovePermit2}
              disabled={approvePending || approveConfirming}
              className="w-full h-11 rounded-xl font-semibold text-sm mb-3 border border-primary/25 hover:bg-card transition-all disabled:opacity-50"
            >
              {approvePending || approveConfirming ? (
                <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Approving...</span>
              ) : (
                "Approve USDT for Permit2"
              )}
            </button>
          )}

          <button
            onClick={handleActivate}
            disabled={busy || isActive || activated || !permit2Approved}
            className="w-full h-12 rounded-xl font-semibold text-sm transition-all disabled:opacity-50 relative overflow-hidden group font-heading"
            style={{
              color: busy ? "var(--color-foreground)" : "var(--color-background)",
              background: isActive ? "oklch(0.74 0.18 145 / 0.15)" : "var(--grad-arctic)",
              boxShadow: isActive ? "none" : "inset 0 1px 0 oklch(1 0 0 / 0.4), 0 4px 24px oklch(0.72 0.20 195 / 0.22)",
              border: isActive ? "1px solid oklch(0.74 0.18 145 / 0.3)" : "none",
            }}
          >
            {busy ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Activating...
              </span>
            ) : isActive ? (
              <span className="flex items-center justify-center gap-2" style={{ color: "var(--profit-green)" }}>
                <CheckCircle2 className="w-4 h-4" /> Already Active
              </span>
            ) : activated ? (
              <span className="flex items-center justify-center gap-2 text-background">
                <CheckCircle2 className="w-4 h-4" /> Activated! Redirecting...
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2 group-hover:gap-3 transition-all">
                <Zap className="w-4 h-4" />
                {walletReady ? "Sign & Activate PancakeSwap" : "Connect Wallet & Activate"}
              </span>
            )}
          </button>

          <p className="text-[11px] text-muted-foreground/60 text-center mt-3">
            Capped at 1,000 USDT, expires in 30 days, revocable anytime. Anavitrade can only pull up to the approved amount — never more, never a different token.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="flex flex-wrap items-center justify-center gap-6 text-xs text-muted-foreground/50"
        >
          <span className="flex items-center gap-1.5"><Shield className="w-3.5 h-3.5" /> Capped & revocable</span>
          <span className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5" /> Direct onchain execution</span>
          <span className="flex items-center gap-1.5"><ExternalLink className="w-3.5 h-3.5" /> Powered by PancakeSwap</span>
        </motion.div>
      </div>

      <WalletConnectModal
        isOpen={showWalletModal}
        onClose={() => setShowWalletModal(false)}
        onConnected={() => setShowWalletModal(false)}
      />
    </DashboardLayout>
  );
}
