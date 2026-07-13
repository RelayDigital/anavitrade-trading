import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import {
  Shield, Cpu, Smartphone, ChevronRight, X, CheckCircle2,
  Lock, Eye, AlertTriangle, Wifi, HardDrive, Zap, Loader2, ExternalLink, Usb, Bluetooth
} from "lucide-react";
import { useConnect, useAccount, useDisconnect, useChainId } from "wagmi";

interface WalletConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnected?: (address: string, walletType: string) => void;
}

type WalletOption = {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  badge?: string;
  badgeColor?: string;
  recommended?: boolean;
  connectorId: string;
};

const connectorAliases: Record<string, string[]> = {
  ledger: ["walletConnect", "walletconnect"],
  walletconnect: ["walletConnect", "walletconnect"],
  metamask: ["metaMask", "metaMaskSDK", "io.metamask", "injected"],
  coinbase: ["coinbaseWallet", "coinbaseWalletSDK", "coinbase wallet", "coinbase", "com.coinbase.wallet"],
};

const walletOptions: WalletOption[] = [
  {
    id: "ledger",
    name: "Ledger Nano",
    description: "Hardware wallet — maximum security. Your keys never leave the device.",
    icon: (
      <svg viewBox="0 0 32 32" className="w-8 h-8" fill="none">
        <rect width="32" height="32" rx="8" fill="#000" />
        <rect x="6" y="10" width="14" height="12" rx="1" fill="white" />
        <rect x="22" y="18" width="4" height="4" rx="0.5" fill="white" />
      </svg>
    ),
    badge: "Most Secure",
    badgeColor: "text-primary bg-primary/10 border-primary/20",
    recommended: true,
    connectorId: "walletConnect",
  },
  {
    id: "metamask",
    name: "MetaMask",
    description: "Browser extension wallet. Connect your existing MetaMask account.",
    icon: (
      <svg viewBox="0 0 32 32" className="w-8 h-8" fill="none">
        <rect width="32" height="32" rx="8" fill="#F6851B" />
        <path d="M26 6L18 12l1.5-4.5L26 6z" fill="#E2761B" />
        <path d="M6 6l7.9 6.1L12.5 7.5 6 6z" fill="#E4761B" />
        <path d="M23.2 21.5l-2.1 3.2 4.5 1.2 1.3-4.3-3.7-.1z" fill="#E4761B" />
        <path d="M5.1 21.6l1.3 4.3 4.5-1.2-2.1-3.2-3.7.1z" fill="#E4761B" />
        <path d="M10.6 14.5l-1.3 2 4.6.2-.2-4.9-3.1 2.7z" fill="#E4761B" />
        <path d="M21.4 14.5l-3.2-2.8-.1 4.9 4.6-.2-1.3-1.9z" fill="#E4761B" />
        <path d="M10.9 24.7l2.8-1.3-2.4-1.9-.4 3.2z" fill="#E4761B" />
        <path d="M18.3 23.4l2.8 1.3-.4-3.2-2.4 1.9z" fill="#E4761B" />
      </svg>
    ),
    badge: "Popular",
    badgeColor: "text-orange-400 bg-orange-400/10 border-orange-400/20",
    connectorId: "metaMask",
  },
  {
    id: "walletconnect",
    name: "WalletConnect",
    description: "Scan QR code with any compatible mobile wallet app.",
    icon: (
      <svg viewBox="0 0 32 32" className="w-8 h-8" fill="none">
        <rect width="32" height="32" rx="8" fill="#3B99FC" />
        <path d="M9.6 12.8c3.5-3.5 9.3-3.5 12.8 0l.4.4c.2.2.2.5 0 .7l-1.4 1.4c-.1.1-.3.1-.4 0l-.6-.6c-2.5-2.5-6.5-2.5-9 0l-.6.6c-.1.1-.3.1-.4 0L8.9 14c-.2-.2-.2-.5 0-.7l.7-.5zm15.8 2.9l1.2 1.2c.2.2.2.5 0 .7l-5.5 5.5c-.2.2-.5.2-.7 0l-3.9-3.9c-.1-.1-.2-.1-.3 0l-3.9 3.9c-.2.2-.5.2-.7 0L6.4 17.6c-.2-.2-.2-.5 0-.7l1.2-1.2c.2-.2.5-.2.7 0l3.9 3.9c.1.1.2.1.3 0l3.9-3.9c.2-.2.5-.2.7 0l3.9 3.9c.1.1.2.1.3 0l3.9-3.9c.2-.2.5-.2.7 0z" fill="white" />
      </svg>
    ),
    badge: "Mobile",
    badgeColor: "text-blue-400 bg-blue-400/10 border-blue-400/20",
    connectorId: "walletConnect",
  },
  {
    id: "coinbase",
    name: "Coinbase Wallet",
    description: "Connect via Coinbase Wallet browser extension or mobile app.",
    icon: (
      <svg viewBox="0 0 32 32" className="w-8 h-8" fill="none">
        <rect width="32" height="32" rx="8" fill="#0052FF" />
        <circle cx="16" cy="16" r="8" fill="white" />
        <rect x="12" y="13" width="8" height="6" rx="1.5" fill="#0052FF" />
      </svg>
    ),
    badge: "Institutional",
    badgeColor: "text-blue-300 bg-blue-300/10 border-blue-300/20",
    connectorId: "coinbaseWallet",
  },
];

