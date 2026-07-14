import { eq, and, desc, gte, lte } from "drizzle-orm";
import { getDb } from "../db";
import { feePeriods, feePayments, navSnapshots } from "../../drizzle/schema";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ANNUAL_MANAGEMENT_FEE_RATE = 0.02; // 2 % per year
const PERFORMANCE_FEE_RATE = 0.2; // 20 % on net new profits above HWM
const DAYS_PER_YEAR = 365;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface CrystallizeFeesResult {
  status: "ok" | "error";
  usersProcessed: number;
  managementFeesTotal: number;
  performanceFeesTotal: number;
  paymentsCreated: number;
  errorMessage?: string;
}

export interface UserFeeStatus {
  userId: number;
  currentPeriod: {
    id: number;
    periodStart: number;
    periodEnd: number;
    startingNavUsd: number;
    endingNavUsd: number | null;
    highWaterMarkUsd: number;
    managementFeeUsd: number;
    performanceFeeUsd: number;
    status: string;
  } | null;
  accruedFeesTotal: number;
  hwm: number;
  nextCrystallizationDate: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function startOfToday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function endOfToday(): Date {
  const d = new Date();
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function startOfTomorrow(): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

function quarterStart(ts: Date): Date {
  const d = new Date(ts);
  const month = d.getUTCMonth();
  const quarterMonth = Math.floor(month / 3) * 3;
  d.setUTCMonth(quarterMonth, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function quarterEnd(ts: Date): Date {
  const start = quarterStart(ts);
  const d = new Date(start);
  d.setUTCMonth(d.getUTCMonth() + 3);
  d.setUTCMilliseconds(-1);
  return d;
}

/* ------------------------------------------------------------------ */
/*  crystallizeFees – main cron entry-point                            */
/* ------------------------------------------------------------------ */

/**
 * Daily fee crystallization:
 *  - For every user with an OPEN fee_period OR a NAV snapshot today,
 *    find/create the open period, compute daily management fee (2 % /
 *    365 * ending NAV) and performance fee (20 % of NAV above HWM),
 *    update the period row and insert fee_payments.
 */
export async function crystallizeFees(): Promise<CrystallizeFeesResult> {
  const db = getDb();
  const todayStart = startOfToday();
  const todayEnd = endOfToday();
  const todayStartMs = todayStart.getTime();
  const todayEndMs = todayEnd.getTime();

  try {
    /* ---- collect active user ids ---- */
    const [openPeriodUsers, snapshotUsers] = await Promise.all([
      db
        .selectDistinct({ userId: feePeriods.userId })
        .from(feePeriods)
        .where(eq(feePeriods.status, "open")),
      db
        .selectDistinct({ userId: navSnapshots.userId })
        .from(navSnapshots)
        .where(
          and(
            gte(navSnapshots.snapshotAt, todayStartMs),
            lte(navSnapshots.snapshotAt, todayEndMs),
          ),
        ),
    ]);

    const userIdSet = new Set<number>();
    for (const row of openPeriodUsers) userIdSet.add(row.userId);
    for (const row of snapshotUsers) userIdSet.add(row.userId);
    const activeUserIds = [...userIdSet];

    let usersProcessed = 0;
    let managementFeesTotal = 0;
    let performanceFeesTotal = 0;
    let paymentsCreated = 0;

    for (const userId of activeUserIds) {
      try {
        /* -- 1. find or create open fee period -- */
        const periodRows = await db
          .select()
          .from(feePeriods)
          .where(
            and(eq(feePeriods.userId, userId), eq(feePeriods.status, "open")),
          )
          .limit(1);

        let period = periodRows[0] ?? null;

        if (!period) {
          // No open period — create one anchored to the latest NAV snapshot
          const latestSnap = await db
            .select()
            .from(navSnapshots)
            .where(eq(navSnapshots.userId, userId))
            .orderBy(desc(navSnapshots.snapshotAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (!latestSnap) continue; // nothing to anchor on

          const startingNav = parseFloat(latestSnap.accountEquityUsd);
          const pStart = quarterStart(todayStart);
          const pEnd = quarterEnd(todayStart);

          const [inserted] = await db
            .insert(feePeriods)
            .values({
              userId,
              periodStart: pStart,
              periodEnd: pEnd,
              startingNavUsd: String(startingNav),
              endingNavUsd: String(startingNav),
              highWaterMarkUsd: String(startingNav),
              managementFeeUsd: "0.00",
              performanceFeeUsd: "0.00",
              status: "open",
            } as any)
            .returning();

          period = inserted;
        }

        /* -- 2. fetch today's NAV snapshots -- */
        const todaySnapshots = await db
          .select()
          .from(navSnapshots)
          .where(
            and(
              eq(navSnapshots.userId, userId),
              gte(navSnapshots.snapshotAt, todayStartMs),
              lte(navSnapshots.snapshotAt, todayEndMs),
            ),
          )
          .orderBy(desc(navSnapshots.snapshotAt));

        if (todaySnapshots.length === 0) continue; // nothing to accrue today

        /* -- 3. compute fees -- */
        const latestNav = todaySnapshots[0];
        const endingNav = parseFloat(latestNav.accountEquityUsd);
        const currentHwm = parseFloat(period.highWaterMarkUsd);

        // Daily management fee
        const dailyManagementFee =
          (ANNUAL_MANAGEMENT_FEE_RATE / DAYS_PER_YEAR) * endingNav;

        // Performance fee (only on net new profits above HWM)
        let performanceFee = 0;
        let newHwm = currentHwm;

        if (endingNav > currentHwm) {
          performanceFee = PERFORMANCE_FEE_RATE * (endingNav - currentHwm);
          newHwm = endingNav;
        }

        /* -- 4. update fee period -- */
        const updatedManagementTotal =
          parseFloat(period.managementFeeUsd) + dailyManagementFee;
        const updatedPerformanceTotal =
          parseFloat(period.performanceFeeUsd) + performanceFee;

        await db
          .update(feePeriods)
          .set({
            endingNavUsd: String(endingNav),
            highWaterMarkUsd: String(newHwm),
            managementFeeUsd: String(updatedManagementTotal.toFixed(2)),
            performanceFeeUsd: String(updatedPerformanceTotal.toFixed(2)),
          } as any)
          .where(eq(feePeriods.id, period.id));

        /* -- 5. create fee payment rows -- */
        if (dailyManagementFee > 0) {
          await db.insert(feePayments).values({
            feePeriodId: period.id,
            userId,
            amountUsd: String(dailyManagementFee.toFixed(2)),
            status: "pending",
          } as any);
          paymentsCreated++;
        }

        if (performanceFee > 0) {
          await db.insert(feePayments).values({
            feePeriodId: period.id,
            userId,
            amountUsd: String(performanceFee.toFixed(2)),
            status: "pending",
          } as any);
          paymentsCreated++;
        }

        usersProcessed++;
        managementFeesTotal += dailyManagementFee;
        performanceFeesTotal += performanceFee;
      } catch (userError: unknown) {
        const msg =
          userError instanceof Error ? userError.message : String(userError);
        console.error(`[FeeEngine] Error processing user ${userId}:`, msg);
      }
    }

    return {
      status: "ok",
      usersProcessed,
      managementFeesTotal: Math.round(managementFeesTotal * 100) / 100,
      performanceFeesTotal: Math.round(performanceFeesTotal * 100) / 100,
      paymentsCreated,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "error",
      usersProcessed: 0,
      managementFeesTotal: 0,
      performanceFeesTotal: 0,
      paymentsCreated: 0,
      errorMessage: msg,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  getUserFeeStatus – per-user dashboard helper                       */
/* ------------------------------------------------------------------ */

export async function getUserFeeStatus(userId: number): Promise<UserFeeStatus> {
  const db = getDb();

  const period = await db
    .select()
    .from(feePeriods)
    .where(
      and(eq(feePeriods.userId, userId), eq(feePeriods.status, "open")),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const payments = await db
    .select()
    .from(feePayments)
    .where(
      and(eq(feePayments.userId, userId), eq(feePayments.status, "pending")),
    );

  const accruedFeesTotal = payments.reduce(
    (sum, p) => sum + parseFloat(p.amountUsd),
    0,
  );

  return {
    userId,
    currentPeriod: period
      ? {
          id: period.id,
          periodStart: new Date(period.periodStart).getTime(),
          periodEnd: new Date(period.periodEnd).getTime(),
          startingNavUsd: parseFloat(period.startingNavUsd),
          endingNavUsd: period.endingNavUsd
            ? parseFloat(period.endingNavUsd)
            : null,
          highWaterMarkUsd: parseFloat(period.highWaterMarkUsd),
          managementFeeUsd: parseFloat(period.managementFeeUsd),
          performanceFeeUsd: parseFloat(period.performanceFeeUsd),
          status: period.status,
        }
      : null,
    accruedFeesTotal,
    hwm: period ? parseFloat(period.highWaterMarkUsd) : 0,
    nextCrystallizationDate: startOfTomorrow(),
  };
}
