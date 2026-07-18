import assert from "node:assert/strict";
import test from "node:test";

import type { User } from "../src/drizzle/schema";
import type { TrpcContext } from "../src/server/context";
import type { Env } from "../src/server/_core/env";
import { RecordingAuthEmailSender } from "../src/server/auth/email";
import { createAuthRouter, type AuthRouterDependencies } from "../src/server/auth/router";

const user = {
  id: 7,
  openId: "local:7",
  name: "Test User",
  email: "user@example.com",
  passwordHash: "not-for-the-client",
  loginMethod: "email",
  role: "user",
  emailVerified: false,
  verificationToken: null,
  verificationTokenExpiresAt: null,
  resetToken: null,
  resetTokenExpiresAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  lastSignedIn: new Date("2026-01-01T00:00:00Z"),
} satisfies User;

function dependencies(): AuthRouterDependencies {
  const sender = new RecordingAuthEmailSender();
  return {
    registerUser: async () => ({ user, verificationToken: "verify-raw" }),
    verifyUserPassword: async () => user,
    verifyEmailToken: async () => user,
    resendVerificationEmail: async () => ({ user, verificationToken: "verify-raw" }),
    createPasswordResetToken: async () => null,
    resetPassword: async () => user,
    updateUserProfile: async () => undefined,
    updateUserPasswordHash: async () => undefined,
    hashPassword: async () => "hash",
    writeAuditLog: async () => undefined,
    signSessionToken: async () => "session",
    revokeSessionToken: async () => undefined,
    getEmailSender: () => sender,
  };
}

function context(environment: "development" | "production", appBaseUrl: string): TrpcContext {
  return {
    req: new Request(`${appBaseUrl}/api/trpc`),
    env: {
      DB: {},
      JWT_SECRET: "test-secret-that-is-long-enough",
      ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough",
      VITE_APP_ID: "test-app",
      APP_ENVIRONMENT: environment,
      APP_BASE_URL: appBaseUrl,
    } as Env,
    user: null,
    setHeader: () => undefined,
  };
}

test("development registration returns a local verification URL", async () => {
  const result = await createAuthRouter(dependencies())
    .createCaller(context("development", "http://127.0.0.1:5175"))
    .register({ name: "Test User", email: "user@example.com", password: "long-enough-password" });

  assert.equal(
    result.developmentVerificationUrl,
    "http://127.0.0.1:5175/verify-email?token=verify-raw&email=user%40example.com",
  );
});

test("production registration never returns a verification URL", async () => {
  const result = await createAuthRouter(dependencies())
    .createCaller(context("production", "https://app.example.com"))
    .register({ name: "Test User", email: "user@example.com", password: "long-enough-password" });

  assert.equal("developmentVerificationUrl" in result, false);
  assert.equal("verificationToken" in result, false);
});
