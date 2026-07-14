import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { asterAgentAccounts, liveAccounts } from "../../drizzle/schema";
import { encryptKey, getDb, getOrCreateLiveAccount, getWeb3WalletSession, writeAuditLog } from "../db";
import { getAsterConfig } from "./config";
import { createAsterAgentKeypair } from "./signing";
import type { AsterAgentPermissions, AsterAgentStatusView } from "./types";

const DEFAULT_PERMISSIONS: AsterAgentPermissions = {
  perp: true,
  spot: false,
  withdraw: false,
};

function normalizeAddress(address: string) {
  return address.trim().toLowerCase();
}

function parsePermissions(raw: string | null): AsterAgentPermissions {
  if (!raw) return DEFAULT_PERMISSIONS;
  try {
    return { ...DEFAULT_PERMISSIONS, ...(JSON.parse(raw) as Partial<AsterAgentPermissions>) };
  } catch {
    return DEFAULT_PERMISSIONS;
  }
}

function toEpochMs(value: Date | number | null | undefined): number | null {
  if (value == null) return null;
  return value instanceof Date ? value.getTime() : value;
}

function statusView(account: typeof asterAgentAccounts.$inferSelect): AsterAgentStatusView {
  return {
    status: account.status as AsterAgentStatusView["status"],
    asterAccountAddress: account.asterAccountAddress,
    signerAddress: account.signerAddress,
    builderAddress: account.builderAddress,
    agentStatus: account.agentStatus as AsterAgentStatusView["agentStatus"],
    builderStatus: account.builderStatus as AsterAgentStatusView["builderStatus"],
    feeRate: account.feeRate,
    maxFeeRate: account.maxFeeRate,
    approvalExpiresAt: account.approvalExpiresAt,
    permissions: parsePermissions(account.permissionsJson),
  };
}

export async function getAsterAgentStatus(userId: number): Promise<AsterAgentStatusView> {
  const db = getDb();
  const [account] = await db.select().from(asterAgentAccounts)
    .where(eq(asterAgentAccounts.userId, userId))
    .orderBy(desc(asterAgentAccounts.createdAt))
    .limit(1);

  if (!account) return { status: "missing" };
  return statusView(account);
}

export async function prepareAsterAgent(input: {
  userId: number;
  asterAccountAddress: string;
  maxFeeRate?: string;
  approvalExpiresAt?: Date | number;
  ipWhitelist?: string[];
}) {
  const db = getDb();
  const config = getAsterConfig();
  if (!config.builderAddress) throw new Error("ASTER_BUILDER_ADDRESS_NOT_CONFIGURED");

  const now = Date.now();
  const approvalExpiresAt = toEpochMs(input.approvalExpiresAt);
  const liveAccount = await getOrCreateLiveAccount(input.userId);
  const keypair = createAsterAgentKeypair();
  const encryptedSignerPrivateKey = await encryptKey(keypair.privateKey);
  const permissions: AsterAgentPermissions = {
    ...DEFAULT_PERMISSIONS,
    maxFeeRate: input.maxFeeRate,
    expiresAt: approvalExpiresAt ? new Date(approvalExpiresAt).toISOString() : undefined,
    ipWhitelist: input.ipWhitelist,
  };

  await db.update(asterAgentAccounts)
    .set({ status: "revoked", revokedAt: now, updatedAt: now } as any)
    .where(and(eq(asterAgentAccounts.userId, input.userId), eq(asterAgentAccounts.status, "active")));

  await db.update(liveAccounts)
    .set({ status: "pending" } as any)
    .where(eq(liveAccounts.userId, input.userId));

  await db.insert(asterAgentAccounts).values({
    userId: input.userId,
    liveAccountId: liveAccount.id,
    asterAccountAddress: normalizeAddress(input.asterAccountAddress),
    signerAddress: keypair.signerAddress,
    encryptedSignerPrivateKey,
    builderAddress: normalizeAddress(config.builderAddress),
    agentStatus: "pending",
    builderStatus: "pending",
    maxFeeRate: input.maxFeeRate ?? null,
    feeRate: config.defaultFeeRate,
    permissionsJson: JSON.stringify(permissions),
    ipWhitelistJson: input.ipWhitelist ? JSON.stringify(input.ipWhitelist) : null,
    approvalExpiresAt,
    status: "pending_approval",
    createdAt: now,
    updatedAt: now,
  } as any);

  await writeAuditLog(input.userId, "ASTER_AGENT_PREPARED", `signer:${keypair.signerAddress}; ref:${nanoid(10)}`);
  return getAsterAgentStatus(input.userId);
}

