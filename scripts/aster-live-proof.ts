const confirm = process.env.ASTER_LIVE_PROOF_CONFIRM ?? "";
const baseUrl = process.env.ASTER_LIVE_PROOF_API_BASE_URL ?? "http://127.0.0.1:8787";
const adminKey = process.env.ADMIN_API_KEY ?? process.env.ASTER_LIVE_PROOF_ADMIN_API_KEY ?? "";
const account = process.env.ASTER_LIVE_PROOF_ACCOUNT ?? "";
const symbol = process.env.ASTER_LIVE_PROOF_SYMBOL ?? "BTCUSDT";
const maxNotionalUsd = Number(process.env.ASTER_LIVE_PROOF_MAX_NOTIONAL_USD ?? "0");
const limitOffsetBps = Number(process.env.ASTER_LIVE_PROOF_LIMIT_OFFSET_BPS ?? "0");
const side = process.env.ASTER_LIVE_PROOF_SIDE === "SELL" ? "SELL" : "BUY";

if (process.env.ASTER_LIVE_ORDER_SUBMISSION_ENABLED !== "true") {
  throw new Error("Refusing live proof: ASTER_LIVE_ORDER_SUBMISSION_ENABLED must be true in this shell.");
}
if (confirm !== "PLACE_REAL_ASTER_LIMIT_ORDER_AND_CANCEL") {
  throw new Error("Refusing live proof: set ASTER_LIVE_PROOF_CONFIRM=PLACE_REAL_ASTER_LIMIT_ORDER_AND_CANCEL.");
}
if (!adminKey) throw new Error("Refusing live proof: ADMIN_API_KEY or ASTER_LIVE_PROOF_ADMIN_API_KEY is required.");
if (!account.startsWith("0x")) throw new Error("Refusing live proof: ASTER_LIVE_PROOF_ACCOUNT must be the active Aster account.");
if (!Number.isFinite(maxNotionalUsd) || maxNotionalUsd <= 0 || maxNotionalUsd > 10) {
  throw new Error("Refusing live proof: ASTER_LIVE_PROOF_MAX_NOTIONAL_USD must be > 0 and <= 10.");
}
if (!Number.isFinite(limitOffsetBps) || limitOffsetBps < 100) {
  throw new Error("Refusing live proof: ASTER_LIVE_PROOF_LIMIT_OFFSET_BPS must be >= 100.");
}

const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/aster/live-proof`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-admin-api-key": adminKey,
  },
  body: JSON.stringify({ confirm, account, symbol, maxNotionalUsd, limitOffsetBps, side }),
});
const body = await response.json().catch(() => ({}));
if (!response.ok || body.status === "error") {
  throw new Error(`Aster live proof failed: ${body.message ?? response.statusText}`);
}
console.log(JSON.stringify(body, null, 2));
