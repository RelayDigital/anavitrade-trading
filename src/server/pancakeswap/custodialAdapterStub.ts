import { eq } from "drizzle-orm";
import { pancakeswapAgentAccounts } from "../../drizzle/schema";
import { getDb, decryptKey } from "../db";
import { privateKeyToAccount } from "viem/accounts";
import { createPancakeswapAgentKeypair } from "./signing";
import type { ExecutionAdapter, ExecutionAdapterReceipt } from "../aster/types";

/**
 * NOT THE LIVE PATH. Custodial agent-wallet scaffold — see
 * pancakeswapAgentAccounts in schema.ts for the custody caveat: unlike
 * Aster's Agent (protocol-restricted to perps-only/no-withdraw by Aster's own
 * exchange contract), a key generated here has NO protocol-level restriction.
 * It is genuine full custody of whatever is deposited to it.
 *
 * This class is intentionally inert: it is never imported by dispatch.ts,
 * never exposed via a tRPC router, and has no onboarding UI. It exists only
 * to keep the shape available if a future decision explicitly promotes this
 * path — do not wire it up without a dedicated custody/legal review first.
 */
export class PancakeswapCustodialAdapterStub implements ExecutionAdapter {
  constructor(private readonly agentAccountId: number) {}

  static async createAgentAccount(userId: number) {
    const { signerAddress, privateKey } = createPancakeswapAgentKeypair();
    const db = getDb();
    const { encryptKey } = await import("../db");
    const [row] = await db.insert(pancakeswapAgentAccounts).values({
      userId,
      signerAddress,
      encryptedSignerPrivateKey: await encryptKey(privateKey),
      status: "pending_approval",
    } as any).returning();
    return row;
  }

  private async loadSigner() {
    const db = getDb();
    const [row] = await db.select().from(pancakeswapAgentAccounts)
      .where(eq(pancakeswapAgentAccounts.id, this.agentAccountId))
      .limit(1);
    if (!row) throw new Error("PANCAKESWAP_AGENT_ACCOUNT_NOT_FOUND");
    if (row.status !== "active") throw new Error("PANCAKESWAP_AGENT_ACCOUNT_NOT_ACTIVE_NOT_LIVE_PATH");
    const privateKey = await decryptKey(row.encryptedSignerPrivateKey);
    return { row, account: privateKeyToAccount(privateKey as `0x${string}`) };
  }

  async submitOrder(_jobId: number, _request: any): Promise<ExecutionAdapterReceipt> {
    await this.loadSigner();
    throw new Error("PANCAKESWAP_CUSTODIAL_PATH_NOT_LIVE — this adapter is a scaffold, not wired for execution");
  }

  async cancelOrder(_orderId: string): Promise<ExecutionAdapterReceipt> {
    throw new Error("PANCAKESWAP_CUSTODIAL_PATH_NOT_LIVE");
  }
}
