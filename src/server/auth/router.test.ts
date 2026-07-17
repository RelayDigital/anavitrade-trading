import assert from "node:assert/strict";
import test from "node:test";

import type { User } from "../../drizzle/schema";
import type { TrpcContext } from "../context";
import type { Env } from "../_core/env";
import { createAuthRouter, type AuthRouterDependencies } from "./router";
import { RecordingAuthEmailSender } from "./email";

const baseUser: User = {
  id: 7,
  openId: "local:7",
  name: "Test User",
  email: "user@example.com",
  passwordHash: "not-for-the-client",
  loginMethod: "email",
  role: "user",
  emailVerified: true,
  verificationToken: null,
  verificationTokenExpiresAt: null,
  resetToken: null,
  resetTokenExpiresAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  lastSignedIn: new Date("2026-01-01T00:00:00Z"),
};

function context(
  user: User | null = null,
  options: {
    requestUrl?: string;
    appBaseUrl?: string | null;
    environment?: "production" | "testnet" | "development";
    cookie?: string;
  } = {},
) {
  const headers = new Map<string, string>();
  const appBaseUrl = options.appBaseUrl === undefined ? "https://app.example.com" : options.appBaseUrl;
  const ctx: TrpcContext = {
    req: new Request(options.requestUrl ?? "https://app.example.com/api/trpc", {
      headers: options.cookie ? { cookie: options.cookie } : undefined,
    }),
    env: {
      DB: {},
      JWT_SECRET: "test-secret-that-is-long-enough",
      ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough",
      VITE_APP_ID: "test-app",
      ...(appBaseUrl === null ? {} : { APP_BASE_URL: appBaseUrl }),
      ...(options.environment === undefined ? {} : { APP_ENVIRONMENT: options.environment }),
    } as Env & { APP_BASE_URL?: string },
    user,
    setHeader: (name, value) => headers.set(name, value),
  };
  return { ctx, headers };
}

function dependencies(overrides: Partial<AuthRouterDependencies> = {}) {
  const sender = new RecordingAuthEmailSender();
  const deps: AuthRouterDependencies = {
    registerUser: async () => ({ user: { ...baseUser, emailVerified: false }, verificationToken: "verify-raw" }),
    verifyUserPassword: async () => baseUser,
    verifyEmailToken: async () => baseUser,
    resendVerificationEmail: async () => ({ user: baseUser, verificationToken: "verify-raw" }),
    createPasswordResetToken: async () => ({ user: baseUser, resetToken: "reset-raw" }),
    resetPassword: async () => baseUser,
    updateUserProfile: async () => undefined,
    updateUserPasswordHash: async () => undefined,
    hashPassword: async () => "new-password-hash",
    writeAuditLog: async () => undefined,
    signSessionToken: async () => "signed-session",
    revokeSessionToken: async () => undefined,
    getEmailSender: () => sender,
    ...overrides,
  };
  return { deps, sender };
}

test("auth.me returns only the safe explicit user DTO", async () => {
  const { deps } = dependencies();
  const caller = createAuthRouter(deps).createCaller(context(baseUser).ctx);

  const result = await caller.me();

  assert.equal(result?.id, baseUser.id);
  assert.equal("passwordHash" in (result ?? {}), false);
  assert.equal("verificationToken" in (result ?? {}), false);
  assert.equal("resetToken" in (result ?? {}), false);
});

test("registration returns a safe DTO, sends verification, and does not set a cookie", async () => {
  const { deps, sender } = dependencies();
  const { ctx, headers } = context();
  const caller = createAuthRouter(deps).createCaller(ctx);

  const result = await caller.register({
    name: "Test User",
    email: "user@example.com",
    password: "long-enough-password",
  });

  assert.equal(result.id, baseUser.id);
  assert.equal("passwordHash" in result, false);
  assert.equal("verificationToken" in result, false);
  assert.equal(headers.has("Set-Cookie"), false);
  assert.equal(sender.messages.length, 1);
});

test("login denies an unverified email without creating a session", async () => {
  let signed = false;
  const { deps } = dependencies({
    verifyUserPassword: async () => ({ ...baseUser, emailVerified: false }),
    signSessionToken: async () => {
      signed = true;
      return "signed-session";
    },
  });
  const { ctx, headers } = context();
  const caller = createAuthRouter(deps).createCaller(ctx);

  await assert.rejects(
    caller.login({ email: "user@example.com", password: "long-enough-password" }),
    (error: any) => error.code === "UNAUTHORIZED" && error.message === "Invalid email or password.",
  );
  assert.equal(signed, false);
  assert.equal(headers.has("Set-Cookie"), false);
});

test("login returns a safe DTO and sets a short-lived cookie in seconds", async () => {
  const { deps } = dependencies();
  const { ctx, headers } = context();
  const result = await createAuthRouter(deps).createCaller(ctx).login({
    email: "user@example.com",
    password: "long-enough-password",
  });

  assert.equal(result.id, baseUser.id);
  assert.equal("passwordHash" in result, false);
  assert.match(headers.get("Set-Cookie") ?? "", /Max-Age=28800/);
  assert.match(headers.get("Set-Cookie") ?? "", /HttpOnly/);
  assert.match(headers.get("Set-Cookie") ?? "", /Secure/);
  assert.match(headers.get("Set-Cookie") ?? "", /SameSite=None/);
});

