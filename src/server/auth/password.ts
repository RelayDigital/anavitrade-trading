export const PASSWORD_HASH_ITERATIONS = 600_000;

const LEGACY_PASSWORD_HASH_ITERATIONS = 100_000;
const PASSWORD_HASH_PREFIX = "pbkdf2-sha256$v1";
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const saltBuffer = Uint8Array.from(salt).buffer as ArrayBuffer;
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBuffer, iterations, hash: "SHA-256" },
    keyMaterial,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePasswordHash(password, salt, PASSWORD_HASH_ITERATIONS);
  return [
    PASSWORD_HASH_PREFIX,
    PASSWORD_HASH_ITERATIONS,
    bytesToBase64Url(salt),
    bytesToBase64Url(hash),
  ].join("$");
}

type PasswordVerificationResult = {
  valid: boolean;
  rehashedPassword?: string;
};

export async function verifyPasswordAndRehash(
  password: string,
  storedHash: string,
): Promise<PasswordVerificationResult> {
  try {
    if (storedHash.startsWith(`${PASSWORD_HASH_PREFIX}$`)) {
      const [algorithm, version, iterationText, saltText, hashText, extra] = storedHash.split("$");
      if (
        algorithm !== "pbkdf2-sha256" ||
        version !== "v1" ||
        extra !== undefined ||
        Number(iterationText) !== PASSWORD_HASH_ITERATIONS
      ) {
        return { valid: false };
      }
      const salt = base64UrlToBytes(saltText);
      const expected = base64UrlToBytes(hashText);
      if (salt.length !== SALT_BYTES || expected.length !== HASH_BYTES) return { valid: false };
      const actual = await derivePasswordHash(password, salt, PASSWORD_HASH_ITERATIONS);
      return { valid: constantTimeEqual(actual, expected) };
    }

    const legacy = Uint8Array.from(atob(storedHash), (character) => character.charCodeAt(0));
    if (legacy.length !== SALT_BYTES + HASH_BYTES) return { valid: false };
    const actual = await derivePasswordHash(
      password,
      legacy.slice(0, SALT_BYTES),
      LEGACY_PASSWORD_HASH_ITERATIONS,
    );
    const valid = constantTimeEqual(actual, legacy.slice(SALT_BYTES));
    return valid ? { valid, rehashedPassword: await hashPassword(password) } : { valid: false };
  } catch {
    return { valid: false };
  }
}
