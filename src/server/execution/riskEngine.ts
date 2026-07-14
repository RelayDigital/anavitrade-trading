import { eq, and, gte, sql, inArray } from "drizzle-orm";
import { liveAccounts, navSnapshots, executionJobs, globalSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import type { CexConnectionRow } from "./types";

/**
 * Risk engine — owns whether a user gets an order for a given TradeIntent.
 * Provider-neutral: works for any connection that exposes copytrade/kill-switch
 * flags. The execution adapter must never re-implement this policy.
 *
 * Kill switch: persisted in DB via the `global_settings` table so the flag
 * survives Worker restarts. An in-memory hot-path cache avoids a DB read on
 * every decision; the cache is refreshed every 1000ms (the DB value is
 * authoritative).
 */

export type TradeIntentInput = {
  id: number;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  requestedNotionalUsd?: string | null;
  targetLeverage?: number | null;
  limitPrice?: string | null;
  stopLossPrice?: string | null;
  takeProfitPrice?: string | null;
  period?: string; // timeframe from coinlegs signals (e.g. "4h", "15m", "1d")
};

/** Timeframe-based risk multipliers derived from 1,265-trade backtest.
 *  4h signals have 70.7% WR → 2.0x position size for maximum returns.
 *  15m signals have 60.8% WR → 0.75x to reduce noise exposure. */
const TF_RISK_MULTIPLIER: Record<string, number> = {
  "4h": 2.0,   // double risk on the strongest timeframes
  "1d": 2.0,
  "1w": 2.0,
  "1h": 1.5,   // 50% more on medium timeframes
  "30m": 1.0,  // standard
  "15m": 0.75, // reduced on noisy timeframes
  "5m": 0.5,
};

export type RiskDecision =
  | { approved: true; notionalUsd: number; leverage: number }
  | { approved: false; reason: string };

/* ─── DB-backed kill switch ────────────────────────────────────────────── */

let GLOBAL_KILL_CACHE = false;
let GLOBAL_KILL_CACHE_EXPIRY = 0;
const CACHE_TTL_MS = 1_000;

/** Check `global_kill_switch` in DB (cache-friendly, verifies every ~1s). */
export async function verifyGlobalKill(): Promise<boolean> {
  if (Date.now() < GLOBAL_KILL_CACHE_EXPIRY) return GLOBAL_KILL_CACHE;
  const db = getDb();
  const [row] = await db.select({ value: globalSettings.value })
    .from(globalSettings)
    .where(eq(globalSettings.key, "global_kill_switch"))
    .limit(1);
  GLOBAL_KILL_CACHE = row?.value === "true";
  GLOBAL_KILL_CACHE_EXPIRY = Date.now() + CACHE_TTL_MS;
  return GLOBAL_KILL_CACHE;
}

/** Synchronous reader — returns cached value (up to ~1s stale). */
export function isGlobalKill(): boolean {
  return GLOBAL_KILL_CACHE;
}

/** Write the kill switch to DB and immediately update the in-memory cache. */
export async function setGlobalKill(active: boolean) {
  const db = getDb();
  const [existing] = await db.select({ id: globalSettings.id })
    .from(globalSettings)
    .where(eq(globalSettings.key, "global_kill_switch"))
    .limit(1);
  if (existing) {
    await db.update(globalSettings).set({
      value: active ? "true" : "false",
      updatedAt: new Date(),
    } as any).where(eq(globalSettings.id, existing.id));
  } else {
    await db.insert(globalSettings).values({
      key: "global_kill_switch",
      value: active ? "true" : "false",
    } as any);
  }
  GLOBAL_KILL_CACHE = active;
  GLOBAL_KILL_CACHE_EXPIRY = Date.now() + CACHE_TTL_MS;
}

/* ─── Batch-prefetch support ───────────────────────────────────────────── */

export interface PrefetchedUserData {
  accounts: Map<number, typeof liveAccounts.$inferSelect>;
  navSnapshotsToday: Map<number, Array<typeof navSnapshots.$inferSelect>>;
  openJobs: Map<number, Array<{ notionalUsd: string | null }>>;
  latestNav: Map<number, typeof navSnapshots.$inferSelect | null>;
}

/**
 * Pre-fetch all user-level data needed for risk decisions, keyed by userId.
 * Eliminates N+1 DB roundtrips when processing multiple connections.
 */
export async function prefetchUserData(userIds: number[]): Promise<PrefetchedUserData> {
  const db = getDb();
  if (userIds.length === 0) {
    return { accounts: new Map(), navSnapshotsToday: new Map(), openJobs: new Map(), latestNav: new Map() };
  }

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  const [accounts, todaySnapshots, openJobs, latestNavs] = await Promise.all([
    db.select().from(liveAccounts)
      .where(inArray(liveAccounts.userId, userIds))
      .all(),
    db.select().from(navSnapshots)
      .where(and(
        inArray(navSnapshots.userId, userIds),
        gte(navSnapshots.snapshotAt, todayStartMs as any),
      ))
      .orderBy(sql`${navSnapshots.snapshotAt} ASC`)
      .all(),
    db.select({
      userId: executionJobs.userId,
      notionalUsd: executionJobs.notionalUsd,
    }).from(executionJobs)
      .where(and(
        inArray(executionJobs.userId, userIds),
        inArray(executionJobs.status, ["queued", "submitted"]),
      ))
      .all(),
    db.select().from(navSnapshots)
      .where(inArray(navSnapshots.userId, userIds))
      .orderBy(sql`${navSnapshots.snapshotAt} DESC`)
      .all(),
  ]);

  const accountMap = new Map<number, typeof liveAccounts.$inferSelect>();
  for (const a of accounts) accountMap.set(a.userId, a);

  const navMap = new Map<number, Array<typeof navSnapshots.$inferSelect>>();
  for (const s of todaySnapshots) {
    const arr = navMap.get(s.userId) ?? [];
    arr.push(s);
    navMap.set(s.userId, arr);
  }

  const jobsMap = new Map<number, Array<{ notionalUsd: string | null }>>();
  for (const j of openJobs) {
    const arr = jobsMap.get(j.userId) ?? [];
    arr.push(j);
    jobsMap.set(j.userId, arr);
  }

  const latestNavMap = new Map<number, typeof navSnapshots.$inferSelect | null>();
  for (const n of latestNavs) {
    if (!latestNavMap.has(n.userId)) latestNavMap.set(n.userId, n);
  }
  for (const uid of userIds) {
    if (!latestNavMap.has(uid)) latestNavMap.set(uid, null);
  }

  return {
    accounts: accountMap,
    navSnapshotsToday: navMap,
    openJobs: jobsMap,
    latestNav: latestNavMap,
  };
}

/* ─── Decision ──────────────────────────────────────────────────────────── */

export async function decideExecution(
  intent: TradeIntentInput,
  userId: number,
  connection: Pick<CexConnectionRow, "status" | "copytradeEnabled" | "killSwitchActive">,
  preloaded?: PrefetchedUserData,
): Promise<RiskDecision> {
  // DB-backed kill switch (with hot-path cache)
  if (await verifyGlobalKill()) return { approved: false, reason: "global_kill_switch" };
  if (connection.status !== "active") return { approved: false, reason: "connection_not_active" };
  if (!connection.copytradeEnabled) return { approved: false, reason: "copytrade_disabled" };
  if (connection.killSwitchActive) return { approved: false, reason: "kill_switch_active" };

  const db = getDb();

  // Use preloaded data if available; otherwise fall back to individual queries.
  let account: typeof liveAccounts.$inferSelect | undefined;
  if (preloaded?.accounts.has(userId)) {
    account = preloaded.accounts.get(userId);
  } else {
    const [acct] = await db.select().from(liveAccounts)
      .where(eq(liveAccounts.userId, userId)).limit(1);
    account = acct;
  }
  if (!account) return { approved: false, reason: "no_live_account" };
  if (account.status !== "active") return { approved: false, reason: "account_not_active" };
  if (account.killSwitchActive) return { approved: false, reason: "account_kill_switch" };

  const maxLeverage = parseFloat(account.maxLeverage ?? "10");
  const maxPositionPct = parseFloat(account.maxPositionSizePct ?? "10");
  const maxDailyLossPct = parseFloat(account.maxDailyLossPct ?? "5.00");

  // Apply timeframe-based risk multiplier from backtest results.
  // Defaults to 1.0 for legacy intents without a period.
  const tfMultiplier = TF_RISK_MULTIPLIER[intent.period ?? ""] ?? 1.0;
  const effectivePositionPct = maxPositionPct * tfMultiplier;

  const requestedLeverage = intent.targetLeverage ?? 3;
  const leverage = Math.min(requestedLeverage, maxLeverage);

  // ── Daily loss limit ──
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  let recentSnapshots: Array<typeof navSnapshots.$inferSelect>;
  if (preloaded?.navSnapshotsToday.has(userId)) {
    recentSnapshots = preloaded.navSnapshotsToday.get(userId)!;
  } else {
    recentSnapshots = await db.select()
      .from(navSnapshots)
      .where(and(eq(navSnapshots.userId, userId), gte(navSnapshots.snapshotAt, todayStartMs as any)))
      .orderBy(sql`${navSnapshots.snapshotAt} ASC`)
      .limit(10)
      .all();
  }

  if (recentSnapshots.length >= 2) {
    const startEquity = parseFloat(recentSnapshots[0].accountEquityUsd);
    const currentEquity = parseFloat(recentSnapshots[recentSnapshots.length - 1].accountEquityUsd);
    if (startEquity > 0) {
      const todayPnlPct = ((currentEquity - startEquity) / startEquity) * 100;
      if (todayPnlPct < -maxDailyLossPct) {
        return { approved: false, reason: `daily_loss_limit:${todayPnlPct.toFixed(1)}%` };
      }
    }
  }

  // ── Portfolio exposure cap ──
  const requestedNotional = intent.requestedNotionalUsd
    ? parseFloat(intent.requestedNotionalUsd)
    : 0;

  if (isNaN(requestedNotional) || requestedNotional < 0) return { approved: false, reason: "invalid_notional" };

  const maxTotalExposurePct = parseFloat(account.maxTotalExposurePct ?? "25.00");
  let openJobsResult: Array<{ notionalUsd: string | null }>;
  if (preloaded?.openJobs.has(userId)) {
    openJobsResult = preloaded.openJobs.get(userId)!;
  } else {
    openJobsResult = await db.select({ notionalUsd: executionJobs.notionalUsd })
      .from(executionJobs)
      .where(and(eq(executionJobs.userId, userId), inArray(executionJobs.status, ["queued", "submitted"])))
      .all();
  }

  const totalOpenNotional = openJobsResult.reduce(
    (sum, job) => sum + parseFloat(job.notionalUsd ?? "0"),
    0,
  );

  let latestNav: typeof navSnapshots.$inferSelect | null | undefined;
  if (preloaded?.latestNav.has(userId)) {
    latestNav = preloaded.latestNav.get(userId);
  } else {
    const [nav] = await db.select().from(navSnapshots)
      .where(eq(navSnapshots.userId, userId))
      .orderBy(sql`${navSnapshots.snapshotAt} DESC`)
      .limit(1);
    latestNav = nav ?? null;
  }

  const availableEquity = latestNav ? parseFloat(latestNav.accountEquityUsd) : 0;

  if (availableEquity > 0) {
    const proposedNotional = requestedNotional > 0
      ? requestedNotional
      : sizeNotionalFromEquity(availableEquity, effectivePositionPct);

    const projectedExposurePct =
      ((totalOpenNotional + proposedNotional) / availableEquity) * 100;

    if (projectedExposurePct > maxTotalExposurePct) {
      return {
        approved: false,
        reason: `exposure_cap:${projectedExposurePct.toFixed(1)}%_vs_${maxTotalExposurePct.toFixed(0)}%`,
      };
    }
  }

  return { approved: true, notionalUsd: requestedNotional, leverage };
}

/** Position size from account equity + the user's max position-size cap. */
export function sizeNotionalFromEquity(equityUsd: number, maxPositionPct: number): number {
  return Math.max(0, equityUsd * (maxPositionPct / 100));
}
