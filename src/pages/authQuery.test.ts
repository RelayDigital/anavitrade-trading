import assert from "node:assert/strict";
import test from "node:test";

import { stripSensitiveQueryParams } from "./authQuery";

test("auth query scrubbing removes secrets while preserving safe routing state", () => {
  const result = stripSensitiveQueryParams(
    "https://app.example.com/reset-password?token=raw-secret&next=%2Flogin#form",
    ["token"],
  );

  assert.equal(result.valueByName.token, "raw-secret");
  assert.equal(result.sanitizedPath, "/reset-password?next=%2Flogin#form");
  assert.equal(result.sanitizedPath.includes("raw-secret"), false);
});

