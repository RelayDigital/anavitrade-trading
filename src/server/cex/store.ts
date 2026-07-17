import { and, desc, eq, sql } from "drizzle-orm";
import { cexConnections, liveAccounts, navSnapshots } from "../../drizzle/schema";
import {
  decryptKey, encryptKey, getDb, getOrCreateLiveAccount, writeAuditLog,
} from "../db";
import { assertAutomatedExecutionSupported, getExchange, isLiveExchange } from "./registry";
import { createCexClient } from "./factory";
import type { CexBalance, CexCredentials, ExchangeEnvironment } from "./clientTypes";

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

type CexNavConnection = Pick<typeof cexConnections.$inferSelect,
  "id" | "exchange" | "label" | "killSwitchActive">;

type StoredCexNavConnection = CexNavConnection & Pick<typeof cexConnections.$inferSelect,
  "encryptedApiKey" | "encryptedApiSecret" | "encryptedPassphrase">;

export type CexNavRefreshFailureCode =
  | "CEX_NAV_REFRESH_NO_ACTIVE_CONNECTIONS"
  | "CEX_NAV_REFRESH_CONNECTION_FAILED"
  | "CEX_NAV_REFRESH_INVALID_TOTALS";

/** A refresh error that callers must treat as an unsafe/missing CEX NAV. */
export class CexNavRefreshError extends Error {
  readonly name = "CexNavRefreshError";

  constructor(
    readonly code: CexNavRefreshFailureCode,
    detail?: string,
  ) {
    super(detail ? `${code}:${detail}` : code);
  }
}

export type CexNavSnapshotForPersistence = {
  userId: number;
  provider: "cex";
  source: "provider_sync";
  accountEquityUsd: string;
  availableBalanceUsd: string;
  snapshotAt: number;
  linkedExchanges: Array<{ exchange: string; label: string | null; error: false }>;
  connectionEquities: Array<{ connectionId: number; equityUsd: string }>;
};

export type CexNavRefreshDependencies = {
  loadActiveConnections?: (userId: number) => Promise<CexNavConnection[]>;
  readBalance?: (connection: CexNavConnection, environment: ExchangeEnvironment) => Promise<CexBalance>;
  persist?: (snapshot: CexNavSnapshotForPersistence) => Promise<void>;
};

export type CexNavRefreshOptions = {
  environment?: ExchangeEnvironment;
  /** Automated dispatch must assert capabilities before any credential is materialized. */
  requireAutomatedExecution?: boolean;
  dependencies?: CexNavRefreshDependencies;
};

async function loadActiveCexConnections(userId: number): Promise<StoredCexNavConnection[]> {
  const db = getDb();
  return db.select().from(cexConnections)
    .where(and(eq(cexConnections.userId, userId), eq(cexConnections.status, "active")));
}

async function readCexBalance(
  connection: CexNavConnection,
  environment: ExchangeEnvironment,
): Promise<CexBalance> {
  const credentials = await decryptCexCredentials(connection as typeof cexConnections.$inferSelect);
  credentials.environment = environment;
  credentials.testnet = environment === "testnet";
  return createCexClient(connection.exchange, credentials).validateAndReadBalance();
}

