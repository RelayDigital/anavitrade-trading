import assert from "node:assert/strict";
import test from "node:test";
import type { CexClient, CexCredentials } from "../cex/clientTypes";
import { prepareExecutionJob } from "./server";

const fakeClient = {} as CexClient;

function dependencies(calls: string[], credentials?: CexCredentials) {
  return {
    decryptKey: async (ciphertext: string) => {
      calls.push(`decrypt:${ciphertext}`);
      return `plain:${ciphertext}`;
    },
    createClient: (exchange: string, received: CexCredentials) => {
      calls.push(`client:${exchange}`);
      if (credentials) Object.assign(credentials, received);
      return fakeClient;
    },
  };
}

test("disabled mode does not decrypt credentials or create an exchange client", async () => {
  const calls: string[] = [];

  const result = await prepareExecutionJob(
    "disabled",
    "binance",
    { apiKey: "encrypted-key", apiSecret: "encrypted-secret", passphrase: "encrypted-passphrase" },
    "encryption-key",
    dependencies(calls),
  );

  assert.deepEqual(result, { status: "disabled", mode: "disabled" });
  assert.deepEqual(calls, []);
});

test("invalid execution mode fails closed before decrypting or creating a client", async () => {
  const calls: string[] = [];

  await assert.rejects(
    prepareExecutionJob(
      "",
      "binance",
      { apiKey: "encrypted-key", apiSecret: "encrypted-secret" },
      "encryption-key",
      dependencies(calls),
    ),
    /Unknown EXECUTION_MODE/,
  );

  assert.deepEqual(calls, []);
});

test("unsupported testnet exchange fails before secrets are materialized", async () => {
  const calls: string[] = [];

  await assert.rejects(
    prepareExecutionJob(
      "testnet",
      "bybit",
      { apiKey: "encrypted-key", apiSecret: "encrypted-secret" },
      "encryption-key",
      dependencies(calls),
    ),
    /CEX_ENVIRONMENT_UNSUPPORTED:bybit:testnet/,
  );

  assert.deepEqual(calls, []);
});

test("production and testnet modes map to explicit client environments", async () => {
  for (const mode of ["production", "testnet"] as const) {
    const calls: string[] = [];
    const credentials: CexCredentials = { apiKey: "", apiSecret: "" };

    const result = await prepareExecutionJob(
      mode,
      "binance",
      { apiKey: "encrypted-key", apiSecret: "encrypted-secret" },
      "encryption-key",
      dependencies(calls, credentials),
    );

    assert.equal(result.status, "ready");
    assert.equal(result.environment, mode);
    assert.deepEqual(credentials, {
      apiKey: "plain:encrypted-key",
      apiSecret: "plain:encrypted-secret",
      environment: mode,
    });
    assert.deepEqual(calls, ["decrypt:encrypted-key", "decrypt:encrypted-secret", "client:binance"]);
  }
});
