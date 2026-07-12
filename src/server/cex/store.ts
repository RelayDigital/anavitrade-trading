import { and, desc, eq } from "drizzle-orm";
import { cexConnections, liveAccounts } from "../../drizzle/schema";
import {
  decryptKey, encryptKey, getDb, getOrCreateLiveAccount, writeAuditLog,
} from "../db";
import { getExchange, isLiveExchange } from "./registry";
import { createCexClient } from "./factory";
import type { CexCredentials } from "./clientTypes";

export type CexConnectionView = {
  id: number;
  exchange: string;
  label: string | null;
  status: string;
  copytradeEnabled: boolean;
  killSwitchActive: boolean;
  permissionsVerified: boolean;
  withdrawalDisabledVerified: boolean;
  attested: boolean;
  lastBalanceUsd: string | null;
  lastValidatedAt: Date | null;
};

function view(row: typeof cexConnections.$inferSelect): CexConnectionView {
  return {
    id: row.id,
    exchange: row.exchange,
    label: row.label,
    status: row.status,
    copytradeEnabled: row.copytradeEnabled,
    killSwitchActive: row.killSwitchActive,
    permissionsVerified: row.permissionsVerified,
    withdrawalDisabledVerified: row.withdrawalDisabledVerified,
    attested: row.attested,
    lastBalanceUsd: row.lastBalanceUsd,
    lastValidatedAt: row.lastValidatedAt,
  };
}

/** All non-revoked connections for a user (newest first). */
export async function listCexConnections(userId: number): Promise<CexConnectionView[]> {
  const db = getDb();
  const rows = await db.select().from(cexConnections)
    .where(eq(cexConnections.userId, userId))
    .orderBy(desc(cexConnections.createdAt));
  return rows.filter((r) => r.status !== "revoked").map(view);
}

export async function getActiveCexConnection(userId: number, exchange?: string) {
  const db = getDb();
  const conds = [eq(cexConnections.userId, userId), eq(cexConnections.status, "active")];
  if (exchange) conds.push(eq(cexConnections.exchange, exchange));
  const [row] = await db.select().from(cexConnections)
    .where(and(...conds))
    .orderBy(desc(cexConnections.createdAt))
    .limit(1);
  return row ?? null;
}

/** Decrypt a stored connection's credentials for use by the execution adapter. */
export async function decryptCexCredentials(
  row: typeof cexConnections.$inferSelect,
  testnet = false,
): Promise<CexCredentials> {
  return {
    apiKey: await decryptKey(row.encryptedApiKey),
    apiSecret: await decryptKey(row.encryptedApiSecret),
    passphrase: row.encryptedPassphrase ? await decryptKey(row.encryptedPassphrase) : undefined,
    testnet,
  };
}

/**
 * Store new API credentials for an exchange (encrypted at rest), replacing any
 * prior active connection for the same exchange. Status starts "pending" until
 * validate() proves the keys work.
 */
export async function prepareCexConnection(input: {
  userId: number;
  exchange: string;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  attestTradeOnly: boolean;
  label?: string;
}) {
  const meta = getExchange(input.exchange);
  if (!meta) throw new Error("EXCHANGE_UNKNOWN");
  if (!meta.live) throw new Error("EXCHANGE_NOT_LIVE");
  if (meta.needsPassphrase && !input.passphrase) throw new Error("PASSPHRASE_REQUIRED");

  const db = getDb();
  const liveAccount = await getOrCreateLiveAccount(input.userId);

  // Revoke any existing active connection for this exchange.
  await db.update(cexConnections)
    .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() } as any)
    .where(and(
      eq(cexConnections.userId, input.userId),
      eq(cexConnections.exchange, input.exchange),
      eq(cexConnections.status, "active"),
    ));

  await db.insert(cexConnections).values({
    userId: input.userId,
    liveAccountId: liveAccount.id,
    exchange: input.exchange,
    label: input.label ?? meta.label,
    encryptedApiKey: await encryptKey(input.apiKey),
    encryptedApiSecret: await encryptKey(input.apiSecret),
    encryptedPassphrase: input.passphrase ? await encryptKey(input.passphrase) : null,
    status: "pending",
    attested: input.attestTradeOnly,
  } as any);

  await writeAuditLog(input.userId, "CEX_CONNECTION_PREPARED", `exchange:${input.exchange}`);

  const [row] = await db.select().from(cexConnections)
    .where(and(
      eq(cexConnections.userId, input.userId),
      eq(cexConnections.exchange, input.exchange),
      eq(cexConnections.status, "pending"),
    ))
    .orderBy(desc(cexConnections.createdAt))
    .limit(1);
  return row;
}

