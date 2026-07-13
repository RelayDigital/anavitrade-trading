import React, { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { Sparkles, Zap, ZapOff } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

// Extracted hooks
import { useDashboardData } from "@/hooks/useDashboardData";
import { useDemoData } from "@/hooks/useDemoData";
import { useSignalFeed } from "@/hooks/useSignalFeed";

// Extracted components
import DashboardLayout from "@/components/DashboardLayout";
import ActivationCard from "@/components/dashboard/ActivationCard";
import DashboardStatsRow from "@/components/dashboard/DashboardStatsRow";
import PortfolioChartPanel from "@/components/dashboard/PortfolioChartPanel";
import GoldWinnersPodium from "@/components/dashboard/GoldWinnersPodium";
import DemoTradeHistory from "@/components/dashboard/DemoTradeHistory";
import LiveSignalFeed from "@/components/dashboard/LiveSignalFeed";
import FirstRunWizard from "@/components/dashboard/FirstRunWizard";
import AsterExecutionPanel from "@/components/dashboard/AsterExecutionPanel";

// Shared components
import WalletPanel from "@/components/WalletPanel";
import ConnectedExchangesPanel from "@/components/ConnectedExchangesPanel";
import WalletConnectModal from "@/components/WalletConnectModal";
import TradingViewMiniWidgets from "@/components/TradingViewMiniWidgets";

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
  if (utcStr) {
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
  const d = typeof fallback === "string" ? new Date(fallback) : fallback;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Is this signal a "winner"? Buy + ≥3% 24h gain */
function isWinner(signal: number, pct: number | null): boolean {
  return signal === 1 && pct !== null && pct >= 3;
}

export default function Dashboard() {
  const [, navigate] = useLocation();
  const { user } = useAuth();

  const {
    anyConnected, asterConnected, asterPending, web3Connected, web3Session,
    currentMode, isDemoMode, killActive, statusLabel, statusColor, dotColor,
    setDisplayMode, toggleWeb3Kill, handleKillSwitch,
    revokeWeb3, refetch, refetchWeb3,
  } = useDashboardData();

  const {
    demoCurrentBalance, demoTotalPnl, demoPnlPercent,
    demoPortfolioSeries, closedTrades, wins, losses,
    winRate, avgProfit, avgLoss, profitFactor, bestTrade,
    syncDemo,
  } = useDemoData(isDemoMode);

  const {
    signals, signalsLoading, signalsTotal, signalsMaxPage,
    signalPage, tierFilter, signalPeriod, sortBy, topWinners, winnerRankMap,
    setTierFilter, setSignalPeriod, setSignalPage, setSortBy, refetchSignals,
    SIGNALS_PER_PAGE,
  } = useSignalFeed();

  // Inline Aster Activation state
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [showActivationPanel, setShowActivationPanel] = useState(false);
  const activate = trpc.aster.activateWithWallet.useMutation({
    onSuccess: () => {
      toast.success("Aster execution activated!");
      refetch();
      setShowActivationPanel(false);
    },
    onError: (e) => toast.error(e.message || "Failed to activate Aster."),
  });

  // When a wallet is connected while the activation panel is open, auto-activate
  useEffect(() => {
    if (showActivationPanel && web3Connected && !activate.isPending && !asterConnected) {
      if (web3Session?.walletAddress) {
        activate.mutate();
      }
    }
  }, [web3Connected, showActivationPanel, web3Session?.walletAddress, asterConnected, activate]);

  // First-run wizard
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);

  // Portfolio data (placeholder for live mode)
  const portfolioData: { day: string; value: number }[] = [];
  const currentBalance = 0;
  const totalPnl = 0;
  const pnlPct = "0.00";

  const rankMedals = ["🥇", "🥈", "🥉"];

  return (
    <DashboardLayout
      headerActions={
        <div className="flex items-center gap-2">
          {/* Mode Toggle */}
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg border border-primary/15 bg-background/50">
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
          {anyConnected && (
            <button
              onClick={handleKillSwitch}
              disabled={false}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-50 ${
                killActive
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20"
              }`}
            >
              {killActive ? <Zap className="w-3.5 h-3.5" /> : <ZapOff className="w-3.5 h-3.5" />}
              {killActive ? "Resume" : "Kill"}
            </button>
          )}
        </div>
      }
    >
      <div className="max-w-7xl mx-auto">
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
        </div>

        {/* Inline Aster Activation */}
        <ActivationCard
          asterConnected={asterConnected}
          asterPending={asterPending}
          web3Connected={web3Connected}
          web3Session={web3Session}
          showActivationPanel={showActivationPanel}
          activatePending={activate.isPending}
          hasWalletAddress={!!web3Session?.walletAddress}
          onShowPanel={() => setShowActivationPanel(true)}
          onHidePanel={() => setShowActivationPanel(false)}
          onConnectWallet={() => setShowWalletModal(true)}
          onActivate={() => activate.mutate()}
          onShowWizard={() => setShowWizard(true)}
        />

        <TradingViewMiniWidgets />

        {/* Stats row */}
        <DashboardStatsRow
          isDemoMode={isDemoMode}
          demoCurrentBalance={demoCurrentBalance}
          demoTotalPnl={demoTotalPnl}
          demoPnlPercent={demoPnlPercent}
          anyConnected={anyConnected}
          killActive={killActive}
          web3Connected={web3Connected}
          currentBalance={currentBalance}
          totalPnl={totalPnl}
          pnlPct={pnlPct}
        />

        {/* Chart + Wallet panel */}
        <div className="grid lg:grid-cols-3 gap-6 mb-8">
          <PortfolioChartPanel
            isDemoMode={isDemoMode}
            anyConnected={anyConnected}
            demoPortfolioSeries={demoPortfolioSeries}
            portfolioData={portfolioData}
            demoStartingCapital={10000}
            totalPnl={totalPnl}
            pnlPct={pnlPct}
            syncPending={syncDemo.isPending}
            onSync={() => syncDemo.mutate()}
          />

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
        <GoldWinnersPodium topWinners={topWinners} fmtPrice={fmtPrice} />

        {/* Demo Trade History (only in demo mode) */}
        {isDemoMode && (
          <DemoTradeHistory
            closedTrades={closedTrades}
            wins={wins}
            losses={losses}
            winRate={winRate}
            avgProfit={avgProfit}
            avgLoss={avgLoss}
            profitFactor={profitFactor}
            bestTrade={bestTrade}
          />
        )}

        {/* Live Signal Feed */}
        <LiveSignalFeed
          signals={signals}
          signalsLoading={signalsLoading}
          signalsTotal={signalsTotal}
          signalsMaxPage={signalsMaxPage}
          signalPage={signalPage}
          tierFilter={tierFilter}
          signalPeriod={signalPeriod}
          sortBy={sortBy}
          winnerRankMap={winnerRankMap}
          SIGNALS_PER_PAGE={SIGNALS_PER_PAGE}
          fmtPrice={fmtPrice}
          fmtSignalDate={fmtSignalDate}
          isWinner={isWinner}
          onSetTierFilter={setTierFilter}
          onSetSignalPeriod={setSignalPeriod}
          onSetSignalPage={setSignalPage}
          onToggleSort={() => { setSortBy(s => s === "quality" ? "date" : "quality"); setSignalPage(0); }}
          onRefresh={refetchSignals}
        />

        {/* Connected exchanges (CEX copytrading) */}
        <div className="mt-8">
          <ConnectedExchangesPanel />
        </div>

        {/* Aster execution readiness */}
        <div className="mt-8 rounded-2xl border overflow-hidden"
          style={{ background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.90), oklch(0.09 0.018 255 / 0.95))", borderColor: "oklch(0.60 0.22 220 / 0.18)", backdropFilter: "blur(16px)" }}
        >
          <AsterExecutionPanel />
        </div>
      </div>

      {/* First-run wizard overlay */}
      <FirstRunWizard
        showWizard={showWizard}
        wizardStep={wizardStep}
        onClose={() => setShowWizard(false)}
        onBack={() => setWizardStep(s => s - 1)}
        onNext={() => {
          if (wizardStep < 2) {
            setWizardStep(s => s + 1);
          } else {
            setShowWizard(false);
          }
        }}
      />

      {/* Floating quick-launch for wizard */}
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
        onConnected={() => { refetchWeb3(); }}
      />
    </DashboardLayout>
  );
}
