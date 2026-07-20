import { motion } from "framer-motion";
import { Coins, RefreshCw, WifiOff } from "lucide-react";
import { useWalletAssets } from "@/hooks/useWalletAssets";

function fmtBalance(value: string): string {
  const num = parseFloat(value);
  if (!Number.isFinite(num)) return "0";
  if (num === 0) return "0";
  if (num < 0.0001) return num.toExponential(2);
  if (num < 1) return num.toFixed(6);
  return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtUsd(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

const tokenColors: Record<string, string> = {
  BNB: "text-amber-400",
  ETH: "text-blue-400",
  USDT: "text-green-400",
  USDC: "text-blue-300",
};

interface WalletAssetsPanelProps {
  /** Server-persisted wallet session, used as a fallback when wagmi's own
   *  live connection state hasn't registered (see useWalletAssets). */
  walletAddress?: string | null;
  chainId?: number | null;
}

export default function WalletAssetsPanel({ walletAddress, chainId }: WalletAssetsPanelProps) {
  const { assets, totalValueUsd, isLoading, isConnected, unsupportedChain } = useWalletAssets({
    address: walletAddress,
    chainId,
  });

  if (!isConnected) return null;

  return (
    <div className="glass-card rounded-2xl border-border/50">
      <div className="px-5 pt-5 pb-4 border-b border-border/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center border bg-primary/10 border-primary/20 text-primary">
              <Coins className="w-4 h-4" />
            </div>
            <div>
              <p className="text-foreground font-semibold text-sm">Wallet Assets</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                {isLoading ? "Refreshing balances…" : `${assets.length} asset${assets.length === 1 ? "" : "s"} on-chain`}
              </p>
            </div>
          </div>
          {isLoading && <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />}
        </div>
      </div>

      <div className="p-5 space-y-2">
        {assets.length === 0 && !isLoading && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <WifiOff className="w-5 h-5 text-muted-foreground/50" />
            <p className="text-muted-foreground text-xs">
              {unsupportedChain
                ? "This network isn't tracked yet — switch to Ethereum, BSC, Arbitrum, Base, or Optimism."
                : "No tracked token balances found in this wallet."}
            </p>
          </div>
        )}

        {assets.map((asset, i) => (
          <motion.div
            key={asset.symbol}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            className="flex items-center justify-between p-3 rounded-xl bg-muted/20 border border-border/30"
          >
            <div className="flex items-center gap-2.5">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold bg-muted/30 ${tokenColors[asset.symbol] ?? "text-foreground"}`}>
                {asset.symbol.slice(0, 3)}
              </div>
              <div>
                <p className="text-foreground text-sm font-medium">{asset.symbol}</p>
                <p className="text-muted-foreground text-xs font-mono">{fmtBalance(asset.balance)}</p>
              </div>
            </div>
            <p className="text-foreground text-sm font-semibold">
              {asset.valueUsd !== null ? fmtUsd(asset.valueUsd) : "—"}
            </p>
          </motion.div>
        ))}

        {assets.length > 0 && (
          <div className="flex items-center justify-between pt-2 mt-2 border-t border-border/30">
            <span className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">Total</span>
            <span className="text-foreground text-sm font-bold">{fmtUsd(totalValueUsd)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
