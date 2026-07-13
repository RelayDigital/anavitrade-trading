import { motion } from "framer-motion";
import { BarChart3 } from "lucide-react";

interface DemoTrade {
  id?: number;
  pair?: string;
  qualityTier?: string | null;
  indicatorName?: string | null;
  period?: string | null;
  pnl?: string | number | null;
  pnlPct?: string | number | null;
  closedAt?: string | Date | null;
  win?: boolean | null;
  status?: string;
}

interface DemoTradeHistoryProps {
  closedTrades: DemoTrade[];
  wins: DemoTrade[];
  losses: DemoTrade[];
  winRate: number;
  avgProfit: number;
  avgLoss: number;
  profitFactor: number;
  bestTrade: DemoTrade | null;
}

export default function DemoTradeHistory({
  closedTrades, wins, losses, winRate, avgProfit, avgLoss, profitFactor, bestTrade,
}: DemoTradeHistoryProps) {
  if (closedTrades.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-6 rounded-2xl border border-primary/20 overflow-hidden"
        style={{ background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.90), oklch(0.09 0.018 255 / 0.95))" }}
      >
        <div className="px-6 py-5 border-b border-primary/10">
          <h3 className="text-sm font-semibold text-foreground">Demo Trade History</h3>
        </div>
        <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
          <BarChart3 className="w-8 h-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No demo trades yet. Click "Sync Signals" above to simulate trades.</p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-6 rounded-2xl border border-primary/20 overflow-hidden"
      style={{ background: "linear-gradient(145deg, oklch(0.12 0.022 250 / 0.90), oklch(0.09 0.018 255 / 0.95))" }}
    >
      {/* Header */}
      <div className="px-6 py-5 border-b border-primary/10">
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
          <div className="p-3 rounded-xl bg-primary/[0.04] border border-primary/[0.08]">
            <p className="text-[10px] text-muted-foreground mb-0.5">Win Rate</p>
            <p className="text-sm font-heading font-bold text-green-500">{winRate.toFixed(1)}%</p>
          </div>
          <div className="p-3 rounded-xl bg-primary/[0.04] border border-primary/[0.08]">
            <p className="text-[10px] text-muted-foreground mb-0.5">Avg Win</p>
            <p className="text-sm font-heading font-bold text-green-500">+${avgProfit.toFixed(2)}</p>
          </div>
          <div className="p-3 rounded-xl bg-primary/[0.04] border border-primary/[0.08]">
            <p className="text-[10px] text-muted-foreground mb-0.5">Avg Loss</p>
            <p className="text-sm font-heading font-bold text-red-400">-${Math.abs(avgLoss).toFixed(2)}</p>
          </div>
          <div className="p-3 rounded-xl bg-primary/[0.04] border border-primary/[0.08]">
            <p className="text-[10px] text-muted-foreground mb-0.5">Profit Factor</p>
            <p className="text-sm font-heading font-bold text-foreground">{profitFactor.toFixed(2)}</p>
          </div>
          <div className="p-3 rounded-xl bg-primary/[0.04] border border-primary/[0.08]">
            <p className="text-[10px] text-muted-foreground mb-0.5">Best Trade</p>
            <p className="text-sm font-heading font-bold gold-shimmer-text">
              {bestTrade ? `+${parseFloat(String(bestTrade.pnlPct ?? "0")).toFixed(1)}%` : "—"}
            </p>
          </div>
        </div>
      </div>

      {/* Trades table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-primary/[0.07]">
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
            {closedTrades.slice(0, 20).map((trade, idx) => {
              const pnl = parseFloat(String(trade.pnl ?? "0"));
              const pnlPctVal = parseFloat(String(trade.pnlPct ?? "0"));
              const isWin = pnl > 0;
              const pair = (trade.pair ?? "").replace("USDT", "/USDT");
              const tier = trade.qualityTier ?? "C";
              return (
                <tr key={trade.id ?? idx} className="border-b border-primary/[0.04] last:border-0">
                  <td className="py-3 px-4">
                    <span className="font-mono text-xs font-bold text-foreground">{pair || "—"}</span>
                  </td>
                  <td className="py-3 pr-4">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                      tier === "A" ? "bg-amber-500/15 text-amber-400" : tier === "B" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                    }`}>
                      {tier}
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
    </motion.div>
  );
}
