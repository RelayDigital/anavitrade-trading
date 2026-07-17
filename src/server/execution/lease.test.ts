import assert from "node:assert/strict";
import test from "node:test";
import {
  claimExecutionJobs,
  LeaseConflictError,
  reportExecutionOutcome,
  type D1LeaseDatabase,
  type LeaseAction,
  type LeasedExecutionJob,
} from "./lease";

type Job = LeasedExecutionJob & {
  tradeIntentId: number;
  provider: string;
  riskApproved: number;
  status: string;
  idempotencyKey: string;
  queuedAt: number;
  orderId: string | null;
  errorMessage: string | null;
  submittedAt: number | null;
  filledAt: number | null;
  cancelledAt: number | null;
  leaseToken: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  leaseAction: string | null;
  leasePreviousStatus: string | null;
  updatedAt: number;
};

type Report = {
  reportId: string;
  executionJobId: number;
  leaseAttempt: number;
  status: string;
  orderId: string | null;
  errorCode: string | null;
  createdAt: number;
};

/**
 * Small D1 behavioral fake. It executes the prepared lease statements against
 * durable row state and serializes batches, matching D1's transaction boundary
 * without making a network request or asserting on SQL source text.
 */
class FakeD1 implements D1LeaseDatabase {
  readonly jobs = new Map<number, Job>();
  readonly reports = new Map<string, Report>();
  readonly intents = new Map<number, string>();
  private batchTail: Promise<void> = Promise.resolve();

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  batch(statements: FakeStatement[]): Promise<Array<{ results?: unknown[]; meta?: { changes?: number } }>> {
    const run = this.batchTail.then(() => statements.map((statement) => statement.execute()));
    this.batchTail = run.then(() => undefined, () => undefined);
    return run;
  }

  job(id: number): Job {
    const job = this.jobs.get(id);
    assert.ok(job, `job ${id} should exist`);
    return job;
  }
}

type StatementKind =
  | "claim-update"
  | "claim-select"
  | "report-lookup"
  | "report-insert"
  | "report-update"
  | "intent-update";

class FakeStatement {
  private values: unknown[] = [];
  private readonly kind: StatementKind;

