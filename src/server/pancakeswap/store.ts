import { and, eq } from "drizzle-orm";
import { pancakeswapDelegations } from "../../drizzle/schema";
import { getDb, getWeb3WalletSession, writeAuditLog } from "../db";
import { getPancakeswapConfig } from "./config";
import type { PancakeswapDelegationChallenge, PancakeswapPermitSingle } from "./types";

const DEFAULT_EXPIRATION_DAYS = 30;
const SIG_DEADLINE_MINUTES = 30;

async function loadDelegation(userId: number, tokenAddress: string) {
  const db = getDb();
  const [row] = await db.select().from(pancakeswapDelegations)
    .where(and(eq(pancakeswapDelegations.userId, userId), eq(pancakeswapDelegations.tokenAddress, tokenAddress.toLowerCase())))
    .limit(1);
  return row ?? null;
}

/** Builds the Permit2 delegation challenge for the user to sign — mirrors
 *  aster/store.ts's prepareAsterRegistration (prepare → sign → complete). */
export async function preparePancakeswapDelegation(input: {
  userId: number;
  tokenAddress: string;
  amountCap: string;
  expirationDays?: number;
}): Promise<PancakeswapDelegationChallenge> {
  const session = await getWeb3WalletSession(input.userId);
  if (!session) throw new Error("NO_WALLET_CONNECTED");
  if (!session.walletAddress) throw new Error("WALLET_ADDRESS_MISSING");
  if (session.killSwitchActive) throw new Error("WALLET_KILL_SWITCH_ACTIVE");

  const config = getPancakeswapConfig();
  if (!config.executorAddress) throw new Error("PANCAKESWAP_EXECUTOR_NOT_CONFIGURED");

  const tokenAddress = input.tokenAddress.toLowerCase();
  const owner = session.walletAddress.toLowerCase() as `0x${string}`;

  const [{ readPermit2Allowance }, { buildPermitSingleTypedData }] = await Promise.all([
    import("./client"),
    import("./signing"),
  ]);

  const { nonce } = await readPermit2Allowance({
    owner,
    token: tokenAddress as `0x${string}`,
    spender: config.executorAddress,
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiration = nowSeconds + (input.expirationDays ?? DEFAULT_EXPIRATION_DAYS) * 86400;
  const sigDeadline = nowSeconds + SIG_DEADLINE_MINUTES * 60;

  const permit: PancakeswapPermitSingle = {
    details: { token: tokenAddress, amount: input.amountCap, expiration, nonce },
    spender: config.executorAddress,
    sigDeadline,
  };

  const chainId = 56; // BSC
  const typedData = buildPermitSingleTypedData({ chainId, permit2Address: config.permit2Address, permit });

  const db = getDb();
  const existing = await loadDelegation(input.userId, tokenAddress);
  const now = Date.now();
  const values = {
    userId: input.userId,
    walletAddress: owner,
    tokenAddress,
    spenderAddress: config.executorAddress,
    amountCap: input.amountCap,
    expiration,
    nonce,
    sigDeadline,
    status: "pending" as const,
    updatedAt: now,
  };
  if (existing) {
    await db.update(pancakeswapDelegations).set(values as any).where(eq(pancakeswapDelegations.id, existing.id));
  } else {
    await db.insert(pancakeswapDelegations).values({ ...values, createdAt: now } as any);
  }

  return { chainId, permit2Address: config.permit2Address, spenderAddress: config.executorAddress, typedData };
}

/** Verifies the signed permit matches what was issued, submits it on-chain via
 *  the executor, and activates the delegation. Mirrors completeAsterRegistration's
 *  anti-tamper param verification before trusting a client-submitted signature. */
export async function completePancakeswapDelegation(input: {
  userId: number;
  tokenAddress: string;
  signature: `0x${string}`;
}) {
  const tokenAddress = input.tokenAddress.toLowerCase();
  const delegation = await loadDelegation(input.userId, tokenAddress);
  if (!delegation) throw new Error("PANCAKESWAP_DELEGATION_NOT_FOUND");
  if (delegation.status !== "pending") throw new Error("PANCAKESWAP_DELEGATION_NOT_PENDING");

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

  const { submitPermit2Permit } = await import("./client");
  const permitTxHash = await submitPermit2Permit({
    owner: delegation.walletAddress as `0x${string}`,
    permit,
    signature: input.signature,
  });

  const db = getDb();
  const now = Date.now();
  await db.update(pancakeswapDelegations).set({
    status: "active",
    signature: input.signature,
    permitTxHash,
    lastValidatedAt: now,
    updatedAt: now,
  } as any).where(eq(pancakeswapDelegations.id, delegation.id));

  await writeAuditLog(input.userId, "PANCAKESWAP_DELEGATION_ACTIVATED", `token:${tokenAddress}; tx:${permitTxHash}`);
  return { status: "active" as const, permitTxHash };
}

export async function revokePancakeswapDelegation(userId: number, tokenAddress: string) {
  const db = getDb();
  const delegation = await loadDelegation(userId, tokenAddress.toLowerCase());
  if (!delegation) throw new Error("PANCAKESWAP_DELEGATION_NOT_FOUND");
  const now = Date.now();
  await db.update(pancakeswapDelegations).set({
    status: "revoked", revokedAt: now, updatedAt: now,
  } as any).where(eq(pancakeswapDelegations.id, delegation.id));
  await writeAuditLog(userId, "PANCAKESWAP_DELEGATION_REVOKED", `token:${tokenAddress}`);
}

export async function getPancakeswapDelegationStatus(userId: number, tokenAddress: string) {
  const delegation = await loadDelegation(userId, tokenAddress.toLowerCase());
  if (!delegation) return { status: "missing" as const };
  return {
    status: delegation.status,
    tokenAddress: delegation.tokenAddress,
    amountCap: delegation.amountCap,
    expiration: delegation.expiration,
    lastValidatedAt: delegation.lastValidatedAt,
  };
}
