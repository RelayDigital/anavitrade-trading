import type { Handler, MiddlewareHandler } from "hono";
import { timingSafeSecretEqual } from "../security/requestSecurity";

type CounterLabels = Record<string, string>;

export type WorkerMetricsOptions = {
  knownRoutes?: readonly string[];
  knownCronJobs?: readonly string[];
};

export type HttpRequestObservation = {
  method: string;
  route: string;
  status: number;
  durationMs: number;
};

const MAX_LABEL_VALUES = 64;
const DEFAULT_CRON_JOBS = ["native", "scraper", "mirror", "demo", "fee", "outcome", "analysis", "analysis_outcome"] as const;
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const EXECUTION_STATUSES = new Set(["success", "failure", "rejected", "unknown"]);
const FAILURE_REASONS = new Set(["exchange_timeout", "exchange_error", "validation", "unknown"]);
const DENIAL_REASONS = new Set(["limited", "unconfigured", "error", "origin", "content_type", "client_header", "missing", "invalid"]);

function boundedValues(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).slice(0, MAX_LABEL_VALUES));
}

function bounded(value: string, allowed: ReadonlySet<string>): string {
  return allowed.has(value) ? value : "other";
}

function labelsKey(labels: CounterLabels): string {
  return Object.entries(labels).map(([name, value]) => `${name}=${value}`).join("\u0000");
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}

