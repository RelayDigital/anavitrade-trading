import { eq, and, desc, asc, sql, inArray, gte, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "./_core/env";
import { encryptKey as _encryptKey, decryptKey as _decryptKey } from "./cex/crypto";
import {
  InsertUser, users,
  authSessions,
  demoAccounts, demoTrades,
  portfolioSnapshots,
  liveAccounts, InsertLiveAccount,
  auditLog,
  web3WalletSessions, InsertWeb3WalletSession,
  coinlegsSignals,
  scraperRuns,
  type DemoAccount, type DemoTrade, type PortfolioSnapshot,
} from "../drizzle/schema";
import { nanoid } from "nanoid";
import {
  hashPassword,
  verifyPasswordAndRehash,
} from "./auth/password";
import {
  createOneTimeToken,
  digestOneTimeToken,
  getTokenPersistence,
} from "./auth/tokens";

export { hashPassword } from "./auth/password";

let _db: ReturnType<typeof drizzle> | null = null;
let _env: Env | null = null;

/** Expose the raw D1 binding for operations that bypass Drizzle ORM Date serialization. */
export function getRawD1(): any {
  if (!_env) throw new Error("Env not set — call setDbEnv() first");
  return _env.DB;
}

export function setDbEnv(env: Env) {
  _env = env;
  (globalThis as any).__env = env;
  _db = drizzle(env.DB);
}

export function getDb() {
  if (!_db) throw new Error("Database not available — call setDbEnv() first");
  return _db;
}

/* ─── Encryption key ───
   Delegates to the shared crypto module (src/server/cex/crypto.ts).
   This file provides Worker-friendly wrappers that read ENCRYPTION_KEY
   from the Worker env, while the crypto module itself is portable. */

function getEncryptionKeyOrThrow(): string {
  const encryptionKey = _env?.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error(
      "ENCRYPTION_KEY is not set. " +
      "Set a separate 32+ character key in wrangler.toml [vars] for local dev, " +
      "or via `npx wrangler secret put ENCRYPTION_KEY` for production. " +
      "Do NOT reuse JWT_SECRET as the encryption key."
    );
  }
  return encryptionKey;
}

export async function encryptKey(plaintext: string): Promise<string> {
  return _encryptKey(plaintext, getEncryptionKeyOrThrow());
}

export async function decryptKey(ciphertext: string): Promise<string> {
  return _decryptKey(ciphertext, getEncryptionKeyOrThrow());
}

/* Audit log */

export async function writeAuditLog(userId: number | null, action: string, detail?: string, ipAddress?: string) {
  const db = getDb();
  try {
    await db.insert(auditLog).values({ userId, action, detail: detail ?? null, ipAddress: ipAddress ?? null } as any);
  } catch (e) {
    console.warn("[AuditLog] Failed to write:", e);
  }
}

/* User / Auth Helpers */