  constructor(private readonly database: FakeD1, sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (normalized.startsWith("UPDATE EXECUTION_JOBS SET LEASEPREVIOUSSTATUS")) this.kind = "claim-update";
    else if (normalized.startsWith("SELECT * FROM EXECUTION_JOBS")) this.kind = "claim-select";
    else if (normalized.startsWith("SELECT REPORTID, EXECUTIONJOBID, LEASEATTEMPT FROM EXECUTION_REPORTS")) this.kind = "report-lookup";
    else if (normalized.startsWith("INSERT INTO EXECUTION_REPORTS")) this.kind = "report-insert";
    else if (normalized.startsWith("UPDATE EXECUTION_JOBS SET STATUS")) this.kind = "report-update";
    else if (normalized.startsWith("UPDATE TRADE_INTENTS SET STATUS")) this.kind = "intent-update";
    else throw new Error(`Unsupported fake D1 statement: ${normalized.slice(0, 80)}`);
  }

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.kind !== "report-lookup") throw new Error("first() is only modeled for report lookup");
    const report = this.database.reports.get(String(this.values[0]));
    return (report ? { reportId: report.reportId, executionJobId: report.executionJobId, leaseAttempt: report.leaseAttempt } : null) as T | null;
  }

  execute(): { results?: unknown[]; meta?: { changes?: number } } {
    switch (this.kind) {
      case "claim-update": return this.executeClaimUpdate();
      case "claim-select": return this.executeClaimSelect();
      case "report-insert": return this.executeReportInsert();
      case "report-update": return this.executeReportUpdate();
      case "intent-update": return this.executeIntentUpdate();
      case "report-lookup": throw new Error("report lookup must use first()");
    }
  }

  private executeClaimUpdate() {
    const [token, owner, expiresAt, action, updatedAt, maxAttempts, baseStatus, reclaimAction, now, limit] = this.values as [
      string, string, number, LeaseAction, number, number, string, LeaseAction, number, number,
    ];
    const eligible = [...this.database.jobs.values()]
      .filter((job) => job.provider === "cex" && job.riskApproved === 1 && job.leaseAttempt < maxAttempts)
      .filter((job) => job.status === baseStatus || (
        job.status === "leased" && job.leaseAction === reclaimAction && (job.leaseExpiresAt ?? 0) <= now
      ))
      .sort((left, right) => left.queuedAt - right.queuedAt || left.id - right.id)
      .slice(0, limit);

    for (const job of eligible) {
      job.leasePreviousStatus = job.status === "leased" ? job.leasePreviousStatus : job.status;
      job.status = "leased";
      job.leaseToken = token;
      job.leaseOwner = owner;
      job.leaseExpiresAt = expiresAt;
      job.leaseAttempt += 1;
      job.leaseAction = action;
      job.updatedAt = updatedAt;
    }
    return { meta: { changes: eligible.length } };
  }

  private executeClaimSelect() {
    const [token, owner, action] = this.values as [string, string, string];
    const results = [...this.database.jobs.values()]
      .filter((job) => job.leaseToken === token && job.leaseOwner === owner && job.leaseAction === action)
      .sort((left, right) => left.queuedAt - right.queuedAt || left.id - right.id)
      .map((job) => ({ ...job }));
    return { results };
  }

  private executeReportInsert() {
    const [reportId, leaseAttempt, status, orderId, errorCode, _stopLossOrderId, _takeProfitOrderId, _compensationState, _compensationOrderId, createdAt, jobId, token, attempt, now] = this.values as [
      string, number, string, string | null, string | null, string | null, string | null, string | null, string | null,
      number, number, string, number, number,
    ];
    if (this.database.reports.has(reportId)) return { meta: { changes: 0 } };
    const job = this.database.jobs.get(jobId);
    if (!job || job.status !== "leased" || job.leaseToken !== token || job.leaseAttempt !== attempt || (job.leaseExpiresAt ?? 0) <= now) {
      return { meta: { changes: 0 } };
    }
    this.database.reports.set(reportId, {
      reportId,
      executionJobId: jobId,
      leaseAttempt,
      status,
      orderId,
      errorCode,
      createdAt,
    });
    return { meta: { changes: 1 } };
  }

  private executeReportUpdate() {
    const [nextStatus, orderId, errorMessage, submittedStatus, submittedAt, filledStatus, filledAt, cancelledStatus, cancelledAt, updatedAt, jobId, token, attempt, now, reportId, reportJobId, reportAttempt] = this.values as [
      string, string | null, string | null, string, number, string, number, string, number, number,
      number, string, number, number, string, number, number,
    ];
    const job = this.database.jobs.get(jobId);
    const report = this.database.reports.get(reportId);
    if (!job || !report || report.executionJobId !== reportJobId || report.leaseAttempt !== reportAttempt
      || job.status !== "leased" || job.leaseToken !== token || job.leaseAttempt !== attempt
      || (job.leaseExpiresAt ?? 0) <= now) {
      return { meta: { changes: 0 } };
    }

    job.status = nextStatus;
    if (orderId !== null) job.orderId = orderId;
    job.errorMessage = errorMessage;
    if (["submitted", "filled", "protection_pending", "protected"].includes(submittedStatus)) job.submittedAt ??= submittedAt;
    if (["filled", "protection_pending", "protected"].includes(filledStatus)) job.filledAt ??= filledAt;
    if (cancelledStatus === "cancelled") job.cancelledAt = cancelledAt;
    job.leaseToken = null;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.leaseAction = null;
    job.leasePreviousStatus = null;
    job.updatedAt = updatedAt;
    return { meta: { changes: 1 } };
  }

  private executeIntentUpdate() {
    const [_now, jobId, reportId, reportJobId, reportAttempt] = this.values as [number, number, string, number, number];
    const job = this.database.jobs.get(jobId);
    const report = this.database.reports.get(reportId);
    if (!job || !report || report.executionJobId !== reportJobId || report.leaseAttempt !== reportAttempt
      || !this.database.intents.has(job.tradeIntentId)) return { meta: { changes: 0 } };
    const statuses = [...this.database.jobs.values()]
      .filter((candidate) => candidate.tradeIntentId === job.tradeIntentId)
      .map((candidate) => candidate.status);
    const next = statuses.includes("failed") ? "failed"
      : statuses.includes("protection_pending") ? "protection_pending"
        : statuses.every((status) => status === "protected") ? "protected"
          : statuses.includes("filled") ? "filled"
            : statuses.includes("submitted") ? "submitted"
              : statuses.every((status) => status === "cancelled") ? "cancelled"
                : this.database.intents.get(job.tradeIntentId)!;
    this.database.intents.set(job.tradeIntentId, next);
    return { meta: { changes: 1 } };
  }
}

function newJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 7,
    tradeIntentId: 3,
    provider: "cex",
    riskApproved: 1,
    status: "queued",
    idempotencyKey: "stable-user-intent-key",
    queuedAt: 10,
    leaseToken: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseAttempt: 0,
    leasePreviousStatus: null,
    leaseAction: "submit",
    orderId: null,
    errorMessage: null,
    submittedAt: null,
    filledAt: null,
    cancelledAt: null,
    updatedAt: 10,
    ...overrides,
  };
}

function reportInput(overrides: Partial<Parameters<typeof reportExecutionOutcome>[1]> = {}) {
  return {
    reportId: "report-7-attempt-1",
    jobId: 7,
    leaseToken: "lease-token-1",
    leaseAttempt: 1,
    status: "submitted" as const,
    now: 1_500,
    ...overrides,
  };
}

