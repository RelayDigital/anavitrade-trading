import { Link } from "wouter";
import { Plus, Power, RefreshCw, Trash2, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

/**
 * Per-user "Connected Exchanges" dashboard panel. Lists each active CEX
 * connection with live balance, copytrade status, per-connection kill switch,
 * and revoke. Replaces the legacy singleton env-based Binance panel.
 */
export default function ConnectedExchangesPanel() {
  const utils = trpc.useUtils();
  const { data: connections, isLoading } = trpc.cex.getConnections.useQuery();

  const toggleKill = trpc.cex.toggleKillSwitch.useMutation({
    onSuccess: () => utils.cex.getConnections.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const revoke = trpc.cex.revoke.useMutation({
    onSuccess: () => { toast.success("Exchange disconnected"); utils.cex.getConnections.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const validate = trpc.cex.validate.useMutation({
    onSuccess: () => { toast.success("Balance refreshed"); utils.cex.getConnections.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const active = (connections ?? []).filter((c) => c.status === "active");

  return (
    <div className="glass-card rounded-2xl overflow-hidden border-border/50">
      <div className="px-5 py-4 flex items-center justify-between border-b border-border/30">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-primary" />
          <h3 className="font-heading font-medium text-foreground">Connected Exchanges</h3>
        </div>
        <Link href="/onboarding/exchange">
          <button className="btn-hairline h-9 px-4 text-[0.82rem]">
            <Plus className="w-3.5 h-3.5" /> Connect
          </button>
        </Link>
      </div>

      <div className="p-5">
        {isLoading ? (
          <div className="text-sm text-white/40 py-6 text-center">Loading connections…</div>
        ) : active.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-muted-foreground mb-4">No exchanges connected yet.</p>
            <Link href="/onboarding/exchange">
              <button
                className="btn-azure inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold"
              >
                <Plus className="w-4 h-4" /> Connect an exchange
              </button>
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {active.map((c) => (
              <div key={c.id} className="rounded-xl p-4 bg-muted/20 border border-border/30">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <span className="w-8 h-8 rounded-lg inline-flex items-center justify-center font-heading font-bold text-xs btn-azure text-background">
                      {c.label?.slice(0, 1) ?? c.exchange.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <div className="text-sm font-medium text-foreground capitalize">{c.label ?? c.exchange}</div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${c.killSwitchActive ? "bg-amber-400" : "bg-green-500"}`} />
                        <span className="text-xs text-muted-foreground">
                          {c.killSwitchActive ? "Paused" : "Copytrade live"}
                          {c.withdrawalDisabledVerified ? " · trade-only ✓" : c.attested ? " · attested" : ""}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm text-foreground">
                      ${Number(c.lastBalanceUsd ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </div>
                    <div className="text-xs text-muted-foreground">balance</div>
                  </div>
                </div>

                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={() => toggleKill.mutate({ exchange: c.exchange, active: !c.killSwitchActive })}
                    className={`flex-1 h-8 rounded-lg text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors ${
                      c.killSwitchActive
                        ? "bg-green-500/15 text-green-500"
                        : "bg-amber-500/10 text-amber-400"
                    }`}>
                    <Power className="w-3.5 h-3.5" />
                    {c.killSwitchActive ? "Resume" : "Kill switch"}
                  </button>
                  <button
                    onClick={() => validate.mutate({ exchange: c.exchange })}
                    className="h-8 w-8 rounded-lg inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors bg-muted/30"
                    title="Refresh balance"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${validate.isPending ? "animate-spin" : ""}`} />
                  </button>
                  <button
                    onClick={() => revoke.mutate({ exchange: c.exchange })}
                    className="h-8 w-8 rounded-lg inline-flex items-center justify-center transition-colors bg-red-500/10 text-red-400 hover:bg-red-500/20"
                    title="Disconnect"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
