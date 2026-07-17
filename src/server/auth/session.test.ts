import assert from "node:assert/strict";
import test from "node:test";

import { setEnv } from "../_core/env";
import { getSessionTokenFromRequest, signSession, verifySession } from "../sdk";

function setTestEnv() {
  setEnv({
    DB: {},
    JWT_SECRET: "test-secret-that-is-long-enough",
    ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough",
    VITE_APP_ID: "test-app",
  });
}

test("session extraction accepts the HttpOnly cookie and ignores bearer credentials", () => {
  const cookieRequest = new Request("https://app.example.com", {
    headers: { cookie: "app_session=cookie-token" },
  });
  const bearerRequest = new Request("https://app.example.com", {
    headers: { authorization: "Bearer storage-token" },
  });

  assert.equal(getSessionTokenFromRequest(cookieRequest, "app_session"), "cookie-token");
  assert.equal(getSessionTokenFromRequest(bearerRequest, "app_session"), undefined);
});

test("a valid JWT is rejected when its server-side session is missing, revoked, or expired", async () => {
  setTestEnv();
  const token = await signSession({
    openId: "local:7",
    appId: "test-app",
    name: "Test User",
  }, { sessionId: "session-identifier" });
  const future = new Date(Date.now() + 60_000);

  assert.equal(await (verifySession as any)(token, async () => null), null);
  assert.equal(await (verifySession as any)(token, async () => ({ expiresAt: future, revokedAt: new Date() })), null);
  assert.equal(await (verifySession as any)(token, async () => ({ expiresAt: new Date(Date.now() - 1), revokedAt: null })), null);
  assert.deepEqual(
    await (verifySession as any)(token, async () => ({ expiresAt: future, revokedAt: null })),
    { openId: "local:7", appId: "test-app", name: "Test User" },
  );
});
