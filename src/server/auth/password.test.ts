import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import {
  PASSWORD_HASH_ITERATIONS,
  hashPassword,
  verifyPasswordAndRehash,
} from "./password";

const encoder = new TextEncoder();

async function legacyHash(password: string): Promise<string> {
  const salt = new Uint8Array(16).fill(7);
  const key = await webcrypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hash = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    key,
    256,
  );
  const combined = new Uint8Array(48);
  combined.set(salt);
  combined.set(new Uint8Array(hash), 16);
  return Buffer.from(combined).toString("base64");
}

test("hashPassword creates a versioned PBKDF2-SHA256 600k hash", async () => {
  const encoded = await hashPassword("correct horse battery staple");

  assert.match(
    encoded,
    new RegExp(`^pbkdf2-sha256\\$v1\\$${PASSWORD_HASH_ITERATIONS}\\$`),
  );
  assert.equal(PASSWORD_HASH_ITERATIONS, 600_000);
  assert.equal((await verifyPasswordAndRehash("correct horse battery staple", encoded)).valid, true);
  assert.equal((await verifyPasswordAndRehash("wrong password", encoded)).valid, false);
});

test("legacy 100k hashes verify and return a versioned replacement", async () => {
  const legacy = await legacyHash("legacy password");
  const result = await verifyPasswordAndRehash("legacy password", legacy);

  assert.equal(result.valid, true);
  assert.match(result.rehashedPassword ?? "", /^pbkdf2-sha256\$v1\$600000\$/);
  assert.equal((await verifyPasswordAndRehash("wrong", legacy)).valid, false);
});
