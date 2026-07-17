import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readOptional = (path) => {
  try {
    return read(path);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
};

const compose = read("docker-compose.yml");
const prometheus = read("prometheus.yml");
const wrangler = read("wrangler.toml");
const serverTsconfig = JSON.parse(read("src/server/tsconfig.json"));
const operations = readOptional("docs/ops/PRODUCTION_INFRASTRUCTURE.md");

function serviceBlock(name) {
  const match = compose.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|^volumes:)`, "m"));
  assert.ok(match, `missing Compose service: ${name}`);
  return match[0];
}

test("Redis is private and requires a Compose-provided password", () => {
  const redis = serviceBlock("redis");
  const execution = serviceBlock("execution");

  assert.doesNotMatch(redis, /^    ports:/m);
  assert.match(redis, /REDIS_PASSWORD:\s*["\']?\$\{REDIS_PASSWORD:\?[^}]+\}["\']?/);
  assert.match(redis, /--requirepass\s+"?\$\$REDIS_PASSWORD"?/);
  assert.match(redis, /redis-cli[^\n]+\$\$REDIS_PASSWORD[^\n]+ping/);
  assert.match(execution, /REDIS_URL:\s*["\']?redis:\/\/:\$\{REDIS_PASSWORD:\?[^}]+\}@redis:6379\/0["\']?/);
});

test("host-published operational ports bind to loopback by default", () => {
  const expected = {
    execution: /\$\{EXECUTION_HEALTH_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{EXECUTION_HEALTH_PORT:-9090\}:9090/,
    prometheus: /\$\{PROMETHEUS_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{PROMETHEUS_PORT:-9091\}:9090/,
    grafana: /\$\{GRAFANA_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{GRAFANA_PORT:-3000\}:3000/,
  };

  for (const [service, binding] of Object.entries(expected)) {
    assert.match(serviceBlock(service), binding, `${service} must default to 127.0.0.1`);
  }

  assert.doesNotMatch(serviceBlock("node-exporter"), /^    ports:/m);
  assert.doesNotMatch(compose, /^\s*-\s*["']?(?:0\.0\.0\.0:)?(?:6379|3000|9090|9091|9100):/m);
});

test("Prometheus explicitly scrapes the execution /metrics endpoint", () => {
  const executionJob = prometheus.match(/- job_name:\s*["']execution-server["'][\s\S]*?(?=\n\s*- job_name:|$)/)?.[0];
  assert.ok(executionJob, "missing execution-server scrape job");
  assert.match(executionJob, /^\s+metrics_path:\s*["']?\/metrics["']?\s*$/m);
  assert.match(executionJob, /targets:\s*\[["']execution:9090["']\]/);
});

test("Worker configuration opts into current compatibility and observability", () => {
  assert.match(wrangler, /^compatibility_date\s*=\s*"2026-07-17"$/m);
  assert.match(wrangler, /^\[observability\]$/m);
  assert.match(wrangler, /^enabled\s*=\s*true$/m);
  assert.match(wrangler, /^head_sampling_rate\s*=\s*0\.1$/m);
  assert.doesNotMatch(wrangler, /(?:secret|token|password|api_key)\s*=\s*"[^"$<][^"]+"/i);
});

test("server TypeScript config includes the Node execution server", () => {
  const excluded = serverTsconfig.exclude ?? [];
  const includedTypes = serverTsconfig.compilerOptions?.types ?? [];

  assert.ok(!excluded.includes("./execution/server.ts"));
  assert.ok(includedTypes.includes("node"), "Node runtime types are required by execution/server.ts");
  assert.ok(
    serverTsconfig.include.some((entry) => entry === "./**/*.ts" || entry.includes("execution/server.ts")),
    "execution/server.ts must be covered by include",
  );
});

test("operations runbook defines firewall, rotation, and deployment gates", () => {
  for (const required of [
    "Provider firewall",
    "Host firewall",
    "Redis credential rotation",
    "Grafana credential rotation",
    "wrangler types",
    "docker compose config",
    "Do not enable production execution",
  ]) {
    assert.match(operations, new RegExp(required, "i"), `missing operator guidance: ${required}`);
  }
});
