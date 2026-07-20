/**
 * Dispatch Gate — the single, ordered decision layer for every TradeIntent.
 *
 * PRD R1.1 / R1.3 (docs/prd/2026-07-16-unified-algo-development-integration.md §4).
 * This module owns the ordered gate logic. It is intentionally PURE (no DB, no
 * network, no Worker globals) so it is unit-testable in isolation and free of
 * side effects. All IO (kline fetch, ML inference call, persistence) lives in
 * src/server/execution/dispatch.ts, which feeds pre-computed scalars in here.
 *
 * The canonical entry point is re-exported from ./unified-engine.ts so that
 * "all dispatch flows through one decision layer in unified-engine.ts" holds
 * while keeping this file small and focused (coding-style: many small files).
 *
 * Evaluation order (EXACT — do not reorder; empirical + PRD mandated):
 *   1. Universe gate      — alt-only; majors + 4h ATP% < 2 rejected
 *   2. Tier gate          — Tier A (>= 80) live; Tier B (65-79) paper-only
 *   3. RSI extension gate — no chasing: reject long >= 70 / short <= 30
 *   4. Regime gate        — longs half-size unless bull regime (MA200 slope +)
 *   5. Judgment gate       — Opus confidence >= threshold (src/server/analysis/
 *                            llm-trade-judge.ts; replaced the statistical ML
 *                            score once its locked walk-forward test proved
 *                            it had no usable edge — see
 *                            docs/prd/2026-07-17-honest-ml-validation-gate.md)
 *   (6. Risk engine decideExecution() runs downstream per-connection, unchanged)
 *
 * Fail-closed (R1.3): if scoring is impossible (Opus unreachable OR the
 * market data required to score is unavailable) the gate REJECTS with
 * gate_result='ml_unreachable'. It never falls back to unjudged dispatch.
 */

/* ─── Config (no hardcoded thresholds — sourced from empirical findings / card) ─ */

export const GATE_CONFIG = {
  /** Majors are net-negative on the ICR edge — excluded from auto-dispatch. */
  majors: ["BTCUSDT", "ETHUSDT", "BNBUSDT"] as readonly string[],
  /** Alt-only universe requires >= 2% 4h ATR (EMPIRICAL_FINDINGS §"Edge is on Alts"). */
  minAtrPct4h: 2,
  /** Tier A: score >= 80 trades live (avgR +0.21, profitable). */
  tierAScore: 80,
  /** Tier B: 65-79 is losing (avgR -0.21) → paper book only, never dispatched. */
  tierBScore: 65,
  /** RSI extension filter (EMPIRICAL_FINDINGS: +6.5% TotalR). */
  rsiMax: 70,
  rsiMin: 30,
  /** Longs get half size in a non-bull regime (shorts unaffected). */
  regimeHalfSizeFactor: 0.5,
} as const;

/**
 * Confidence threshold for the Opus trade-judgment gate (src/server/analysis/
 * llm-trade-judge.ts), which replaced the statistical ML score. The old
 * value (modelCard.threshold, 0.52) was calibrated for meta-v22-definitive's
 * LightGBM output distribution — meaningless once the score comes from an
 * LLM's own 0-1 confidence scale instead. 0.65 is a starting value, not
 * backtest-derived (there is no historical corpus of Opus judgments to
 * calibrate against yet) — tune once live confirm/reject outcomes accumulate.
 * Name kept as ML_THRESHOLD (not renamed) because it feeds the same
 * `mlScore`/`mlThreshold` fields throughout this file, dispatch.ts, and the
 * ml_inferences table — only the source of the score changed.
 */
export const ML_THRESHOLD: number = 0.65;

/**
 * Above this, a signal is high-conviction enough to enter immediately at
 * market (unchanged legacy behavior). Between ML_THRESHOLD and this value,
 * the signal is real but marginal — see "entry confirmation band" below.
 * Starting value, not backtest-derived; tune once live data accumulates.
 */
export const ML_CONFIRM_THRESHOLD: number = ML_THRESHOLD + 0.1;

/* ─── Types ──────────────────────────────────────────────────────────────── */

export type GateDirection = "long" | "short";

/**
 * Named gate result persisted to ml_inferences.gate_result. "passed" means the
 * intent cleared all pre-risk gates and proceeds to decideExecution().
 */
export type GateResult =
  | "passed"
  | "passed_confirm"
  | "universe"
  | "tier_b_paper"
  | "tier_c_reject"
  | "rsi_extension"
  | "ml"
  | "ml_unreachable";

