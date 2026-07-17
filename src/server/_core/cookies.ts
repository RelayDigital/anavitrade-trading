import type { Env } from "./env";
import { isExplicitDevelopmentOrTestnet } from "../auth/origin";

export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export function getSessionCookieOptions(env: Env) {
  const secure = !isExplicitDevelopmentOrTestnet(env);
  return {
    httpOnly: true,
    secure,
    // The production UI is served by Vercel while the API is served by a
    // Cloudflare Worker. Cross-site fetches therefore require SameSite=None;
    // origin/client-header checks provide the mutation CSRF boundary.
    sameSite: secure ? ("none" as const) : ("lax" as const),
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function getClientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
