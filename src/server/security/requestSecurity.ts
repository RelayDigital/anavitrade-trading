const encoder = new TextEncoder();

export type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export async function timingSafeSecretEqual(actual: string, expected: string): Promise<boolean> {
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(actualHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0 && actual.length === expected.length;
}

export function parseAllowedOrigins(value: string | undefined): ReadonlySet<string> {
  const origins = (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => new URL(origin).origin);
  return new Set(origins);
}

export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!origin) return false;
  try {
    return allowed.has(new URL(origin).origin) && origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function requiresMutationOriginCheck(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function validateMutationRequest(input: {
  method: string;
  origin?: string;
  contentType?: string;
  clientHeader?: string;
  allowedOrigins: ReadonlySet<string>;
}): { ok: true } | { ok: false; reason: "origin" | "content_type" | "client_header" } {
  if (!requiresMutationOriginCheck(input.method)) return { ok: true };
  if (!isAllowedOrigin(input.origin, input.allowedOrigins)) return { ok: false, reason: "origin" };
  if (!(input.contentType ?? "").toLowerCase().startsWith("application/json")) {
    return { ok: false, reason: "content_type" };
  }
  if (input.clientHeader !== "web") return { ok: false, reason: "client_header" };
  return { ok: true };
}

export async function enforceRateLimit(input: {
  binding?: RateLimitBinding;
  key: string;
  production: boolean;
}): Promise<{ allowed: boolean; reason?: "unconfigured" | "limited" }> {
  if (!input.binding) {
    return input.production ? { allowed: false, reason: "unconfigured" } : { allowed: true };
  }
  const result = await input.binding.limit({ key: input.key });
  return result.success ? { allowed: true } : { allowed: false, reason: "limited" };
}
