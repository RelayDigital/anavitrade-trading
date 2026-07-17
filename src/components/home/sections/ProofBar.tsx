import { TrendingUp, Activity, Sparkles, Shield, Lock, Database } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { UNAVAILABLE } from "@/components/performancePresentation";
import StatRail, { type StatItem } from "../primitives/StatRail";

/* ─── PROOF BAR ───
   Friendly, count-up trust strip. Numbers animate up on view, labels are
   plain language, and any finance term carries a one-line explainer so a
   complete beginner is never left guessing. Solid surface (no glass) keeps
   the numbers crisp and legible. */
export default function ProofBar() {
  const { data: demoStats } = trpc.demo.getPublicDemoStats.useQuery();
  const hasDemoTrades = Number(demoStats?.tradeCount ?? 0) > 0;

  const items: StatItem[] = [
    {
      value: demoStats?.tierAJulyCount != null ? Number(demoStats.tierAJulyCount) : undefined,
      display: demoStats?.tierAJulyCount == null ? UNAVAILABLE : undefined,
      label: "Tier A signals in July",
      hint: "The API-reported count of signals scored as Tier A during July.",
      icon: <Database className="w-4 h-4" />,
      tone: "gold",
    },
    {
      value: hasDemoTrades && demoStats?.totalReturnPct != null ? Number(demoStats.totalReturnPct) : undefined,
      display: hasDemoTrades && demoStats?.totalReturnPct != null ? undefined : UNAVAILABLE,
      prefix: "+",
      suffix: "%",
      decimals: 1,
      label: "Modeled July change",
      hint: "Change in the demo's historical scenario. It is not a live account return or a forecast.",
      icon: <TrendingUp className="w-4 h-4" />,
      tone: "green",
    },
    {
      value: hasDemoTrades && demoStats?.avgPnlPct != null ? Number(demoStats.avgPnlPct) : undefined,
      display: hasDemoTrades && demoStats?.avgPnlPct != null ? undefined : UNAVAILABLE,
      prefix: "+",
      suffix: "%",
      decimals: 1,
      label: "Average modeled change",
      hint: "Average per-trade change in the demo's historical scenario.",
      icon: <Activity className="w-4 h-4" />,
    },
    {
      value: hasDemoTrades && demoStats?.bestPnlPct != null ? Number(demoStats.bestPnlPct) : undefined,
      display: hasDemoTrades && demoStats?.bestPnlPct != null ? undefined : UNAVAILABLE,
      prefix: "+",
      suffix: "%",
      decimals: 2,
      label: "Largest modeled change",
      hint: "Largest per-trade change in the demo's historical scenario.",
      icon: <Sparkles className="w-4 h-4" />,
    },
    {
      value: demoStats?.tradeCount != null ? Number(demoStats.tradeCount) : undefined,
      display: demoStats?.tradeCount == null ? UNAVAILABLE : undefined,
      label: "Modeled trades",
      hint: "Trades included in the API-reported historical scenario.",
      icon: <Shield className="w-4 h-4" />,
    },
    {
      display: "Trade-only",
      label: "Connection scope",
      hint: "Supported exchange connections should use credentials without withdrawal permission; verify permissions before enabling execution.",
      icon: <Lock className="w-4 h-4" />,
    },
  ];

  return (
    <section className="py-14 relative">
      <div className="container">
        <StatRail key={demoStats ? "loaded" : "pending"} items={items} />
      </div>
    </section>
  );
}
