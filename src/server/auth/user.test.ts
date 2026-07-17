import assert from "node:assert/strict";
import test from "node:test";

import { toSafeUser } from "./user";

test("safe user DTO has an exact allowlist and excludes authentication secrets", () => {
  const dto = toSafeUser({
    id: 42,
    openId: "local:42",
    name: "Ariel",
    email: "ariel@example.com",
    passwordHash: "secret-hash",
    loginMethod: "email",
    role: "user",
    emailVerified: true,
    verificationToken: "raw-verification-token",
    verificationTokenExpiresAt: new Date(),
    resetToken: "raw-reset-token",
    resetTokenExpiresAt: new Date(),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    lastSignedIn: new Date("2026-01-03T00:00:00Z"),
  });

  assert.deepEqual(Object.keys(dto).sort(), [
    "createdAt",
    "email",
    "emailVerified",
    "id",
    "lastSignedIn",
    "loginMethod",
    "name",
    "role",
  ]);
  assert.equal("passwordHash" in dto, false);
  assert.equal("verificationToken" in dto, false);
  assert.equal("resetToken" in dto, false);
});

