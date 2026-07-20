/**
 * Tests for the Opus trade-judgment gate. All Anthropic API calls are mocked
 * via a stubbed global fetch — no real network traffic or API cost.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { judgeTradeWithOpus, buildPrompt, type TradeJudgeInput } from "../src/server/analysis/llm-trade-judge";

const baseInput: TradeJudgeInput = {
  symbol: "SOLUSDT",
  direction: "long",
  entry: 100,
  stopLoss: 95,
  takeProfit: 115,
  tierScore: 85,
  atrPct4h: 3.2,
  rsi14: 55,
  bullRegime: true,
  source: "icr",
  thesis: "ICR long on SOLUSDT 4h: impulse + pullback + compression trigger",
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(response: unknown, ok = true, status = 200) {
  globalThis.fetch = (async () => ({
    ok,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
  })) as typeof fetch;
}

function toolResponse(input: Record<string, unknown>) {
  return {
    content: [{ type: "tool_use", name: "judge_trade", input }],
  };
}

// ─── buildPrompt ─────────────────────────────────────────────────────────────

test("buildPrompt: includes symbol, direction, prices, and computed R:R", () => {
  const prompt = buildPrompt(baseInput);
  assert.ok(prompt.includes("SOLUSDT"));
  assert.ok(prompt.includes("long"));
  assert.ok(prompt.includes("100"));
  assert.ok(prompt.includes("3.00:1")); // (115-100)/(100-95) = 3
});

// ─── judgeTradeWithOpus ──────────────────────────────────────────────────────

test("judgeTradeWithOpus: parses a valid tool_use response", async () => {
  mockFetch(toolResponse({ approved: true, confidence: 0.82, reasoning: "Clean structure, favorable R:R." }));
  const result = await judgeTradeWithOpus(baseInput, "fake-key");
  assert.equal(result.approved, true);
  assert.equal(result.confidence, 0.82);
  assert.equal(result.reasoning, "Clean structure, favorable R:R.");
});

test("judgeTradeWithOpus: throws when API key is missing", async () => {
  await assert.rejects(() => judgeTradeWithOpus(baseInput, ""), /ANTHROPIC_API_KEY/);
});

test("judgeTradeWithOpus: throws on non-200 response", async () => {
  mockFetch({ error: "rate_limited" }, false, 429);
  await assert.rejects(() => judgeTradeWithOpus(baseInput, "fake-key"), /Anthropic API 429/);
});

test("judgeTradeWithOpus: throws when no tool_use block is present", async () => {
  mockFetch({ content: [{ type: "text", text: "I decline to use the tool." }] });
  await assert.rejects(() => judgeTradeWithOpus(baseInput, "fake-key"), /did not return a judge_trade/);
});

test("judgeTradeWithOpus: throws on malformed tool input (wrong types)", async () => {
  mockFetch(toolResponse({ approved: "yes", confidence: 0.5, reasoning: "ok" }));
  await assert.rejects(() => judgeTradeWithOpus(baseInput, "fake-key"), /Malformed judge_trade/);
});

test("judgeTradeWithOpus: throws when confidence is out of 0-1 range", async () => {
  mockFetch(toolResponse({ approved: true, confidence: 1.5, reasoning: "ok" }));
  await assert.rejects(() => judgeTradeWithOpus(baseInput, "fake-key"), /out of range/);
});

test("judgeTradeWithOpus: sends the model, tool_choice, and API headers correctly", async () => {
  let capturedBody: any;
  let capturedHeaders: any;
  globalThis.fetch = (async (_url: any, opts: any) => {
    capturedBody = JSON.parse(opts.body);
    capturedHeaders = opts.headers;
    return {
      ok: true,
      status: 200,
      json: async () => toolResponse({ approved: false, confidence: 0.3, reasoning: "Stop too tight relative to ATR." }),
    };
  }) as typeof fetch;

  await judgeTradeWithOpus(baseInput, "fake-key");

  assert.equal(capturedBody.model, "claude-opus-4-8");
  assert.equal(capturedBody.tool_choice.name, "judge_trade");
  assert.equal(capturedHeaders["x-api-key"], "fake-key");
  assert.equal(capturedHeaders["anthropic-version"], "2023-06-01");
});
