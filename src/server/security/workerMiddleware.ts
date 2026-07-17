import type { Context, Handler, MiddlewareHandler } from "hono";
import { timingSafeSecretEqual } from "./requestSecurity";

export type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export type WorkerRouteKind = "browser" | "internal" | "admin";

export type SecurityMetricsSink = {
  recordRateLimitDenial?: (reason: "limited" | "unconfigured" | "error") => void;
  recordCsrfDenial?: (reason: "origin" | "content_type" | "client_header") => void;
  recordSecretDenial?: (route: "internal" | "admin", reason: "missing" | "invalid" | "unconfigured") => void;
};

export type WorkerSecurityOptions = {
  allowedOrigins: string | readonly string[] | ReadonlySet<string>;
  production: boolean;
  rateLimitBinding?: RateLimitBinding;
  rateLimitKey?: (context: Context) => string;
  machineSecrets?: Partial<Record<"internal" | "admin", string>>;
  internalRoutePrefixes?: readonly string[];
  adminRoutePrefixes?: readonly string[];
  routeClassifier?: (path: string) => WorkerRouteKind | undefined;
  clientHeader?: string;
  clientValue?: string;
  allowedMethods?: readonly string[];
  allowedHeaders?: readonly string[];
  metrics?: SecurityMetricsSink;
};

const DEFAULT_INTERNAL_PREFIXES = ["/api/internal/"] as const;
const DEFAULT_ADMIN_PREFIXES = ["/api/admin/"] as const;
const DEFAULT_ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const DEFAULT_ALLOWED_HEADERS = ["Content-Type", "Authorization", "X-Client", "X-Internal-Secret", "X-Admin-Api-Key"] as const;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function originFromString(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function parseConfiguredOrigins(value: string | readonly string[] | ReadonlySet<string>): ReadonlySet<string> {
  const values = typeof value === "string" ? value.split(",") : [...value];
  const origins = new Set<string>();
  for (const candidate of values) {
    const origin = originFromString(candidate);
    if (origin) origins.add(origin);
  }
  return origins;
}

export function isExactOriginAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!origin) return false;
  const parsed = originFromString(origin);
  return parsed !== undefined && parsed === origin && allowed.has(parsed);
}

function hasPathPrefix(path: string, prefix: string): boolean {
  const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function classifyWorkerRoute(
  path: string,
  options: Pick<WorkerSecurityOptions, "internalRoutePrefixes" | "adminRoutePrefixes" | "routeClassifier"> = {},
): WorkerRouteKind {
  const custom = options.routeClassifier?.(path);
  if (custom) return custom;
  if ((options.internalRoutePrefixes ?? DEFAULT_INTERNAL_PREFIXES).some((prefix) => hasPathPrefix(path, prefix))) {
    return "internal";
  }
  if ((options.adminRoutePrefixes ?? DEFAULT_ADMIN_PREFIXES).some((prefix) => hasPathPrefix(path, prefix))) {
    return "admin";
  }
  return "browser";
}

function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1];
}

export async function authorizeBearerOrToken(input: {
  authorization?: string;
  token?: string;
  expected: string;
}): Promise<boolean> {
  const bearer = extractBearerToken(input.authorization) ?? "";
  const token = input.token ?? "";
  const [bearerMatches, tokenMatches] = await Promise.all([
    timingSafeSecretEqual(bearer, input.expected),
    timingSafeSecretEqual(token, input.expected),
  ]);
  return input.expected.length > 0 && (bearerMatches || tokenMatches);
}