/**
 * "market": dispatch immediately at market (high-conviction, mlScore >= ML_CONFIRM_THRESHOLD).
 * "limit_confirm": real edge but marginal score — dispatch as a LIMIT order pulled back
 * toward the stop instead of chasing at market, so price action itself provides
 * confirmation before the order can fill.
 */
export type EntryMode = "market" | "limit_confirm";

export interface GateInput {
  symbol: string;
  direction: GateDirection;
  /** Coinlegs quality score (0-100). */
  tierScore: number;
  /** 4h ATR as a percentage of last close. */
  atrPct4h: number;
  /** RSI(14) on the entry timeframe. */
  rsi14: number;
  /** True when MA200 slope is positive (bull regime) on the pair's 4h series. */
  bullRegime: boolean;
  /** Calibrated model probability, or null when it could not be produced. */
  mlScore: number | null;
  /** Decision threshold (defaults to the model card value). */
  mlThreshold?: number;
  /** Confirmation-band threshold (defaults to ML_CONFIRM_THRESHOLD). */
  mlConfirmThreshold?: number;
  /** True when the inference call itself failed / was unreachable (R1.3). */
  mlUnreachable: boolean;
  /**
   * True when the market data required by the universe / RSI / regime gates is
   * available. When false, scoring is impossible → fail closed (ml_unreachable).
   */
  marketDataAvailable: boolean;
}

export interface GateDecision {
  /** Cleared all gates → proceed to per-connection risk engine + dispatch. */
  approved: boolean;
  /** Record the intent but do NOT dispatch (Tier B counterfactual book). */
  paperOnly: boolean;
  /** The gate that decided the outcome (or "passed"). Persisted to D1. */
  gateResult: GateResult;
  /** Human-readable reason for audit logs. */
  reason: string;
  /** Position-size multiplier from the regime gate (1.0 or 0.5). */
  sizeFactor: number;
  /** How the entry should be triggered — see EntryMode. "market" on any non-approved path. */
  entryMode: EntryMode;
}

/* ─── Pure gate evaluation (ordered) ─────────────────────────────────────── */

/**
 * Evaluate the ordered dispatch gate. Pure and deterministic.
 *
 * @returns immutable GateDecision. Never mutates its inputs.
 */
export function evaluateDispatchGate(
  input: GateInput,
  cfg: typeof GATE_CONFIG = GATE_CONFIG,
): GateDecision {
  const threshold = input.mlThreshold ?? ML_THRESHOLD;
  const symbol = input.symbol.toUpperCase();

  const reject = (gateResult: GateResult, reason: string): GateDecision => ({
    approved: false,
    paperOnly: false,
    gateResult,
    reason,
    sizeFactor: 0,
    entryMode: "market",
  });

  /* ── 1. Universe gate ───────────────────────────────────────────────── */
  if (cfg.majors.includes(symbol)) {
    return reject("universe", `major_excluded:${symbol}`);
  }
  // Fail closed when the data needed to verify the universe / score is absent.
  // Scoring is mandatory (R1.3): without market data we cannot score, so we
  // must not dispatch.
  if (!input.marketDataAvailable) {
    return reject("ml_unreachable", "market_data_unavailable");
  }
  if (input.atrPct4h < cfg.minAtrPct4h) {
    return reject(
      "universe",
      `atr_pct_below_min:${input.atrPct4h.toFixed(3)}<${cfg.minAtrPct4h}`,
    );
  }

  /* ── 2. Tier gate ───────────────────────────────────────────────────── */
  if (input.tierScore < cfg.tierBScore) {
    return reject("tier_c_reject", `tier_c_score:${input.tierScore}`);
  }
  if (input.tierScore < cfg.tierAScore) {
    // Tier B → paper book only. Recorded, never dispatched.
    return {
      approved: false,
      paperOnly: true,
      gateResult: "tier_b_paper",
      reason: `tier_b_score:${input.tierScore}`,
      sizeFactor: 0,
      entryMode: "market",
    };
  }

  /* ── 3. RSI extension gate ──────────────────────────────────────────── */
  if (input.direction === "long" && input.rsi14 >= cfg.rsiMax) {
    return reject("rsi_extension", `long_rsi_extended:${input.rsi14.toFixed(1)}`);
  }
  if (input.direction === "short" && input.rsi14 <= cfg.rsiMin) {
    return reject("rsi_extension", `short_rsi_extended:${input.rsi14.toFixed(1)}`);
  }

  /* ── 4. Regime gate (sizing only — never rejects) ───────────────────── */
  const sizeFactor =
    input.direction === "long" && !input.bullRegime
      ? cfg.regimeHalfSizeFactor
      : 1.0;

  /* ── 5. Judgment gate — Opus confidence (fail closed) ─────────────────── */
  if (input.mlUnreachable || input.mlScore === null) {
    return reject("ml_unreachable", "inference_unreachable");
  }
  if (input.mlScore < threshold) {
    return reject(
      "ml",
      `score_below_threshold:${input.mlScore.toFixed(4)}<${threshold}`,
    );
  }

  /* ── Entry confirmation band (graduated conviction, mirrors Pine v7) ──── */
  // A score just above the reject threshold is real edge but not strong
  // enough to chase at market: dispatch as a LIMIT order pulled back toward
  // the stop instead (see dispatch.ts), so price action confirms before fill.
  const confirmThreshold = input.mlConfirmThreshold ?? ML_CONFIRM_THRESHOLD;
  const entryMode: EntryMode = input.mlScore >= confirmThreshold ? "market" : "limit_confirm";
  const gateResult: GateResult = entryMode === "market" ? "passed" : "passed_confirm";

  /* ── Passed all pre-risk gates ──────────────────────────────────────── */
  return {
    approved: true,
    paperOnly: false,
    gateResult,
    reason: `${gateResult}:score=${input.mlScore.toFixed(4)};size=${sizeFactor};entry=${entryMode}`,
    sizeFactor,
    entryMode,
  };
}

