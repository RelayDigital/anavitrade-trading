import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useDisconnect } from "wagmi";
import {
  Shield, Lock, Zap, CheckCircle2, HardDrive,
  Wifi, WifiOff, AlertTriangle, Eye, RefreshCw, ChevronDown,
  ChevronUp, TrendingUp, Activity, Copy, ExternalLink, LogOut
} from "lucide-react";
import WalletConnectModal from "./WalletConnectModal";

interface WalletPanelProps {
  walletAddress?: string | null;
  walletType?: string | null;
  copytradeEnabled?: boolean;
  killSwitchActive?: boolean;
  maxPositionSize?: number;
  maxDailyLoss?: number;
  onKillSwitch?: (active: boolean) => void;
  onRevoke?: () => void;
  onConnected?: (address: string, walletType: string) => void;
}

const securityBadges = [
  { icon: <Lock className="w-3 h-3" />, label: "Non-Custodial", color: "text-primary", bg: "oklch(0.60 0.22 220 / 0.08)", border: "oklch(0.60 0.22 220 / 0.15)" },
  { icon: <Shield className="w-3 h-3" />, label: "Keys On-Device", color: "text-blue-400", bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.15)" },
  { icon: <Eye className="w-3 h-3" />, label: "Read-Only Access", color: "text-purple-400", bg: "rgba(168,85,247,0.08)", border: "rgba(168,85,247,0.15)" },
  { icon: <Zap className="w-3 h-3" />, label: "Instant Revoke", color: "text-amber-400", bg: "rgba(251,191,36,0.08)", border: "rgba(251,191,36,0.15)" },
];

const walletTypeLabels: Record<string, string> = {
  ledger: "Ledger Nano",
  metamask: "MetaMask",
  walletconnect: "WalletConnect",
  coinbase: "Coinbase Wallet",
  other: "Web3 Wallet",
};

const profitGreen = "oklch(0.78 0.19 155)";

