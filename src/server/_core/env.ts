// eslint-disable-next-line @typescript-eslint/no-explicit-any
type D1Database = any;

export type Env = {
  DB: D1Database;
  JWT_SECRET: string;
  ENCRYPTION_KEY: string;
  VITE_APP_ID: string;
  BINANCE_API_KEY?: string;
  BINANCE_SECRET_KEY?: string;
  ASTER_API_BASE_URL?: string;
  ASTER_BUILDER_ADDRESS?: string;
  ASTER_DEFAULT_FEE_RATE?: string;
  ASTER_ENVIRONMENT?: "production" | "testnet" | "development";
  OWNER_OPEN_ID?: string;
  ADMIN_API_KEY?: string;
};

let _env: Env | null = null;

export function setEnv(env: Env) {
  _env = env;
}

export function getEnv(): Env {
  if (!_env) throw new Error("Env not set — call setEnv() first");
  return _env;
}
