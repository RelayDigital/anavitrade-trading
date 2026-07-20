/**
 * Opus trade-judgment gate — replaces the statistical ML score at step 5 of
 * the shared dispatch gate (src/server/signals/dispatch-gate.ts).
 *
 * Why: the locked walk-forward test (scripts/data/models/locked-gate-2026-07-18/
 * report.json, docs/prd/2026-07-17-honest-ml-validation-gate.md) proved
 * meta-v22-definitive has no usable edge — calibrated probabilities never
 * exceed 0.243 against a 0.52 threshold, so the old ML gate rejected
 * essentially everything platform-wide, from every source, regardless of
 * tier quality. Rather than patch a proven-uninformative model or bypass
 * gating entirely, this asks Claude Opus to judge each candidate directly —
 * a fundamentally different evaluation mechanism than a frozen LightGBM
 * classifier, using the same structured context (entry/stop/RR, tier,
 * regime, RSI, ATR%) a human risk reviewer would look at.
 *
 * Wiring: dispatch.ts::runDispatchGate calls judgeTradeWithOpus() in place
 * of the old runInference() call and feeds its confidence into the SAME
 * `mlScore` slot evaluateDispatchGate() already consumes — the pure gate
 * logic (universe/tier/RSI/regime/threshold steps) is completely unchanged.
 * Fail-closed on any API error, missing key, or malformed response, mirroring
 * the prior mlUnreachable behavior (R1.3) — a broken external dependency
 * must never fall back to unscored/unjudged dispatch.
 */

export interface TradeJudgeInput {
  symbol: string;
  direction: "long" | "short";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  tierScore: number;
  atrPct4h: number;
  rsi14: number;
  bullRegime: boolean;
  source: string;
  thesis: string;
}

export interface TradeJudgeResult {
  /** 0-1, treated as the gate's mlScore. */
  confidence: number;
  approved: boolean;
  reasoning: string;
}

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-8";
const ANTHROPIC_VERSION = "2023-06-01";

const JUDGE_TOOL = {
  name: "judge_trade",
  description:
    "Record your judgment of whether this trade candidate should be dispatched live.",
  input_schema: {
    type: "object" as const,
    properties: {
      approved: {
        type: "boolean" as const,
        description: "True if this is a good trade to take right now, false otherwise.",
      },
      confidence: {
        type: "number" as const,
        description: "0.0-1.0 confidence in the trade's risk/reward and structural soundness.",
      },
      reasoning: {
        type: "string" as const,
        description: "One or two sentences on why, referencing the specific numbers given.",
      },
    },
    required: ["approved", "confidence", "reasoning"],
  },
};

function riskReward(input: TradeJudgeInput): number {
  const risk = Math.abs(input.entry - input.stopLoss);
  const reward = Math.abs(input.takeProfit - input.entry);
  return risk > 0 ? reward / risk : 0;
}

export function buildPrompt(input: TradeJudgeInput): string {
  const rr = riskReward(input);
  return `Evaluate this ${input.direction} trade candidate for a crypto perpetual futures desk. Be a skeptical risk reviewer, not a cheerleader — most candidates that reach you have already cleared cheap structural filters, so your job is catching the ones that shouldn't go further, not rubber-stamping.

Symbol: ${input.symbol}
Direction: ${input.direction}
Entry: ${input.entry}
Stop loss: ${input.stopLoss}
Take profit: ${input.takeProfit}
Risk:Reward: ${rr.toFixed(2)}:1
Signal source: ${input.source}
Thesis: ${input.thesis}

Context:
- Tier score (structural quality, 0-100, already passed an 80+ floor): ${input.tierScore}
- 4h ATR%: ${input.atrPct4h.toFixed(2)}%
- RSI(14) on entry timeframe: ${input.rsi14.toFixed(1)}
- Bull regime (MA200 slope positive): ${input.bullRegime}

Judge on: is the stop placement structurally sound relative to ATR, is the R:R
genuinely favorable (not just numerically positive), is the entry chasing an
already-extended move (check RSI), and does the stated thesis actually match
the numbers given. Call judge_trade with your verdict.`;
}

export async function judgeTradeWithOpus(
  input: TradeJudgeInput,
  apiKey: string,
): Promise<TradeJudgeResult> {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      temperature: 0,
      tools: [JUDGE_TOOL],
      tool_choice: { type: "tool", name: "judge_trade" },
      messages: [{ role: "user", content: buildPrompt(input) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const toolUse = (data?.content ?? []).find((b: any) => b.type === "tool_use" && b.name === "judge_trade");
  if (!toolUse) throw new Error("Opus did not return a judge_trade tool call");

  const { approved, confidence, reasoning } = toolUse.input ?? {};
  if (typeof approved !== "boolean" || typeof confidence !== "number" || typeof reasoning !== "string") {
    throw new Error("Malformed judge_trade tool input");
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Confidence out of range: ${confidence}`);
  }

  return { approved, confidence, reasoning };
}