test("racing claimers yield exactly one owner for a queued job", async () => {
  const database = new FakeD1();
  database.jobs.set(7, newJob());

  const [first, second] = await Promise.all([
    claimExecutionJobs(database, { owner: "worker-a", action: "submit", now: 1_000, token: "token-a" }),
    claimExecutionJobs(database, { owner: "worker-b", action: "submit", now: 1_000, token: "token-b" }),
  ]);

  assert.equal(first.length + second.length, 1);
  assert.notEqual(first.length, second.length);
  assert.equal(database.job(7).status, "leased");
  assert.equal(database.job(7).leaseOwner, first[0]?.leaseOwner ?? second[0]?.leaseOwner);
});

test("stale lease reclaim increments the attempt but preserves job identity and idempotency data", async () => {
  const database = new FakeD1();
  database.jobs.set(7, newJob());

  const original = (await claimExecutionJobs(database, {
    owner: "worker-a", action: "submit", now: 1_000, leaseMs: 1_000, token: "token-a",
  }))[0];
  const reclaimed = (await claimExecutionJobs(database, {
    owner: "worker-b", action: "submit", now: 2_000, leaseMs: 1_000, token: "token-b",
  }))[0];

  assert.equal(original.id, reclaimed.id);
  assert.equal(database.job(7).idempotencyKey, "stable-user-intent-key");
  assert.equal(reclaimed.leaseAttempt, 2);
  assert.equal(database.job(7).leasePreviousStatus, "queued");
});

test("claiming stops at the configured maximum attempt count", async () => {
  const database = new FakeD1();
  database.jobs.set(7, newJob());

  const first = await claimExecutionJobs(database, { owner: "worker-a", action: "submit", now: 0, leaseMs: 1_000, maxAttempts: 2, token: "token-1" });
  const second = await claimExecutionJobs(database, { owner: "worker-b", action: "submit", now: 1_000, leaseMs: 1_000, maxAttempts: 2, token: "token-2" });
  const third = await claimExecutionJobs(database, { owner: "worker-c", action: "submit", now: 2_000, leaseMs: 1_000, maxAttempts: 2, token: "token-3" });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(third.length, 0);
  assert.equal(database.job(7).leaseAttempt, 2);
});

test("a report with a mismatched lease token is rejected without changing the job", async () => {
  const database = new FakeD1();
  database.jobs.set(7, newJob());
  await claimExecutionJobs(database, { owner: "worker-a", action: "submit", now: 1_000, token: "correct-token" });

  await assert.rejects(
    reportExecutionOutcome(database, reportInput({ leaseToken: "wrong-token" })),
    (error: unknown) => error instanceof LeaseConflictError && /stale or inactive/.test(error.message),
  );
  assert.equal(database.job(7).status, "leased");
  assert.equal(database.reports.size, 0);
});

test("an expired lease cannot submit an execution report", async () => {
  const database = new FakeD1();
  database.jobs.set(7, newJob());
  await claimExecutionJobs(database, { owner: "worker-a", action: "submit", now: 1_000, leaseMs: 1_000, token: "lease-token-1" });

  await assert.rejects(
    reportExecutionOutcome(database, reportInput({ now: 2_000 })),
    (error: unknown) => error instanceof LeaseConflictError && /stale or inactive/.test(error.message),
  );
  assert.equal(database.job(7).status, "leased");
  assert.equal(database.reports.size, 0);
});

test("concurrent duplicate reports are applied once and then idempotent", async () => {
  const database = new FakeD1();
  database.jobs.set(7, newJob());
  await claimExecutionJobs(database, { owner: "worker-a", action: "submit", now: 1_000, token: "lease-token-1" });

  const [first, second] = await Promise.all([
    reportExecutionOutcome(database, reportInput({ orderId: "order-7" })),
    reportExecutionOutcome(database, reportInput({ orderId: "order-7" })),
  ]);

  assert.deepEqual([first.status, second.status].sort(), ["applied", "idempotent"]);
  assert.equal(database.reports.size, 1);
  assert.equal(database.job(7).orderId, "order-7");
});

test("a filled report advances the job and clears its lease", async () => {
  const database = new FakeD1();
  database.jobs.set(7, newJob());
  database.intents.set(3, "created");
  await claimExecutionJobs(database, { owner: "worker-a", action: "submit", now: 1_000, token: "lease-token-1" });

  const result = await reportExecutionOutcome(database, reportInput({
    status: "filled", orderId: "order-7", now: 1_500,
  }));

  assert.deepEqual(result, { status: "applied", jobId: 7 });
  assert.equal(database.job(7).status, "filled");
  assert.equal(database.job(7).leaseToken, null);
  assert.equal(database.job(7).submittedAt, 1_500);
  assert.equal(database.job(7).filledAt, 1_500);
  assert.equal(database.reports.get("report-7-attempt-1")?.status, "filled");
  assert.equal(database.intents.get(3), "filled");
});
