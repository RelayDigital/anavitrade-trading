export type LeaseAction = "submit" | "reconcile";

type D1Result<T = unknown> = { results?: T[]; meta?: { changes?: number } };
type D1Statement = { bind: (...values: unknown[]) => D1Statement; first?: <T>() => Promise<T | null> };
export type D1LeaseDatabase = {
  prepare: (sql: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<D1Result[]>;
};

export type LeaseClaimInput = {
  owner: string;
  action: LeaseAction;
  now?: number;
  leaseMs?: number;
  limit?: number;
  maxAttempts?: number;
  token?: string;
};

export type LeasedExecutionJob = {
  id: number;
  leaseToken: string;
  leaseOwner: string;
  leaseExpiresAt: number;
  leaseAttempt: number;
  leaseAction: LeaseAction;
  [key: string]: unknown;
};

export async function claimExecutionJobs(
  database: D1LeaseDatabase,
  input: LeaseClaimInput,
): Promise<LeasedExecutionJob[]> {
  if (!input.owner?.trim()) throw new Error("lease owner is required");
  const now = input.now ?? Date.now();
  const leaseMs = Math.min(Math.max(input.leaseMs ?? 30_000, 1_000), 5 * 60_000);
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 50);
  const maxAttempts = Math.min(Math.max(input.maxAttempts ?? 5, 1), 20);
  const token = input.token ?? crypto.randomUUID();
  const baseStatus = input.action === "submit" ? "queued" : "submitted";

  const update = database.prepare(`
    UPDATE execution_jobs
    SET leasePreviousStatus = CASE WHEN status = 'leased' THEN leasePreviousStatus ELSE status END,
        status = 'leased', leaseToken = ?, leaseOwner = ?, leaseExpiresAt = ?,
        leaseAttempt = leaseAttempt + 1, leaseAction = ?, updatedAt = ?
    WHERE id IN (
      SELECT id FROM execution_jobs
      WHERE provider = 'cex' AND riskApproved = 1 AND leaseAttempt < ?
        AND (status = ? OR (status = 'leased' AND leaseAction = ? AND leaseExpiresAt <= ?))
      ORDER BY queuedAt ASC, id ASC LIMIT ?
    )
  `).bind(token, input.owner, now + leaseMs, input.action, now,
    maxAttempts, baseStatus, input.action, now, limit);
  const select = database.prepare(`
    SELECT * FROM execution_jobs
    WHERE leaseToken = ? AND leaseOwner = ? AND leaseAction = ?
    ORDER BY queuedAt ASC, id ASC
  `).bind(token, input.owner, input.action);

  const results = await database.batch([update, select]);
  return (results[1]?.results ?? []) as LeasedExecutionJob[];
}

export type ExecutionReportInput = {
  reportId: string;
  jobId: number;
  leaseToken: string;
  leaseAttempt: number;
  status: "submitted" | "filled" | "protection_pending" | "protected" | "failed" | "cancelled" | "unresolved";
  orderId?: string | null;
  errorCode?: string | null;
  stopLossOrderId?: string | null;
  takeProfitOrderId?: string | null;
  compensationState?: "completed" | "failed" | null;
  compensationOrderId?: string | null;
  now?: number;
};

export class LeaseConflictError extends Error {}

