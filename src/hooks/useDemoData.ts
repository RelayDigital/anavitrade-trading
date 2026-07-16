import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

/**
 * Demo-specific queries, mutations, and derived portfolio metrics.
 * Fetched only when the dashboard is in demo mode.
 * Demo starts from zero — no auto-backfill of past signals.
 */
export function useDemoData(isDemoMode: boolean) {
  const { data: myDemoData } = trpc.demo.getMyDemo.useQuery(undefined, { enabled: isDemoMode });
  const { data: demoTradesData, refetch: refetchDemoTrades } = trpc.demo.getMyTrades.useQuery(undefined, { enabled: isDemoMode });
  const { data: demoPortfolioSeries, refetch: refetchDemoSeries } = trpc.demo.getMyPortfolioSeries.useQuery(undefined, { enabled: isDemoMode });

  const syncDemo = trpc.demo.syncMySignals.useMutation({
    onSuccess: (r) => {
      if (r.tradesCreated > 0) {
        toast.success(`${r.tradesCreated} trade${r.tradesCreated !== 1 ? "s" : ""} synced`);
      }
      refetchDemoTrades();
      refetchDemoSeries();
    },
    onError: (e) => toast.error(`Sync failed: ${e.message}`),
  });

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

  return {
    demoAccount,
    demoStartingCapital,
    demoCurrentBalance,
    demoTotalPnl,
    demoPnlPercent,
    demoPortfolioSeries,
    closedTrades,
    wins,
    losses,
    winRate,
    avgProfit,
    avgLoss,
    profitFactor,
    bestTrade,
    syncDemo,
    refetchDemoTrades,
    refetchDemoSeries,
  };
}
