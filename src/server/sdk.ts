import { COOKIE_NAME } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import { SignJWT, jwtVerify } from "jose";
import { parse } from "cookie";
import type { User } from "../drizzle/schema";
import * as db from "./db";
import { getEnv, type Env } from "./_core/env";
import { SESSION_MAX_AGE_SECONDS } from "./_core/cookies";
import { createSessionId, digestSessionId } from "./auth/sessions";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  openId: string;
  appId: string;
  name: string;
};

type StoredSession = {
  expiresAt: Date;
  revokedAt: Date | null;
};

type SessionLookup = (sessionId: string) => Promise<StoredSession | null | undefined>;

function getSessionSecret(): Uint8Array {
  const secret = getEnv().JWT_SECRET;
  return new TextEncoder().encode(secret);
}

export function getSessionTokenFromRequest(
  req: Request,
  cookieName = COOKIE_NAME,
): string | undefined {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return undefined;
  return parse(cookieHeader)[cookieName];
}

export async function createSessionToken(
  openId: string,
  options: { expiresInMs?: number; name?: string } = {}
): Promise<string> {
  const env = getEnv();
  const user = openId.startsWith("local:")
    ? await db.getUserById(Number.parseInt(openId.slice(6), 10))
    : await db.getUserByOpenId(openId);
  if (!user || !Number.isInteger(user.id)) throw new Error("Cannot create a session for an unknown user");
  const expiresInMs = options.expiresInMs ?? SESSION_MAX_AGE_SECONDS * 1000;
  const sessionId = createSessionId();
  await db.createAuthSession(
    user.id,
    await digestSessionId(sessionId),
    new Date(Date.now() + expiresInMs),
  );
  return signSession(
    { openId, appId: env.VITE_APP_ID, name: options.name || "" },
    { expiresInMs, sessionId },
  );
}

export async function signSession(
  payload: SessionPayload,
  options: { expiresInMs?: number; sessionId?: string } = {}
): Promise<string> {
  const issuedAt = Date.now();
  const expiresInMs = options.expiresInMs ?? SESSION_MAX_AGE_SECONDS * 1000;
  const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
  const secretKey = getSessionSecret();

  return new SignJWT({
    openId: payload.openId,
    appId: payload.appId,
    name: payload.name,
    sid: options.sessionId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expirationSeconds)
    .sign(secretKey);
}

export async function verifySession(
  cookieValue: string | undefined | null,
  lookupSession: SessionLookup = async (sessionId) =>
    db.getAuthSessionByDigest(await digestSessionId(sessionId)),
): Promise<SessionPayload | null> {
  if (!cookieValue) return null;
  try {
    const secretKey = getSessionSecret();
    const { payload } = await jwtVerify(cookieValue, secretKey, {
      algorithms: ["HS256"],
    });
    const { openId, appId, name, sid } = payload as Record<string, unknown>;
    if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name) || !isNonEmptyString(sid)) {
      return null;
    }
    const stored = await lookupSession(sid);
    if (!stored || stored.revokedAt || stored.expiresAt.getTime() <= Date.now()) return null;
    return { openId, appId, name };
  } catch {
    return null;
  }
}

export async function revokeSessionToken(cookieValue: string | undefined | null): Promise<void> {
  if (!cookieValue) return;
  try {
    const { payload } = await jwtVerify(cookieValue, getSessionSecret(), { algorithms: ["HS256"] });
    const sessionId = (payload as Record<string, unknown>).sid;
    if (!isNonEmptyString(sessionId)) return;
    await db.revokeAuthSessionByDigest(await digestSessionId(sessionId));
  } catch {
    // Logout remains idempotent when a browser presents a stale or malformed cookie.
  }
}

export async function authenticateRequest(req: Request, env: Env): Promise<User> {
  void env;
  const session = await verifySession(getSessionTokenFromRequest(req));
  if (!session) {
    throw new ForbiddenError("Invalid session");
  }

  // Local email/password auth: openId is "local:{userId}"
  if (session.openId.startsWith("local:")) {
    const userId = parseInt(session.openId.slice(6), 10);
    if (isNaN(userId)) throw new ForbiddenError("Invalid local session");
    const user = await db.getUserById(userId);
    if (!user) throw new ForbiddenError("User not found");
    if (!user.emailVerified) throw new ForbiddenError("Email verification required");
    return user;
  }

  // OAuth: look up by openId
  const user = await db.getUserByOpenId(session.openId);
  if (!user) throw new ForbiddenError("User not found");
  return user;
}