export async function upsertUser(user: any): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = getDb();
  try {
    const values: Record<string, unknown> = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    textFields.forEach((field) => {
      const value = user[field];
      if (value === undefined) return;
      values[field] = value ?? null;
      updateSet[field] = value ?? null;
    });
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    else if (user.openId === _env?.OWNER_OPEN_ID) { values.role = "admin"; updateSet.role = "admin"; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

    await db.insert(users).values(values as any)
      .onConflictDoUpdate({ target: users.openId, set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = getDb();
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserByEmail(email: string) {
  const db = getDb();
  const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserById(id: number) {
  const db = getDb();
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createAuthSession(
  userId: number,
  sessionIdDigest: string,
  expiresAt: Date,
) {
  await getDb().insert(authSessions).values({ userId, sessionIdDigest, expiresAt } as any);
}

export async function getAuthSessionByDigest(sessionIdDigest: string) {
  const result = await getDb().select().from(authSessions)
    .where(eq(authSessions.sessionIdDigest, sessionIdDigest))
    .limit(1);
  return result[0];
}

export async function revokeAuthSessionByDigest(sessionIdDigest: string): Promise<void> {
  await getDb().update(authSessions)
    .set({ revokedAt: new Date() } as any)
    .where(eq(authSessions.sessionIdDigest, sessionIdDigest));
}

export async function registerUser(input: { name: string; email: string; password: string }) {
  const db = getDb();
  const existing = await getUserByEmail(input.email);
  if (existing) throw new Error("EMAIL_EXISTS");
  const passwordHash = await hashPassword(input.password);
  const verificationToken = await createOneTimeToken();
  const verificationTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.insert(users).values({
    name: input.name,
    email: input.email,
    passwordHash,
    loginMethod: "email",
    emailVerified: false,
    ...getTokenPersistence("verification", verificationToken.digest, verificationTokenExpiresAt).values,
    lastSignedIn: new Date(),
  } as any);
  const created = await getUserByEmail(input.email);
  if (!created) throw new Error("Failed to create user");
  const localOpenId = `local:${created.id}`;
  await db.update(users).set({ openId: localOpenId } as any).where(eq(users.id, created.id));
  const finalUser = await getUserByEmail(input.email);
  return { user: finalUser!, verificationToken: verificationToken.rawToken };
}

export async function verifyUserPassword(email: string, password: string) {
  const user = await getUserByEmail(email);
  if (!user || !user.passwordHash) return null;
  const verification = await verifyPasswordAndRehash(password, user.passwordHash);
  if (!verification.valid) return null;
  const db = getDb();
  if (verification.rehashedPassword) {
    await db.update(users)
      .set({ passwordHash: verification.rehashedPassword } as any)
      .where(eq(users.id, user.id));
  }
  return user;
}

export async function verifyEmailToken(token: string) {
  const digest = await digestOneTimeToken(token);
  const userId = await consumeOneTimeTokenAtomically("verification", digest);
  if (userId === null) throw new Error("INVALID_TOKEN");
  const user = await getUserById(userId);
  if (!user) throw new Error("INVALID_TOKEN");
  return user;
}

export async function resendVerificationEmail(email: string) {
  const db = getDb();
  const user = await getUserByEmail(email);
  if (!user || user.emailVerified) return;
  const verificationToken = await createOneTimeToken();
  const verificationTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.update(users)
    .set(getTokenPersistence("verification", verificationToken.digest, verificationTokenExpiresAt).values as any)
    .where(eq(users.id, user.id));
  return { user, verificationToken: verificationToken.rawToken };
}

export async function createPasswordResetToken(email: string) {
  const db = getDb();
  const user = await getUserByEmail(email);
  if (!user) return null;
  const resetToken = await createOneTimeToken();
  const resetTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await db.update(users)
    .set(getTokenPersistence("reset", resetToken.digest, resetTokenExpiresAt).values as any)
    .where(eq(users.id, user.id));
  return { user, resetToken: resetToken.rawToken };
}

export async function resetPassword(token: string, newPassword: string) {
  const digest = await digestOneTimeToken(token);
  const passwordHash = await hashPassword(newPassword);
  const userId = await consumeOneTimeTokenAtomically("reset", digest, passwordHash);
  if (userId === null) throw new Error("INVALID_TOKEN");
  const user = await getUserById(userId);
  if (!user) throw new Error("INVALID_TOKEN");
  return user;
}

/**
 * The D1 UPDATE predicate is the one-time-token compare-and-swap boundary.
 * A token is usable only while its current persisted digest and expiry match.
 */
async function consumeOneTimeTokenAtomically(
  kind: "verification" | "reset",
  digest: string,
  passwordHash?: string,
): Promise<number | null> {
  const now = Date.now();
  const query = kind === "verification"
    ? `UPDATE users
         SET emailVerified = 1, verificationToken = NULL, verificationTokenExpiresAt = NULL
       WHERE verificationToken = ? AND verificationTokenExpiresAt > ?
       RETURNING id`
    : `UPDATE users
         SET passwordHash = ?, resetToken = NULL, resetTokenExpiresAt = NULL
       WHERE resetToken = ? AND resetTokenExpiresAt > ?
       RETURNING id`;
  const parameters = kind === "verification" ? [digest, now] : [passwordHash!, digest, now];
  const result = await (getRawD1() as any).prepare(query).bind(...parameters).all();
  const rows = result?.results ?? [];
  return rows.length === 1 && typeof rows[0]?.id === "number" ? rows[0].id : null;
}

export async function updateUserProfile(userId: number, name: string): Promise<void> {
  await getDb().update(users).set({ name } as any).where(eq(users.id, userId));
}

export async function updateUserPasswordHash(userId: number, passwordHash: string): Promise<void> {
  await getDb().update(users).set({ passwordHash } as any).where(eq(users.id, userId));
}

/* Live Account Helpers */

export async function getOrCreateLiveAccount(userId: number) {
  const db = getDb();
  const existing = await db.select().from(liveAccounts).where(eq(liveAccounts.userId, userId)).limit(1);
  if (existing.length > 0) return existing[0];
  await db.insert(liveAccounts).values({ userId, status: "pending" } as any);
  const created = await db.select().from(liveAccounts).where(eq(liveAccounts.userId, userId)).limit(1);
  return created[0];
}

export async function getLiveAccountByUserId(userId: number) {
  const db = getDb();
  const result = await db.select().from(liveAccounts).where(eq(liveAccounts.userId, userId)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function toggleKillSwitch(userId: number, active: boolean) {
  const db = getDb();
  await db.update(liveAccounts).set({ killSwitchActive: active ? 1 : 0 } as any).where(eq(liveAccounts.userId, userId));
  await writeAuditLog(userId, active ? "KILL_SWITCH_ACTIVATED" : "KILL_SWITCH_DEACTIVATED");
}

export async function updateRiskSettings(userId: number, settings: { maxDailyLossPct?: string; maxLeverage?: string; maxPositionSizePct?: string }) {
  const db = getDb();
  await db.update(liveAccounts).set(settings as any).where(eq(liveAccounts.userId, userId));
  await writeAuditLog(userId, "RISK_SETTINGS_UPDATED", JSON.stringify(settings));
}

/* ── Per-User Demo Account ────────────────────────────────────────── */

export async function getOrCreateDemoAccountForUser(
  userId: number,
  opts?: { startingCapital?: string; username?: string; email?: string }
): Promise<DemoAccount> {
  const db = getDb();
  const existing = await db.select().from(demoAccounts).where(eq(demoAccounts.userId, userId)).limit(1);
  if (existing.length > 0) return existing[0];

  const now = new Date();
  const capital = opts?.startingCapital ?? "10000.00";

  // Seed lastSyncedSignalId to the current max signal id so the demo only picks
  // up signals that arrive AFTER account creation — zero-trade clean start.
  const [maxSignal] = await db.select({ maxId: sql`COALESCE(MAX(${coinlegsSignals.id}), 0)` as any })
    .from(coinlegsSignals);
  const seedSyncId = (maxSignal as any)?.maxId ?? 0;

  await db.insert(demoAccounts).values({
    username: opts?.username ?? `user_${userId}`,
    email: opts?.email ?? `user_${userId}@anavitrade.demo`,
    startingCapital: capital,
    currentBalance: capital,
    accessToken: nanoid(32),
    status: "active",
    userId,
    positionSizePct: "5.00",
    leverage: "3.00",
    strategyTier: "A",
    pyramidingEnabled: false,
    pyramidMaxEntries: 3,
    pyramidScalePct: "0.50",
    lastSyncedSignalId: seedSyncId,
    createdAt: now,
    updatedAt: now,
  } as any);

  const created = await db.select().from(demoAccounts).where(eq(demoAccounts.userId, userId)).limit(1);
  return created[0];
}

export async function getDemoAccountByUserId(userId: number): Promise<DemoAccount | null> {
  const db = getDb();
  const result = await db.select().from(demoAccounts).where(eq(demoAccounts.userId, userId)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getDemoTradesByUserId(userId: number): Promise<DemoTrade[]> {
  const account = await getDemoAccountByUserId(userId);
  if (!account) return [];
  return getDemoTradesByAccountId(account.id);
}

export async function getPortfolioSnapshotsByUserId(userId: number): Promise<PortfolioSnapshot[]> {
  const account = await getDemoAccountByUserId(userId);
  if (!account) return [];
  return getPortfolioSnapshotsByAccountId(account.id);
}

/* ── Display Mode ─────────────────────────────────────────────────── */

export async function getDisplayMode(userId: number): Promise<"live" | "demo"> {
  const db = getDb();
  const result = await db.select({ displayMode: liveAccounts.displayMode })
    .from(liveAccounts).where(eq(liveAccounts.userId, userId)).limit(1);
  if (result.length === 0) return "demo";
  return (result[0].displayMode as "live" | "demo") ?? "demo";
}

export async function setDisplayMode(userId: number, mode: "live" | "demo"): Promise<void> {
  const db = getDb();
  await getOrCreateLiveAccount(userId);
  await db.update(liveAccounts).set({ displayMode: mode } as any).where(eq(liveAccounts.userId, userId));
}

/* Demo Account Helpers */

export async function createDemoAccount(input: { username: string; email: string; startingCapital: string; userId?: number }) {
  const db = getDb();
  const accessToken = nanoid(32);
  // Seed lastSyncedSignalId to current max so the demo only picks up signals
  // created AFTER account registration — zero-trade clean start.
  const [maxSignal] = await db.select({ maxId: sql`COALESCE(MAX(${coinlegsSignals.id}), 0)` as any })
    .from(coinlegsSignals);
  const seedSyncId = (maxSignal as any)?.maxId ?? 0;
  await db.insert(demoAccounts).values({
    username: input.username, email: input.email,
    startingCapital: input.startingCapital, currentBalance: input.startingCapital,
    accessToken, status: "active", userId: input.userId ?? null,
    lastSyncedSignalId: seedSyncId,
    positionSizePct: "5.00", leverage: "3.00", strategyTier: "A",
    pyramidingEnabled: false, pyramidMaxEntries: 3, pyramidScalePct: "0.50",
  } as any);
  return { accessToken };
}

/** Public selector only; it is not an account credential and cannot mutate state. */
export const PUBLIC_DEMO_READ_KEY = "public";

export async function getPublicDemoAccount(): Promise<DemoAccount | null> {
  const db = getDb();
  const result = await db.select().from(demoAccounts)
    .where(eq(demoAccounts.email, "demo@anavitrade.com"))
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getPublicDemoAccountForRead(readKey: string): Promise<DemoAccount | null> {
  if (readKey !== PUBLIC_DEMO_READ_KEY) return null;
  return getPublicDemoAccount();
}

export async function updateDemoAccountSettingsForUser(userId: number, settings: {
  positionSizePct?: number; leverage?: number; strategyTier?: "A" | "AB" | "ABC";
  pyramidingEnabled?: boolean; pyramidMaxEntries?: number; pyramidScalePct?: number;
}) {
  const db = getDb();
  const account = await getDemoAccountByUserId(userId);
  if (!account) throw new Error("Demo account not found");
  const updates: Record<string, unknown> = {};
  if (settings.positionSizePct !== undefined) updates.positionSizePct = String(settings.positionSizePct.toFixed(2));
  if (settings.leverage !== undefined) updates.leverage = String(settings.leverage.toFixed(2));
  if (settings.strategyTier !== undefined) updates.strategyTier = settings.strategyTier;
  if (settings.pyramidingEnabled !== undefined) updates.pyramidingEnabled = settings.pyramidingEnabled;
  if (settings.pyramidMaxEntries !== undefined) updates.pyramidMaxEntries = settings.pyramidMaxEntries;
  if (settings.pyramidScalePct !== undefined) updates.pyramidScalePct = String(settings.pyramidScalePct.toFixed(2));
  if (Object.keys(updates).length > 0) {
    await db.update(demoAccounts).set(updates as any).where(eq(demoAccounts.id, account.id));
  }
  return { success: true };
}

export async function getPublicDemoStats() {
  const db = getDb();
  const account = await getPublicDemoAccount();
  const startingCapital = account ? parseFloat(account.startingCapital) : 0;
  const currentBalance = account ? parseFloat(account.currentBalance) : 0;
  const totalReturnPct = startingCapital > 0 ? ((currentBalance - startingCapital) / startingCapital) * 100 : 0;
  const [{ tradeCount }] = await db.select({ tradeCount: sql`count(*)` })
    .from(demoTrades).where(and(eq(demoTrades.demoAccountId, account?.id ?? -1), eq(demoTrades.status, 'closed')));
  const [{ bestPnlPct }] = await db.select({ bestPnlPct: sql`MAX(CAST(${demoTrades.pnlPct} AS REAL))` })
    .from(demoTrades).where(and(eq(demoTrades.demoAccountId, account?.id ?? -1), eq(demoTrades.status, 'closed')));
  const [{ avgPnlPct }] = await db.select({ avgPnlPct: sql`AVG(CAST(${demoTrades.pnlPct} AS REAL))` })
    .from(demoTrades).where(and(eq(demoTrades.demoAccountId, account?.id ?? -1), eq(demoTrades.status, 'closed')));
  const julyStart = new Date("2026-07-01T00:00:00Z").getTime();
  const [{ tierAJulyCount }] = await db.select({ tierAJulyCount: sql`count(*)` })
    .from(coinlegsSignals).where(and(eq(coinlegsSignals.signal, 1), eq(coinlegsSignals.qualityTier, 'A'), gte(coinlegsSignals.signalDate, julyStart)));
  return {
    currentBalance, startingCapital, totalReturnPct: Number(totalReturnPct.toFixed(2)),
    tradeCount: Number(tradeCount), bestPnlPct: Number(bestPnlPct ?? 0),
    avgPnlPct: Number(avgPnlPct ?? 0), tierAJulyCount: Number(tierAJulyCount),
  };
}

export async function getDemoAccountByToken(token: string) {
  const db = getDb();
  const result = await db.select().from(demoAccounts).where(eq(demoAccounts.accessToken, token)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getDemoTradesByAccountId(accountId: number) {
  const db = getDb();
  return db.select().from(demoTrades).where(eq(demoTrades.demoAccountId, accountId)).orderBy(desc(demoTrades.openedAt));
}

export async function getPortfolioSnapshotsByAccountId(accountId: number) {
  const db = getDb();
  return db.select().from(portfolioSnapshots).where(eq(portfolioSnapshots.demoAccountId, accountId)).orderBy(portfolioSnapshots.snapshotAt);
}

/** Sync only the authenticated user's existing demo account; never bootstrap or fan out. */
export async function syncSignalsToDemoAccount(userId: number): Promise<{ accountsProcessed: number; tradesCreated: number; snapshotsWritten: number }> {
  const account = await getDemoAccountByUserId(userId);
  if (!account || account.status !== "active") {
    return { accountsProcessed: 0, tradesCreated: 0, snapshotsWritten: 0 };
  }
  return syncSignalsToDemoAccounts([account.id]);
}

export async function syncSignalsToDemoAccounts(scopedAccountIds?: number[]): Promise<{ accountsProcessed: number; tradesCreated: number; snapshotsWritten: number }> {
  const db = getDb();
  const accountScope = scopedAccountIds
    ? and(eq(demoAccounts.status, "active"), inArray(demoAccounts.id, scopedAccountIds))
    : eq(demoAccounts.status, "active");
  const accounts = await db.select().from(demoAccounts).where(accountScope);
  if (accounts.length === 0) return { accountsProcessed: 0, tradesCreated: 0, snapshotsWritten: 0 };

  // Batch: find the minimum lastSyncedSignalId and query all new signals once.
  const minLastId = Math.min(...accounts.map((a) => a.lastSyncedSignalId ?? 0));
  const allAccountsTierFilter = accounts.map((a) => a.strategyTier);
  const allTiers = allAccountsTierFilter.includes("ABC") ? ["A", "B", "C"]
    : allAccountsTierFilter.includes("AB") ? ["A", "B"]
    : ["A"];

  const allNewSignals = await db.select().from(coinlegsSignals).where(
    and(sql`${coinlegsSignals.id} > ${minLastId}`, eq(coinlegsSignals.signal, 1), inArray(coinlegsSignals.qualityTier, allTiers))
  ).orderBy(coinlegsSignals.signalDate);

  if (allNewSignals.length === 0) return { accountsProcessed: accounts.length, tradesCreated: 0, snapshotsWritten: 0 };

  // Group signals by tier for fast per-account filtering
  const tierSignalMap: Record<string, typeof allNewSignals> = { A: [], B: [], C: [] };
  for (const s of allNewSignals) {
    const t = s.qualityTier ?? "C";
    if (tierSignalMap[t]) tierSignalMap[t].push(s);
  }

  // ── Batch query: Pre-fetch existing trade counts for all accounts ────────
  const accountIds = accounts.map((a) => a.id);
  const existingCountRows = await db.select({
    demoAccountId: demoTrades.demoAccountId,
    count: sql<number>`count(*)`,
  }).from(demoTrades)
    .where(inArray(demoTrades.demoAccountId, accountIds))
    .groupBy(demoTrades.demoAccountId);
  const existingCountMap = new Map(existingCountRows.map((r) => [r.demoAccountId, r.count]));
  const existingSignalRows = await db.select({
    demoAccountId: demoTrades.demoAccountId,
    signalId: demoTrades.signalId,
  }).from(demoTrades).where(inArray(demoTrades.demoAccountId, accountIds));
  const existingSignalsByAccount = new Map<number, Set<number>>();
  for (const row of existingSignalRows) {
    if (row.signalId === null) continue;
    const ids = existingSignalsByAccount.get(row.demoAccountId) ?? new Set<number>();
    ids.add(row.signalId);
    existingSignalsByAccount.set(row.demoAccountId, ids);
  }

  // ── Batch query: Pre-fetch all demoTrades for pyramiding accounts ────────
  const pyramidingAccountIds = accounts
    .filter((a) => a.pyramidingEnabled)
    .map((a) => a.id);
  const pyramidingTradesByAccount = new Map<number, Array<Record<string, unknown>>>();
  if (pyramidingAccountIds.length > 0) {
    const allPyramidTrades = await db.select().from(demoTrades)
      .where(inArray(demoTrades.demoAccountId, pyramidingAccountIds));
    for (const t of allPyramidTrades) {
      const list = pyramidingTradesByAccount.get(t.demoAccountId) ?? [];
      list.push(t as any);
      pyramidingTradesByAccount.set(t.demoAccountId, list);
    }
  }

  let tradesCreated = 0;
  let snapshotsWritten = 0;

  for (const account of accounts) {
    try {
      const lastId = account.lastSyncedSignalId ?? 0;
      const allowedTiers = account.strategyTier === "A" ? ["A"]
        : account.strategyTier === "AB" ? ["A", "B"]
        : ["A", "B", "C"];

      // Filter in-memory by tier and id > lastId
      const newSignals: typeof allNewSignals = [];
      for (const tier of allowedTiers) {
        for (const s of tierSignalMap[tier] ?? []) {
          if (s.id > lastId) newSignals.push(s);
        }
      }
      newSignals.sort((a, b) => (a.signalDate as number) - (b.signalDate as number));

      if (newSignals.length === 0) continue;
      let currentBalance = parseFloat(account.currentBalance);
      const startingBalance = currentBalance;
      let maxSignalId = lastId;
      let runningTradeCount = existingCountMap.get(account.id) ?? 0;
      const snapshotRows: Array<{ demoAccountId: number; balance: string; tradeCount: number; snapshotAt: Date }> = [];
      const accountTradeRows: Array<Record<string, unknown>> = [];
      const existingSignalIds = existingSignalsByAccount.get(account.id) ?? new Set<number>();

      for (const signal of newSignals) {
        if (signal.id > maxSignalId) maxSignalId = signal.id;
        if (existingSignalIds.has(signal.id)) continue;
        existingSignalIds.add(signal.id);
        const maxProfitPct = parseFloat(signal.maxProfit ?? "0");
        const tradeStatus: "closed" | "open" = "closed";

        // ── Realistic stop-and-target outcome — NOT the uncapped maxProfit peak ──
        // maxProfit is a hindsight metric (the highest price ever reached with no
        // stop, no exit). Trading it directly is lookahead fiction. Instead we model
        // a disciplined trade: fixed ATR stop, R-multiple take-profit. The win is
        // CAPPED at the take-profit target (you exit at your limit, not the peak);
        // the loss is a real ATR stop. This is what a forward-traded signal earns.
        const tfAtr: Record<string, number> = {
          "5m": 0.3, "15m": 0.5, "30m": 0.8, "1h": 1.2, "4h": 2.0, "1d": 3.5, "1w": 6.0,
        };
        const stopPct = (tfAtr[signal.period ?? ""] ?? 1.5) * 1.5;
        const rMultiple = signal.period === "4h" || signal.period === "1d" || signal.period === "1w"
          ? 5 : signal.period === "1h" ? 3 : 2;
        const tpPct = stopPct * rMultiple;

        let simulatedProfitPct: number;
        if (maxProfitPct <= 0) {
          simulatedProfitPct = -stopPct;              // never moved up → stopped out
        } else if (maxProfitPct >= tpPct) {
          simulatedProfitPct = tpPct;                 // hit target → exit at limit (capped, no peak fiction)
        } else if (maxProfitPct >= stopPct) {
          simulatedProfitPct = Math.max(stopPct * 0.5, maxProfitPct * 0.5); // trailed out mid-move
        } else {
          simulatedProfitPct = -stopPct;              // small pop <1R → most likely reversed to stop
        }
        const entryPrice = parseFloat(signal.price);
        if (entryPrice <= 0) continue;
        const riskPct = parseFloat(account.positionSizePct ?? "5.00") / 100;
        const leverage = parseFloat((account as any).leverage ?? "3.00");
        const positionSizePct = riskPct * leverage;
        let effectivePositionPct = positionSizePct;
        if (account.pyramidingEnabled) {
          const pyramidWindow = Number(signal.signalDate) - 7 * 24 * 60 * 60 * 1000;
          const accountPyramidTrades = pyramidingTradesByAccount.get(account.id) ?? [];
          const existingEntries = accountPyramidTrades.filter((t) =>
            (t as any).pair === signal.marketName && Number((t as any).openedAt) >= pyramidWindow
          ).length;
          const maxEntries = account.pyramidMaxEntries ?? 3;
          if (existingEntries >= maxEntries) continue;
          const scaleFactor = Math.pow(parseFloat(account.pyramidScalePct ?? "0.50"), existingEntries);
          effectivePositionPct = positionSizePct * (existingEntries === 0 ? 1 : scaleFactor);
        }
        const positionValueUsd = currentBalance * effectivePositionPct;
        const quantity = positionValueUsd / entryPrice;
        const exitPrice = entryPrice * (1 + simulatedProfitPct / 100);
        const rawPnl = currentBalance * riskPct * leverage * (simulatedProfitPct / 100);
        const maxPnl = currentBalance * riskPct * leverage;
        const pnl = Math.min(Math.max(rawPnl, -positionValueUsd), maxPnl);
        const openedAt = signal.signalDate;
        const durationMs = parseDurationToMs(signal.maxProfitDuration) ?? (4 * 60 * 60 * 1000);
        const closedAt = new Date(Number(openedAt) + durationMs);
        accountTradeRows.push({
          demoAccountId: account.id, signalId: signal.id, pair: signal.marketName, side: "buy",
          entryPrice: String(entryPrice), exitPrice: String(exitPrice), quantity: String(quantity),
          pnl: String(pnl.toFixed(2)), pnlPct: String(simulatedProfitPct.toFixed(4)), status: tradeStatus,
          indicatorName: signal.indicatorShortName, period: signal.period,
          qualityScore: signal.qualityScore, qualityTier: signal.qualityTier,
          maxProfitPct: String(maxProfitPct), openedAt, closedAt,
        });
        // Feed new trades into the in-memory pyramiding cache so same-batch
        // subsequent signals for the same pair count them correctly.
        if (account.pyramidingEnabled) {
          const cache = pyramidingTradesByAccount.get(account.id);
          if (cache) cache.push(accountTradeRows[accountTradeRows.length - 1] as any);
        }
        currentBalance += pnl;
        runningTradeCount++;
        snapshotRows.push({ demoAccountId: account.id, balance: String(currentBalance.toFixed(2)), tradeCount: runningTradeCount, snapshotAt: closedAt });
      }

      const statements: any[] = [];
      if (accountTradeRows.length > 0) {
        statements.push(db.insert(demoTrades).values(accountTradeRows as any).onConflictDoNothing());
      }
      if (currentBalance !== startingBalance || maxSignalId > lastId) {
        statements.push(db.update(demoAccounts).set({
          currentBalance: String(currentBalance.toFixed(2)),
          lastSyncedSignalId: maxSignalId,
        } as any).where(eq(demoAccounts.id, account.id)));
      }
      if (snapshotRows.length > 0) {
        statements.push(db.insert(portfolioSnapshots).values(snapshotRows as any).onConflictDoNothing());
      }
      if (statements.length > 0) {
        // D1 batch is transactional. A retry observes either the complete
        // account transition or none of it, while unique indexes absorb races.
        await (db as any).batch(statements);
        tradesCreated += accountTradeRows.length;
        snapshotsWritten += snapshotRows.length;
      }
    } catch (err: any) {
      console.error(`[SyncEngine] Error processing account ${account.id}:`, err?.message);
    }
  }

  return { accountsProcessed: accounts.length, tradesCreated, snapshotsWritten };
}

function parseDurationToMs(dur: string | null): number | null {
  if (!dur) return null;
  const d = dur.toLowerCase().trim();
  const n = parseFloat(d.split(/\s+/)[0]);
  if (isNaN(n)) return null;
  if (d.includes("day")) return n * 24 * 60 * 60 * 1000;
  if (d.includes("hour") || d.includes("hr")) return n * 60 * 60 * 1000;
  if (d.includes("min")) return n * 60 * 1000;
  return null;
}

/* Web3 Wallet Session Helpers */

export async function saveWeb3WalletSession(data: { userId: number; walletAddress: string; chainId?: number; walletType: "ledger" | "metamask" | "walletconnect" | "coinbase" | "other"; maxPositionSizeUsd?: number; maxDailyLossPct?: number; ledgerDerivationPath?: string }) {
  const db = getDb();
  await db.update(web3WalletSessions).set({ status: "revoked", revokedAt: new Date() } as any)
    .where(and(eq(web3WalletSessions.userId, data.userId), eq(web3WalletSessions.status, "active")));
  const values = {
    userId: data.userId, walletAddress: data.walletAddress.toLowerCase(),
    chainId: data.chainId ?? 1, walletType: data.walletType,
    copytradeEnabled: true, maxPositionSizeUsd: data.maxPositionSizeUsd ? String(data.maxPositionSizeUsd) : null,
    maxDailyLossPct: data.maxDailyLossPct ? String(data.maxDailyLossPct) : "5.00",
    killSwitchActive: false, status: "active", ledgerDerivationPath: data.ledgerDerivationPath ?? null,
  };
  await db.insert(web3WalletSessions).values(values as any);
  await writeAuditLog(data.userId, "WEB3_WALLET_CONNECTED", `${data.walletType}:${data.walletAddress}`);
  const result = await db.select().from(web3WalletSessions).where(and(eq(web3WalletSessions.userId, data.userId), eq(web3WalletSessions.status, "active"))).orderBy(web3WalletSessions.connectedAt).limit(1);
  return result[0];
}

export async function getWeb3WalletSession(userId: number) {
  const db = getDb();
  const result = await db.select().from(web3WalletSessions).where(and(eq(web3WalletSessions.userId, userId), eq(web3WalletSessions.status, "active"))).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function revokeWeb3WalletSession(userId: number) {
  const db = getDb();
  await db.update(web3WalletSessions).set({ status: "revoked", revokedAt: new Date() } as any)
    .where(and(eq(web3WalletSessions.userId, userId), eq(web3WalletSessions.status, "active")));
  await writeAuditLog(userId, "WEB3_WALLET_REVOKED");
}

export async function toggleWeb3KillSwitch(userId: number, active: boolean) {
  const db = getDb();
  await db.update(web3WalletSessions).set({ killSwitchActive: active ? 1 : 0, lastSeenAt: new Date() } as any)
    .where(and(eq(web3WalletSessions.userId, userId), eq(web3WalletSessions.status, "active")));
  await writeAuditLog(userId, active ? "KILL_SWITCH_ACTIVATED" : "KILL_SWITCH_DEACTIVATED");
}

export async function enableCopytrade(userId: number) {
  const db = getDb();
  await db.update(web3WalletSessions).set({ copytradeEnabled: true, lastSeenAt: new Date() } as any)
    .where(and(eq(web3WalletSessions.userId, userId), eq(web3WalletSessions.status, "active")));
  await writeAuditLog(userId, "COPYTRADE_ENABLED");
}

export async function dispatchCopytradeSignal(userId: number, signal: { pair: string; side: "buy" | "sell"; size: number; price: number; stopLoss?: number; takeProfit?: number }) {
  const session = await getWeb3WalletSession(userId);
  if (!session || !session.copytradeEnabled || session.killSwitchActive) {
    return { dispatched: false, reason: session?.killSwitchActive ? "kill_switch" : "not_enabled" };
  }
  await writeAuditLog(userId, "COPYTRADE_SIGNAL_DISPATCHED", JSON.stringify(signal));
  return { dispatched: true, walletAddress: session.walletAddress };
}

/* Coinlegs Signals */

export async function getSignals(opts: { page?: number; limit?: number; period?: string; tier?: "A" | "B" | "C" | "all"; exchg?: string; sortBy?: "quality" | "date" }) {
  const db = getDb();
  const page = opts.page ?? 0;
  const limit = opts.limit ?? 20;
  const offset = page * limit;
  const conditions: ReturnType<typeof eq>[] = [eq(coinlegsSignals.signal, 1)];
  if (opts.tier && opts.tier !== "all") conditions.push(eq(coinlegsSignals.qualityTier, opts.tier));
  if (opts.period) conditions.push(eq(coinlegsSignals.period, opts.period));
  if (opts.exchg) conditions.push(eq(coinlegsSignals.exchg, opts.exchg));
  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
  const sortBy = opts.sortBy ?? "quality";
  const orderCols = sortBy === "quality" ? [desc(coinlegsSignals.qualityScore), desc(coinlegsSignals.signalDate)] : [desc(coinlegsSignals.signalDate), desc(coinlegsSignals.qualityScore)];
  const signals = await db.select().from(coinlegsSignals).where(whereClause).orderBy(...orderCols).limit(limit).offset(offset);
  const [{ count }] = await db.select({ count: sql`count(*)` }).from(coinlegsSignals).where(whereClause);
  return { signals, total: Number(count), page, limit };
}

export async function getTopBangers(limit = 6) {
  const db = getDb();
  const rows = await db.select().from(coinlegsSignals).where(and(eq(coinlegsSignals.signal, 1), sql`CAST(${coinlegsSignals.maxProfit} AS REAL) > 5`))
    .orderBy(sql`CAST(${coinlegsSignals.maxProfit} AS REAL) DESC`, desc(coinlegsSignals.qualityScore)).limit(limit * 4);
  const seen = new Set<string>();
  const deduped = [];
  for (const row of rows) {
    const key = row.marketName;
    if (!seen.has(key)) { seen.add(key); deduped.push(row); if (deduped.length >= limit) break; }
  }
  return deduped;
}

export async function getSignalStats() {
  const db = getDb();
  const [{ total }] = await db.select({ total: sql`count(*)` }).from(coinlegsSignals).where(eq(coinlegsSignals.signal, 1));
  const [{ avgProfit }] = await db.select({ avgProfit: sql`AVG(CAST(${coinlegsSignals.maxProfit} AS REAL))` }).from(coinlegsSignals).where(and(eq(coinlegsSignals.signal, 1), sql`CAST(${coinlegsSignals.maxProfit} AS REAL) > 0`));
  const [{ tierA }] = await db.select({ tierA: sql`count(*)` }).from(coinlegsSignals).where(and(eq(coinlegsSignals.signal, 1), eq(coinlegsSignals.qualityTier, 'A')));
  const [{ maxProfit }] = await db.select({ maxProfit: sql`MAX(CAST(${coinlegsSignals.maxProfit} AS REAL))` }).from(coinlegsSignals).where(eq(coinlegsSignals.signal, 1));
  return { totalSignals: Number(total), avgProfit: Number(avgProfit ?? 0), tierACount: Number(tierA), allTimeMax: Number(maxProfit ?? 0) };
}

export async function getPerformance() {
  const db = getDb();

  // ── Basic counts (already SQL) ──
  const [{ totalSignals }] = await db
    .select({ totalSignals: sql<number>`count(*)` })
    .from(coinlegsSignals)
    .where(eq(coinlegsSignals.signal, 1));

  const tierCounts = await db
    .select({
      tier: coinlegsSignals.qualityTier,
      count: sql<number>`count(*)`,
    })
    .from(coinlegsSignals)
    .where(eq(coinlegsSignals.signal, 1))
    .groupBy(coinlegsSignals.qualityTier);

  const tierMap: Record<string, number> = {};
  for (const t of tierCounts) tierMap[t.tier ?? "C"] = Number(t.count);

  // ── Median profit (SQL percentile approximation through ordered rows) ──
  // Fetch only maxProfit for median calculations — not all columns.
  const allProfits = (await db
    .select({ maxProfit: coinlegsSignals.maxProfit })
    .from(coinlegsSignals)
    .where(and(eq(coinlegsSignals.signal, 1), sql`CAST(${coinlegsSignals.maxProfit} AS REAL) > 0`))
    .orderBy(sql`CAST(${coinlegsSignals.maxProfit} AS REAL) ASC`)
    .all() as Array<{ maxProfit: string }>).map((r) => parseFloat(r.maxProfit));

  const median = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
  };
  const overallMedian = median(allProfits);

  // ── Median by tier (SQL batched, minimal columns) ──
  const tierProfitsRaw = await db
    .select({
      tier: coinlegsSignals.qualityTier,
      maxProfit: coinlegsSignals.maxProfit,
    })
    .from(coinlegsSignals)
    .where(and(eq(coinlegsSignals.signal, 1), sql`CAST(${coinlegsSignals.maxProfit} AS REAL) > 0`))
    .orderBy(sql`CAST(${coinlegsSignals.maxProfit} AS REAL) ASC`)
    .all() as Array<{ tier: string | null; maxProfit: string }>;

  const tierProfitMap: Record<string, number[]> = {};
  for (const r of tierProfitsRaw) {
    const t = r.tier ?? "C";
    if (!tierProfitMap[t]) tierProfitMap[t] = [];
    tierProfitMap[t].push(parseFloat(r.maxProfit));
  }
  const tierMedians: Record<string, number> = {};
  for (const tier of ["A", "B", "C"]) {
    tierMedians[tier] = median(tierProfitMap[tier] ?? []);
  }

  // ── Indicator breakdown (SQL GROUP BY) ──
  const indicatorAggs = await db
    .select({
      name: coinlegsSignals.indicatorShortName,
      signalCount: sql<number>`count(*)`,
      avgProfit: sql<number>`ROUND(AVG(CAST(${coinlegsSignals.maxProfit} AS REAL)), 1)`,
      bestProfit: sql<number>`MAX(CAST(${coinlegsSignals.maxProfit} AS REAL))`,
      bestPair: sql<string>`(SELECT ${coinlegsSignals.marketName} FROM ${coinlegsSignals} sub WHERE sub.signal = 1 AND sub.indicatorShortName = ${coinlegsSignals.indicatorShortName} AND CAST(sub.maxProfit AS REAL) > 0 ORDER BY CAST(sub.maxProfit AS REAL) DESC LIMIT 1)`,
    })
    .from(coinlegsSignals)
    .where(and(eq(coinlegsSignals.signal, 1), sql`CAST(${coinlegsSignals.maxProfit} AS REAL) > 0`))
    .groupBy(coinlegsSignals.indicatorShortName)
    .orderBy(sql`AVG(CAST(${coinlegsSignals.maxProfit} AS REAL)) DESC`);

  const indicatorBreakdown = indicatorAggs.map((r) => ({
    name: r.name ?? "Unknown",
    signalCount: Number(r.signalCount),
    medianProfit: 0, // populated below
    avgProfit: Number(r.avgProfit),
    bestPair: r.bestPair ?? "",
  }));

  // ── 4H indicator breakdown (SQL GROUP BY with filter) ──
  const fourHIndicatorAggs = await db
    .select({
      name: coinlegsSignals.indicatorShortName,
      signalCount: sql<number>`count(*)`,
      avgProfit: sql<number>`ROUND(AVG(CAST(${coinlegsSignals.maxProfit} AS REAL)), 1)`,
      bestProfit: sql<number>`MAX(CAST(${coinlegsSignals.maxProfit} AS REAL))`,
      bestPair: sql<string>`(SELECT sub2.marketName FROM ${coinlegsSignals} sub2 WHERE sub2.signal = 1 AND sub2.period = '4h' AND sub2.indicatorShortName = ${coinlegsSignals.indicatorShortName} AND CAST(sub2.maxProfit AS REAL) > 0 ORDER BY CAST(sub2.maxProfit AS REAL) DESC LIMIT 1)`,
    })
    .from(coinlegsSignals)
    .where(and(eq(coinlegsSignals.signal, 1), eq(coinlegsSignals.period, "4h"), sql`CAST(${coinlegsSignals.maxProfit} AS REAL) > 0`))
    .groupBy(coinlegsSignals.indicatorShortName)
    .orderBy(sql`AVG(CAST(${coinlegsSignals.maxProfit} AS REAL)) DESC`);

  const fourHIndicatorBreakdown = fourHIndicatorAggs.map((r) => ({
    name: r.name ?? "Unknown",
    signalCount: Number(r.signalCount),
    medianProfit: 0,
    avgProfit: Number(r.avgProfit),
    bestPair: r.bestPair ?? "",
  }));

  // ── Timeframe breakdown (SQL GROUP BY) ──
  const tfAggs = await db
    .select({
      name: coinlegsSignals.period,
      signalCount: sql<number>`count(*)`,
      avgProfit: sql<number>`ROUND(AVG(CAST(${coinlegsSignals.maxProfit} AS REAL)), 1)`,
      bestProfit: sql<number>`MAX(CAST(${coinlegsSignals.maxProfit} AS REAL))`,
      bestPair: sql<string>`(SELECT sub3.marketName FROM ${coinlegsSignals} sub3 WHERE sub3.signal = 1 AND sub3.period = ${coinlegsSignals.period} AND CAST(sub3.maxProfit AS REAL) > 0 ORDER BY CAST(sub3.maxProfit AS REAL) DESC LIMIT 1)`,
    })
    .from(coinlegsSignals)
    .where(and(eq(coinlegsSignals.signal, 1), sql`CAST(${coinlegsSignals.maxProfit} AS REAL) > 0`))
    .groupBy(coinlegsSignals.period)
    .orderBy(sql`AVG(CAST(${coinlegsSignals.maxProfit} AS REAL)) DESC`);

  const timeframeBreakdown = tfAggs.map((r) => ({
    name: r.name ?? "Unknown",
    signalCount: Number(r.signalCount),
    medianProfit: 0,
    avgProfit: Number(r.avgProfit),
    bestPair: r.bestPair ?? "",
  }));

  // ── Median profit per indicator (client-side on grouped data) ──
  // Fetch ordered per-indicator profits for median calculation
  const indicatorProfits = await db
    .select({
      name: coinlegsSignals.indicatorShortName,
      maxProfit: coinlegsSignals.maxProfit,
    })
    .from(coinlegsSignals)
    .where(and(eq(coinlegsSignals.signal, 1), sql`CAST(${coinlegsSignals.maxProfit} AS REAL) > 0`))
    .orderBy(sql`CAST(${coinlegsSignals.maxProfit} AS REAL) ASC`)
    .all() as Array<{ name: string | null; maxProfit: string }>;

  const indicatorMedianMap: Record<string, number[]> = {};
  for (const r of indicatorProfits) {
    const n = r.name ?? "Unknown";
    if (!indicatorMedianMap[n]) indicatorMedianMap[n] = [];
    indicatorMedianMap[n].push(parseFloat(r.maxProfit));
  }
  for (const b of indicatorBreakdown) {
    const profits = indicatorMedianMap[b.name] ?? [];
    b.medianProfit = Number(median(profits).toFixed(1));
  }

  // ── 4H per-indicator medians ──
  // Fetch 4h indicator profits separately (period column not in indicatorProfits)
  const fourHIndProfitsFull = await db
    .select({
      name: coinlegsSignals.indicatorShortName,
      maxProfit: coinlegsSignals.maxProfit,
    })
    .from(coinlegsSignals)
    .where(and(eq(coinlegsSignals.signal, 1), eq(coinlegsSignals.period, "4h"), sql`CAST(${coinlegsSignals.maxProfit} AS REAL) > 0`))
    .orderBy(sql`CAST(${coinlegsSignals.maxProfit} AS REAL) ASC`)
    .all() as Array<{ name: string | null; maxProfit: string }>;

  const fourHIndMedianMap: Record<string, number[]> = {};
  for (const r of fourHIndProfitsFull) {
    const n = r.name ?? "Unknown";
    if (!fourHIndMedianMap[n]) fourHIndMedianMap[n] = [];
    fourHIndMedianMap[n].push(parseFloat(r.maxProfit));
  }
  for (const b of fourHIndicatorBreakdown) {
    const profits = fourHIndMedianMap[b.name] ?? [];
    b.medianProfit = Number(median(profits).toFixed(1));
  }

  // 4h overall median
  const fourHProfits = fourHIndProfitsFull.map((r) => parseFloat(r.maxProfit)).filter((p) => p > 0);
  const fourHMedian = median(fourHProfits);

  // ── 3+ indicator confluence ──
  // Fetch minimal data for confluence analysis
  const confluenceData = await db
    .select({
      marketName: coinlegsSignals.marketName,
      period: coinlegsSignals.period,
      indicatorShortName: coinlegsSignals.indicatorShortName,
      maxProfit: coinlegsSignals.maxProfit,
    })
    .from(coinlegsSignals)
    .where(eq(coinlegsSignals.signal, 1))
    .all() as Array<{ marketName: string; period: string; indicatorShortName: string; maxProfit: string }>;

  const confluenceGroups = new Map<string, { indicators: Set<string>; profits: number[] }>();
  for (const s of confluenceData) {
    const profit = parseFloat(s.maxProfit ?? "0");
    const key = `${s.marketName}|${s.period}`;
    if (!confluenceGroups.has(key)) {
      confluenceGroups.set(key, { indicators: new Set(), profits: [] });
    }
    const group = confluenceGroups.get(key)!;
    group.indicators.add(s.indicatorShortName);
    if (profit > 0) group.profits.push(profit);
  }
  const confluenceAllProfits: number[] = [];
  for (const [, group] of confluenceGroups) {
    if (group.indicators.size >= 3) {
      confluenceAllProfits.push(...group.profits);
    }
  }
  const confluenceMedian = median(confluenceAllProfits);

  // ── Momentum analysis ──
  const momentumData = await db
    .select({
      maxProfit: coinlegsSignals.maxProfit,
      percentage24: coinlegsSignals.percentage24,
    })
    .from(coinlegsSignals)
    .where(and(eq(coinlegsSignals.signal, 1), sql`CAST(${coinlegsSignals.maxProfit} AS REAL) > 0`))
    .all() as Array<{ maxProfit: string; percentage24: string | null }>;

  const negPct24Profits: number[] = [];
  for (const s of momentumData) {
    const profit = parseFloat(s.maxProfit ?? "0");
    if (profit <= 0) continue;
    const pct24 = parseFloat(s.percentage24 ?? "0");
    if (isNaN(pct24)) continue;
    if (pct24 < 0) negPct24Profits.push(profit);
  }
  const negPct24Median = median(negPct24Profits);

  // ── Rejected (maxProfit = 0) count ──
  const [{ rejectedCount }] = await db
    .select({ rejectedCount: sql<number>`count(*)` })
    .from(coinlegsSignals)
    .where(
      and(
        eq(coinlegsSignals.signal, 1),
        sql`CAST(${coinlegsSignals.maxProfit} AS REAL) = 0`,
      ),
    );
  const totalWithSignal = Number(totalSignals);
  const rejectedPct =
    totalWithSignal > 0
      ? Number(((Number(rejectedCount) / totalWithSignal) * 100).toFixed(1))
      : 0;

  // Last scraper run
  const [latestRun] = await db
    .select()
    .from(scraperRuns)
    .orderBy(desc(scraperRuns.startedAt))
    .limit(1);

  // ── Outcome-validated byTimeframe & byIndicator ──
  // Use actualMaxProfitPct when outcome-validated data exists,
  // fall back to maxProfit otherwise (marked "unvalidated").
  const [{ validatedCount }] = await db
    .select({ validatedCount: sql<number>`count(*)` })
    .from(coinlegsSignals)
    .where(
      and(
        eq(coinlegsSignals.signal, 1),
        eq(coinlegsSignals.outcomeValidated, 1),
        sql`${coinlegsSignals.actualMaxProfitPct} IS NOT NULL`,
      ),
    );
  const useValidated = Number(validatedCount) > 0;

  const groupData = (await db
    .select({
      period: coinlegsSignals.period,
      indicatorShortName: coinlegsSignals.indicatorShortName,
      maxProfit: coinlegsSignals.maxProfit,
      actualMaxProfitPct: coinlegsSignals.actualMaxProfitPct,
    })
    .from(coinlegsSignals)
    .where(
      useValidated
        ? and(
            eq(coinlegsSignals.signal, 1),
            eq(coinlegsSignals.outcomeValidated, 1),
            sql`${coinlegsSignals.actualMaxProfitPct} IS NOT NULL`,
          )
        : eq(coinlegsSignals.signal, 1),
    )
    .all()) as Array<{
    period: string | null;
    indicatorShortName: string | null;
    maxProfit: string | null;
    actualMaxProfitPct: string | null;
  }>;

  function parseGroupProfit(r: (typeof groupData)[number]): number {
    if (useValidated) return parseFloat(r.actualMaxProfitPct ?? "0");
    return parseFloat(r.maxProfit ?? "0");
  }

  // byTimeframe
  const tfMap: Record<string, number[]> = {};
  for (const r of groupData) {
    const profit = parseGroupProfit(r);
    const tf = r.period ?? "unknown";
    if (!tfMap[tf]) tfMap[tf] = [];
    tfMap[tf].push(profit);
  }
  const byTimeframe: Record<string, { count: number; winRate: number; avgPnl: string }> = {};
  for (const [tf, profits] of Object.entries(tfMap)) {
    const wins = profits.filter((p) => p > 0).length;
    byTimeframe[tf] = {
      count: profits.length,
      winRate: profits.length > 0 ? Number(((wins / profits.length) * 100).toFixed(1)) : 0,
      avgPnl: profits.length > 0 ? (profits.reduce((a, b) => a + b, 0) / profits.length).toFixed(1) : "0.0",
    };
  }

  // byIndicator
  const indMap: Record<string, number[]> = {};
  for (const r of groupData) {
    const profit = parseGroupProfit(r);
    const ind = r.indicatorShortName ?? "Unknown";
    if (!indMap[ind]) indMap[ind] = [];
    indMap[ind].push(profit);
  }
  const byIndicator: Record<string, { count: number; winRate: number; avgPnl: string }> = {};
  for (const [ind, profits] of Object.entries(indMap)) {
    const wins = profits.filter((p) => p > 0).length;
    byIndicator[ind] = {
      count: profits.length,
      winRate: profits.length > 0 ? Number(((wins / profits.length) * 100).toFixed(1)) : 0,
      avgPnl: profits.length > 0 ? (profits.reduce((a, b) => a + b, 0) / profits.length).toFixed(1) : "0.0",
    };
  }

  // lastScraperRun structured
  const lastScraperRun = latestRun
    ? {
        startedAt:
          latestRun.startedAt instanceof Date
            ? latestRun.startedAt.toISOString()
            : String(latestRun.startedAt),
        signalsFetched: latestRun.signalsFetched,
        tierA: latestRun.tierA,
        tierB: latestRun.tierB,
      }
    : null;

  return {
    totalSignals: totalWithSignal,
    tierA: tierMap["A"] ?? 0,
    tierB: tierMap["B"] ?? 0,
    tierC: tierMap["C"] ?? 0,
    medianMaxProfit: Number(overallMedian.toFixed(1)),
    medianMaxProfitByTier: {
      A: Number((tierMedians["A"] ?? 0).toFixed(1)),
      B: Number((tierMedians["B"] ?? 0).toFixed(1)),
      C: Number((tierMedians["C"] ?? 0).toFixed(1)),
    },
    fourHMedian: Number(fourHMedian.toFixed(1)),
    confluenceMedian: Number(confluenceMedian.toFixed(1)),
    negPct24Median: Number(negPct24Median.toFixed(1)),
    rejectedCount: Number(rejectedCount),
    rejectedPct,
    indicatorBreakdown,
    fourHIndicatorBreakdown,
    timeframeBreakdown,
    lastScraperStartedAt: latestRun?.startedAt ?? null,
    validationStatus: useValidated ? ("validated" as const) : ("unvalidated" as const),
    byTimeframe,
    byIndicator,
    lastScraperRun,
  };
}

export async function getScraperStatus() {
  const db = getDb();
  const [latest] = await db.select().from(scraperRuns).orderBy(desc(scraperRuns.startedAt)).limit(1);
  const [{ totalSignals }] = await db.select({ totalSignals: sql`count(*)` }).from(coinlegsSignals);
  return { latestRun: latest ?? null, totalSignals: Number(totalSignals) };
}

export async function getJulyResults() {
  const db = getDb();
  const julyStart = new Date("2026-07-01T00:00:00Z").getTime();
  const julyEnd = new Date("2026-08-01T00:00:00Z").getTime();
  const taken = await db.select({
    id: coinlegsSignals.id, marketName: coinlegsSignals.marketName,
    indicatorShortName: coinlegsSignals.indicatorShortName, period: coinlegsSignals.period,
    qualityTier: coinlegsSignals.qualityTier, qualityScore: coinlegsSignals.qualityScore,
    maxProfit: coinlegsSignals.maxProfit, signalDate: coinlegsSignals.signalDate, price: coinlegsSignals.price,
  }).from(coinlegsSignals).where(and(eq(coinlegsSignals.signal, 1), inArray(coinlegsSignals.qualityTier, ["A", "B"]), gte(coinlegsSignals.signalDate, julyStart), lt(coinlegsSignals.signalDate, julyEnd)))
    .orderBy(desc(sql`CAST(${coinlegsSignals.maxProfit} AS REAL)`));
  const filteredOut = await db.select({
    id: coinlegsSignals.id, marketName: coinlegsSignals.marketName,
    indicatorShortName: coinlegsSignals.indicatorShortName, period: coinlegsSignals.period,
    qualityTier: coinlegsSignals.qualityTier, qualityScore: coinlegsSignals.qualityScore,
    maxProfit: coinlegsSignals.maxProfit, signalDate: coinlegsSignals.signalDate, price: coinlegsSignals.price,
  }).from(coinlegsSignals).where(and(eq(coinlegsSignals.signal, 1), eq(coinlegsSignals.qualityTier, "C"), gte(coinlegsSignals.signalDate, julyStart), lt(coinlegsSignals.signalDate, julyEnd)))
    .orderBy(asc(sql`CAST(${coinlegsSignals.maxProfit} AS REAL)`)).limit(20);
  const wins = taken.filter(s => s.maxProfit !== null && parseFloat(String(s.maxProfit)) >= 2);
  const nearFlat = taken.filter(s => s.maxProfit !== null && parseFloat(String(s.maxProfit)) > 0 && parseFloat(String(s.maxProfit)) < 2);
  let balance = 10000;
  let totalPnl = 0;
  const sortedByDate = [...taken].sort((a, b) => new Date(a.signalDate!).getTime() - new Date(b.signalDate!).getTime());
  for (const s of sortedByDate) {
    const mp = s.maxProfit !== null ? parseFloat(String(s.maxProfit)) : 0;
    const pnl = balance * 0.005 * (mp / 100);
    balance += pnl;
    totalPnl += pnl;
  }
  return {
    wins, nearFlat, filteredOut,
    summary: { totalTaken: taken.length, winCount: wins.length, nearFlatCount: nearFlat.length, filteredOutCount: filteredOut.length, netReturn: ((balance - 10000) / 10000) * 100, totalPnl, bestProfit: wins.length > 0 ? parseFloat(String(wins[0].maxProfit)) : 0, bestPair: wins.length > 0 ? wins[0].marketName : "" },
  };
}
