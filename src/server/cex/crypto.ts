/**
 * AES-256-GCM encryption/decryption for API credentials.
 *
 * Extracted from src/server/db.ts so this module can be used
 * anywhere (Worker, VPS) without depending on the Worker's
 * global _env / setDbEnv() lifecycle.
 *
 * Usage on Worker:
 *   import { encryptKey, decryptKey } from "./crypto";
 *   const enc = await encryptKey(plaintext, env.ENCRYPTION_KEY);
 *
 * Usage on Execution VPS:
 *   import { decryptKey } from "../cex/crypto";
 *   const key = await decryptKey(encryptedBlob, process.env.ENCRYPTION_KEY);
 */

/** Derive a 32-byte AES key from an arbitrary-length secret. */
function deriveKeyBytes(secret: string): Uint8Array {
  return new TextEncoder().encode(secret.slice(0, 32).padEnd(32, "0"));
}

async function getEncryptionKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt `plaintext` with AES-256-GCM using the given `encryptionKey`.
 * Returns a base64-encoded blob: 12-byte IV + ciphertext (includes 16-byte GCM auth tag).
 */
export async function encryptKey(plaintext: string, encryptionKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getEncryptionKey(deriveKeyBytes(encryptionKey));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(12 + new Uint8Array(encrypted).length);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64-encoded blob previously produced by `encryptKey`.
 * Expects the same `encryptionKey` used during encryption.
 */
export async function decryptKey(ciphertext: string, encryptionKey: string): Promise<string> {
  const raw = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const iv = raw.slice(0, 12);
  const encrypted = raw.slice(12);
  const key = await getEncryptionKey(deriveKeyBytes(encryptionKey));
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}