function setSecurityHeaders(context: Context, production: boolean): void {
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
  context.header("Referrer-Policy", "strict-origin-when-cross-origin");
  context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  context.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  context.header("Cross-Origin-Opener-Policy", "same-origin");
  context.header("Cross-Origin-Resource-Policy", "same-origin");
  if (production) context.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function setCorsHeaders(context: Context, origin: string | undefined, options: WorkerSecurityOptions, allowed: ReadonlySet<string>): boolean {
  if (!isExactOriginAllowed(origin, allowed)) return false;
  context.header("Access-Control-Allow-Origin", origin);
  context.header("Access-Control-Allow-Credentials", "true");
  context.header("Access-Control-Allow-Methods", (options.allowedMethods ?? DEFAULT_ALLOWED_METHODS).join(", "));
  context.header("Access-Control-Allow-Headers", (options.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS).join(", "));
  context.header("Vary", "Origin");
  return true;
}

function denial(context: Context, status: 401 | 403 | 429 | 503, code: string): Response {
  return context.json({ status: "error", code }, status);
}

function defaultRateLimitKey(context: Context): string {
  const ip = context.req.header("CF-Connecting-IP") ?? context.req.header("X-Real-IP") ?? "anonymous";
  return `${ip}:${context.req.method}:${context.req.path}`;
}

async function enforceWorkerRateLimit(context: Context, options: WorkerSecurityOptions): Promise<Response | null> {
  if (!options.rateLimitBinding) {
    if (options.production) {
      options.metrics?.recordRateLimitDenial?.("unconfigured");
      return denial(context, 503, "rate_limit_unconfigured");
    }
    return null;
  }
  try {
    const result = await options.rateLimitBinding.limit({
      key: (options.rateLimitKey ?? defaultRateLimitKey)(context),
    });
    if (!result.success) {
      options.metrics?.recordRateLimitDenial?.("limited");
      return denial(context, 429, "rate_limited");
    }
  } catch {
    options.metrics?.recordRateLimitDenial?.("error");
    return denial(context, 503, "rate_limit_unavailable");
  }
  return null;
}

export function createExactOriginCorsMiddleware(options: WorkerSecurityOptions): MiddlewareHandler {
  const allowed = parseConfiguredOrigins(options.allowedOrigins);
  return async (context, next) => {
    const origin = context.req.header("Origin");
    const allowedOrigin = setCorsHeaders(context, origin, options, allowed);
    if (context.req.method.toUpperCase() === "OPTIONS") {
      return allowedOrigin ? context.body(null, 204) : denial(context, 403, "cors_origin");
    }
    await next();
  };
}

export function createSecurityHeadersMiddleware(production = true): MiddlewareHandler {
  return async (context, next) => {
    setSecurityHeaders(context, production);
    await next();
  };
}

export function createWorkerSecurityMiddleware(options: WorkerSecurityOptions): MiddlewareHandler {
  const allowed = parseConfiguredOrigins(options.allowedOrigins);
  const clientHeader = options.clientHeader ?? "X-Client";
  const clientValue = options.clientValue ?? "web";

  return async (context, next) => {
    setSecurityHeaders(context, options.production);
    const allowedOrigin = setCorsHeaders(context, context.req.header("Origin"), options, allowed);
    if (context.req.method.toUpperCase() === "OPTIONS") {
      return allowedOrigin ? context.body(null, 204) : denial(context, 403, "cors_origin");
    }

    const rateLimitError = await enforceWorkerRateLimit(context, options);
    if (rateLimitError) return rateLimitError;

    const route = classifyWorkerRoute(context.req.path, options);
    if (route === "internal" || route === "admin") {
      if (options.machineSecrets?.internal
        && options.machineSecrets?.admin
        && options.machineSecrets.internal === options.machineSecrets.admin) {
        options.metrics?.recordSecretDenial?.(route, "unconfigured");
        return denial(context, 503, "machine_secrets_not_distinct");
      }
      const expected = options.machineSecrets?.[route];
      if (!expected) {
        options.metrics?.recordSecretDenial?.(route, "unconfigured");
        return denial(context, 503, "secret_unconfigured");
      }
      const authorized = await authorizeBearerOrToken({
        authorization: context.req.header("Authorization"),
        token: context.req.header(route === "internal" ? "X-Internal-Secret" : "X-Admin-Api-Key"),
        expected,
      });
      if (!authorized) {
        options.metrics?.recordSecretDenial?.(route, "invalid");
        return denial(context, 401, "secret_invalid");
      }
      await next();
      return;
    }

    if (MUTATION_METHODS.has(context.req.method.toUpperCase())) {
      const origin = context.req.header("Origin");
      if (!isExactOriginAllowed(origin, allowed)) {
        options.metrics?.recordCsrfDenial?.("origin");
        return denial(context, 403, "csrf_origin");
      }
      if (!(context.req.header("Content-Type") ?? "").trim().toLowerCase().startsWith("application/json")) {
        options.metrics?.recordCsrfDenial?.("content_type");
        return denial(context, 403, "csrf_content_type");
      }
      if (context.req.header(clientHeader) !== clientValue) {
        options.metrics?.recordCsrfDenial?.("client_header");
        return denial(context, 403, "csrf_client_header");
      }
    }

    await next();
  };
}

export const createWorkerMiddleware = createWorkerSecurityMiddleware;

export type WorkerSecurityHandler = Handler;