test("logout revokes the current session before clearing its cookie", async () => {
  let revokedToken: string | undefined;
  const { deps } = dependencies();
  deps.revokeSessionToken = async (token) => {
    revokedToken = token;
  };
  const { ctx, headers } = context(null, { cookie: "anavitrade_session=current-session" });

  await createAuthRouter(deps).createCaller(ctx).logout();

  assert.equal(revokedToken, "current-session");
  assert.match(headers.get("Set-Cookie") ?? "", /Max-Age=0/);
});

test("forgot password always returns the same generic response", async () => {
  const existing = dependencies();
  const missing = dependencies({ createPasswordResetToken: async () => null });

  const existingResult = await createAuthRouter(existing.deps)
    .createCaller(context().ctx)
    .forgotPassword({ email: "user@example.com" });
  const missingResult = await createAuthRouter(missing.deps)
    .createCaller(context().ctx)
    .forgotPassword({ email: "missing@example.com" });

  assert.deepEqual(existingResult, { success: true });
  assert.deepEqual(missingResult, existingResult);
});

test("verification links use the configured canonical APP_BASE_URL instead of the request host", async () => {
  const { deps, sender } = dependencies();
  const { ctx } = context(null, {
    requestUrl: "https://attacker.example/api/trpc",
    appBaseUrl: "https://app.example.com",
  });

  await createAuthRouter(deps).createCaller(ctx).register({
    name: "Test User",
    email: "user@example.com",
    password: "long-enough-password",
  });

  assert.equal(sender.messages[0]?.kind, "verification");
  assert.equal(new URL(sender.messages[0]!.verificationUrl).origin, "https://app.example.com");
});

test("password-reset links use the configured canonical APP_BASE_URL instead of the request host", async () => {
  const { deps, sender } = dependencies();
  const { ctx } = context(null, {
    requestUrl: "https://attacker.example/api/trpc",
    appBaseUrl: "https://app.example.com",
  });

  await createAuthRouter(deps).createCaller(ctx).forgotPassword({ email: "user@example.com" });

  assert.equal(sender.messages[0]?.kind, "password-reset");
  assert.equal(new URL(sender.messages[0]!.resetUrl).origin, "https://app.example.com");
});

test("production email link generation fails closed without a valid APP_BASE_URL", async () => {
  const { deps } = dependencies();
  const { ctx } = context(null, { environment: "production", appBaseUrl: null });

  await assert.rejects(
    createAuthRouter(deps).createCaller(ctx).register({
      name: "Test User",
      email: "user@example.com",
      password: "long-enough-password",
    }),
    (error: any) => error.code === "INTERNAL_SERVER_ERROR",
  );
});

test("production email link generation rejects a non-canonical APP_BASE_URL", async () => {
  const { deps } = dependencies();
  const { ctx } = context(null, {
    environment: "production",
    appBaseUrl: "https://app.example.com/untrusted-path",
  });

  await assert.rejects(
    createAuthRouter(deps).createCaller(ctx).register({
      name: "Test User",
      email: "user@example.com",
      password: "long-enough-password",
    }),
    (error: any) => error.code === "INTERNAL_SERVER_ERROR",
  );
});

test("registration validates the production canonical origin before creating an account", async () => {
  let registrations = 0;
  const { deps } = dependencies({
    registerUser: async () => {
      registrations += 1;
      return { user: { ...baseUser, emailVerified: false }, verificationToken: "verify-raw" };
    },
  });
  const { ctx } = context(null, {
    environment: "production",
    appBaseUrl: "http://app.example.com",
  });

  await assert.rejects(
    createAuthRouter(deps).createCaller(ctx).register({
      name: "Test User",
      email: "user@example.com",
      password: "long-enough-password",
    }),
    (error: any) => error.code === "INTERNAL_SERVER_ERROR",
  );
  assert.equal(registrations, 0);
});

test("resend validates the production canonical origin before replacing a token", async () => {
  let resends = 0;
  const { deps } = dependencies({
    resendVerificationEmail: async () => {
      resends += 1;
      return { user: baseUser, verificationToken: "verify-raw" };
    },
  });
  const { ctx } = context(null, {
    environment: "production",
    appBaseUrl: "http://app.example.com",
  });

  await assert.rejects(
    createAuthRouter(deps).createCaller(ctx).resendVerification({ email: "user@example.com" }),
    (error: any) => error.code === "INTERNAL_SERVER_ERROR",
  );
  assert.equal(resends, 0);
});

test("forgot password validates the production canonical origin before creating a token", async () => {
  let resets = 0;
  const { deps } = dependencies({
    createPasswordResetToken: async () => {
      resets += 1;
      return { user: baseUser, resetToken: "reset-raw" };
    },
  });
  const { ctx } = context(null, {
    environment: "production",
    appBaseUrl: "http://app.example.com",
  });

  await assert.rejects(
    createAuthRouter(deps).createCaller(ctx).forgotPassword({ email: "user@example.com" }),
    (error: any) => error.code === "INTERNAL_SERVER_ERROR",
  );
  assert.equal(resets, 0);
});
