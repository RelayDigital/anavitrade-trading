import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_MAX_AGE_SECONDS,
  getSessionCookieOptions,
} from "../_core/cookies";

const baseEnv = {
  DB: {},
  JWT_SECRET: "test-secret-that-is-long-enough",
  ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough",
  VITE_APP_ID: "test-app",
};

test("production session cookies are host-scoped, secure, and use seconds", () => {
  const options = getSessionCookieOptions({ ...baseEnv, APP_ENVIRONMENT: "production" } as any);

  assert.equal(SESSION_MAX_AGE_SECONDS, 8 * 60 * 60);
  assert.deepEqual(options, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  assert.equal("domain" in options, false);
});

test("only explicit development and testnet may issue insecure local cookies", () => {
  assert.equal(
    getSessionCookieOptions({ ...baseEnv, APP_ENVIRONMENT: "development" } as any).secure,
    false,
  );
  assert.equal(
    getSessionCookieOptions({ ...baseEnv, APP_ENVIRONMENT: "testnet" } as any).secure,
    false,
  );
  assert.equal(
    getSessionCookieOptions({ ...baseEnv, APP_ENVIRONMENT: "testnet", APP_BASE_URL: "https://app.example.com" } as any).secure,
    true,
  );
  assert.equal(getSessionCookieOptions(baseEnv as any).secure, true);
  assert.equal(
    getSessionCookieOptions({ ...baseEnv, APP_ENVIRONMENT: "development" } as any).sameSite,
    "lax",
  );
});