const securityGuarantees = [
  { icon: <Lock className="w-4 h-4" />, text: "Your private keys never leave your device" },
  { icon: <Shield className="w-4 h-4" />, text: "Anavitrade has zero custody of your funds" },
  { icon: <Eye className="w-4 h-4" />, text: "Read-only address verification only" },
  { icon: <Zap className="w-4 h-4" />, text: "Revoke access instantly at any time" },
];

type ModalStep = "select" | "ledger-guide" | "ledger-connecting-direct" | "connecting" | "saving" | "success" | "error";
type LedgerTransport = "usb" | "bluetooth" | "walletconnect";

export default function WalletConnectModal({ isOpen, onClose, onConnected }: WalletConnectModalProps) {
  const [, navigate] = useLocation();
  const [step, setStep] = useState<ModalStep>("select");
  const [selectedWallet, setSelectedWallet] = useState<WalletOption | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [hasSaved, setHasSaved] = useState(false);
  const [ledgerTransport, setLedgerTransport] = useState<LedgerTransport | null>(null);
  const [directAddress, setDirectAddress] = useState<string | null>(null);
  const [connectKitAvailable, setConnectKitAvailable] = useState<boolean | null>(null);
  const connectKitRef = useRef<{ getProvider: (opts: { chainId?: number }) => Promise<{ request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }> } | null>(null);

  // Real wagmi hooks
  const { connectors, connect, isPending: isWagmiConnecting, error: wagmiError } = useConnect();
  const { address: wagmiAddress, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();

  const saveWalletMutation = trpc.web3Wallet.connect.useMutation();
  const utils = trpc.useUtils();

  // Connection timeout guard — prevents indefinite spinner if wallet popup is dismissed silently
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startConnectTimeout = useCallback(() => {
    clearConnectTimeout();
    connectTimeoutRef.current = setTimeout(() => {
      if (step === "connecting" || step === "ledger-connecting-direct") {
        disconnect();
        setErrorMsg("Connection timed out. The wallet popup may have been blocked or dismissed.");
        setStep("error");
      }
    }, 120_000); // 2-minute timeout for wallet popups
  }, [step, disconnect]);

  const clearConnectTimeout = useCallback(() => {
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  }, []);

  // Clean up timeouts and pending connections on unmount or when modal closes
  useEffect(() => {
    if (!isOpen) {
      clearConnectTimeout();
    }
    return () => {
      clearConnectTimeout();
    };
  }, [isOpen, clearConnectTimeout]);

  // Probe connect-kit availability on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { loadConnectKit } = await import("@ledgerhq/connect-kit-loader");
        const ck = await loadConnectKit();
        if (!cancelled) {
          connectKitRef.current = ck as typeof connectKitRef.current;
          setConnectKitAvailable(true);
        }
      } catch {
        if (!cancelled) setConnectKitAvailable(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist to DB once we have a real address (from wagmi OR direct connect-kit)
  const persistWallet = useCallback((addr: string, walletId: string, chain: number) => {
    if (hasSaved) return;
    clearConnectTimeout();
    setHasSaved(true);
    setStep("saving");
    saveWalletMutation.mutate(
      {
        walletAddress: addr,
        walletType: walletId as "ledger" | "metamask" | "walletconnect" | "coinbase" | "other",
        chainId: chain,
        maxDailyLossPct: 5,
      },
      {
        onSuccess: () => {
          utils.web3Wallet.getSession.invalidate();
          setStep("success");
          onConnected?.(addr, walletId);
        },
        onError: (e) => {
          setErrorMsg(e.message || "Failed to register wallet. Please try again.");
          setStep("error");
        },
      }
    );
  }, [hasSaved, saveWalletMutation, utils, onConnected]);

  // When wagmi reports a real connected address (WalletConnect / MetaMask / Coinbase path)
  useEffect(() => {
    if (isConnected && wagmiAddress && step === "connecting" && !hasSaved) {
      clearConnectTimeout();
      persistWallet(wagmiAddress, selectedWallet?.id ?? "other", chainId ?? 1);
    }
  }, [isConnected, wagmiAddress, step, hasSaved, chainId, selectedWallet, persistWallet, clearConnectTimeout]);

  // Catch wagmi connection errors
  useEffect(() => {
    if (wagmiError && step === "connecting") {
      clearConnectTimeout();
      const msg = wagmiError.message || "Wallet connection was rejected.";
      if (msg.toLowerCase().includes("reject") || msg.toLowerCase().includes("denied") || msg.toLowerCase().includes("cancel") || msg.toLowerCase().includes("user refused")) {
        setStep("select");
      } else {
        setErrorMsg(msg);
        setStep("error");
      }
    }
  }, [wagmiError, step, clearConnectTimeout]);

  const findConnector = useCallback((wallet: WalletOption) => {
    const aliases = connectorAliases[wallet.id] ?? [wallet.connectorId];
    return connectors.find((connector) => {
      const connectorText = `${connector.id} ${connector.name}`.toLowerCase();
      return aliases.some((alias) => connectorText.includes(alias.toLowerCase()));
    });
  }, [connectors]);

  const initiateWagmiConnect = useCallback((wallet: WalletOption | null) => {
    if (!wallet) {
      setErrorMsg("Choose a wallet before starting the connection.");
      setStep("error");
      return;
    }

    setSelectedWallet(wallet);
    setStep("connecting");
    startConnectTimeout();

    const connector = findConnector(wallet);
    if (!connector) {
      clearConnectTimeout();
      if (wallet.id === "metamask") {
        setErrorMsg("MetaMask was not detected. Install the browser extension, then refresh this page.");
      } else if (wallet.id === "walletconnect" || wallet.id === "ledger") {
        setErrorMsg("WalletConnect is not available. Check VITE_WALLETCONNECT_PROJECT_ID and restart the dev server.");
      } else if (wallet.id === "coinbase") {
        setErrorMsg("Coinbase Wallet is not available. Install Coinbase Wallet, unlock it, or connect through WalletConnect.");
      } else {
        setErrorMsg(`${wallet.name} connector is not available in this browser.`);
      }
      setStep("error");
      return;
    }

    connect({ connector });
  }, [connect, findConnector, startConnectTimeout, clearConnectTimeout]);

  // Direct Ledger USB/Bluetooth via connect-kit-loader
  const connectLedgerDirect = useCallback(async (transport: LedgerTransport) => {
    setLedgerTransport(transport);
    startConnectTimeout();

    // If connect-kit never loaded, go straight to WalletConnect QR fallback
    if (!connectKitRef.current) {
      initiateWagmiConnect(selectedWallet ?? walletOptions[0]);
      return;
    }

    setStep("ledger-connecting-direct");
    try {
      // Pass transport preference via SupportedProviders enum when available;
      // connect-kit resolves the best available transport (USB → Bluetooth → WalletConnect)
      // based on browser capabilities and the user's Ledger device model.
      const providerOptions: { chainId?: number; transport?: string } = { chainId: 1 };
      if (transport === "bluetooth") {
        // Hint to connect-kit to prefer Bluetooth (Nano X only)
        providerOptions.transport = "bluetooth";
      } else if (transport === "usb") {
        // Hint to connect-kit to prefer USB/HID transport
        providerOptions.transport = "usb";
      }
      const provider = await connectKitRef.current.getProvider(providerOptions);
      // Request accounts — triggers the browser permission dialog and Ledger device prompt
      const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
      if (!accounts || accounts.length === 0) throw new Error("No accounts returned from Ledger device.");
      const addr = accounts[0];
      setDirectAddress(addr);
      persistWallet(addr, "ledger", 1);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isUserCancel = msg.toLowerCase().includes("cancel") || msg.toLowerCase().includes("reject") || msg.toLowerCase().includes("denied") || msg.toLowerCase().includes("user refused");
      const isTransportError = msg.toLowerCase().includes("webusb") || msg.toLowerCase().includes("hid") || msg.toLowerCase().includes("transport") || msg.toLowerCase().includes("bluetooth") || msg.toLowerCase().includes("not supported");
      if (isUserCancel) {
        setStep("ledger-guide");
      } else if (isTransportError) {
        // Transport not available — silently fall through to WalletConnect QR
        setLedgerTransport("walletconnect");
        initiateWagmiConnect(selectedWallet ?? walletOptions[0]);
      } else {
        setErrorMsg(msg || "Failed to connect to Ledger device. Ensure it is unlocked and the Ethereum app is open.");
        setStep("error");
      }
    }
  }, [initiateWagmiConnect, persistWallet, selectedWallet]);

  const handleSelectWallet = useCallback((wallet: WalletOption) => {
    setSelectedWallet(wallet);
    setErrorMsg("");
    setHasSaved(false);
    setDirectAddress(null);
    if (wallet.id === "ledger") {
      setStep("ledger-guide");
    } else {
      initiateWagmiConnect(wallet);
    }
  }, [initiateWagmiConnect]);

  const handleClose = useCallback(() => {
    clearConnectTimeout();
    if (isConnected) disconnect();
    setStep("select");
    setSelectedWallet(null);
    setErrorMsg("");
    setHasSaved(false);
    setDirectAddress(null);
    setLedgerTransport(null);
    onClose();
  }, [onClose, clearConnectTimeout, isConnected, disconnect]);

  const handleGoToDashboard = useCallback(() => {
    handleClose();
    navigate("/dashboard");
  }, [handleClose, navigate]);

  const handleRetry = useCallback(() => {
    clearConnectTimeout();
    if (isConnected) disconnect();
    setStep("select");
    setSelectedWallet(null);
    setErrorMsg("");
    setHasSaved(false);
    setDirectAddress(null);
    setLedgerTransport(null);
  }, [isConnected, disconnect, clearConnectTimeout]);

  const resolvedAddress = directAddress ?? wagmiAddress;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80"
          style={{ backdropFilter: "blur(8px)" }}
          onClick={(e) => e.target === e.currentTarget && handleClose()}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="relative w-full max-w-lg rounded-2xl overflow-hidden bg-card"
            style={{
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: "0 25px 80px rgba(0,0,0,0.8), 0 0 0 1px oklch(0.60 0.22 220 / 0.05)",
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-white/5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-primary/10 border border-primary/20">
                  <Shield className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <h2 className="text-white font-semibold text-base">Connect Wallet</h2>
                  <p className="text-xs text-white/40">Non-custodial · Read-only access</p>
                </div>
              </div>
              <button
                onClick={handleClose}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/5 transition-all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6">
              <AnimatePresence mode="wait">

                {/* Step: Select Wallet */}
                {step === "select" && (
                  <motion.div key="select" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }}>
                    <p className="text-white/60 text-sm mb-5">
                      Choose how you'd like to connect. Your funds remain entirely in your control — Anavitrade only mirrors trade signals to your wallet.
                    </p>
                    {errorMsg && (
                      <div className="mb-4 p-3 rounded-xl text-red-400 text-xs flex items-start gap-2" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.15)" }}>
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                        {errorMsg}
                      </div>
                    )}
                    <div className="space-y-2 mb-6">
                      {walletOptions.map((wallet) => (
                        <motion.button
                          key={wallet.id}
                          whileHover={{ scale: 1.01 }}
                          whileTap={{ scale: 0.99 }}
                          onClick={() => handleSelectWallet(wallet)}
                          className="w-full flex items-center gap-4 p-4 rounded-xl text-left transition-all group"
                          style={{
                            background: wallet.recommended
                              ? "linear-gradient(135deg, oklch(0.60 0.22 220 / 0.06) 0%, oklch(0.60 0.22 220 / 0.02) 100%)"
                              : "rgba(255,255,255,0.03)",
                            border: wallet.recommended
                              ? "1px solid oklch(0.60 0.22 220 / 0.15)"
                              : "1px solid rgba(255,255,255,0.06)",
                          }}
                        >
                          <div className="flex-shrink-0">{wallet.icon}</div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-white font-medium text-sm">{wallet.name}</span>
                              {wallet.badge && (
                                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${wallet.badgeColor}`}>
                                  {wallet.badge}
                                </span>
                              )}
                            </div>
                            <p className="text-white/40 text-xs leading-relaxed">{wallet.description}</p>
                          </div>
                          <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/60 transition-colors flex-shrink-0" />
                        </motion.button>
                      ))}
                    </div>
                    <div className="rounded-xl p-4 border border-primary/8 bg-primary/[0.04]">
                      <p className="text-primary text-xs font-semibold uppercase tracking-wider mb-3">Security Guarantees</p>
                      <div className="grid grid-cols-2 gap-2">
                        {securityGuarantees.map((g, i) => (
                          <div key={i} className="flex items-start gap-2">
                            <span className="text-primary mt-0.5 flex-shrink-0">{g.icon}</span>
                            <span className="text-white/50 text-xs leading-relaxed">{g.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* Step: Ledger Guide — choose transport */}
                {step === "ledger-guide" && (
                  <motion.div key="ledger" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }}>
                    <div className="flex items-center gap-3 mb-5">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-black border border-white/10">
                        <HardDrive className="w-5 h-5 text-white" />
                      </div>
                      <div>
                        <h3 className="text-white font-semibold">Ledger Nano Setup</h3>
                        <p className="text-white/40 text-xs">Choose your connection method</p>
                      </div>
                    </div>

                    {/* Transport selection */}
                    <div className="space-y-2 mb-5">
                      {/* USB Direct */}
                      <div
                        className="p-4 rounded-xl cursor-pointer group transition-all border border-primary/12 bg-primary/4"
                        onClick={() => connectLedgerDirect("usb")}
                      >
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10">
                            <Usb className="w-4 h-4 text-primary" />
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-white font-medium text-sm">Connect via USB</span>
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border text-primary bg-primary/10 border-primary/20">Recommended</span>
                            </div>
                            <p className="text-white/40 text-xs mt-0.5">Direct hardware connection — fastest and most reliable</p>
                          </div>
                          <ChevronRight className="w-4 h-4 text-white/30 group-hover:text-primary transition-colors" />
                        </div>
                        <div className="ml-11 space-y-1">
                          {["Plug your Ledger Nano X or S Plus into USB", "Unlock with your PIN", "Open the Ethereum app on your Ledger"].map((s, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <span className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-primary bg-primary/10">{i + 1}</span>
                              <span className="text-white/40 text-xs">{s}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Bluetooth Direct */}
                      <div
                        className="p-4 rounded-xl cursor-pointer group transition-all"
                        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                        onClick={() => connectLedgerDirect("bluetooth")}
                      >
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "rgba(59,130,246,0.1)" }}>
                            <Bluetooth className="w-4 h-4 text-blue-400" />
                          </div>
                          <div className="flex-1">
                            <span className="text-white font-medium text-sm">Connect via Bluetooth</span>
                            <p className="text-white/40 text-xs mt-0.5">Wireless connection — Ledger Nano X only</p>
                          </div>
                          <ChevronRight className="w-4 h-4 text-white/30 group-hover:text-blue-400 transition-colors" />
                        </div>
                        <div className="ml-11 space-y-1">
                          {["Enable Bluetooth on your Ledger Nano X", "Unlock with your PIN", "Open the Ethereum app on your Ledger"].map((s, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <span className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-blue-400" style={{ background: "rgba(59,130,246,0.1)" }}>{i + 1}</span>
                              <span className="text-white/40 text-xs">{s}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* WalletConnect QR fallback */}
                      <div
                        className="p-4 rounded-xl cursor-pointer group transition-all"
                        style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}
                        onClick={() => initiateWagmiConnect(selectedWallet!)}
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "rgba(59,153,252,0.1)" }}>
                            <Wifi className="w-4 h-4 text-blue-300" />
                          </div>
                          <div className="flex-1">
                            <span className="text-white/70 font-medium text-sm">Use WalletConnect QR</span>
                            <p className="text-white/30 text-xs mt-0.5">Scan QR code with Ledger Live mobile app</p>
                          </div>
                          <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/50 transition-colors" />
                        </div>
                      </div>
                    </div>

                    <div className="p-3 rounded-xl mb-5 flex items-start gap-2 border border-primary/10 bg-primary/5">
                      <Shield className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                      <p className="text-white/50 text-xs leading-relaxed">
                        <strong className="text-white/70">The Golden Rule:</strong> Anavitrade is a signal router, not a custodian. Your Ledger is the only thing that can sign and broadcast transactions. If you don't press confirm on the device, nothing happens.
                      </p>
                    </div>

                    <button
                      onClick={() => setStep("select")}
                      className="w-full py-2.5 rounded-xl text-sm font-medium text-white/50 hover:text-white transition-colors"
                      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}
                    >
                      ← Back to wallet selection
                    </button>
                  </motion.div>
                )}

                {/* Step: Direct Ledger connecting */}
                {step === "ledger-connecting-direct" && (
                  <motion.div key="ledger-direct" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="flex flex-col items-center text-center py-6">
                    <div className="relative mb-6">
                      <div className="w-16 h-16 rounded-2xl flex items-center justify-center bg-primary/8 border border-primary/20">
                        {ledgerTransport === "bluetooth"
                          ? <Bluetooth className="w-7 h-7 text-blue-400" />
                          : <Usb className="w-7 h-7 text-primary" />}
                      </div>
                      <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-sidebar border border-white/10 flex items-center justify-center">
                        <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
                      </div>
                    </div>
                    <h3 className="text-white font-semibold text-lg mb-2">
                      {ledgerTransport === "bluetooth" ? "Connecting via Bluetooth…" : "Connecting via USB…"}
                    </h3>
                    <p className="text-white/50 text-sm max-w-xs leading-relaxed mb-2">
                      Your browser will request permission to access the Ledger device. Approve the prompt, then confirm the connection on your Ledger screen.
                    </p>
                    <div className="mt-3 p-3 rounded-xl w-full text-left border border-primary/8 bg-primary/4">
                      {["Ledger is plugged in and unlocked", "Ethereum app is open on the device", "Browser permission dialog approved"].map((s, i) => (
                        <div key={i} className="flex items-center gap-2 py-1">
                          <div className="w-4 h-4 rounded-full flex items-center justify-center bg-primary/10">
                            <span className="text-primary text-[9px] font-bold">{i + 1}</span>
                          </div>
                          <span className="text-white/50 text-xs">{s}</span>
                        </div>
                      ))}
                    </div>
                    <button onClick={handleRetry} className="mt-5 text-white/30 hover:text-white/50 text-xs transition-colors">
                      Cancel
                    </button>
                  </motion.div>
                )}

                {/* Step: WalletConnect / MetaMask / Coinbase connecting */}
                {(step === "connecting" || step === "saving") && (
                  <motion.div key="connecting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="flex flex-col items-center text-center py-6">
                    <div className="relative mb-6">
                      <div className="w-16 h-16 rounded-2xl flex items-center justify-center bg-primary/8 border border-primary/20">
                        {selectedWallet?.icon}
                      </div>
                      <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-sidebar border border-white/10 flex items-center justify-center">
                        <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
                      </div>
                    </div>
                    <h3 className="text-white font-semibold text-lg mb-2">
                      {step === "saving" ? "Registering Wallet…" : `Connecting to ${selectedWallet?.name}`}
                    </h3>
                    {step === "connecting" && selectedWallet?.id === "ledger" && (
                      <p className="text-white/50 text-sm max-w-xs leading-relaxed">
                        A WalletConnect QR code will appear. Open <strong className="text-white/70">Ledger Live</strong> and scan it to approve the connection.
                      </p>
                    )}
                    {step === "connecting" && selectedWallet?.id === "walletconnect" && (
                      <p className="text-white/50 text-sm max-w-xs">Scan the QR code with your mobile wallet to connect.</p>
                    )}
                    {step === "connecting" && selectedWallet?.id === "metamask" && (
                      <p className="text-white/50 text-sm max-w-xs">Check MetaMask and approve the connection request.</p>
                    )}
                    {step === "connecting" && selectedWallet?.id === "coinbase" && (
                      <p className="text-white/50 text-sm max-w-xs">
                        Approve the request in Coinbase Wallet. Anavitrade requests a standard wallet address, not a Coinbase Smart Wallet.
                      </p>
                    )}
                    {step === "saving" && (
                      <p className="text-white/50 text-sm max-w-xs">Saving your wallet address and enabling copytrade signal routing…</p>
                    )}
                    <button onClick={handleRetry} className="mt-5 text-white/30 hover:text-white/50 text-xs transition-colors">
                      Cancel
                    </button>
                  </motion.div>
                )}

                {/* Step: Success */}
                {step === "success" && (
                  <motion.div key="success" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                    className="flex flex-col items-center text-center py-4">
                    <motion.div
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 300, damping: 20 }}
                      className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-primary/12 border border-primary/30"
                    >
                      <CheckCircle2 className="w-8 h-8 text-primary" />
                    </motion.div>
                    <h3 className="text-white font-semibold text-lg mb-1">Wallet Connected</h3>
                    {resolvedAddress && (
                      <p className="text-white/40 text-xs font-mono mb-1">
                        {resolvedAddress.slice(0, 6)}…{resolvedAddress.slice(-4)}
                      </p>
                    )}
                    {ledgerTransport && (
                      <div className="flex items-center gap-1.5 mb-2">
                        {ledgerTransport === "bluetooth"
                          ? <Bluetooth className="w-3 h-3 text-blue-400" />
                          : ledgerTransport === "usb"
                          ? <Usb className="w-3 h-3 text-primary" />
                          : <Wifi className="w-3 h-3 text-blue-300" />}
                        <span className="text-white/40 text-xs capitalize">Connected via {ledgerTransport}</span>
                      </div>
                    )}
                    <p className="text-white/50 text-sm mb-5 max-w-xs leading-relaxed">
                      Your {selectedWallet?.name} is registered. Anavitrade will mirror trade signals to your wallet — your funds stay on your device at all times.
                    </p>
                    <div className="grid grid-cols-2 gap-2 w-full mb-5">
                      {[
                        { icon: Shield, label: "Non-Custodial" },
                        { icon: HardDrive, label: "Keys On-Device" },
                        { icon: Eye, label: "Read-Only Access" },
                        { icon: Zap, label: "Instant Revoke" },
                      ].map(({ icon: Icon, label }) => (
                        <div key={label} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/10">
                          <Icon className="w-3.5 h-3.5 text-primary" />
                          <span className="text-white/60 text-xs">{label}</span>
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={handleGoToDashboard}
                      className="w-full py-3 rounded-xl font-semibold text-sm text-black transition-all active:scale-[0.97]"
                      style={{ background: "linear-gradient(135deg, oklch(0.60 0.22 220), oklch(0.52 0.22 225))" }}
                    >
                      Go to Dashboard →
                    </button>
                  </motion.div>
                )}

                {/* Step: Error */}
                {step === "error" && (
                  <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="flex flex-col items-center text-center py-4">
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                      style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
                      <AlertTriangle className="w-8 h-8 text-red-400" />
                    </div>
                    <h3 className="text-white font-semibold text-lg mb-1">Connection Failed</h3>
                    <p className="text-white/50 text-sm mb-4 max-w-xs leading-relaxed">
                      {errorMsg || "Something went wrong. Please try again."}
                    </p>
                    {errorMsg?.toLowerCase().includes("metamask") && (
                      <a
                        href="https://metamask.io/download/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-primary text-sm mb-4 hover:underline"
                      >
                        Install MetaMask <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                    {errorMsg?.toLowerCase().includes("coinbase") && (
                      <a
                        href="https://www.coinbase.com/wallet/downloads"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-primary text-sm mb-4 hover:underline"
                      >
                        Install Coinbase Wallet <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                    {(errorMsg?.toLowerCase().includes("usb") || errorMsg?.toLowerCase().includes("bluetooth") || errorMsg?.toLowerCase().includes("transport")) && (
                      <button
                        onClick={() => { setErrorMsg(""); initiateWagmiConnect(selectedWallet!); }}
                        className="inline-flex items-center gap-1.5 text-blue-400 text-sm mb-4 hover:underline"
                      >
                        <Wifi className="w-3.5 h-3.5" /> Try WalletConnect QR instead
                      </button>
                    )}
                    <button
                      onClick={handleRetry}
                      className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all active:scale-[0.97]"
                      style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
                    >
                      Try Again
                    </button>
                  </motion.div>
                )}

              </AnimatePresence>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
