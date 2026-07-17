import assert from "node:assert/strict";
import test from "node:test";

import type { Env } from "../_core/env";
import { getCanonicalAppOrigin } from "./origin";

const baseEnv = {
  DB: {},
  JWT_SECRET: "test-secret-that-is-long-enough",
  ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough",
  VITE_APP_ID: "test-app",
};

test("only explicit development or testnet permits an HTTP canonical auth origin", () => {
  assert.equal(
    getCanonicalAppOrigin({ ...baseEnv, APP_ENVIRONMENT: "development", APP_BASE_URL: "http://localhost:5173" } as Env),
    "http://localhost:5173",
  );
  assert.equal(
    getCanonicalAppOrigin({ ...baseEnv, APP_ENVIRONMENT: "testnet", APP_BASE_URL: "http://localhost:5173" } as any),
    "http://localhost:5173",
  );

  for (const APP_ENVIRONMENT of [undefined, "staging", "production", "unexpected"]) {
    assert.throws(
      () => getCanonicalAppOrigin({ ...baseEnv, APP_ENVIRONMENT, APP_BASE_URL: "http://app.example.com" } as any),
      /APP_BASE_URL/,
    );
  }
});

test("auth origin policy does not depend on ASTER_ENVIRONMENT", () => {
  assert.equal(
    getCanonicalAppOrigin({
      ...baseEnv,
      APP_ENVIRONMENT: "development",
      APP_BASE_URL: "http://localhost:5173",
      ASTER_ENVIRONMENT: "production",
    } as Env),
    "http://localhost:5173",
  );
});
