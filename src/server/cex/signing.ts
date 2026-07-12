/**
 * CEX request-signing primitives. All Web Crypto (crypto.subtle) — Workers-safe,
 * no Node crypto. Two families:
 *   - HMAC-SHA256 over a param string   → Binance (and Bybit/OKX later)
 *   - double SHA-256 header signature    → Bitunix
 */

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** HMAC-SHA256(secret, data) → lowercase hex. Binance signature recipe. */
export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return toHex(sig);
}

/** HMAC-SHA512(secret, data) → lowercase hex. Used by Gate.io. */
export async function hmacSha512Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return toHex(sig);
}

/** SHA-256(input) → lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return toHex(digest);
}

/**
 * Bitunix double-SHA256 signature.
 * digest = sha256(nonce + timestamp + apiKey + queryParams + body)
 * sign   = sha256(digest + secretKey)
 * For POST, queryParams = "" and body is the exact compact JSON string sent.
 * For GET, body = "" and queryParams is the sorted key+value concatenation.
 */
export async function bitunixSign(params: {
  nonce: string;
  timestamp: string;
  apiKey: string;
  queryParams: string;
  body: string;
  secretKey: string;
}): Promise<string> {
  const digest = await sha256Hex(
    params.nonce + params.timestamp + params.apiKey + params.queryParams + params.body,
  );
  return sha256Hex(digest + params.secretKey);
}

/**
 * Bitunix GET query normalization: sort keys ASCII-ascending, concatenate
 * key+value with no separators (excluding the auth headers).
 */
export function bitunixQueryParams(params: Record<string, string | number | undefined>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
}

/** Build a Binance-style signed query string: caller passes ordered params. */
export async function binanceSignedQuery(
  secret: string,
  params: Record<string, string | number | undefined>,
): Promise<string> {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const signature = await hmacSha256Hex(secret, query);
  return `${query}&signature=${signature}`;
}

/** Random hex nonce for Bitunix requests (Workers-safe, no Math.random dependency). */
export function randomNonce(bytes = 16): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return toHex(arr.buffer);
}
