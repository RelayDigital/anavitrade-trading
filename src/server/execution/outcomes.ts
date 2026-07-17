export type ExecutionMode = "disabled" | "testnet" | "production";

export function parseExecutionMode(value: unknown): ExecutionMode {
  if (value === "disabled" || value === "testnet" || value === "production") return value;
  throw new Error(`Unknown EXECUTION_MODE: ${String(value)}`);
}

export const DEFAULT_NAV_MAX_AGE_MS = 5 * 60 * 1_000;

export type NavValidation =
  | { approved: true; equityUsd: number }
  | { approved: false; reason: "missing_nav" | "invalid_nav" | "non_positive_nav" | "stale_nav" };

export function validateNavSnapshot(
  nav: { accountEquityUsd: string; snapshotAt: number | Date } | null | undefined,
  now = Date.now(),
  maxAgeMs = DEFAULT_NAV_MAX_AGE_MS,
): NavValidation {
  if (!nav) return { approved: false, reason: "missing_nav" };
  const equityUsd = Number(nav.accountEquityUsd);
  if (!Number.isFinite(equityUsd)) return { approved: false, reason: "invalid_nav" };
  if (equityUsd <= 0) return { approved: false, reason: "non_positive_nav" };
  const snapshotAt = nav.snapshotAt instanceof Date ? nav.snapshotAt.getTime() : Number(nav.snapshotAt);
  if (!Number.isFinite(snapshotAt)) return { approved: false, reason: "invalid_nav" };
  if (snapshotAt > now || now - snapshotAt > maxAgeMs) return { approved: false, reason: "stale_nav" };
  return { approved: true, equityUsd };
}

type ExactOrder = { orderId?: string; clientOrderId?: string; status?: string; [key: string]: unknown };
type ExactOrderClient = {
  getOrderById?: (symbol: string, orderId: string) => Promise<ExactOrder | null>;
  getOrderByClientId?: (symbol: string, clientOrderId: string) => Promise<ExactOrder | null>;
};

export async function reconcileExactOrder(
  client: ExactOrderClient,
  ids: { symbol: string; orderId?: string | null; clientOrderId?: string | null },
): Promise<{ status: "matched"; order: ExactOrder } | { status: "unresolved"; reason: string }> {
  if (ids.orderId && client.getOrderById) {
    const order = await client.getOrderById(ids.symbol, ids.orderId);
    return order ? { status: "matched", order } : { status: "unresolved", reason: "order_id_not_found" };
  }
  if (ids.clientOrderId && client.getOrderByClientId) {
    const order = await client.getOrderByClientId(ids.symbol, ids.clientOrderId);
    return order ? { status: "matched", order } : { status: "unresolved", reason: "client_order_id_not_found" };
  }
  return { status: "unresolved", reason: "exact_order_lookup_unsupported" };
}
