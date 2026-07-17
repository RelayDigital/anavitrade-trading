import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  classifyWorkerRoute,
  createWorkerSecurityMiddleware,
  isExactOriginAllowed,
  parseConfiguredOrigins,
} from "./workerMiddleware";

test("malformed configured origins are ignored without crashing exact-origin CORS", () => {
  const allowed = parseConfiguredOrigins("https://app.example.com,not a URL,https://other.example");

  assert.equal(allowed.has("https://app.example.com"), true);
  assert.equal(allowed.has("https://other.example"), true);
  assert.equal(isExactOriginAllowed("https://app.example.com", allowed), true);
  assert.equal(isExactOriginAllowed("https://app.example.com.evil.test", allowed), false);
  assert.equal(isExactOriginAllowed("https://app.example.com/path", allowed), false);
  assert.equal(isExactOriginAllowed("%%%", allowed), false);
});

test("security middleware emits exact-origin CORS and baseline security headers", async () => {
  const app = new Hono();
  app.use("/*", createWorkerSecurityMiddleware({
    allowedOrigins: "https://app.example.com",
    production: false,
  }));
  app.get("/api/health", (c) => c.text("ok"));

  const response = await app.request("https://worker.example/api/health", {
    headers: { Origin: "https://app.example.com" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.com");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
});

test("valid CORS preflight responses preserve the negotiated headers", async () => {
  const app = new Hono();
  app.use("/*", createWorkerSecurityMiddleware({
    allowedOrigins: "https://app.example.com",
    production: false,
  }));

  const response = await app.request("https://worker.example/api/mutate", {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.example.com",
      "Access-Control-Request-Method": "POST",
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://app.example.com");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.match(response.headers.get("Access-Control-Allow-Headers") ?? "", /X-Internal-Secret/i);
});

test("browser mutation requests fail closed on origin, JSON, and client marker", async () => {
  const app = new Hono();
  app.use("/*", createWorkerSecurityMiddleware({
    allowedOrigins: "https://app.example.com",
    production: false,
  }));
  app.post("/api/mutate", (c) => c.text("mutated"));

  const badOrigin = await app.request("https://worker.example/api/mutate", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/json",
      "X-Client": "web",
    },
  });
  assert.equal(badOrigin.status, 403);
  assert.equal((await badOrigin.json()).code, "csrf_origin");

  const badContentType = await app.request("https://worker.example/api/mutate", {
    method: "POST",
    headers: { Origin: "https://app.example.com", "X-Client": "web" },
  });
  assert.equal(badContentType.status, 403);
  assert.equal((await badContentType.json()).code, "csrf_content_type");

  const badClient = await app.request("https://worker.example/api/mutate", {
    method: "POST",
    headers: {
      Origin: "https://app.example.com",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  assert.equal(badClient.status, 403);
  assert.equal((await badClient.json()).code, "csrf_client_header");
});

test("internal and admin routes use secret auth instead of browser CSRF", async () => {
  const app = new Hono();
  app.use("/*", createWorkerSecurityMiddleware({
    allowedOrigins: "https://app.example.com",
    production: true,
    rateLimitBinding: { limit: async () => ({ success: true }) },
    machineSecrets: { internal: "internal-secret", admin: "admin-secret" },
    adminRoutePrefixes: ["/api/ops/"],
  }));
  app.post("/api/internal/report", (c) => c.text("reported"));
  app.post("/api/ops/rebuild", (c) => c.text("rebuilt"));

  assert.equal(classifyWorkerRoute("/api/internal/report"), "internal");
  assert.equal(classifyWorkerRoute("/api/admin/rebuild"), "admin");

  const internal = await app.request("https://worker.example/api/internal/report", {
    method: "POST",
    headers: { Authorization: "Bearer internal-secret" },
  });
  assert.equal(internal.status, 200);

  const admin = await app.request("https://worker.example/api/ops/rebuild", {
    method: "POST",
    headers: { "X-Admin-Api-Key": "admin-secret" },
  });
  assert.equal(admin.status, 200);

  const invalid = await app.request("https://worker.example/api/internal/report", {
    method: "POST",
    headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).code, "secret_invalid");
});

test("machine routes accept only their route-specific token header", async () => {
  const app = new Hono();
  app.use("/*", createWorkerSecurityMiddleware({
    allowedOrigins: "https://app.example.com",
    production: false,
    machineSecrets: { internal: "internal-secret", admin: "admin-secret" },
  }));
  app.post("/api/internal/report", (c) => c.text("reported"));
  app.post("/api/admin/rebuild", (c) => c.text("rebuilt"));

  const internal = await app.request("https://worker.example/api/internal/report", {
    method: "POST",
    headers: { "X-Internal-Secret": "internal-secret" },
  });
  assert.equal(internal.status, 200);

  const internalWithAdminHeader = await app.request("https://worker.example/api/internal/report", {
    method: "POST",
    headers: { "X-Admin-Api-Key": "internal-secret" },
  });
  assert.equal(internalWithAdminHeader.status, 401);

  const admin = await app.request("https://worker.example/api/admin/rebuild", {
    method: "POST",
    headers: { "X-Admin-Api-Key": "admin-secret" },
  });
  assert.equal(admin.status, 200);

  const adminWithInternalHeader = await app.request("https://worker.example/api/admin/rebuild", {
    method: "POST",
    headers: { "X-Internal-Secret": "admin-secret" },
  });
  assert.equal(adminWithInternalHeader.status, 401);
});

test("machine routes fail closed when internal and admin secrets are reused", async () => {
  const app = new Hono();
  app.use("/*", createWorkerSecurityMiddleware({
    allowedOrigins: "https://app.example.com",
    production: false,
    machineSecrets: { internal: "shared-secret", admin: "shared-secret" },
  }));
  app.post("/api/internal/report", (c) => c.text("reported"));

  const response = await app.request("https://worker.example/api/internal/report", {
    method: "POST",
    headers: { "X-Internal-Secret": "shared-secret" },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "machine_secrets_not_distinct");
});

test("production rate limiting deterministically returns 503 when unconfigured and 429 when limited", async () => {
  const unconfigured = new Hono();
  unconfigured.use("/*", createWorkerSecurityMiddleware({
    allowedOrigins: "https://app.example.com",
    production: true,
  }));
  unconfigured.get("/api/health", (c) => c.text("ok"));
  const unavailable = await unconfigured.request("https://worker.example/api/health");
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, "rate_limit_unconfigured");

  const limited = new Hono();
  limited.use("/*", createWorkerSecurityMiddleware({
    allowedOrigins: "https://app.example.com",
    production: true,
    rateLimitBinding: { limit: async () => ({ success: false }) },
  }));
  limited.get("/api/health", (c) => c.text("ok"));
  const tooMany = await limited.request("https://worker.example/api/health");
  assert.equal(tooMany.status, 429);
  assert.equal((await tooMany.json()).code, "rate_limited");
});
