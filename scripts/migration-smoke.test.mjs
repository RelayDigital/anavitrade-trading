import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationsDir = new URL("../migrations/", import.meta.url);

function applyMigrations() {
  const database = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();

  for (const file of files) {
    const sql = readFileSync(new URL(file, migrationsDir), "utf8")
      .replaceAll("--> statement-breakpoint", "");
    database.exec(sql);
  }

  return database;
}

function columns(database, table) {
  return new Map(
    database.prepare(`PRAGMA table_info(${table})`).all()
      .map((column) => [column.name, column]),
  );
}

test("all ordered migrations apply to a fresh SQLite/D1-compatible database", () => {
  const database = applyMigrations();
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get().count > 0,
    true,
  );
});

test("forward migration contains every execution and risk production field", () => {
  const database = applyMigrations();

  const liveAccountColumns = columns(database, "live_accounts");
  for (const name of [
    "displayMode",
    "lastTotalEquityUsd",
    "lastAvailableUsd",
    "depositAddress",
    "linkedExchangesJson",
  ]) assert.ok(liveAccountColumns.has(name), `live_accounts.${name}`);

  const connectionColumns = columns(database, "cex_connections");
  for (const name of ["consecutiveLosses", "circuitBreakerUntil", "highWaterMark"]) {
    assert.ok(connectionColumns.has(name), `cex_connections.${name}`);
  }

  assert.ok(columns(database, "trade_intents").has("sourceSignal"));

  const jobColumns = columns(database, "execution_jobs");
  for (const name of [
    "riskApproved",
    "leaseToken",
    "leaseOwner",
    "leaseExpiresAt",
    "leaseAttempt",
    "leaseAction",
    "leasePreviousStatus",
  ]) assert.ok(jobColumns.has(name), `execution_jobs.${name}`);
  assert.equal(jobColumns.get("riskApproved").dflt_value, "0");
  assert.equal(jobColumns.get("leaseAttempt").dflt_value, "0");

  const reports = columns(database, "execution_reports");
  for (const name of ["reportId", "executionJobId", "stopLossOrderId", "takeProfitOrderId", "compensationState", "compensationOrderId"]) {
    assert.ok(reports.has(name), `execution_reports.${name}`);
  }

  const indexes = new Set(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
      .map((row) => row.name),
  );
  assert.ok(indexes.has("execution_jobs_claim_eligibility_idx"));
  assert.ok(indexes.has("execution_jobs_lease_expiry_idx"));
  assert.ok(indexes.has("demo_accounts_user_id_unique"));
  assert.ok(indexes.has("demo_trades_account_signal_idx"));
  assert.ok(indexes.has("portfolio_snapshots_account_trade_count_idx"));
});
