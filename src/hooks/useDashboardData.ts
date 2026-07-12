import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

/**
 * Aggregates all top-level Dashboard queries + derived connection state.
 * Single hook so child components don't each fetch their own copies.
 */
export function useDashboardData() {
  const { data: liveData, refetch } = trpc.liveAccount.get.useQuery();
  const account = liveData?.account;

  const { data: asterStatus, refetch: refetchAster } = trpc.aster.getStatus.useQuery();
  const { data: web3Session, refetch: refetchWeb3 } = trpc.web3Wallet.getSession.useQuery();

  const asterConnected = asterStatus?.status === "active";
  const asterPending = asterStatus?.status === "pending_approval";
  const web3Connected = web3Session?.status === "active";
  const anyConnected = asterConnected || web3Connected;

  const statusLabel = asterConnected
    ? "Aster Live"
    : web3Connected
      ? "Wallet Connected"
      : asterPending
        ? "Aster Pending"
        : "Not Connected";

  const statusColor = asterConnected || web3Connected
    ? "bg-primary/10 border-primary/20 text-primary"
    : asterPending
      ? "bg-amber-400/10 border-amber-400/20 text-amber-400"
      : "bg-border/50 border-border text-muted-foreground";

  const dotColor = asterConnected || web3Connected
    ? "bg-primary animate-pulse"
    : asterPending
      ? "bg-amber-400"
      : "bg-muted-foreground";

  // Kill switch mutations
  const toggleWeb3Kill = trpc.web3Wallet.toggleKillSwitch.useMutation({
    onSuccess: (d) => {
      toast.success(d.killSwitchActive ? "Kill switch activated." : "Kill switch deactivated.");
      refetchWeb3();
    },
    onError: () => toast.error("Failed to toggle kill switch."),
  });

  const toggleKill = trpc.liveAccount.toggleKillSwitch.useMutation({
    onSuccess: (d) => {
      toast.success(d.killSwitchActive ? "Kill switch activated." : "Kill switch deactivated.");
      refetch();
    },
    onError: () => toast.error("Failed to toggle kill switch."),
  });

  const revokeWeb3 = trpc.web3Wallet.revoke.useMutation({
    onSuccess: () => { toast.success("Wallet revoked."); refetchWeb3(); },
    onError: () => toast.error("Failed to revoke wallet."),
  });

  // Display mode
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

  // Unified balance: aggregated across all connected CEX exchanges + cached on live_accounts
  const { data: unifiedBalance } = trpc.cex.getUnifiedBalance.useQuery(undefined, {
    enabled: anyConnected, // only fetch when user has at least one connection
    refetchInterval: 60_000, // refresh every minute
  });

  const killActive = web3Connected
    ? (web3Session?.killSwitchActive ?? false)
    : (account?.killSwitchActive ?? false);

  const handleKillSwitch = () => {
    if (web3Connected) toggleWeb3Kill.mutate({ active: !killActive });
    else if (asterConnected) toggleKill.mutate({ active: !killActive });
  };

  return {
    // Raw data
    account,
    liveData,
    asterStatus,
    web3Session,

    // Derived connection state
    asterConnected,
    asterPending,
    web3Connected,
    anyConnected,
    statusLabel,
    statusColor,
    dotColor,
    killActive,

    // Display mode
    currentMode,
    isDemoMode,
    setDisplayMode,

    // Unified balance
    unifiedBalance,

    // Mutations
    toggleWeb3Kill,
    toggleKill,
    revokeWeb3,
    handleKillSwitch,
    refetch,
    refetchAster,
    refetchWeb3,
    refetchDisplayMode,
  };
}