export default function WalletPanel({
  walletAddress, walletType, copytradeEnabled = false, killSwitchActive = false,
  maxPositionSize = 10, maxDailyLoss = 5, onKillSwitch, onRevoke, onConnected,
}: WalletPanelProps) {
  const { disconnect } = useDisconnect();
  const [modalOpen, setModalOpen] = useState(false);
  const [killActive, setKillActive] = useState(killSwitchActive);
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revokeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isConnected = !!walletAddress;

  useEffect(() => { setKillActive(killSwitchActive); }, [killSwitchActive]);
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      if (revokeTimeoutRef.current) clearTimeout(revokeTimeoutRef.current);
    };
  }, []);

  const handleKillSwitch = () => {
    const next = !killActive;
    setKillActive(next);
    onKillSwitch?.(next);
  };

  const handleCopyAddress = () => {
    if (walletAddress) {
      navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRevoke = () => {
    if (revokeConfirm) {
      onRevoke?.();
      setRevokeConfirm(false);
      if (revokeTimeoutRef.current) clearTimeout(revokeTimeoutRef.current);
    } else {
      setRevokeConfirm(true);
      if (revokeTimeoutRef.current) clearTimeout(revokeTimeoutRef.current);
      revokeTimeoutRef.current = setTimeout(() => setRevokeConfirm(false), 4000);
    }
  };

  const truncate = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <>
      <div className="glass-card rounded-2xl border-border/50">
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-border/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center border ${
                isConnected ? "bg-primary/10 border-primary/20 text-primary" : "bg-muted/20 border-border/30 text-muted-foreground"
              }`}>
                {isConnected ? <HardDrive className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
              </div>
              <div>
                <p className="text-foreground font-semibold text-sm">
                  {isConnected ? walletTypeLabels[walletType || "other"] : "Wallet"}
                </p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className={`w-1.5 h-1.5 rounded-full ${
                    isConnected && !killActive ? "bg-green-500 shadow-[0_0_6px] shadow-green-500/50"
                    : isConnected && killActive ? "bg-amber-400"
                    : "bg-muted-foreground/30"
                  }`} />
                  <span className="text-xs text-muted-foreground">
                    {isConnected
                      ? killActive ? "Kill switch active" : copytradeEnabled ? "Copytrade live" : "Connected · Awaiting signals"
                      : "Not connected"}
                  </span>
                </div>
              </div>
            </div>
            {isConnected && (
              <button onClick={() => setShowDetails(!showDetails)} className="min-h-10 min-w-10 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60" aria-label={showDetails ? "Hide wallet details" : "Show wallet details"}>
                {showDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            )}
          </div>
        </div>

        {/* Not connected state */}
        {!isConnected && (
          <div className="p-5">
            <p className="text-muted-foreground text-sm leading-relaxed mb-5">
              Connect your Ledger Nano or Web3 wallet to enable copytrade signal routing. Your funds stay on your device — Anavitrade only mirrors trade signals.
            </p>
            <div className="grid grid-cols-2 gap-2 mb-5">
              {securityBadges.map((badge, i) => (
                <div key={i} className={`flex items-center gap-2 px-3 py-2 rounded-lg ${badge.color} bg-muted/20 border border-border/30`}>
                  <span>{badge.icon}</span>
                  <span className="text-xs font-medium">{badge.label}</span>
                </div>
              ))}
            </div>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setModalOpen(true)}
              className="btn-azure w-full py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2"
            >
              <Wifi className="w-4 h-4" />
              Connect Wallet
            </motion.button>
          </div>
        )}

        {/* Connected state */}
        {isConnected && (
          <div className="p-5 space-y-4">
            {/* Address row */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-muted/20 border border-border/30">
              <div>
                <p className="text-muted-foreground text-xs mb-0.5">Wallet Address</p>
                <p className="text-foreground font-mono text-sm">{truncate(walletAddress!)}</p>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={handleCopyAddress}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-muted/30 text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60" aria-label={copied ? "Wallet address copied" : "Copy wallet address"}>
                  {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
                <a href={`https://etherscan.io/address/${walletAddress}`} target="_blank" rel="noopener noreferrer"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-muted/30 text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60" aria-label="Open wallet address on Etherscan">
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>

            {/* Copytrade status */}
            <div className={`flex items-center justify-between p-3 rounded-xl border ${
              copytradeEnabled && !killActive ? "bg-green-500/5 border-green-500/15" : "bg-muted/20 border-border/30"
            }`}>
              <div className="flex items-center gap-2">
                <Activity className={`w-4 h-4 ${copytradeEnabled && !killActive ? "text-green-500" : "text-muted-foreground"}`} />
                <div>
                  <p className="text-foreground text-sm font-medium">Copytrade</p>
                  <p className="text-muted-foreground text-xs">
                    {killActive ? "Paused by kill switch" : copytradeEnabled ? "Receiving signals" : "Ready for signal routing"}
                  </p>
                </div>
              </div>
              <div className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                killActive ? "bg-amber-500/10 text-amber-400"
                : copytradeEnabled ? "bg-green-500/10 text-green-500"
                : "bg-muted/20 text-muted-foreground"
              }`}>
                {killActive ? "Paused" : copytradeEnabled ? "Live" : "Pending"}
              </div>
            </div>

            {/* Kill switch */}
            <div className={`p-3 rounded-xl border ${
              killActive ? "bg-amber-500/10 border-amber-500/20" : "bg-muted/20 border-border/30"
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap className={`w-4 h-4 ${killActive ? "text-amber-400" : "text-muted-foreground"}`} />
                  <div>
                    <p className="text-foreground text-sm font-medium">Kill Switch</p>
                    <p className="text-muted-foreground text-xs">Instantly halts all signal routing</p>
                  </div>
                </div>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleKillSwitch}
                  className={`min-h-10 px-4 py-1.5 rounded-lg text-xs font-bold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
                    killActive
                      ? "bg-amber-400 text-background"
                      : "text-amber-400 border border-amber-400/30"
                  }`}>
                  {killActive ? "RESUME" : "HALT"}
                </motion.button>
              </div>
              {killActive && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="mt-3 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                  <p className="text-amber-400/70 text-xs">All copytrade signals are paused. No new transactions will be sent to your wallet until you resume.</p>
                </motion.div>
              )}
            </div>

            {/* Expandable details */}
            <AnimatePresence>
              {showDetails && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-3 overflow-hidden"
                >
                  {/* Risk limits */}
                  <div className="p-3 rounded-xl bg-muted/20 border border-border/30 space-y-2">
                    <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider mb-2">Risk Limits</p>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground/70 text-xs">Max position size</span>
                      <span className="text-foreground text-xs font-semibold">{maxPositionSize}% of portfolio</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground/70 text-xs">Max daily loss</span>
                      <span className="text-red-400 text-xs font-semibold">{maxDailyLoss}% auto-pause</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    {securityBadges.map((badge, i) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/20 border border-border/30">
                        <span>{badge.icon}</span>
                        <span className="text-xs font-medium text-muted-foreground">{badge.label}</span>
                      </div>
                    ))}
                  </div>

                  <button onClick={handleRevoke}
                    className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border py-2.5 text-xs font-semibold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
                      revokeConfirm
                        ? "bg-red-500/20 border-red-500/40 text-red-400"
                        : "bg-transparent border-red-500/20 text-red-400 hover:bg-red-500/5"
                    }`}>
                    {revokeConfirm ? (
                      <><AlertTriangle className="w-3.5 h-3.5" /> Click again to confirm revocation</>
                    ) : (
                      <><RefreshCw className="w-3.5 h-3.5" /> Revoke Wallet Access</>
                    )}
                  </button>

                  <button onClick={() => disconnect()}
                    className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border py-2.5 text-xs font-semibold transition-all bg-transparent border-border/30 text-muted-foreground hover:bg-muted/20 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                    <LogOut className="w-3.5 h-3.5" /> Disconnect Wallet
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {!showDetails && (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-primary/5 border border-primary/15">
                <TrendingUp className="w-3.5 h-3.5 text-primary mt-0.5 flex-shrink-0" />
                <p className="text-muted-foreground text-xs leading-relaxed">
                  <strong className="text-foreground/60">Your funds never leave your wallet.</strong> Anavitrade routes trade signals to your device — each transaction requires your physical approval on the hardware.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <WalletConnectModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onConnected={(addr, type) => {
          setModalOpen(false);
          onConnected?.(addr, type);
        }}
      />
    </>
  );
}
