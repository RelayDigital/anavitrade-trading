import type { Env } from "../_core/env";

type AuthEnv = Env & { APP_BASE_URL?: unknown };

/** Only these explicitly configured non-production environments may use HTTP. */
export function isExplicitDevelopmentOrTestnet(env: Env): boolean {
  const environment: unknown = (env as Record<string, unknown>).APP_ENVIRONMENT;
  return environment === "development" || environment === "testnet";
}

function invalidAppBaseUrl(): never {
  throw new Error("APP_BASE_URL must be a canonical http(s) origin");
}

export function getCanonicalAppOrigin(env: Env): string {
  const value = (env as AuthEnv).APP_BASE_URL;
  if (typeof value !== "string" || value.trim() === "") invalidAppBaseUrl();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidAppBaseUrl();
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (!isExplicitDevelopmentOrTestnet(env) && url.protocol !== "https:")
  ) {
    invalidAppBaseUrl();
  }
  return url.origin;
}

export function createCanonicalAuthUrl(
  env: Env,
  path: string,
  params: Record<string, string>,
): string {
  const url = new URL(path, `${getCanonicalAppOrigin(env)}/`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}
