import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  WorkerMetricsCollector,
  createMetricsEndpoint,
  createWorkerMetricsMiddleware,
} from "./workerMetrics";

test("metrics collector records bounded HTTP totals and duration without arbitrary route labels", () => {
  const metrics = new WorkerMetricsCollector({ knownRoutes: ["/api/health"] });
  metrics.observeHttpRequest({ method: "get", route: "/api/health", status: 200, durationMs: 125 });
  metrics.observeHttpRequest({ method: "POST", route: "/api/users/alice", status: 500, durationMs: 5 });

  const output = metrics.render();
  assert.match(output, /worker_http_requests_total\{method="GET",route="\/api\/health",status="200"\} 1/);
  assert.match(output, /worker_http_request_duration_seconds_count\{method="GET",route="\/api\/health",status="200"\} 1/);
  assert.match(output, /route="other"/);
  assert.doesNotMatch(output, /alice/);
});

test("metrics rendering escapes configured label values", () => {
  const metrics = new WorkerMetricsCollector({ knownRoutes: ["/api/quote\"line\nnext"] });
  metrics.observeHttpRequest({ method: "GET", route: "/api/quote\"line\nnext", status: 204, durationMs: 1 });

  assert.match(metrics.render(), /route="\/api\/quote\\\"line\\nnext"/);
});

test("metrics record denials, execution outcomes, cron cycles, and last successful timestamps", () => {
  const metrics = new WorkerMetricsCollector();
  metrics.recordRateLimitDenial("limited");
  metrics.recordCsrfDenial("origin");
  metrics.recordSecretDenial("internal", "invalid");
  metrics.recordExecutionReport("success");
  metrics.recordExecutionFailure("exchange_timeout");
  metrics.recordCronCycle("native", { success: false, timestampMs: 10_000 });
  metrics.recordCronCycle("native", { success: true, timestampMs: 12_345 });

  const output = metrics.render();
  assert.match(output, /worker_rate_limit_denials_total\{reason="limited"\} 1/);
  assert.match(output, /worker_csrf_denials_total\{reason="origin"\} 1/);
  assert.match(output, /worker_secret_denials_total\{route="internal",reason="invalid"\} 1/);
  assert.match(output, /worker_execution_reports_total\{status="success"\} 1/);
  assert.match(output, /worker_execution_failures_total\{reason="exchange_timeout"\} 1/);
  assert.match(output, /worker_cron_cycles_total\{job="native",outcome="failure"\} 1/);
  assert.match(output, /worker_cron_cycles_total\{job="native",outcome="success"\} 1/);
  assert.match(output, /worker_cron_last_success_timestamp_seconds\{job="native"\} 12\.345/);
});

test("metrics middleware measures completed and failed Hono requests", async () => {
  const metrics = new WorkerMetricsCollector({ knownRoutes: ["/api/health"] });
  const app = new Hono();
  app.use("/*", createWorkerMetricsMiddleware(metrics, () => 100));
  app.get("/api/health", (c) => c.text("ok"));
  const response = await app.request("https://worker.example/api/health");

  assert.equal(response.status, 200);
  assert.match(metrics.render(), /worker_http_requests_total\{method="GET",route="\/api\/health",status="200"\} 1/);
});

test("metrics endpoint authorizes bearer and token headers", async () => {
  const metrics = new WorkerMetricsCollector();
  metrics.recordExecutionReport("success");
  const app = new Hono();
  app.get("/metrics", createMetricsEndpoint(metrics, { token: "metrics-secret" }));

  const denied = await app.request("https://worker.example/metrics", {
    headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(denied.status, 401);

  const bearer = await app.request("https://worker.example/metrics", {
    headers: { Authorization: "Bearer metrics-secret" },
  });
  assert.equal(bearer.status, 200);
  assert.match(await bearer.text(), /worker_execution_reports_total/);

  const token = await app.request("https://worker.example/metrics", {
    headers: { "X-Metrics-Token": "metrics-secret" },
  });
  assert.equal(token.status, 200);
});

