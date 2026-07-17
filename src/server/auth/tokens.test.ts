import assert from "node:assert/strict";
import test from "node:test";

import {
  createOneTimeToken,
  digestOneTimeToken,
  getTokenPersistence,
} from "./tokens";
import { resetPassword, setDbEnv, verifyEmailToken } from "../db";

function tokenUser(overrides: Record<string, unknown>) {
  return {
    id: 7,
    openId: "local:7",
    name: "Test User",
    email: "user@example.com",
    passwordHash: "existing-password-hash",
    loginMethod: "email",
    role: "user",
    emailVerified: 0,
    verificationToken: null,
    verificationTokenExpiresAt: null,
    resetToken: null,
    resetTokenExpiresAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSignedIn: Date.now(),
    ...overrides,
  };
}

function oneTimeTokenBoundary(initialUser: Record<string, any>) {
  let user: Record<string, any> | null = { ...initialUser };
  let digestReads = 0;
  let releaseDigestReads: (() => void) | undefined;
  const twoDigestReads = new Promise<void>((resolve) => { releaseDigestReads = resolve; });

  return {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...bound: unknown[]) {
          values = bound;
          return statement;
        },
        async all() {
          const normalized = query.trim().toLowerCase();
          if (normalized.startsWith("select")) {
            const isTokenRead = values.some((value) => value === user?.verificationToken || value === user?.resetToken);
            if (isTokenRead && digestReads < 2) {
              digestReads += 1;
              if (digestReads === 2) releaseDigestReads?.();
              await twoDigestReads;
            }
            return { results: user ? [{ ...user }] : [] };
          }
          if (normalized.startsWith("update") && normalized.includes("returning")) {
            const tokenColumn = normalized.includes("verificationtoken") ? "verificationToken" : "resetToken";
            const expiryColumn = tokenColumn === "verificationToken" ? "verificationTokenExpiresAt" : "resetTokenExpiresAt";
            const digest = values.find((value) => typeof value === "string" && value.length === 64);
            if (!user || user[tokenColumn] !== digest || user[expiryColumn] <= Date.now()) return { results: [] };
            user = {
              ...user,
              ...(tokenColumn === "verificationToken"
                ? { emailVerified: 1, verificationToken: null, verificationTokenExpiresAt: null }
                : { passwordHash: values[0], resetToken: null, resetTokenExpiresAt: null }),
            };
            return { results: [{ id: user.id }] };
          }
          if (normalized.startsWith("update")) {
            if (user) {
              if (normalized.includes("verificationtoken")) {
                user = { ...user, emailVerified: 1, verificationToken: null, verificationTokenExpiresAt: null };
              } else {
                user = { ...user, passwordHash: values[0], resetToken: null, resetTokenExpiresAt: null };
              }
            }
            return { results: [], meta: { changes: 1 } };
          }
          throw new Error(`Unexpected D1 query: ${query}`);
        },
        async run() { return statement.all(); },
        async raw() {
          const result = await statement.all();
          return result.results.map((row: Record<string, unknown>) => Object.values(row));
        },
      };
      return statement;
    },
  };
}

function setTokenTestDb(user: Record<string, unknown>) {
  setDbEnv({
    DB: oneTimeTokenBoundary(user) as any,
    JWT_SECRET: "test-secret-that-is-long-enough",
    ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough",
    VITE_APP_ID: "test-app",
  });
}

test("one-time tokens are random while persistence stores only SHA-256 digests", async () => {
  const first = await createOneTimeToken();
  const second = await createOneTimeToken();

  assert.notEqual(first.rawToken, second.rawToken);
  assert.equal(first.digest, await digestOneTimeToken(first.rawToken));
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.equal(first.digest.includes(first.rawToken), false);
});

test("token persistence isolates legacy schema column names from digest semantics", () => {
  assert.deepEqual(getTokenPersistence("verification", "digest", new Date(1234)), {
    values: { verificationToken: "digest", verificationTokenExpiresAt: new Date(1234) },
    digestColumn: "verificationToken",
    expiresAtColumn: "verificationTokenExpiresAt",
  });
  assert.deepEqual(getTokenPersistence("reset", null, null).values, {
    resetToken: null,
    resetTokenExpiresAt: null,
  });
});

test("only one concurrent verification can consume the same digest", async () => {
  const rawToken = "v".repeat(48);
  setTokenTestDb(tokenUser({
    verificationToken: await digestOneTimeToken(rawToken),
    verificationTokenExpiresAt: Date.now() + 60_000,
  }));

  const results = await Promise.allSettled([verifyEmailToken(rawToken), verifyEmailToken(rawToken)]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("only one concurrent reset can consume the same digest", async () => {
  const rawToken = "r".repeat(48);
  setTokenTestDb(tokenUser({
    resetToken: await digestOneTimeToken(rawToken),
    resetTokenExpiresAt: Date.now() + 60_000,
  }));

  const results = await Promise.allSettled([
    resetPassword(rawToken, "long-enough-password-one"),
    resetPassword(rawToken, "long-enough-password-two"),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("verification rejects plaintext legacy token persistence", async () => {
  const rawToken = "l".repeat(48);
  setTokenTestDb(tokenUser({
    verificationToken: rawToken,
    verificationTokenExpiresAt: Date.now() + 60_000,
  }));

  await assert.rejects(verifyEmailToken(rawToken), /INVALID_TOKEN/);
});
