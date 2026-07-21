import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/pages/AsterOnboarding.tsx", import.meta.url), "utf8");

assert.match(source, /Anavitrade never signs this authorization on your behalf/);
assert.match(source, /renewal requires another wallet signature/);
assert.match(source, /typed-data signing domain \(chain 56\)/);
assert.doesNotMatch(source, /auto-renewable/);

console.log("ASTER_ONBOARDING_CONSENT_COPY_TEST_PASS");
