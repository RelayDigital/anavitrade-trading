import { nanoid } from "nanoid";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestSessionId(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  return bytesToHex(new Uint8Array(digest));
}

export function createSessionId(): string {
  return nanoid(48);
}
