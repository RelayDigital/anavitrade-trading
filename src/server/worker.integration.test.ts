import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker";
import type { Env } from "./_core/env";

type D1Database = Env["DB"];

type Query = { sql: string; values: unknown[] };

function createDatabase(options: {
  schemaReady?: boolean;
  claimedJobs?: Record<string, unknown>[];
  enrichedJobs?: Record<string, unknown>[];
  reportConflict?: boolean;
} = {}) {
  const queries: Query[] = [];
  const database = {
    prepare(sql: string) {
      const query: Query = { sql, values: [] };
      queries.push(query);
      return {
        bind(...values: unknown[]) {
          query.values = values;
          return this;
        },
        async first() {
          if (sql.includes("sqlite_master")) return options.schemaReady === false ? null : { ok: 1 };
          if (sql.includes("execution_reports")) return null;
          return null;
        },
        async all() {
          if (sql.includes("INNER JOIN cex_connections")) return { results: options.enrichedJobs ?? [] };
          return { results: [] };
        },
      };
    },
    async batch(statements: Array<{ sql?: string }>) {
      const isReport = statements.some((statement) => statement.sql?.includes("INSERT INTO execution_reports"));
      if (isReport || options.reportConflict) return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }, { meta: { changes: 0 } }];
      return [
        { meta: { changes: 1 } },
        { results: options.claimedJobs ?? [] },
      ];
    },
  };
  return { database, queries };
}

function env(overrides: Partial<Env> = {}): Env {
  const { database } = createDatabase();
  return {
    DB: database as unknown as D1Database,
    JWT_SECRET: "test-jwt",
    ENCRYPTION_KEY: "test-encryption-key",
    VITE_APP_ID: "test",
    APP_ENVIRONMENT: "development",
    CORS_ALLOWED_ORIGINS: "https://app.example.test",
    INTERNAL_SECRET: "internal-secret",
    ADMIN_API_KEY: "admin-secret",
    METRICS_TOKEN: "metrics-secret",
    ...overrides,
  };
}

async function request(path: string, init: RequestInit = {}, bindings = env()) {
  return worker.fetch(new Request(`https://worker.example.test${path}`, init), bindings, {} as ExecutionContext);
}

test("Worker health is readiness-checked while liveness stays lightweight", async () => {
  const ready = await request("/api/health");
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).status, "ok");

  const { database } = createDatabase({ schemaReady: false });
  const unavailable = await request("/api/health", {}, env({ DB: database as unknown as D1Database }));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { status: "unavailable" });

  const live = await request("/api/live", {}, env({
    APP_ENVIRONMENT: "production",
    RATE_LIMITER: { limit: async () => ({ success: true }) },
  }));
  assert.equal(live.status, 200);
});

test("Worker applies exact-origin browser mutation protections and production rate-limit fail-closed behavior", async () => {
  const denied = await request("/api/health", {
    method: "POST",
    headers: { Origin: "https://evil.example.test", "Content-Type": "application/json", "X-Client": "web" },
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "csrf_origin");

  const production = await request("/api/live", {}, env({ APP_ENVIRONMENT: "production", RATE_LIMITER: undefined }));
  assert.equal(production.status, 503);
  assert.equal((await production.json()).code, "rate_limit_unconfigured");
});

test("Worker exposes token-protected metrics from actual request middleware", async () => {
  const response = await request("/metrics", { headers: { "X-Metrics-Token": "metrics-secret" } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /worker_http_requests_total/);
});

test("Worker requires the internal secret and returns only the current fields for jobs leased by this call", async () => {
  const claimedJobs = [{ id: 7, leaseToken: "lease-token", leaseOwner: "vps-a", leaseExpiresAt: 123, leaseAttempt: 2, leaseAction: "reconcile" }];
  const enrichedJobs = [{
    jobId: 7, leaseToken: "lease-token", leaseAttempt: 2, leaseExpiresAt: 123,
    leaseAction: "reconcile", orderId: "order-7", symbol: "BTCUSDT", connExchange: "binance",
  }];
  const { database, queries } = createDatabase({ claimedJobs, enrichedJobs });
  const bindings = env({ DB: database as unknown as D1Database, EXECUTION_LEASE_OWNER: "vps-a" });

  const denied = await request("/api/internal/risk-approved-jobs", {}, bindings);
  assert.equal(denied.status, 401);

  const adminHeaderDenied = await request("/api/internal/risk-approved-jobs", {
    headers: { "X-Admin-Api-Key": "internal-secret" },
  }, bindings);
  assert.equal(adminHeaderDenied.status, 401);

  const response = await request("/api/internal/risk-approved-jobs?action=reconcile", {
    headers: { "X-Internal-Secret": "internal-secret" },
  }, bindings);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).jobs, enrichedJobs);
  assert.equal(queries.some((query) => query.sql.includes("UPDATE execution_jobs") && query.values.includes("reconcile")), true);
});

test("Worker validates execution reports and maps stale leases to a redacted conflict", async () => {
  const invalid = await request("/api/internal/report-execution", {
    method: "POST",
    headers: { "X-Internal-Secret": "internal-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: 7 }),
  });
  assert.equal(invalid.status, 400);

  const malformed = await request("/api/internal/report-execution", {
    method: "POST",
    headers: { "X-Internal-Secret": "internal-secret", "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);

  const { database } = createDatabase({ reportConflict: true });
  const conflict = await request("/api/internal/report-execution", {
    method: "POST",
    headers: { "X-Internal-Secret": "internal-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ reportId: "report-7", jobId: 7, leaseToken: "lease-token", leaseAttempt: 1, status: "submitted", orderId: "order-7" }),
  }, env({ DB: database as unknown as D1Database }));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { status: "error", code: "execution_lease_conflict" });
});

test("Worker requires status-specific execution evidence", async () => {
  for (const body of [
    { reportId: "filled", jobId: 7, leaseToken: "lease", leaseAttempt: 1, status: "filled" },
    { reportId: "failed", jobId: 7, leaseToken: "lease", leaseAttempt: 1, status: "failed" },
    { reportId: "protected", jobId: 7, leaseToken: "lease", leaseAttempt: 1, status: "protected", orderId: "entry" },
  ]) {
    const response = await request("/api/internal/report-execution", {
      method: "POST",
      headers: { "X-Internal-Secret": "internal-secret", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
});
