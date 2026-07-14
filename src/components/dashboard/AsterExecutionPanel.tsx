import { Link } from "wouter";
import {
  CheckCircle2, Clock, AlertTriangle, Zap, ZapOff,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export default function AsterExecutionPanel() {
  const utils = trpc.useUtils();
  const { data: config } = trpc.aster.getConfig.useQuery();
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
  const liveSubmissionEnabled = config?.liveOrderSubmissionEnabled === true;

  const statusIcon = active
    ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
    : pending
      ? <Clock className="w-4 h-4 text-amber-400" />
      : <AlertTriangle className="w-4 h-4 text-muted-foreground" />;
  const statusLabel = active ? "Aster Agent Active" : pending ? "Approvals Pending" : "Not Connected";

  return (
    <div>
      <div className="px-6 py-5 border-b border-primary/15 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/10">
            <Zap className="w-4.5 h-4.5 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Aster DEX Execution</h3>
            <p className="text-xs text-muted-foreground">
              One-click activation · Zero-custody · {liveSubmissionEnabled ? "Live submit" : "Staging mode"}
            </p>
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
            <div className="p-3 rounded-xl bg-primary/10">
              <Zap className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-foreground mb-1">One click to activate</h4>
              <p className="text-xs text-muted-foreground max-w-md mb-4">
                Connect your wallet and approve the Agent signer in one step. No copy-pasting, no navigating to Aster, no multi-step forms.
              </p>
              <Link href="/onboarding/aster">
                <button className="btn-azure inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold">
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
              <div className="text-xs font-semibold text-foreground mb-1">{liveSubmissionEnabled ? "Live Orders" : "Order Staging"}</div>
              <p className="text-xs text-muted-foreground">
                {liveSubmissionEnabled
                  ? "Ready. Pause execution anytime from this panel."
                  : "Signals are staged until Aster live order submission is explicitly enabled."}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
