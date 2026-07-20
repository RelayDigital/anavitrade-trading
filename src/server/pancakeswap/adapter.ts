import { eq } from "drizzle-orm";
import { bsc } from "viem/chains";
import { pancakeswapDelegations } from "../../drizzle/schema";
import { getDb } from "../db";
import { getPancakeswapConfig } from "./config";
import { getExecutorWalletClient, getPublicClient, getSwapQuote, buildSwapCalldata, getPancakeswapUniversalRouterAddress } from "./client";
import type { ExecutionAdapter, ExecutionAdapterReceipt } from "../aster/types";
import type { PancakeswapPermitSingle } from "./types";

/**
 * PancakeSwap spot-swap execution adapter — conforms to the shared
 * ExecutionAdapter contract (provider "pancakeswap"). Uses the delegation's
 * Permit2 PermitSingle + signature to build atomic swap calldata (pull +
 * swap + deliver-to-user in one Universal Router transaction, no separate
 * custody window) and submits it from the executor account.
 */
export class PancakeswapExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly delegationId: number) {}

  private async loadDelegation() {
    const db = getDb();
    const [row] = await db.select().from(pancakeswapDelegations)
      .where(eq(pancakeswapDelegations.id, this.delegationId))
      .limit(1);
    if (!row) throw new Error("PANCAKESWAP_DELEGATION_NOT_FOUND");
    if (row.status !== "active") throw new Error("PANCAKESWAP_DELEGATION_NOT_ACTIVE");
    if (row.expiration <= Math.floor(Date.now() / 1000)) throw new Error("PANCAKESWAP_DELEGATION_EXPIRED");
    if (!row.signature) throw new Error("PANCAKESWAP_DELEGATION_MISSING_SIGNATURE");
    return row;
  }

  async submitOrder(_jobId: number, request: any): Promise<ExecutionAdapterReceipt> {
    const config = getPancakeswapConfig();
    if (!config.liveOrderSubmissionEnabled) throw new Error("PANCAKESWAP_LIVE_ORDER_SUBMISSION_DISABLED");

    const delegation = await this.loadDelegation();
    const amountInRaw = BigInt(request.quantity ?? "0");
    if (amountInRaw <= 0n) throw new Error("PANCAKESWAP_ZERO_QUANTITY");

    const { trade } = await getSwapQuote({
      tokenInSymbol: request.tokenInSymbol,
      tokenOutSymbol: request.tokenOutSymbol,
      amountInRaw,
    });

    const permit: PancakeswapPermitSingle = {
      details: {
        token: delegation.tokenAddress,
        amount: delegation.amountCap,
        expiration: delegation.expiration,
        nonce: delegation.nonce,
      },
      spender: delegation.spenderAddress,
      sigDeadline: delegation.sigDeadline,
    };

    const { calldata, value } = buildSwapCalldata({
      trade,
      recipient: delegation.walletAddress as `0x${string}`,
      permit,
      signature: delegation.signature as `0x${string}`,
    });

    const walletClient = getExecutorWalletClient();
    const publicClient = getPublicClient();
    // See client.ts's onChainProvider comment — an unrelated global viem module
    // augmentation (from `porto`, transitively pulled in via wagmi) forces
    // sendTransaction's overload resolution to require blob-transaction fields
    // (`kzg`) that don't apply to this plain call. account/chain are already
    // bound on this walletClient at construction.
    const hash = await walletClient.sendTransaction({
      account: walletClient.account,
      chain: bsc,
      to: getPancakeswapUniversalRouterAddress(),
      data: calldata,
      value: BigInt(value),
    } as any);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    return {
      provider: "pancakeswap",
      orderId: hash,
      status: receipt.status === "success" ? "filled" : "rejected",
      raw: receipt,
    };
  }

  /** Spot swaps settle atomically on submission — nothing to cancel post-submission,
   *  same non-support pattern CexExecutionAdapter.cancelOrder already uses. */
  async cancelOrder(_orderId: string): Promise<ExecutionAdapterReceipt> {
    throw new Error("PANCAKESWAP_ORDER_CANCEL_NOT_SUPPORTED");
  }
}
