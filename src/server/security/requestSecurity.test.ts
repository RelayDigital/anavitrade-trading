import assert from "node:assert/strict";
import test from "node:test";
import {
  enforceRateLimit,
  isAllowedOrigin,
  parseAllowedOrigins,
  timingSafeSecretEqual,
  validateMutationRequest,
} from "./requestSecurity";

test("timingSafeSecretEqual compares exact values", async () => {
  assert.equal(await timingSafeSecretEqual("same-secret", "same-secret"), true);
  assert.equal(await timingSafeSecretEqual("same-secret", "other-secret"), false);
  assert.equal(await timingSafeSecretEqual("", "other-secret"), false);
});

test("origin matching is exact and rejects near matches", () => {
  const allowed = parseAllowedOrigins("https://app.example.com,http://localhost:5174");
  assert.equal(isAllowedOrigin("https://app.example.com", allowed), true);
  assert.equal(isAllowedOrigin("https://app.example.com.evil.test", allowed), false);
  assert.equal(isAllowedOrigin("https://app.example.com/path", allowed), false);
  assert.equal(isAllowedOrigin(undefined, allowed), false);
});

test("unsafe cookie-authenticated requests require origin, JSON, and client marker", () => {
  const allowedOrigins = parseAllowedOrigins("https://app.example.com");
  assert.deepEqual(validateMutationRequest({
    method: "POST",
    origin: "https://app.example.com",
    contentType: "application/json; charset=utf-8",
    clientHeader: "web",
    allowedOrigins,
  }), { ok: true });
  assert.deepEqual(validateMutationRequest({
    method: "POST",
    origin: "https://evil.test",
    contentType: "application/json",
    clientHeader: "web",
    allowedOrigins,
  }), { ok: false, reason: "origin" });
  assert.deepEqual(validateMutationRequest({
    method: "POST",
    origin: "https://app.example.com",
    contentType: "text/plain",
    clientHeader: "web",
    allowedOrigins,
  }), { ok: false, reason: "content_type" });
  assert.deepEqual(validateMutationRequest({
    method: "GET",
    allowedOrigins,
  }), { ok: true });
});

test("rate limiting fails closed in production and remains injectable", async () => {
  assert.deepEqual(await enforceRateLimit({ key: "ip:1", production: true }), {
    allowed: false,
    reason: "unconfigured",
  });
  assert.deepEqual(await enforceRateLimit({ key: "ip:1", production: false }), { allowed: true });
  assert.deepEqual(await enforceRateLimit({
    key: "ip:1",
    production: true,
    binding: { limit: async () => ({ success: false }) },
  }), { allowed: false, reason: "limited" });
});