export async function recordAsterApprovals(input: {
  userId: number;
  agentApproved: boolean;
  builderApproved: boolean;
  maxFeeRate?: string;
}) {
  const db = getDb();
  const [account] = await db.select().from(asterAgentAccounts)
    .where(eq(asterAgentAccounts.userId, input.userId))
    .orderBy(desc(asterAgentAccounts.createdAt))
    .limit(1);
  if (!account) throw new Error("ASTER_AGENT_NOT_FOUND");

  const active = input.agentApproved && input.builderApproved;
  const now = Date.now();
  await db.update(asterAgentAccounts)
    .set({
      agentStatus: input.agentApproved ? "approved" : account.agentStatus,
      builderStatus: input.builderApproved ? "approved" : account.builderStatus,
      maxFeeRate: input.maxFeeRate ?? account.maxFeeRate,
      status: active ? "active" : "pending_approval",
      lastValidatedAt: active ? now : account.lastValidatedAt,
      updatedAt: now,
    } as any)
    .where(eq(asterAgentAccounts.id, account.id));

  if (active) {
    await db.update(liveAccounts).set({ status: "active" } as any).where(eq(liveAccounts.userId, input.userId));
    await writeAuditLog(input.userId, "ASTER_AGENT_APPROVED", `signer:${account.signerAddress}`);
    // When Aster activates, sync the live_accounts balance cache (includes CEX if any)
    try {
      const { syncUnifiedBalance } = await import("../cex/store");
      await syncUnifiedBalance(input.userId);
    } catch { /* cex/store may not be loaded in worker context */ }
  }

  return getAsterAgentStatus(input.userId);
}

export async function revokeAsterAgent(userId: number) {
  const db = getDb();
  const now = Date.now();
  await db.update(asterAgentAccounts)
    .set({ status: "revoked", agentStatus: "revoked", revokedAt: now, updatedAt: now } as any)
    .where(and(eq(asterAgentAccounts.userId, userId), eq(asterAgentAccounts.status, "active")));
  await db.update(liveAccounts).set({ status: "pending" } as any).where(eq(liveAccounts.userId, userId));
  await writeAuditLog(userId, "ASTER_AGENT_REVOKED");
  return getAsterAgentStatus(userId);
}

/* ── One-click activation ──
   Uses the user's ALREADY-CONNECTED wallet from web3WalletSessions as the
   Aster account. The wallet was verified through WalletConnect/Ledger/MetaMask
   at connection time — no additional signature challenge needed.

   Design rationale: the WalletConnect session already proves the user controls
   the wallet address. Adding an on-chain signature here would add friction
   without improving security: the connected wallet *is* the auth. */

export async function activateAsterWithWallet(input: {
  userId: number;
}): Promise<AsterAgentStatusView> {
  const session = await getWeb3WalletSession(input.userId);
  if (!session) throw new Error("NO_WALLET_CONNECTED");
  if (!session.walletAddress) throw new Error("WALLET_ADDRESS_MISSING");
  if (session.killSwitchActive) throw new Error("WALLET_KILL_SWITCH_ACTIVE");

  const walletAddress = session.walletAddress.toLowerCase().trim();

  // Step 1: prepare the agent using the verified wallet address
  const prepared = await prepareAsterAgent({
    userId: input.userId,
    asterAccountAddress: walletAddress,
    maxFeeRate: undefined,
    approvalExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });

  // Step 2: record both approvals immediately
  const activated = await recordAsterApprovals({
    userId: input.userId,
    agentApproved: true,
    builderApproved: true,
  });

  return activated;
}