async function persistCexNavSnapshot(snapshot: CexNavSnapshotForPersistence): Promise<void> {
  const db = getDb();
  const statements: any[] = [db.update(liveAccounts).set({
    lastTotalEquityUsd: snapshot.accountEquityUsd,
    lastAvailableUsd: snapshot.availableBalanceUsd,
    linkedExchangesJson: JSON.stringify(snapshot.linkedExchanges),
    updatedAt: new Date(snapshot.snapshotAt),
  } as any).where(eq(liveAccounts.userId, snapshot.userId))];

  statements.push(db.insert(navSnapshots).values({
    userId: snapshot.userId,
    provider: snapshot.provider,
    accountEquityUsd: snapshot.accountEquityUsd,
    availableBalanceUsd: snapshot.availableBalanceUsd,
    unrealizedPnlUsd: null,
    realizedPnlUsd: null,
    depositsUsd: null,
    withdrawalsUsd: null,
    snapshotAt: snapshot.snapshotAt,
    source: snapshot.source,
  } as any));

  for (const connection of snapshot.connectionEquities) {
    statements.push(db.update(cexConnections).set({
      highWaterMark: sql`CASE
        WHEN ${cexConnections.highWaterMark} IS NULL
          OR CAST(${cexConnections.highWaterMark} AS REAL) < CAST(${connection.equityUsd} AS REAL)
        THEN ${connection.equityUsd}
        ELSE ${cexConnections.highWaterMark}
      END`,
      updatedAt: new Date(snapshot.snapshotAt),
    } as any).where(eq(cexConnections.id, connection.connectionId)));
  }

  await (db as any).batch(statements);

  await writeAuditLog(
    snapshot.userId,
    "CEX_BALANCE_SYNCED",
    `equity:${snapshot.accountEquityUsd}; available:${snapshot.availableBalanceUsd}`,
  );
}

/**
 * Refresh and persist a unified CEX NAV only when every active connection was
 * read successfully. This is deliberately separate from display-oriented
 * balance reads: a partial aggregate must never look like a fresh risk NAV.
 */
export async function refreshCexNavSnapshot(
  userId: number,
  options: CexNavRefreshOptions = {},
) {
  const environment = options.environment ?? "production";
  const dependencies = options.dependencies ?? {};
  const loadConnections = dependencies.loadActiveConnections ?? loadActiveCexConnections;
  const readBalance = dependencies.readBalance ?? readCexBalance;
  const persist = dependencies.persist ?? persistCexNavSnapshot;
  const connections = await loadConnections(userId);

  if (connections.length === 0) {
    throw new CexNavRefreshError("CEX_NAV_REFRESH_NO_ACTIVE_CONNECTIONS");
  }

  const results = await Promise.allSettled(connections.map(async (connection) => {
    // This must precede decryption/client construction in automated dispatch.
    if (options.requireAutomatedExecution) {
      assertAutomatedExecutionSupported(connection.exchange, environment);
    }
    return { connection, balance: await readBalance(connection, environment) };
  }));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) {
    const detail = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
    throw new CexNavRefreshError("CEX_NAV_REFRESH_CONNECTION_FAILED", detail.slice(0, 200));
  }

  const complete = results.map((result) => (result as PromiseFulfilledResult<{
    connection: CexNavConnection;
    balance: CexBalance;
  }>).value);
  const totalEquityUsd = complete.reduce((sum, result) => sum + result.balance.equityUsd, 0);
  const totalAvailableUsd = complete.reduce((sum, result) => sum + result.balance.availableUsd, 0);
  if (!Number.isFinite(totalEquityUsd) || totalEquityUsd <= 0
    || !Number.isFinite(totalAvailableUsd) || totalAvailableUsd < 0) {
    throw new CexNavRefreshError("CEX_NAV_REFRESH_INVALID_TOTALS");
  }

  const snapshotAt = Date.now();
  const snapshot: CexNavSnapshotForPersistence = {
    userId,
    provider: "cex",
    source: "provider_sync",
    accountEquityUsd: totalEquityUsd.toFixed(2),
    availableBalanceUsd: totalAvailableUsd.toFixed(2),
    snapshotAt,
    linkedExchanges: complete.map(({ connection }) => ({
      exchange: connection.exchange,
      label: connection.label,
      error: false,
    })),
    connectionEquities: complete.map(({ connection, balance }) => ({
      connectionId: connection.id,
      equityUsd: balance.equityUsd.toFixed(2),
    })),
  };
  await persist(snapshot);

  return {
    snapshotAt,
    totalEquityUsd,
    totalAvailableUsd,
    balances: complete.map(({ connection, balance }) => ({
      exchange: connection.exchange,
      label: connection.label,
      killSwitchActive: connection.killSwitchActive,
      equityUsd: balance.equityUsd,
      availableUsd: balance.availableUsd,
    })),
  };
}

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
  return refreshCexNavSnapshot(userId);
}
