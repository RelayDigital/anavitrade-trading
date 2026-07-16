import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { asterAgentAccounts, liveAccounts, navSnapshots } from "../../drizzle/schema";
import { decryptKey, encryptKey, getDb, getOrCreateLiveAccount, getWeb3WalletSession, writeAuditLog } from "../db";
import { AsterApiClient } from "./client";
import { getAsterConfig } from "./config";
import { createAsterAgentKeypair } from "./signing";
import { privateKeyToAccount } from "viem/accounts";
import type {
  AsterAgentPermissions,
  AsterAgentRegistrationChallenge,
  AsterAgentRegistrationParams,
  AsterAgentStatusView,
  AsterRemoteAgent,
  AsterRemoteBuilder,
} from "./types";

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

let lastRegistrationNonce = 0;

function nextRegistrationNonce(): number {
  const candidate = Math.floor(Date.now() / 1000) * 1_000_000;
  lastRegistrationNonce = candidate > lastRegistrationNonce ? candidate : lastRegistrationNonce + 1;
  return lastRegistrationNonce;
}

function capitalizeKey(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function managementFieldType(value: unknown): "string" | "bool" | "uint256" {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number" && Number.isInteger(value)) return "uint256";
  return "string";
}

function registrationChallenge(account: typeof asterAgentAccounts.$inferSelect): AsterAgentRegistrationChallenge {
  const permissions = parsePermissions(account.permissionsJson);
  const config = getAsterConfig();
  const feeCap = account.maxFeeRate ?? account.feeRate ?? config.defaultFeeRate;
  const params: AsterAgentRegistrationParams = {
    agentName: "Anavitrade",
    agentAddress: account.signerAddress,
    ipWhitelist: Array.isArray(permissions.ipWhitelist) ? permissions.ipWhitelist.join(" ") : "",
    expired: account.approvalExpiresAt ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
    canSpotTrade: permissions.spot,
    canPerpTrade: permissions.perp,
    canWithdraw: false,
    builder: account.builderAddress,
    maxFeeRate: feeCap,
    builderName: "Anavitrade",
    ...(config.includeCompatParams ? { asterChain: config.asterChain } : {}),
    user: account.asterAccountAddress,
    nonce: nextRegistrationNonce(),
  };

  const message = Object.fromEntries(
    Object.entries(params).map(([key, value]) => [capitalizeKey(key), value]),
  ) as Record<string, string | boolean | number>;

  return {
    params,
    typedData: {
      domain: {
        name: "AsterSignTransaction",
        version: "1",
        chainId: config.codeSigningChainId,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      types: {
        ApproveAgent: Object.entries(message).map(([name, value]) => ({
          name,
          type: managementFieldType(value),
        })),
      },
      primaryType: "ApproveAgent",
      message,
    },
  };
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
    lastValidatedAt: account.lastValidatedAt,
    permissions: parsePermissions(account.permissionsJson),
  };
}

function decimalValue(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function remoteAgentMatches(account: typeof asterAgentAccounts.$inferSelect, remote: AsterRemoteAgent): boolean {
  return normalizeAddress(remote.agentAddress ?? "") === normalizeAddress(account.signerAddress)
    && remote.canPerpTrade === true
    && remote.canWithdraw === false
    && Number(remote.expired ?? 0) >= Date.now();
}

function remoteBuilderMatches(
  account: typeof asterAgentAccounts.$inferSelect,
  requestedMaxFeeRate: string,
  remote: AsterRemoteBuilder,
): boolean {
  return normalizeAddress(remote.builderAddress ?? "") === normalizeAddress(account.builderAddress)
    && decimalValue(remote.maxFeeRate) >= decimalValue(requestedMaxFeeRate);
}

async function validateAsterReadback(
  account: typeof asterAgentAccounts.$inferSelect,
  requestedMaxFeeRate: string,
  client: AsterApiClient,
): Promise<void> {
  const privateKey = await decryptKey(account.encryptedSignerPrivateKey);
  const signer = privateKeyToAccount(privateKey as `0x${string}`);
  const [agents, builders] = await Promise.all([
    client.getAgents(account.asterAccountAddress, signer),
    client.getBuilders(account.asterAccountAddress, signer),
  ]);

  const agentApproved = agents.some((agent) => remoteAgentMatches(account, agent));
  const builderApproved = builders.some((builder) => remoteBuilderMatches(account, requestedMaxFeeRate, builder));
  if (agentApproved && builderApproved) return;

  const now = Date.now();
  const db = getDb();
  await db.update(asterAgentAccounts)
    .set({
      agentStatus: agentApproved ? "approved" : "rejected",
      builderStatus: builderApproved ? "approved" : "rejected",
      status: "pending_approval",
      lastValidatedAt: now,
      updatedAt: now,
    } as any)
    .where(eq(asterAgentAccounts.id, account.id));

  throw new Error(`ASTER_REGISTRATION_VALIDATION_FAILED:agent=${agentApproved};builder=${builderApproved}`);
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
  const approvalExpiresAt = toEpochMs(input.approvalExpiresAt) ?? now + 30 * 24 * 60 * 60 * 1000;
  const liveAccount = await getOrCreateLiveAccount(input.userId);
  const keypair = createAsterAgentKeypair();
  const encryptedSignerPrivateKey = await encryptKey(keypair.privateKey);
  const permissions: AsterAgentPermissions = {
    ...DEFAULT_PERMISSIONS,
    maxFeeRate: input.maxFeeRate,
    expiresAt: new Date(approvalExpiresAt).toISOString(),
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
    maxFeeRate: input.maxFeeRate ?? config.defaultFeeRate,
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

export async function prepareAsterRegistration(input: {
  userId: number;
}): Promise<AsterAgentRegistrationChallenge> {
  const session = await getWeb3WalletSession(input.userId);
  if (!session) throw new Error("NO_WALLET_CONNECTED");
  if (!session.walletAddress) throw new Error("WALLET_ADDRESS_MISSING");
  if (session.killSwitchActive) throw new Error("WALLET_KILL_SWITCH_ACTIVE");

  await prepareAsterAgent({
    userId: input.userId,
    asterAccountAddress: session.walletAddress.toLowerCase().trim(),
    maxFeeRate: undefined,
    approvalExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });

  const db = getDb();
  const [account] = await db.select().from(asterAgentAccounts)
    .where(eq(asterAgentAccounts.userId, input.userId))
    .orderBy(desc(asterAgentAccounts.createdAt))
    .limit(1);
  if (!account) throw new Error("ASTER_AGENT_NOT_FOUND");

  return registrationChallenge(account);
}

export async function completeAsterRegistration(input: {
  userId: number;
  params: AsterAgentRegistrationParams;
  signature: string;
}) {
  const db = getDb();
  const [account] = await db.select().from(asterAgentAccounts)
    .where(eq(asterAgentAccounts.userId, input.userId))
    .orderBy(desc(asterAgentAccounts.createdAt))
    .limit(1);
  if (!account) throw new Error("ASTER_AGENT_NOT_FOUND");
  if (account.status !== "pending_approval") throw new Error("ASTER_AGENT_NOT_PENDING");
  if (normalizeAddress(input.params.user) !== normalizeAddress(account.asterAccountAddress)) {
    throw new Error("ASTER_REGISTRATION_USER_MISMATCH");
  }
  if (normalizeAddress(input.params.agentAddress) !== normalizeAddress(account.signerAddress)) {
    throw new Error("ASTER_REGISTRATION_AGENT_MISMATCH");
  }
  if (Number(account.approvalExpiresAt ?? 0) !== input.params.expired) {
    throw new Error("ASTER_REGISTRATION_EXPIRY_MISMATCH");
  }
  if (normalizeAddress(input.params.builder) !== normalizeAddress(account.builderAddress)) {
    throw new Error("ASTER_REGISTRATION_BUILDER_MISMATCH");
  }

  const client = new AsterApiClient();
  await client.approveAgent(input.params, input.signature);
  await validateAsterReadback(account, input.params.maxFeeRate, client);
  await recordAsterApprovals({
    userId: input.userId,
    agentApproved: true,
    builderApproved: true,
    maxFeeRate: input.params.maxFeeRate,
  });
  await writeAuditLog(input.userId, "ASTER_AGENT_REGISTERED", `signer:${account.signerAddress}`);

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
    try {
      await syncAsterFuturesBalance(input.userId);
    } catch { /* balance read may fail before funds are present; activation already succeeded */ }
  }

  return getAsterAgentStatus(input.userId);
}


export async function syncAsterFuturesBalance(userId: number) {
  const db = getDb();
  const [account] = await db.select().from(asterAgentAccounts)
    .where(and(eq(asterAgentAccounts.userId, userId), eq(asterAgentAccounts.status, "active")))
    .orderBy(desc(asterAgentAccounts.createdAt))
    .limit(1);
  if (!account) throw new Error("ASTER_AGENT_NOT_FOUND");
  if (account.agentStatus !== "approved" || account.builderStatus !== "approved") {
    throw new Error("ASTER_APPROVAL_NOT_CONFIRMED");
  }

  const privateKey = await decryptKey(account.encryptedSignerPrivateKey);
  const signer = privateKeyToAccount(privateKey as `0x${string}`);
  const snapshot = await new AsterApiClient().getFuturesBalance(account.asterAccountAddress, signer);
  const now = Date.now();

  await db.update(liveAccounts).set({
    status: "active",
    lastTotalEquityUsd: snapshot.equityUsd.toFixed(2),
    lastAvailableUsd: snapshot.availableUsd.toFixed(2),
    linkedExchangesJson: JSON.stringify([{ exchange: "aster", label: "Aster Futures", error: false }]),
    updatedAt: new Date(),
  } as any).where(eq(liveAccounts.userId, userId));

  await db.insert(navSnapshots).values({
    userId,
    provider: "aster",
    accountEquityUsd: snapshot.equityUsd.toFixed(2),
    availableBalanceUsd: snapshot.availableUsd.toFixed(2),
    unrealizedPnlUsd: snapshot.unrealizedPnlUsd != null ? snapshot.unrealizedPnlUsd.toFixed(2) : null,
    realizedPnlUsd: null,
    depositsUsd: null,
    withdrawalsUsd: null,
    source: "provider_sync",
    snapshotAt: now,
  } as any);

  await writeAuditLog(userId, "ASTER_BALANCE_SYNCED", `equity:${snapshot.equityUsd.toFixed(2)}; available:${snapshot.availableUsd.toFixed(2)}`);
  return snapshot;
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
