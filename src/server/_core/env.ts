export type D1Meta = {
  duration: number;
  size_after: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changed_db: boolean;
  changes: number;
  served_by_region?: string;
  served_by_colo?: string;
  served_by_primary?: boolean;
  timings?: { sql_duration_ms: number };
  total_attempts?: number;
};

export type D1Result<T = unknown> = {
  success: true;
  meta: D1Meta & Record<string, unknown>;
  results: T[];
};

export type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(columnName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
};

export type D1DatabaseSession = {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  getBookmark(): string | null;
};

/**
 * Structural D1 binding type for both application and Worker typecheck contexts.
 * Cloudflare's package exposes this ambiently in some configurations instead of
 * exporting it as a module symbol.
 */
export type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
  withSession(constraintOrBookmark?: string): D1DatabaseSession;
  dump(): Promise<ArrayBuffer>;
};

export type Env = {
  DB: D1Database;
  APP_BASE_URL?: string;
  APP_ENVIRONMENT?: "development" | "staging" | "production";
  CORS_ALLOWED_ORIGINS?: string;
  RATE_LIMITER?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
  METRICS_TOKEN?: string;
  JWT_SECRET: string;
  ENCRYPTION_KEY: string;
  INTERNAL_SECRET?: string;
  VITE_APP_ID: string;
  BINANCE_API_KEY?: string;
  BINANCE_SECRET_KEY?: string;
  ASTER_API_BASE_URL?: string;
  ASTER_BUILDER_ADDRESS?: string;
  ASTER_DEFAULT_FEE_RATE?: string;
  ASTER_ENVIRONMENT?: "production" | "testnet" | "development";
  ASTER_CHAIN?: string;
  ASTER_CODE_SIGNING_CHAIN_ID?: string;
  ASTER_INCLUDE_COMPAT_PARAMS?: string;
  ASTER_LIVE_ORDER_SUBMISSION_ENABLED?: string;
  PANCAKESWAP_RPC_URL?: string;
  PANCAKESWAP_PERMIT2_ADDRESS?: string;
  PANCAKESWAP_UNIVERSAL_ROUTER_ADDRESS?: string;
  PANCAKESWAP_EXECUTOR_ADDRESS?: string;
  PANCAKESWAP_EXECUTOR_PRIVATE_KEY?: string;
  PANCAKESWAP_ENVIRONMENT?: "production" | "testnet" | "development";
  PANCAKESWAP_LIVE_ORDER_SUBMISSION_ENABLED?: string;
  OWNER_OPEN_ID?: string;
  ADMIN_API_KEY?: string;
  EXECUTION_LEASE_OWNER?: string;
};

let _env: Env | null = null;

export function setEnv(env: Env) {
  _env = env;
}

export function getEnv(): Env {
  if (!_env) throw new Error("Env not set — call setEnv() first");
  return _env;
}