/**
 * Validate a pending connection against the live exchange: read balance and,
 * where possible, verify the key is trade-only (no withdrawal). On success mark
 * it active and flip the user's live account active.
 */
export async function validateCexConnection(userId: number, exchange: string) {
  const db = getDb();
  const [row] = await db.select().from(cexConnections)
    .where(and(
      eq(cexConnections.userId, userId),
      eq(cexConnections.exchange, exchange),
      eq(cexConnections.status, "pending"),
    ))
    .orderBy(desc(cexConnections.createdAt))
    .limit(1);
  if (!row) throw new Error("CEX_CONNECTION_NOT_FOUND");

  const creds = await decryptCexCredentials(row);
  const client = createCexClient(exchange, creds);

  const balance = await client.validateAndReadBalance();
  const perm = await client.verifyTradeOnly();

  // Hard reject if we positively confirmed withdrawal is ENABLED.
  if (perm.permissionsVerified && !perm.withdrawalDisabledVerified) {
    await db.update(cexConnections)
      .set({ status: "error", updatedAt: new Date() } as any)
      .where(eq(cexConnections.id, row.id));
    await writeAuditLog(userId, "CEX_CONNECTION_REJECTED", `exchange:${exchange}; ${perm.note}`);
    throw new Error("KEY_HAS_WITHDRAWAL_PERMISSION");
  }

  // If we can't verify programmatically, require the user's attestation.
  if (!perm.permissionsVerified && !row.attested) {
    throw new Error("ATTESTATION_REQUIRED");
  }

  await db.update(cexConnections)
    .set({
      status: "active",
      permissionsVerified: perm.permissionsVerified,
      withdrawalDisabledVerified: perm.withdrawalDisabledVerified,
      lastBalanceUsd: balance.equityUsd.toFixed(2),
      lastValidatedAt: new Date(),
      updatedAt: new Date(),
    } as any)
    .where(eq(cexConnections.id, row.id));

  await db.update(liveAccounts).set({ status: "active" } as any).where(eq(liveAccounts.userId, userId));
  await writeAuditLog(userId, "CEX_CONNECTION_ACTIVATED", `exchange:${exchange}; equity:${balance.equityUsd.toFixed(2)}`);

  // Sync full unified balance into live_accounts cache
  try { await syncUnifiedBalance(userId); } catch { /* best-effort */ }

  return { balance, permission: perm };
}

export async function revokeCexConnection(userId: number, exchange: string) {
  const db = getDb();
  await db.update(cexConnections)
    .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() } as any)
    .where(and(
      eq(cexConnections.userId, userId),
      eq(cexConnections.exchange, exchange),
      eq(cexConnections.status, "active"),
    ));
  await writeAuditLog(userId, "CEX_CONNECTION_REVOKED", `exchange:${exchange}`);
  // Refresh unified balance cache
  try { await syncUnifiedBalance(userId); } catch { /* best-effort */ }
  return listCexConnections(userId);
}