export async function reportExecutionOutcome(
  database: D1LeaseDatabase,
  input: ExecutionReportInput,
): Promise<{ status: "applied" | "idempotent"; jobId: number }> {
  if (!input.reportId || !input.leaseToken || !Number.isInteger(input.leaseAttempt)) {
    throw new LeaseConflictError("report requires reportId, leaseToken, and leaseAttempt");
  }
  const existing = await database.prepare(
    "SELECT reportId, executionJobId, leaseAttempt FROM execution_reports WHERE reportId = ?",
  ).bind(input.reportId).first?.<{ reportId: string; executionJobId: number; leaseAttempt: number }>();
  if (existing) {
    if (existing.executionJobId !== input.jobId || existing.leaseAttempt !== input.leaseAttempt) {
      throw new LeaseConflictError("reportId already belongs to another lease");
    }
    return { status: "idempotent", jobId: input.jobId };
  }

  const now = input.now ?? Date.now();
  const nextStatus = input.status === "unresolved" ? "submitted" : input.status;
  const insert = database.prepare(`
    INSERT INTO execution_reports (
      reportId, executionJobId, leaseAttempt, status, orderId, errorCode,
      stopLossOrderId, takeProfitOrderId, compensationState, compensationOrderId, createdAt
    )
    SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM execution_jobs
    WHERE id = ? AND status = 'leased' AND leaseToken = ? AND leaseAttempt = ?
      AND leaseExpiresAt > ?
    ON CONFLICT(reportId) DO NOTHING
  `).bind(input.reportId, input.leaseAttempt, input.status, input.orderId ?? null,
    input.errorCode ?? null, input.stopLossOrderId ?? null, input.takeProfitOrderId ?? null,
    input.compensationState ?? null, input.compensationOrderId ?? null, now,
    input.jobId, input.leaseToken, input.leaseAttempt, now);
  const update = database.prepare(`
    UPDATE execution_jobs
    SET status = ?, orderId = COALESCE(?, orderId), errorMessage = ?,
        submittedAt = CASE WHEN ? IN ('submitted','filled','protection_pending','protected') THEN COALESCE(submittedAt, ?) ELSE submittedAt END,
        filledAt = CASE WHEN ? IN ('filled','protection_pending','protected') THEN COALESCE(filledAt, ?) ELSE filledAt END,
        cancelledAt = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelledAt END,
        leaseToken = NULL, leaseOwner = NULL, leaseExpiresAt = NULL,
        leaseAction = NULL, leasePreviousStatus = NULL, updatedAt = ?
    WHERE id = ? AND status = 'leased' AND leaseToken = ? AND leaseAttempt = ?
      AND leaseExpiresAt > ?
      AND EXISTS (SELECT 1 FROM execution_reports WHERE reportId = ? AND executionJobId = ? AND leaseAttempt = ?)
  `).bind(nextStatus, input.orderId ?? null, input.errorCode ?? null,
    nextStatus, now, nextStatus, now, nextStatus, now, now,
    input.jobId, input.leaseToken, input.leaseAttempt, now,
    input.reportId, input.jobId, input.leaseAttempt);
  const updateIntent = database.prepare(`
    UPDATE trade_intents
    SET status = CASE
      WHEN EXISTS (SELECT 1 FROM execution_jobs WHERE tradeIntentId = trade_intents.id AND status = 'failed') THEN 'failed'
      WHEN EXISTS (SELECT 1 FROM execution_jobs WHERE tradeIntentId = trade_intents.id AND status = 'protection_pending') THEN 'protection_pending'
      WHEN NOT EXISTS (SELECT 1 FROM execution_jobs WHERE tradeIntentId = trade_intents.id AND status <> 'protected') THEN 'protected'
      WHEN EXISTS (SELECT 1 FROM execution_jobs WHERE tradeIntentId = trade_intents.id AND status = 'filled') THEN 'filled'
      WHEN EXISTS (SELECT 1 FROM execution_jobs WHERE tradeIntentId = trade_intents.id AND status = 'submitted') THEN 'submitted'
      WHEN NOT EXISTS (SELECT 1 FROM execution_jobs WHERE tradeIntentId = trade_intents.id AND status <> 'cancelled') THEN 'cancelled'
      ELSE status
    END,
    updatedAt = ?
    WHERE id = (SELECT tradeIntentId FROM execution_jobs WHERE id = ?)
      AND EXISTS (SELECT 1 FROM execution_reports WHERE reportId = ? AND executionJobId = ? AND leaseAttempt = ?)
  `).bind(now, input.jobId, input.reportId, input.jobId, input.leaseAttempt);
  const results = await database.batch([insert, update, updateIntent]);
  const inserted = results[0]?.meta?.changes ?? 0;
  const updated = results[1]?.meta?.changes ?? 0;
  if (!inserted && !updated) {
    // A concurrent retry can observe no report before its batch starts, then
    // hit ON CONFLICT after the first caller commits and clears the lease.
    // Re-read the durable report so that this race remains idempotent.
    const duplicate = await database.prepare(
      "SELECT reportId, executionJobId, leaseAttempt FROM execution_reports WHERE reportId = ?",
    ).bind(input.reportId).first?.<{ reportId: string; executionJobId: number; leaseAttempt: number }>();
    if (duplicate?.executionJobId === input.jobId && duplicate.leaseAttempt === input.leaseAttempt) {
      return { status: "idempotent", jobId: input.jobId };
    }
    throw new LeaseConflictError("stale or inactive execution lease");
  }
  return { status: inserted ? "applied" : "idempotent", jobId: input.jobId };
}
