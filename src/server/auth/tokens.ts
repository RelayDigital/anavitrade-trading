import { nanoid } from "nanoid";

export type AuthTokenKind = "verification" | "reset";

const TOKEN_COLUMNS = {
  verification: {
    digest: "verificationToken",
    expiresAt: "verificationTokenExpiresAt",
  },
  reset: {
    digest: "resetToken",
    expiresAt: "resetTokenExpiresAt",
  },
} as const;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestOneTimeToken(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken));
  return bytesToHex(new Uint8Array(digest));
}

export async function createOneTimeToken(): Promise<{ rawToken: string; digest: string }> {
  const rawToken = nanoid(48);
  return { rawToken, digest: await digestOneTimeToken(rawToken) };
}

export function getTokenPersistence(
  kind: AuthTokenKind,
  digest: string | null,
  expiresAt: Date | null,
) {
  const columns = TOKEN_COLUMNS[kind];
  return {
    values: {
      [columns.digest]: digest,
      [columns.expiresAt]: expiresAt,
    },
    digestColumn: columns.digest,
    expiresAtColumn: columns.expiresAt,
  };
}