export async function toggleCexKillSwitch(userId: number, exchange: string, active: boolean) {
  const db = getDb();
  await db.update(cexConnections)
    .set({ killSwitchActive: active, updatedAt: new Date() } as any)
    .where(and(
      eq(cexConnections.userId, userId),
      eq(cexConnections.exchange, exchange),
      eq(cexConnections.status, "active"),
    ));
  await writeAuditLog(userId, active ? "CEX_KILL_SWITCH_ON" : "CEX_KILL_SWITCH_OFF", `exchange:${exchange}`);
  return listCexConnections(userId);
}

/** Read the live balance for an active connection (dashboard display). */
export async function getCexBalance(userId: number, exchange: string) {
  const row = await getActiveCexConnection(userId, exchange);
  if (!row) return null;
  const creds = await decryptCexCredentials(row);
  const client = createCexClient(exchange, creds);
  try {
    const balance = await client.validateAndReadBalance();
    return { exchange, ...balance };
  } catch {
    return { exchange, equityUsd: 0, availableUsd: 0, error: true };
  }
}

export { isLiveExchange };

/* ── Unified Balance (all active CEX connections) ────────────────────── */

export type CexBalanceSnapshot = {
  exchange: string;
  label: string | null;
  killSwitchActive: boolean;
  equityUsd: number;
  availableUsd: number;
  error?: boolean;
};

export type UnifiedBalanceSummary = {
  totalEquityUsd: number;
  totalAvailableUsd: number;
  exchangeCount: number;
  activeCount: number;
};

/** Read live balance for EVERY active CEX connection. */
export async function getAllCexBalances(userId: number): Promise<CexBalanceSnapshot[]> {
  const db = getDb();
  const rows = await db.select().from(cexConnections)
    .where(and(eq(cexConnections.userId, userId), eq(cexConnections.status, "active")));

  const results = await Promise.allSettled(
    rows.map(async (row) => {
      try {
        const creds = await decryptCexCredentials(row);
        const client = createCexClient(row.exchange, creds);
        const balance = await client.validateAndReadBalance();
        return {
          exchange: row.exchange, label: row.label,
          killSwitchActive: row.killSwitchActive,
          equityUsd: balance.equityUsd, availableUsd: balance.availableUsd,
        };
      } catch {
        return {
          exchange: row.exchange, label: row.label,
          killSwitchActive: row.killSwitchActive,
          equityUsd: 0, availableUsd: 0, error: true,
        };
      }
    }),
  );

  return results.map((r) => {
    if (r.status === "fulfilled") return r.value;
    return { exchange: "unknown", label: null, killSwitchActive: false, equityUsd: 0, availableUsd: 0, error: true };
  });
}

/** Aggregate per-exchange snapshots into a unified view. */
export function getUnifiedSummary(balances: CexBalanceSnapshot[]): UnifiedBalanceSummary {
  const active = balances.filter((b) => !b.error);
  return {
    totalEquityUsd: active.reduce((s, b) => s + b.equityUsd, 0),
    totalAvailableUsd: active.reduce((s, b) => s + b.availableUsd, 0),
    exchangeCount: balances.length,
    activeCount: active.length,
  };
}

/**
 * Sync ALL exchange balances into the live_accounts cache.
 * Call this after connect/validate/revoke to keep the user's unified balance fresh.
 * Also returns the snapshot for immediate use.
 */
export async function syncUnifiedBalance(userId: number) {
  const db = getDb();
  const balances = await getAllCexBalances(userId);
  const summary = getUnifiedSummary(balances);

  await db.update(liveAccounts)
    .set({
      lastTotalEquityUsd: summary.totalEquityUsd.toFixed(2),
      lastAvailableUsd: summary.totalAvailableUsd.toFixed(2),
      linkedExchangesJson: JSON.stringify(balances.map(b => ({
        exchange: b.exchange, label: b.label, error: b.error,
      }))),
      updatedAt: new Date(),
    } as any)
    .where(eq(liveAccounts.userId, userId));

  return { balances, summary };
}