function renderLabels(labels: CounterLabels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

function statusLabel(status: number): string {
  const normalized = Math.trunc(status);
  return normalized >= 100 && normalized <= 599 ? String(normalized) : "other";
}

export class WorkerMetricsCollector {
  private readonly routes: Set<string>;
  private readonly cronJobs: Set<string>;
  private readonly counters = new Map<string, { name: string; labels: CounterLabels; value: number }>();
  private readonly httpDuration = new Map<string, {
    labels: CounterLabels;
    count: number;
    sum: number;
    buckets: number[];
  }>();
  private readonly cronLastSuccess = new Map<string, number>();

  constructor(options: WorkerMetricsOptions = {}) {
    this.routes = boundedValues(options.knownRoutes);
    this.cronJobs = boundedValues(options.knownCronJobs ?? DEFAULT_CRON_JOBS);
  }

  private increment(name: string, labels: CounterLabels, amount = 1): void {
    const key = `${name}\u0001${labelsKey(labels)}`;
    const current = this.counters.get(key);
    if (current) current.value += amount;
    else this.counters.set(key, { name, labels, value: amount });
  }

  observeHttpRequest(observation: HttpRequestObservation): void {
    const labels = {
      method: bounded(observation.method.toUpperCase(), METHODS),
      route: bounded(observation.route, this.routes),
      status: statusLabel(observation.status),
    };
    this.increment("worker_http_requests_total", labels);
    const key = labelsKey(labels);
    const durationSeconds = Math.max(0, observation.durationMs) / 1000;
    const current = this.httpDuration.get(key) ?? { labels, count: 0, sum: 0, buckets: DURATION_BUCKETS.map(() => 0) };
    current.count += 1;
    current.sum += durationSeconds;
    for (let index = 0; index < DURATION_BUCKETS.length; index += 1) {
      if (durationSeconds <= DURATION_BUCKETS[index]) current.buckets[index] += 1;
    }
    this.httpDuration.set(key, current);
  }

  recordHttpRequest(observation: HttpRequestObservation): void {
    this.observeHttpRequest(observation);
  }

  recordRateLimitDenial(reason: string): void {
    this.increment("worker_rate_limit_denials_total", { reason: bounded(reason, new Set(["limited", "unconfigured", "error"])) });
  }

  recordCsrfDenial(reason: string): void {
    this.increment("worker_csrf_denials_total", { reason: bounded(reason, new Set(["origin", "content_type", "client_header"])) });
  }

  recordSecretDenial(route: string, reason: string): void {
    this.increment("worker_secret_denials_total", {
      route: bounded(route, new Set(["internal", "admin"])),
      reason: bounded(reason, new Set(["missing", "invalid", "unconfigured"])),
    });
  }

  recordExecutionReport(status: string): void {
    this.increment("worker_execution_reports_total", { status: bounded(status, EXECUTION_STATUSES) });
  }

  recordExecutionFailure(reason: string): void {
    this.increment("worker_execution_failures_total", { reason: bounded(reason, FAILURE_REASONS) });
  }

  recordCronCycle(job: string, input: { success: boolean; timestampMs?: number }): void {
    const boundedJob = bounded(job, this.cronJobs);
    this.increment("worker_cron_cycles_total", { job: boundedJob, outcome: input.success ? "success" : "failure" });
    if (input.success) {
      const timestampMs = input.timestampMs ?? Date.now();
      const previous = this.cronLastSuccess.get(boundedJob) ?? 0;
      this.cronLastSuccess.set(boundedJob, Math.max(previous, timestampMs));
    }
  }

  render(): string {
    const lines = [
      "# HELP worker_http_requests_total Total HTTP requests observed by this Worker isolate.",
      "# TYPE worker_http_requests_total counter",
    ];
    for (const metric of this.counters.values()) {
      if (metric.name === "worker_http_requests_total") lines.push(`${metric.name}${renderLabels(metric.labels)} ${metric.value}`);
    }
    lines.push(
      "# HELP worker_http_request_duration_seconds HTTP request duration observed by this Worker isolate.",
      "# TYPE worker_http_request_duration_seconds histogram",
    );
    for (const duration of this.httpDuration.values()) {
      for (let index = 0; index < DURATION_BUCKETS.length; index += 1) {
        lines.push(`worker_http_request_duration_seconds_bucket${renderLabels({ ...duration.labels, le: String(DURATION_BUCKETS[index]) })} ${duration.buckets[index]}`);
      }
      lines.push(`worker_http_request_duration_seconds_bucket${renderLabels({ ...duration.labels, le: "+Inf" })} ${duration.count}`);
      lines.push(`worker_http_request_duration_seconds_sum${renderLabels(duration.labels)} ${duration.sum}`);
      lines.push(`worker_http_request_duration_seconds_count${renderLabels(duration.labels)} ${duration.count}`);
    }
    const otherCounters = [
      ["worker_rate_limit_denials_total", "Worker requests denied by the rate limiter."],
      ["worker_csrf_denials_total", "Browser mutation requests denied by CSRF checks."],
      ["worker_secret_denials_total", "Machine requests denied by secret authentication."],
      ["worker_execution_reports_total", "Execution reports explicitly recorded by the Worker."],
      ["worker_execution_failures_total", "Execution failures explicitly recorded by the Worker."],
      ["worker_cron_cycles_total", "Cron cycles explicitly recorded by the Worker."],
    ] as const;
    for (const [name, help] of otherCounters) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      for (const metric of this.counters.values()) {
        if (metric.name === name) lines.push(`${metric.name}${renderLabels(metric.labels)} ${metric.value}`);
      }
    }
    lines.push(
      "# HELP worker_cron_last_success_timestamp_seconds Unix timestamp of the last explicitly recorded successful cron cycle.",
      "# TYPE worker_cron_last_success_timestamp_seconds gauge",
    );
    for (const [job, timestampMs] of this.cronLastSuccess) {
      lines.push(`worker_cron_last_success_timestamp_seconds${renderLabels({ job })} ${timestampMs / 1000}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

export function createWorkerMetricsMiddleware(
  metrics: WorkerMetricsCollector,
  now: () => number = () => Date.now(),
): MiddlewareHandler {
  return async (context, next) => {
    const started = now();
    try {
      await next();
    } catch (error) {
      metrics.observeHttpRequest({
        method: context.req.method,
        route: context.req.routePath || context.req.path,
        status: 500,
        durationMs: now() - started,
      });
      throw error;
    }
    metrics.observeHttpRequest({
      method: context.req.method,
      route: context.req.routePath || context.req.path,
      status: context.res.status,
      durationMs: now() - started,
    });
  };
}

export type MetricsEndpointOptions = {
  token: string;
  tokenHeader?: string;
};

function extractBearer(authorization: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec((authorization ?? "").trim());
  return match?.[1];
}

export function createMetricsEndpoint(metrics: WorkerMetricsCollector, options: MetricsEndpointOptions): Handler {
  return async (context) => {
    if (!options.token) return context.text("metrics authorization is not configured\n", 503);
    const bearer = extractBearer(context.req.header("Authorization")) ?? "";
    const token = context.req.header(options.tokenHeader ?? "X-Metrics-Token") ?? "";
    const [bearerMatches, tokenMatches] = await Promise.all([
      timingSafeSecretEqual(bearer, options.token),
      timingSafeSecretEqual(token, options.token),
    ]);
    if (!bearerMatches && !tokenMatches) return context.text("Unauthorized\n", 401);
    context.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return context.text(metrics.render());
  };
}

export const createWorkerMetricsEndpoint = createMetricsEndpoint;