/**
 * How far to pull the entry back toward the stop-loss for a "limit_confirm"
 * entry (0 = original entry, 1 = the stop itself). Starting value, not
 * backtest-derived; tune once live confirmation-band fills accumulate.
 */
export const CONFIRM_PULLBACK_FRACTION = 0.3;

/**
 * Confirmation-band entry price for a marginal-conviction ("limit_confirm")
 * signal: pulls the entry back partway toward the stop-loss so the order
 * only fills if price actually retraces toward invalidation, instead of
 * chasing an extended move on a score that barely cleared ML_THRESHOLD.
 * Result always lies strictly between `stopLoss` and `entry` for
 * `0 < pullbackFraction < 1`.
 */
export function computeConfirmationPrice(
  entry: number,
  stopLoss: number,
  direction: GateDirection,
  pullbackFraction: number = CONFIRM_PULLBACK_FRACTION,
): number {
  const frac = Math.min(1, Math.max(0, pullbackFraction));
  return direction === "long"
    ? entry - (entry - stopLoss) * frac
    : entry + (stopLoss - entry) * frac;
}

/* ─── Pure indicator helpers (for the wiring layer to feed the gate) ─────── */

/** Wilder-free SMA of true range → ATR%. Returns 0 when insufficient data. */
export function computeAtrPct(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number {
  const n = Math.min(highs.length, lows.length, closes.length);
  if (n < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trs.push(tr);
  }
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  const lastClose = closes[n - 1];
  return lastClose > 0 ? (atr / lastClose) * 100 : 0;
}

/** RSI(14) on a close series. Returns 50 (neutral) when insufficient data. */
export function computeRsi14(closes: number[], period = 14): number {
  const n = closes.length;
  if (n < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = n - period; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Regime detection: MA200 slope positive on the supplied close series.
 *
 * DESIGN CHOICE (documented per PRD R1.1 step 4): the slope is measured on the
 * pair's 4h closes, not 1d. 4h kline data is what the pipeline reliably fetches
 * and stores (inference and the scraper both operate on 4h); 1d series are not
 * consistently populated in D1. 200 x 4h ≈ 33 days, a meaningful medium-term
 * trend for the alt universe. Slope is the linear-regression slope over the
 * last `slopeWindow` MA200 points.
 */
export function isBullRegime(closes: number[], slopeWindow = 10): boolean {
  const period = 200;
  const n = closes.length;
  if (n < period + slopeWindow) return false;
  const ma200: number[] = [];
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    ma200.push(sum / period);
  }
  const win = ma200.slice(-slopeWindow);
  if (win.length < 2) return false;
  // Linear-regression slope sign.
  const len = win.length;
  const xs = Array.from({ length: len }, (_, i) => i);
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = win.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * win[i], 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);
  const denom = len * sumX2 - sumX * sumX;
  if (denom === 0) return false;
  const slope = (len * sumXY - sumX * sumY) / denom;
  return slope > 0;
}
