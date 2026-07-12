import React, { useState, useMemo, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, ReferenceLine
} from "recharts";
import {
  Shield, Key, TrendingUp, TrendingDown,
  DollarSign, Activity, Settings, LogOut,
  Zap, ZapOff, Clock, HardDrive, Wifi,
  RefreshCw, ChevronLeft, ChevronRight, Trophy, Flame,
  AlertTriangle, CheckCircle2,
  BarChart3, Wallet, Loader2, X, Sparkles,
} from "lucide-react";
import WalletPanel from "@/components/WalletPanel";
import ConnectedExchangesPanel from "@/components/ConnectedExchangesPanel";
import WalletConnectModal from "@/components/WalletConnectModal";
import TradingViewMiniWidgets from "@/components/TradingViewMiniWidgets";
import { toast } from "sonner";

// Live account dashboard — portfolio chart is populated from real trade history once
// a live account is connected. Until then, show an empty state with a CTA.

/** Format a price to a readable string based on magnitude */
function fmtPrice(p: number): string {
  if (p === 0) return "—";
  if (p < 0.0001) return p.toFixed(8);
  if (p < 0.001) return p.toFixed(6);
  if (p < 1) return p.toFixed(4);
  if (p < 1000) return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return p.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/** Format a UTC timestamp string from coinlegs: "05 Jul 2026 12:00" → "Jul 5, 12:00" */
function fmtSignalDate(utcStr: string | null | undefined, fallback: string | Date): string {
  // Prefer the human-readable UTC string from coinlegs
  if (utcStr) {
    // "05 Jul 2026 12:00" → parse and reformat
    try {
      const d = new Date(utcStr + " UTC");
      if (!isNaN(d.getTime())) {
        return d.toLocaleString([], {
          month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit",
          timeZoneName: "short",
        });
      }
    } catch { /* fall through */ }
  }
  // Fallback: use the stored timestamp
  const d = typeof fallback === "string" ? new Date(fallback) : fallback;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Is this signal a "winner"? Buy + ≥3% 24h gain */
function isWinner(signal: number, pct: number | null): boolean {
  return signal === 1 && pct !== null && pct >= 3;
}

export default function Dashboard() {
  const [, navigate] = useLocation();
  const { user, logout } = useAuth();

  const { data: liveData, refetch } = trpc.liveAccount.get.useQuery();
  const account = liveData?.account;

  const { data: asterStatus, refetch: refetchAster } = trpc.aster.getStatus.useQuery();
  const { data: web3Session, refetch: refetchWeb3 } = trpc.web3Wallet.getSession.useQuery();

  const asterConnected = asterStatus?.status === "active";
  const asterPending = asterStatus?.status === "pending_approval";
  const web3Connected = web3Session?.status === "active";
  const anyConnected = asterConnected || web3Connected;

  const statusLabel = asterConnected ? "Aster Live"
    : web3Connected ? "Wallet Connected"
    : asterPending ? "Aster Pending"
    : "Not Connected";

  const statusColor = asterConnected || web3Connected
    ? "bg-primary/10 border-primary/20 text-primary"
    : asterPending
      ? "bg-amber-400/10 border-amber-400/20 text-amber-400"
      : "bg-border/50 border-border text-muted-foreground";

  const dotColor = asterConnected || web3Connected ? "bg-primary animate-pulse"
    : asterPending ? "bg-amber-400"
    : "bg-muted-foreground";

  const toggleWeb3Kill = trpc.web3Wallet.toggleKillSwitch.useMutation({
    onSuccess: (d) => {
      toast.success(d.killSwitchActive ? "Kill switch activated." : "Kill switch deactivated.");
      refetchWeb3();
    },
    onError: () => toast.error("Failed to toggle kill switch."),
  });

  const revokeWeb3 = trpc.web3Wallet.revoke.useMutation({
    onSuccess: () => { toast.success("Wallet revoked."); refetchWeb3(); },
    onError: () => toast.error("Failed to revoke wallet."),
  });

  const toggleKill = trpc.liveAccount.toggleKillSwitch.useMutation({
    onSuccess: (d) => {
      toast.success(d.killSwitchActive ? "Kill switch activated." : "Kill switch deactivated.");
      refetch();
    },
    onError: () => toast.error("Failed to toggle kill switch."),
  });

  const killActive = account?.killSwitchActive ?? web3Session?.killSwitchActive ?? false;

  // ── First-run wizard ──
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const wizardSteps = [
    { title: "Welcome to Anavitrade", desc: "You're in Demo mode — the portfolio below shows simulated paper trades from our live signals. Try it out.", icon: <Sparkles className="w-6 h-6" /> },
    { title: "Connect a wallet", desc: "Link a wallet to activate DEX execution. Your funds stay in your own account — we never get withdrawal access.", icon: <Wallet className="w-6 h-6" /> },
    { title: "You're all set", desc: "Toggle between Demo and Live mode anytime from the top bar. Let's start trading.", icon: <CheckCircle2 className="w-6 h-6" /> },
  ];

  // ── Inline Aster Activation ──
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [showActivationPanel, setShowActivationPanel] = useState(false);
  const activate = trpc.aster.activateWithWallet.useMutation({
    onSuccess: () => {
      toast.success("Aster execution activated!");
      refetchAster();
      refetch();
      setShowActivationPanel(false);
    },
    onError: (e) => toast.error(e.message || "Failed to activate Aster."),
  });

  // When a wallet is connected while the activation panel is open, auto-activate
  useEffect(() => {
    if (showActivationPanel && web3Connected && !activate.isPending && !asterConnected) {
      if (web3Session?.walletAddress) {
        activate.mutate({ walletAddress: web3Session.walletAddress });
      }
    }
  }, [web3Connected, showActivationPanel, web3Session?.walletAddress]);

  // ── Display Mode ──
  const { data: displayModeData, refetch: refetchDisplayMode } = trpc.liveAccount.getDisplayMode.useQuery();
  const currentMode = displayModeData?.mode ?? "live";
  const isDemoMode = currentMode === "demo";

  const setDisplayMode = trpc.liveAccount.setDisplayMode.useMutation({
    onSuccess: (d) => {
      refetchDisplayMode();
      toast.success(d.mode === "demo" ? "Switched to Demo mode — data is simulated paper trades." : "Switched to Live mode.");
    },
    onError: () => toast.error("Failed to switch display mode."),
  });

  // ── Demo Data (fetched only when in demo mode) ──
  const { data: myDemoData } = trpc.demo.getMyDemo.useQuery(undefined, { enabled: isDemoMode });
  const { data: demoTradesData, refetch: refetchDemoTrades } = trpc.demo.getMyTrades.useQuery(undefined, { enabled: isDemoMode });
  const { data: demoPortfolioSeries, refetch: refetchDemoSeries } = trpc.demo.getMyPortfolioSeries.useQuery(undefined, { enabled: isDemoMode });
  const syncDemo = trpc.demo.syncMySignals.useMutation({
    onSuccess: (r) => {
      toast.success(`${r.tradesCreated} trade${r.tradesCreated !== 1 ? "s" : ""} synced`);
      refetchDemoTrades();
      refetchDemoSeries();
    },
    onError: (e) => toast.error(`Sync failed: ${e.message}`),
  });

  // ── Derived demo state ──
  const demoAccount = myDemoData?.account;
  const demoStartingCapital = demoAccount ? parseFloat(demoAccount.startingCapital) : 10000;
  const demoCurrentBalance = demoAccount ? parseFloat(demoAccount.currentBalance) : demoStartingCapital;
  const demoTotalPnl = demoCurrentBalance - demoStartingCapital;
  const demoPnlPercent = demoStartingCapital > 0 ? ((demoTotalPnl / demoStartingCapital) * 100).toFixed(2) : "0.00";

  const closedTrades = useMemo(() => {
    if (!demoTradesData) return [];
    return demoTradesData.filter((t) => t.status === "closed");
  }, [demoTradesData]);

  const wins = closedTrades.filter((t) => parseFloat(String(t.pnl ?? "0")) > 0);
  const losses = closedTrades.filter((t) => parseFloat(String(t.pnl ?? "0")) <= 0);
  const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
  const avgProfit = wins.length > 0 ? wins.reduce((s, t) => s + parseFloat(String(t.pnl ?? "0")), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + parseFloat(String(t.pnl ?? "0")), 0) / losses.length : 0;
  const profitFactor = avgLoss < 0 ? Math.abs(avgProfit / avgLoss) : 0;
  const bestTrade = closedTrades.length > 0
    ? closedTrades.reduce((best, t) => parseFloat(String(t.pnlPct ?? "0")) > parseFloat(String(best.pnlPct ?? "0")) ? t : best, closedTrades[0])
    : null;

  // ── Portfolio data (demo or live) ──
  const portfolioData: { day: string; value: number }[] = [];
  const startBalance = 0;
  const currentBalance = 0;
  const totalPnl = 0;
  const pnlPct = "0.00";

  // Signal feed state
  const [tierFilter, setTierFilter] = useState<"all" | "A" | "B" | "C">("all");
  const [signalPeriod, setSignalPeriod] = useState<string>("all");
  const [signalPage, setSignalPage] = useState(0);
  const [sortBy, setSortBy] = useState<"quality" | "date">("quality");
  const SIGNALS_PER_PAGE = 20;

  const { data: signalsData, isLoading: signalsLoading, refetch: refetchSignals } = trpc.signals.list.useQuery({
    page: signalPage,
    limit: SIGNALS_PER_PAGE,
    tier: tierFilter,
    period: signalPeriod === "all" ? undefined : signalPeriod,
    sortBy,
  });

  const allSignals = signalsData?.signals ?? [];
  const signals = allSignals;
  const signalsTotal = signalsData?.total ?? 0;
  const signalsMaxPage = Math.max(0, Math.ceil(signalsTotal / SIGNALS_PER_PAGE) - 1);

  // Top 3 winners (Buy + biggest 24h gain) across current page
  const topWinners = useMemo(() => {
    return [...allSignals]
      .filter(s => s.signal === 1 && s.percentage24 != null && parseFloat(String(s.percentage24)) >= 3)
      .sort((a, b) => parseFloat(String(b.percentage24)) - parseFloat(String(a.percentage24)))
      .slice(0, 3);
  }, [allSignals]);

  // Map signalId → rank (1-3) for gold row highlighting
  const winnerRankMap = useMemo(() => {
    const map = new Map<number, number>();
    topWinners.forEach((s, i) => map.set(s.id, i + 1));
    return map;
  }, [topWinners]);

  const handleKillSwitch = () => {
    if (web3Connected) toggleWeb3Kill.mutate({ active: !killActive });
    else if (asterConnected) toggleKill.mutate({ active: !killActive });
  };

  const rankMedals = ["🥇", "🥈", "🥉"];

  return (
    <><div className="min-h-screen bg-background">
      {/* Top nav */}
      <div className="border-b px-6 py-4 sticky top-0 z-40" style={{ borderColor: "oklch(0.60 0.22 220 / 0.12)", background: "oklch(0.07 0.015 255 / 0.85)", backdropFilter: "blur(24px)" }}>
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center font-bold text-sm" style={{ background: "linear-gradient(135deg, oklch(0.60 0.22 220), oklch(0.45 0.18 240))", color: "white" }}>A</div>
              <span className="font-heading font-bold text-foreground hidden sm:block">Anavitrade</span>
            </div>
          </Link>
          <div className="flex items-center gap-2">
            {/* Mode Toggle */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-lg border" style={{ borderColor: "oklch(0.60 0.22 220 / 0.15)", background: "oklch(0.08 0.012 260 / 0.5)" }}>
              <button
                onClick={() => { if (currentMode !== "live") setDisplayMode.mutate({ mode: "live" }); }}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all ${currentMode === "live" ? "bg-primary/20 text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                Live
              </button>
              <button
                onClick={() => { if (currentMode !== "demo") setDisplayMode.mutate({ mode: "demo" }); }}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all ${isDemoMode ? "bg-primary/20 text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                Demo
              </button>
            </div>
            <div className={`hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium ${statusColor}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
              {statusLabel}
            </div>
            <Link href="/settings">
              <button className="p-2 rounded-xl hover:bg-card transition-colors text-muted-foreground hover:text-foreground">
                <Settings className="w-4 h-4" />
              </button>
            </Link>
            <button
              onClick={() => { logout(); navigate("/"); }}
              className="p-2 rounded-xl hover:bg-card transition-colors text-muted-foreground hover:text-red-400"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Welcome row */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-heading font-bold text-foreground">
              Welcome back{user?.name ? `, ${user.name.split(" ")[0]}` : ""}
            </h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              {new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
            </p>
          </div>
          {anyConnected && (
            <button
              onClick={handleKillSwitch}
              disabled={toggleKill.isPending || toggleWeb3Kill.isPending}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-50 ${
                killActive
                  ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
                  : "bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20"
              }`}
            >
              {killActive ? <Zap className="w-4 h-4" /> : <ZapOff className="w-4 h-4" />}
              {killActive ? "Resume Trading" : "Kill Switch"}
            </button>
          )}
        </div>

        {/* Inline Aster Activation */}
        {!asterConnected && (
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
              <div className="p-6 rounded-2xl border relative overflow-hidden" style={{ background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.88), oklch(0.09 0.018 255 / 0.94))", borderColor: "oklch(0.60 0.22 220 / 0.18)" }}>
                <div className="absolute top-0 right-0 w-48 h-48 rounded-full blur-[80px] pointer-events-none" style={{ background: "oklch(0.60 0.22 220 / 0.08)" }} />
                <div className="relative z-10 flex flex-col sm:flex-row items-start gap-5">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0" style={{ background: "linear-gradient(135deg, oklch(0.60 0.22 220 / 0.20), oklch(0.60 0.22 220 / 0.05))", border: "1px solid oklch(0.60 0.22 220 / 0.25)" }}>
                    <Zap className="w-6 h-6 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-base font-heading font-semibold text-foreground mb-1">Activate DEX Execution</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed max-w-lg mb-4">
                      Connect your wallet and activate Aster execution in one click. Your funds stay in your account — we never get withdrawal access.
                    </p>

                    {/* Status */}
                    {showActivationPanel ? (
                      <div className="space-y-3">
                        {activate.isPending ? (
                          <div className="flex items-center gap-3 p-4 rounded-xl" style={{ background: "oklch(0.60 0.22 220 / 0.06)", border: "1px solid oklch(0.60 0.22 220 / 0.12)" }}>
                            <Loader2 className="w-5 h-5 text-primary animate-spin" />
                            <div>
                              <p className="text-sm font-medium text-foreground">Activating...</p>
                              <p className="text-xs text-muted-foreground">Generating Agent signer & recording approvals</p>
                            </div>
                          </div>
                        ) : web3Session?.walletAddress ? (
                          <div className="flex items-center gap-3">
                            <div className="flex-1 p-3 rounded-xl" style={{ background: "oklch(0.74 0.18 145 / 0.08)", border: "1px solid oklch(0.74 0.18 145 / 0.2)" }}>
                              <div className="flex items-center gap-2">
                                <CheckCircle2 className="w-4 h-4 text-green-400" />
                                <span className="text-sm text-foreground">Wallet connected</span>
                                <span className="text-xs font-mono text-muted-foreground">{web3Session.walletAddress.slice(0, 6)}...{web3Session.walletAddress.slice(-4)}</span>
                              </div>
                            </div>
                            <button
                              onClick={() => activate.mutate({ walletAddress: web3Session.walletAddress! })}
                              disabled={activate.isPending}
                              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-50"
                              style={{ fontFamily: "var(--font-heading)", color: "oklch(0.14 0.02 255)", background: "var(--grad-arctic)", boxShadow: "inset 0 1px 0 oklch(1 0 0 / 0.4), 0 4px 24px oklch(0.72 0.20 195 / 0.22)" }}
                            >
                              <Zap className="w-3.5 h-3.5" /> Activate Now
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => setShowWalletModal(true)}
                              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-xs font-semibold transition-all hover:bg-primary/90"
                            >
                              <Wallet className="w-3.5 h-3.5" /> Connect Wallet
                            </button>
                            <button
                              onClick={() => setShowActivationPanel(false)}
                              className="px-4 py-2.5 rounded-xl border text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                              style={{ borderColor: "oklch(0.60 0.22 220 / 0.2)" }}
                            >
                              Skip for now
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setShowActivationPanel(true)}
                          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold transition-all"
                          style={{ fontFamily: "var(--font-heading)", color: "oklch(0.14 0.02 255)", background: "var(--grad-arctic)", boxShadow: "inset 0 1px 0 oklch(1 0 0 / 0.4), 0 4px 24px oklch(0.72 0.20 195 / 0.22)" }}
                        >
                          <Zap className="w-3.5 h-3.5" /> Activate Now
                        </button>
                        <button
                          onClick={() => setShowWizard(true)}
                          className="flex items-center gap-2 px-5 py-2.5 rounded-xl border text-xs font-medium text-foreground transition-all hover:bg-card"
                          style={{ borderColor: "oklch(0.60 0.22 220 / 0.2)" }}
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
        )}

        <TradingViewMiniWidgets />

        {/* Stats row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[
            {
              label: isDemoMode ? "Demo Balance" : "Portfolio Balance",
              value: isDemoMode
                ? `$${demoCurrentBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : `$${currentBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
              icon: <DollarSign className="w-4 h-4" />,
              sub: isDemoMode ? "Simulated paper balance" : (anyConnected ? "Live account value" : "Connect wallet to track"),
              azure: true,
              gold: isDemoMode,
            },
            {
              label: "Total P&L",
              value: isDemoMode
                ? `${demoTotalPnl >= 0 ? "+" : ""}$${demoTotalPnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : (anyConnected
                  ? `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : "—"),
              icon: (isDemoMode ? demoTotalPnl : totalPnl) >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />,
              sub: isDemoMode ? `${demoPnlPercent}% all time` : (anyConnected ? `${pnlPct}% all time` : "No live data yet"),
              azure: false,
              gold: isDemoMode || (anyConnected && totalPnl > 0),
            },
            {
              label: "Open Positions",
              value: "0",
              icon: <Activity className="w-4 h-4" />,
              sub: "Active trades",
              azure: false,
              gold: false,
            },
            {
              label: "Trading Status",
              value: killActive ? "Paused" : anyConnected ? "Active" : "Offline",
              icon: <Shield className="w-4 h-4" />,
              sub: anyConnected
                ? killActive ? "Kill switch on" : web3Connected ? "Ledger/Web3 ready" : "Aster agent active"
                : "No wallet connected",
              azure: false,
              gold: false,
            },
          ].map((stat, i) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.07, duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
              className="p-5 rounded-2xl border transition-all duration-300 relative overflow-hidden"
              style={stat.gold ? {
                background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.90), oklch(0.09 0.018 255 / 0.95))",
                borderColor: "oklch(0.82 0.16 85 / 0.30)",
                boxShadow: "0 0 0 1px oklch(0.82 0.16 85 / 0.10) inset, 0 0 30px oklch(0.82 0.16 85 / 0.10)",
                backdropFilter: "blur(16px)",
              } : stat.azure ? {
                background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.90), oklch(0.09 0.018 255 / 0.95))",
                borderColor: "oklch(0.60 0.22 220 / 0.25)",
                boxShadow: "0 0 0 1px oklch(0.60 0.22 220 / 0.08) inset, 0 0 30px oklch(0.60 0.22 220 / 0.06)",
                backdropFilter: "blur(16px)",
              } : {
                background: "linear-gradient(145deg, oklch(0.11 0.020 250 / 0.85), oklch(0.08 0.016 255 / 0.90))",
                borderColor: "oklch(0.60 0.22 220 / 0.12)",
                backdropFilter: "blur(12px)",
              }}
            >
              {stat.azure && <div className="absolute top-0 left-0 right-0 h-px" style={{ background: "linear-gradient(to right, transparent, oklch(0.60 0.22 220 / 0.40), transparent)" }} />}
              {stat.gold && <div className="absolute top-0 left-0 right-0 h-px" style={{ background: "linear-gradient(to right, transparent, oklch(0.82 0.16 85 / 0.50), transparent)" }} />}
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-muted-foreground font-medium">{stat.label}</span>
                <div style={stat.gold ? { color: "oklch(0.82 0.16 85)" } : stat.azure ? { color: "oklch(0.68 0.22 220)" } : { color: "oklch(0.50 0.015 260)" }}>{stat.icon}</div>
              </div>
              <div className={`text-xl font-heading font-bold mb-0.5 ${stat.gold ? "gold-shimmer-text" : "text-foreground"}`}>{stat.value}</div>
              <div className="text-xs text-muted-foreground">{stat.sub}</div>
            </motion.div>
          ))}
        </div>

        {/* Chart + Wallet panel */}
        <div className="grid lg:grid-cols-3 gap-6 mb-8">
          <div className="lg:col-span-2 p-6 rounded-2xl border relative overflow-hidden" style={{ background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.90), oklch(0.09 0.018 255 / 0.95))", borderColor: "oklch(0.60 0.22 220 / 0.18)", backdropFilter: "blur(16px)" }}>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-sm font-semibold text-foreground">{isDemoMode ? "Demo Portfolio Growth" : "Portfolio Growth"}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isDemoMode ? "Simulated equity curve from signal history" : (anyConnected ? "Live account equity curve" : "Connect a wallet to see your real equity curve")}
                </p>
              </div>
              {isDemoMode && (
                <button
                  onClick={() => syncDemo.mutate()}
                  disabled={syncDemo.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all disabled:opacity-50"
                  style={{ borderColor: "oklch(0.60 0.22 220 / 0.25)" }}
                >
                  <RefreshCw className={`w-3 h-3 ${syncDemo.isPending ? "animate-spin" : ""}`} />
                  {syncDemo.isPending ? "Syncing..." : "Sync Signals"}
                </button>
              )}
              {!isDemoMode && anyConnected && (
                <div className={`flex items-center gap-1.5 text-sm font-semibold ${totalPnl >= 0 ? "text-primary" : "text-red-400"}`}>
                  {totalPnl >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  {totalPnl >= 0 ? "+" : ""}{pnlPct}%
                </div>
              )}
            </div>
            {isDemoMode && demoPortfolioSeries && demoPortfolioSeries.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={demoPortfolioSeries}>
                  <defs>
                    <linearGradient id="demoGradChart" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="oklch(0.82 0.16 85)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="oklch(0.82 0.16 85)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(1 0 0 / 0.06)" opacity={0.4} />
                  <XAxis dataKey="label" tick={{ fill: "oklch(0.50 0.015 260)", fontSize: 10 }} tickLine={false} axisLine={false} interval={6} />
                  <YAxis domain={["dataMin", "dataMax"]} tick={{ fill: "oklch(0.50 0.015 260)", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    contentStyle={{ background: "oklch(0.10 0.018 250 / 0.96)", border: "1px solid oklch(0.60 0.22 220 / 0.25)", borderRadius: "12px", fontSize: "12px" }}
                    labelStyle={{ color: "oklch(0.62 0.020 240)" }}
                    formatter={(v: number) => [`$${v.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, "Balance"]}
                  />
                  <ReferenceLine y={demoStartingCapital} stroke="oklch(1 0 0 / 0.15)" strokeDasharray="3 3" />
                  <Area type="monotone" dataKey="value" stroke="oklch(0.82 0.16 85)" strokeWidth={2.5} fill="url(#demoGradChart)" dot={false} isAnimationActive animationDuration={1200} animationEasing="ease-out" />
                </AreaChart>
              </ResponsiveContainer>
            ) : isDemoMode && syncDemo.isPending ? (
              <div className="flex items-center justify-center h-[200px] gap-2 text-muted-foreground">
                <RefreshCw className="w-5 h-5 animate-spin" />
                <span className="text-sm">Syncing demo signals...</span>
              </div>
            ) : isDemoMode ? (
              <div className="flex flex-col items-center justify-center h-[200px] gap-3 text-center">
                <BarChart3 className="w-8 h-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No demo trades yet. Click "Sync Signals" above to get started.</p>
              </div>
            ) : anyConnected && portfolioData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={portfolioData}>
                  <defs>
                    <linearGradient id="dashGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="oklch(0.60 0.22 220)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="oklch(0.60 0.22 220)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                  <XAxis dataKey="day" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} tickLine={false} axisLine={false} interval={6} />
                  <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "12px", fontSize: "12px" }}
                    labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                    itemStyle={{ color: "hsl(var(--primary))" }}
                    formatter={(v: number) => [`$${v.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, "Balance"]}
                  />
                  <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#dashGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex flex-col items-center justify-center h-[200px] gap-3 text-center">
                <Activity className="w-8 h-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">
                  {anyConnected ? "No trade history yet — equity curve will appear once trades execute" : "Connect a wallet above to start copy-trading and see your real equity curve here"}
                </p>
                {!anyConnected && (
                    <button
                      onClick={() => document.querySelector<HTMLButtonElement>('[data-wallet-connect-btn]')?.click()}
                      className="text-xs font-semibold text-primary hover:underline"
                    >
                      Connect Wallet →
                    </button>
                )}
              </div>
            )}
          </div>

          <WalletPanel
            walletAddress={web3Session?.walletAddress ?? null}
            walletType={web3Session?.walletType ?? null}
            copytradeEnabled={web3Session?.copytradeEnabled ?? false}
            killSwitchActive={web3Session?.killSwitchActive ?? false}
            maxPositionSize={web3Session?.maxPositionSizeUsd != null ? Number(web3Session.maxPositionSizeUsd) : undefined}
            maxDailyLoss={web3Session?.maxDailyLossPct != null ? Number(web3Session.maxDailyLossPct) : undefined}
            onKillSwitch={(active) => toggleWeb3Kill.mutate({ active })}
            onRevoke={() => revokeWeb3.mutate()}
            onConnected={() => refetchWeb3()}
          />
        </div>

        {/* Gold Winners Podium */}
        <AnimatePresence>
          {topWinners.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
              className="mb-6"
            >
              <div className="relative rounded-2xl border overflow-hidden"
                style={{ background: "linear-gradient(135deg, oklch(0.14 0.013 260), oklch(0.82 0.16 85 / 0.04), oklch(0.14 0.013 260))", borderColor: "oklch(0.82 0.16 85 / 0.20)" }}>
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[400px] h-[100px] rounded-full blur-[60px]"
                    style={{ background: "oklch(0.82 0.16 85 / 0.08)" }} />
                </div>
                <div className="relative z-10 p-6">
                  <div className="flex items-center gap-2 mb-5">
                    <Trophy className="w-4 h-4 trophy-pulse text-gold" />
                    <h3 className="text-sm font-semibold text-foreground">Top Movers</h3>
                    <span className="text-xs text-muted-foreground">— biggest Buy signals by 24h gain</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {topWinners.map((sig, i) => {
                      const pct = parseFloat(String(sig.percentage24));
                      const price = parseFloat(String(sig.price));
                      const pair = sig.marketName.replace("USDT", "/USDT");
                      const maxP = sig.maxProfit != null ? parseFloat(String(sig.maxProfit)) : null;
                      const dur = (sig as any).maxProfitDuration as string | null;
                      return (
                        <motion.div
                          key={(sig as any).rowKey ?? `${sig.id}-${i}`}
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: i * 0.08, duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
                          className="relative rounded-xl p-4 border"
                          style={i === 0 ? {
                            background: "linear-gradient(135deg, oklch(0.82 0.16 85 / 0.10), oklch(0.82 0.16 85 / 0.04))",
                            borderColor: "oklch(0.82 0.16 85 / 0.35)",
                            boxShadow: "0 0 0 1px oklch(0.82 0.16 85 / 0.15), 0 0 20px oklch(0.82 0.16 85 / 0.10)",
                          } : { background: "oklch(0.15 0.014 260)", borderColor: "oklch(0.24 0.015 260 / 0.4)" }}
                        >
                          <div className="flex items-start justify-between mb-3">
                            <span className={`text-lg ${i === 0 ? "trophy-pulse inline-block" : ""}`}>{rankMedals[i]}</span>
                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                              style={i === 0 ? { background: "oklch(0.82 0.16 85 / 0.15)", color: "oklch(0.82 0.16 85)" } : { background: "oklch(0.78 0.19 155 / 0.10)", color: "oklch(0.78 0.19 155)" }}>
                              +{pct.toFixed(2)}%
                            </span>
                          </div>
                          <div className={`font-mono font-bold text-base mb-1 ${i === 0 ? "gold-shimmer-text" : "text-foreground"}`}>{pair}</div>
                          <div className="text-xs text-muted-foreground mb-2">{sig.indicatorName} · {sig.period}</div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-mono text-foreground/70">${fmtPrice(price)}</span>
                            {maxP != null && (
                              <span className="font-semibold" style={{ color: "oklch(0.82 0.16 85)" }}>
                                +{maxP.toFixed(2)}% {dur ? `in ${dur}` : ""}
                              </span>
                            )}
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Demo Trade History (only in demo mode) ── */}
        {isDemoMode && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 rounded-2xl border overflow-hidden"
            style={{ background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.90), oklch(0.09 0.018 255 / 0.95))", borderColor: "oklch(0.60 0.22 220 / 0.18)" }}
          >
            {/* Header */}
            <div className="px-6 py-5 border-b" style={{ borderColor: "oklch(0.60 0.22 220 / 0.10)" }}>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Demo Trade History</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {closedTrades.length} closed trades · {wins.length} wins · {losses.length} losses
                  </p>
                </div>
              </div>
              {/* Summary stats */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-4">
                <div className="p-3 rounded-xl" style={{ background: "oklch(0.60 0.22 220 / 0.05)", border: "1px solid oklch(0.60 0.22 220 / 0.10)" }}>
                  <p className="text-[10px] text-muted-foreground mb-0.5">Win Rate</p>
                  <p className="text-sm font-heading font-bold" style={{ color: "oklch(0.74 0.18 145)" }}>{winRate.toFixed(1)}%</p>
                </div>
                <div className="p-3 rounded-xl" style={{ background: "oklch(0.60 0.22 220 / 0.05)", border: "1px solid oklch(0.60 0.22 220 / 0.10)" }}>
                  <p className="text-[10px] text-muted-foreground mb-0.5">Avg Win</p>
                  <p className="text-sm font-heading font-bold" style={{ color: "oklch(0.74 0.18 145)" }}>+${avgProfit.toFixed(2)}</p>
                </div>
                <div className="p-3 rounded-xl" style={{ background: "oklch(0.60 0.22 220 / 0.05)", border: "1px solid oklch(0.60 0.22 220 / 0.10)" }}>
                  <p className="text-[10px] text-muted-foreground mb-0.5">Avg Loss</p>
                  <p className="text-sm font-heading font-bold" style={{ color: "oklch(0.65 0.22 25)" }}>-${Math.abs(avgLoss).toFixed(2)}</p>
                </div>
                <div className="p-3 rounded-xl" style={{ background: "oklch(0.60 0.22 220 / 0.05)", border: "1px solid oklch(0.60 0.22 220 / 0.10)" }}>
                  <p className="text-[10px] text-muted-foreground mb-0.5">Profit Factor</p>
                  <p className="text-sm font-heading font-bold text-foreground">{profitFactor.toFixed(2)}</p>
                </div>
                <div className="p-3 rounded-xl" style={{ background: "oklch(0.60 0.22 220 / 0.05)", border: "1px solid oklch(0.60 0.22 220 / 0.10)" }}>
                  <p className="text-[10px] text-muted-foreground mb-0.5">Best Trade</p>
                  <p className="text-sm font-heading font-bold gold-shimmer-text">
                    {bestTrade ? `+${parseFloat(String(bestTrade.pnlPct ?? "0")).toFixed(1)}%` : "—"}
                  </p>
                </div>
              </div>
            </div>

            {/* Trades table */}
            {closedTrades.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b" style={{ borderColor: "oklch(0.60 0.22 220 / 0.08)" }}>
                      <th className="text-left text-xs text-muted-foreground font-medium py-3 px-4 whitespace-nowrap">Pair</th>
                      <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Tier</th>
                      <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Indicator</th>
                      <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Period</th>
                      <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">P&L</th>
                      <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Return</th>
                      <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedTrades.slice(0, 20).map((trade) => {
                      const pnl = parseFloat(String(trade.pnl ?? "0"));
                      const pnlPctVal = parseFloat(String(trade.pnlPct ?? "0"));
                      const isWin = pnl > 0;
                      return (
                        <tr key={trade.id} className="border-b last:border-0" style={{ borderColor: "oklch(0.60 0.22 220 / 0.05)" }}>
                          <td className="py-3 px-4">
                            <span className="font-mono text-xs font-bold text-foreground">{trade.pair.replace("USDT", "/USDT")}</span>
                          </td>
                          <td className="py-3 pr-4">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                              trade.qualityTier === "A" ? "bg-amber-500/15 text-amber-400" : trade.qualityTier === "B" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                            }`}>
                              {trade.qualityTier ?? "C"}
                            </span>
                          </td>
                          <td className="py-3 pr-4 text-xs text-muted-foreground">{trade.indicatorName ?? "—"}</td>
                          <td className="py-3 pr-4 text-xs font-mono text-muted-foreground">{trade.period ?? "—"}</td>
                          <td className="py-3 pr-4">
                            <span className={`text-xs font-semibold font-mono ${isWin ? "text-green-400" : "text-red-400"}`}>
                              {isWin ? "+" : ""}${pnl.toFixed(2)}
                            </span>
                          </td>
                          <td className="py-3 pr-4">
                            <span className={`text-xs font-semibold font-mono ${isWin ? "text-green-400" : "text-red-400"}`}>
                              {pnlPctVal >= 0 ? "+" : ""}{pnlPctVal.toFixed(2)}%
                            </span>
                          </td>
                          <td className="py-3 pr-4 text-xs text-muted-foreground">
                            {trade.closedAt ? new Date(trade.closedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
                <BarChart3 className="w-8 h-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No demo trades yet. Click "Sync Signals" above to simulate trades.</p>
              </div>
            )}
          </motion.div>
        )}

        {/* ── Live Signal Feed ── */}
        <div className="rounded-2xl bg-card border border-border/50 overflow-hidden">
          {/* Header */}
          <div className="p-6 border-b border-border/40">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Live Signal Feed</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {signalsTotal > 0 ? `${signalsTotal.toLocaleString()} signals · Aster-routable USDT · Updated every 5 min` : "Loading signals..."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setSortBy(s => s === "quality" ? "date" : "quality"); setSignalPage(0); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border"
                  style={sortBy === "quality" ? {
                    background: "oklch(0.82 0.16 85 / 0.08)",
                    borderColor: "oklch(0.82 0.16 85 / 0.40)",
                    color: "oklch(0.82 0.16 85)",
                    boxShadow: "0 0 12px oklch(0.82 0.16 85 / 0.15)",
                  } : {}}
                >
                  <Trophy className={`w-3 h-3 ${sortBy === "quality" ? "trophy-pulse" : ""}`} />
                  {sortBy === "quality" ? "Best First" : "Latest First"}
                </button>
                <button
                  onClick={() => refetchSignals()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-background border border-border text-xs text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all"
                >
                  <RefreshCw className="w-3 h-3" />
                  Refresh
                </button>
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Tier filter — A/B/C based on confluence scoring */}
              <div className="flex items-center gap-0.5 p-1 rounded-lg bg-background border border-border">
                {(["all", "A", "B", "C"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => { setTierFilter(t); setSignalPage(0); }}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                      tierFilter === t
                        ? t === "A" ? "shadow-sm text-black font-bold"
                          : t === "B" ? "bg-primary/20 text-primary shadow-sm"
                          : t === "C" ? "bg-muted text-foreground shadow-sm"
                          : "bg-muted text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    style={tierFilter === t && t === "A" ? {
                      background: "oklch(0.82 0.16 85)",
                      color: "oklch(0.15 0.014 260)",
                    } : {}}
                  >
                    {t === "all" ? "All" : `Tier ${t}`}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-0.5 p-1 rounded-lg bg-background border border-border">
                {(["all", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => { setSignalPeriod(p); setSignalPage(0); }}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                      signalPeriod === p ? "bg-muted text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/40 bg-background/30">
                  <th className="text-left text-xs text-muted-foreground font-medium py-3 px-3 w-8"></th>
                  <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Signal</th>
                  <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Period</th>
                  <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Name</th>
                  <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Date (UTC)</th>
                  <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Price</th>
                  <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Min / Max Price</th>
                  <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Max Profit</th>
                  <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Duration</th>
                  <th className="text-left text-xs text-muted-foreground font-medium py-3 pr-4 whitespace-nowrap">Score</th>
                </tr>
              </thead>
              <tbody>
                {signalsLoading && (
                  <tr>
                    <td colSpan={10} className="py-10 text-center">
                      <div className="flex items-center justify-center gap-2 text-muted-foreground">
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span className="text-xs">Loading signals...</span>
                      </div>
                    </td>
                  </tr>
                )}

                {!signalsLoading && signals.map((sig, signalIndex) => {
                  const isBuy = sig.signal === 1;
                  const isSell = sig.signal === -1;
                  const pct = sig.percentage24 != null ? parseFloat(String(sig.percentage24)) : null;
                  const price = parseFloat(String(sig.price));
                  const minP = sig.minPrice != null ? parseFloat(String(sig.minPrice)) : null;
                  const maxP = sig.maxPrice != null ? parseFloat(String(sig.maxPrice)) : null;
                  const maxProfit = (sig as any).maxProfit != null ? parseFloat(String((sig as any).maxProfit)) : null;
                  const dur = (sig as any).maxProfitDuration as string | null;
                  const utcStr = (sig as any).signalDateUtc as string | null;
                  const pair = sig.marketName.replace("USDT", "/USDT");
                  const qualityScore = (sig as any).qualityScore as number ?? 0;
                  const qualityTier = (sig as any).qualityTier as string ?? "C";
                  const isGold = qualityTier === "A";
                  const winner = isGold || isWinner(sig.signal, pct);
                  const rank = winnerRankMap.get(sig.id) ?? 0;

                  return (
                    <tr
                      key={(sig as any).rowKey ?? `${sig.id}-${signalIndex}`}
                      className={`border-b border-border/25 last:border-0 transition-colors ${winner ? "winner-row" : "hover:bg-background/40"}`}
                    >
                      {/* Rank indicator */}
                      <td className="py-3 px-3 w-8">
                        {rank > 0 ? (
                          <span className={`text-sm ${rank === 1 ? "trophy-pulse inline-block" : ""}`}>
                            {rankMedals[rank - 1]}
                          </span>
                        ) : winner ? (
                          <Flame className="w-3.5 h-3.5" style={{ color: "oklch(0.82 0.16 85 / 0.6)" }} />
                        ) : null}
                      </td>

                      {/* Signal badge */}
                      <td className="py-3 pr-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold ${
                          isBuy ? "bg-primary/15 text-primary" : isSell ? "bg-red-500/15 text-red-400" : "bg-muted text-muted-foreground"
                        }`}>
                          {isBuy ? "▲ BUY" : isSell ? "▼ SELL" : "■ NEUTRAL"}
                        </span>
                      </td>

                      {/* Period */}
                      <td className="py-3 pr-4">
                        <span className="px-2 py-0.5 rounded bg-background border border-border text-xs font-mono text-foreground">{sig.period}</span>
                      </td>

                      {/* Indicator name + pair */}
                      <td className="py-3 pr-4">
                        <div className={`font-mono text-xs font-bold ${winner ? "text-gold" : "text-foreground"}`}>{pair}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{sig.indicatorName}</div>
                      </td>

                      {/* Date (UTC) */}
                      <td className="py-3 pr-4 text-xs text-muted-foreground whitespace-nowrap font-mono">
                        {fmtSignalDate(utcStr, sig.signalDate)}
                      </td>

                      {/* Price */}
                      <td className="py-3 pr-4 font-mono text-xs text-foreground whitespace-nowrap">
                        ${fmtPrice(price)}
                        {pct !== null && (
                          <span className={`ml-1.5 text-xs font-medium ${winner ? "text-gold" : pct >= 0 ? "text-primary" : "text-red-400"}`}>
                            {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
                          </span>
                        )}
                      </td>

                      {/* Min / Max Price */}
                      <td className="py-3 pr-4 text-xs font-mono whitespace-nowrap">
                        {minP != null || maxP != null ? (
                          <span className="text-muted-foreground">
                            <span className="text-red-400/80">${minP != null ? fmtPrice(minP) : "—"}</span>
                            <span className="mx-1 text-border">/</span>
                            <span className="text-primary/80">${maxP != null ? fmtPrice(maxP) : "—"}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>

                      {/* Max Profit % */}
                      <td className="py-3 pr-4 text-xs font-mono font-semibold whitespace-nowrap">
                        {maxProfit != null ? (
                          <span style={winner ? { color: "oklch(0.82 0.16 85)" } : { color: "oklch(0.78 0.19 155)" }}>
                            +{maxProfit.toFixed(2)}%
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>

                      {/* Duration */}
                      <td className="py-3 pr-4 text-xs text-muted-foreground whitespace-nowrap">
                        {dur ?? <span className="text-muted-foreground/40">—</span>}
                      </td>

                      {/* Score / Tier badge */}
                      <td className="py-3 pr-4 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold"
                            style={isGold ? {
                              background: "oklch(0.82 0.16 85)",
                              color: "oklch(0.15 0.014 260)",
                              boxShadow: "0 0 8px oklch(0.82 0.16 85 / 0.4)",
                            } : qualityTier === "B" ? {
                              background: "oklch(0.78 0.19 155 / 0.15)",
                              color: "oklch(0.78 0.19 155)",
                            } : {
                              background: "oklch(0.24 0.015 260 / 0.4)",
                              color: "oklch(0.60 0.015 260)",
                            }}
                          >
                            {qualityTier}
                          </span>
                          <span className="text-xs font-mono" style={isGold ? { color: "oklch(0.82 0.16 85)" } : { color: "oklch(0.50 0.015 260)" }}>
                            {qualityScore}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {!signalsLoading && signals.length === 0 && (
                  <tr>
                    <td colSpan={10} className="py-14 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-border/30 flex items-center justify-center">
                          <Activity className="w-5 h-5 text-muted-foreground" />
                        </div>
                        <p className="text-sm font-medium text-foreground">
                          No signals match your filters
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {tierFilter !== "all" ? `No Tier ${tierFilter} signals in this timeframe. Try a different tier or period.` : "Try changing the tier or timeframe filter."}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {signalsTotal > SIGNALS_PER_PAGE && (
            <div className="flex items-center justify-between px-6 py-4 border-t border-border/40">
              <p className="text-xs text-muted-foreground">
                Showing {signalPage * SIGNALS_PER_PAGE + 1}–{Math.min((signalPage + 1) * SIGNALS_PER_PAGE, signalsTotal)} of {signalsTotal.toLocaleString()}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setSignalPage(p => Math.max(0, p - 1))}
                  disabled={signalPage === 0}
                  className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="px-3 py-1 text-xs text-foreground">{signalPage + 1} / {signalsMaxPage + 1}</span>
                <button
                  onClick={() => setSignalPage(p => Math.min(signalsMaxPage, p + 1))}
                  disabled={signalPage >= signalsMaxPage}
                  className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Connected exchanges (CEX copytrading) */}
        <div className="mt-8">
          <ConnectedExchangesPanel />
        </div>

        {/* Aster execution readiness */}
        <div className="mt-8 rounded-2xl border overflow-hidden" style={{ background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.90), oklch(0.09 0.018 255 / 0.95))", borderColor: "oklch(0.60 0.22 220 / 0.18)", backdropFilter: "blur(16px)" }}>
          <AsterExecutionPanel />
        </div>
      </div>

      {/* First-run wizard overlay */}
    <AnimatePresence>
      {showWizard && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "oklch(0.07 0.015 255 / 0.85)", backdropFilter: "blur(8px)" }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
            className="relative w-full max-w-md rounded-2xl p-8 border"
            style={{ background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.95), oklch(0.09 0.018 255 / 0.98))", borderColor: "oklch(0.60 0.22 220 / 0.18)" }}
          >
            <button
              onClick={() => setShowWizard(false)}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>

            {/* Step indicator */}
            <div className="flex gap-2 mb-6">
              {wizardSteps.map((_, i) => (
                <div
                  key={i}
                  className="h-1 flex-1 rounded-full transition-all duration-500"
                  style={{ background: i <= wizardStep ? "oklch(0.60 0.22 220 / 0.6)" : "oklch(1 0 0 / 0.08)" }}
                />
              ))}
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={wizardStep}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
              >
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5" style={{ background: "oklch(0.60 0.22 220 / 0.12)", color: "oklch(0.68 0.22 220)" }}>
                  {wizardSteps[wizardStep].icon}
                </div>
                <h2 className="text-xl font-heading font-bold text-foreground mb-2">{wizardSteps[wizardStep].title}</h2>
                <p className="text-sm text-muted-foreground leading-relaxed mb-8">{wizardSteps[wizardStep].desc}</p>
              </motion.div>
            </AnimatePresence>

            <div className="flex items-center gap-3">
              {wizardStep > 0 && (
                <button
                  onClick={() => setWizardStep((s) => s - 1)}
                  className="flex-1 px-4 py-2.5 rounded-xl border text-sm font-medium text-foreground transition-colors hover:bg-card"
                  style={{ borderColor: "oklch(0.60 0.22 220 / 0.2)" }}
                >
                  Back
                </button>
              )}
              <button
                onClick={() => {
                  if (wizardStep < wizardSteps.length - 1) {
                    setWizardStep((s) => s + 1);
                  } else {
                    setShowWizard(false);
                  }
                }}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
                style={{ fontFamily: "var(--font-heading)", color: "oklch(0.14 0.02 255)", background: "var(--grad-arctic)", boxShadow: "inset 0 1px 0 oklch(1 0 0 / 0.4), 0 4px 24px oklch(0.72 0.20 195 / 0.22)" }}
              >
                {wizardStep < wizardSteps.length - 1 ? "Next" : "Get Started"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>

    {/* Floating quick-launch for wizard (visible when dismissed but not connected) */}
    {!showWizard && !asterConnected && !showActivationPanel && (
      <motion.button
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg border transition-all hover:scale-105"
        style={{ background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.95), oklch(0.09 0.018 255 / 0.98))", borderColor: "oklch(0.60 0.22 220 / 0.25)" }}
        onClick={() => setShowWizard(true)}
      >
        <Sparkles className="w-4 h-4 text-primary" />
        <span className="text-xs font-semibold text-foreground">Quick Start</span>
      </motion.button>
    )}

    {/* Wallet connect modal for inline activation */}
    <WalletConnectModal
      isOpen={showWalletModal}
      onClose={() => setShowWalletModal(false)}
      onConnected={() => {
        refetchWeb3();
      }}
    />
  </>

function AsterExecutionPanel() {
  const utils = trpc.useUtils();
  const { data: status, isLoading } = trpc.aster.getStatus.useQuery();
  const { data: liveData } = trpc.liveAccount.get.useQuery();
  const toggleKill = trpc.liveAccount.toggleKillSwitch.useMutation({
    onSuccess: (d) => {
      utils.liveAccount.get.invalidate();
      toast.success(d.killSwitchActive ? "Aster execution paused." : "Aster execution resumed.");
    },
    onError: () => toast.error("Failed to update Aster execution state."),
  });

  const active = status?.status === "active";
  const pending = status?.status === "pending_approval";
  const killActive = liveData?.account?.killSwitchActive ?? false;

  const statusIcon = active
    ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
    : pending
      ? <Clock className="w-4 h-4 text-amber-400" />
      : <AlertTriangle className="w-4 h-4 text-muted-foreground" />;
  const statusLabel = active ? "Aster Agent Active" : pending ? "Approvals Pending" : "Not Connected";

  return (
    <div>
      <div className="px-6 py-5 border-b flex items-center justify-between gap-4 flex-wrap" style={{ borderColor: "oklch(0.60 0.22 220 / 0.12)" }}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, oklch(0.60 0.22 220 / 0.20), oklch(0.45 0.18 240 / 0.15))" }}>
            <Zap className="w-4.5 h-4.5" style={{ color: "oklch(0.68 0.22 220)" }} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Aster DEX Execution</h3>
            <p className="text-xs text-muted-foreground">One-click activation · Zero-custody</p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            {statusIcon}
            <span className={active ? "text-emerald-400" : pending ? "text-amber-400" : "text-muted-foreground"}>{statusLabel}</span>
          </div>
          <Link href="/onboarding/aster">
            <button className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all">
              <Zap className="w-3.5 h-3.5" /> {active ? "Manage" : "Activate"}
            </button>
          </Link>
          {active && (
            <button
              onClick={() => toggleKill.mutate({ active: !killActive })}
              disabled={toggleKill.isPending}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all disabled:opacity-50 ${
                killActive
                  ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25"
                  : "bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20"
              }`}
            >
              {killActive ? <Zap className="w-3.5 h-3.5" /> : <ZapOff className="w-3.5 h-3.5" />}
              {killActive ? "Resume" : "Pause"}
            </button>
          )}
        </div>
      </div>

      {!active && !pending && (
        <div className="px-6 py-5">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-xl" style={{ background: "oklch(0.60 0.22 220 / 0.08)" }}>
              <Zap className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-foreground mb-1">One click to activate</h4>
              <p className="text-xs text-muted-foreground max-w-md mb-4">
                Connect your wallet and approve the Agent signer in one step. No copy-pasting, no navigating to Aster, no multi-step forms.
              </p>
              <Link href="/onboarding/aster">
                <button className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold transition-all"
                  style={{ fontFamily: "var(--font-heading)", color: "oklch(0.14 0.02 255)", background: "var(--grad-arctic)", boxShadow: "inset 0 1px 0 oklch(1 0 0 / 0.4), 0 4px 24px oklch(0.72 0.20 195 / 0.22)" }}>
                  Activate Now <Zap className="w-3.5 h-3.5" />
                </button>
              </Link>
            </div>
          </div>
        </div>
      )}

      {active && (
        <div className="px-6 py-4">
          <div className="grid md:grid-cols-3 gap-3">
            <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
              <div className="text-xs font-semibold text-foreground mb-1">Trading Authority</div>
              <p className="text-xs text-muted-foreground">Perps-only Agent with withdrawal disabled. Zero-custody.</p>
            </div>
            <div className="p-4 rounded-xl bg-amber-500/5 border border-amber-500/20">
              <div className="text-xs font-semibold text-foreground mb-1">Fee Accounting</div>
              <p className="text-xs text-muted-foreground">2% and 20% tracked in Anavitrade's fee ledger, not per-order.</p>
            </div>
            <div className="p-4 rounded-xl bg-card border border-border/50">
              <div className="text-xs font-semibold text-foreground mb-1">Live Orders</div>
              <p className="text-xs text-muted-foreground">Ready. Pause execution anytime from this panel.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
