#!/usr/bin/env npx tsx
/**
 * Metacognitive Inference Wrapper for Production (Cloudflare Worker / Node.js).
 *
 * Lightweight TypeScript implementation of the metacognitive scoring pipeline.
 * Loads serialized model artifacts and performs inference without Python dependency.
 *
 * The Python metacognitive.py handles training. This handles production inference.
 *
 * Usage:
 *   import { MetaCognitiveScorer } from './metacognitive-inference';
 *   const scorer = await MetaCognitiveScorer.load('scripts/data/models/meta');
 *   const result = scorer.score(featureVector);
 *   scorer.recordOutcome(featureVector, { win: true, pnlR: 2.4 });
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────

export interface FeatureVector {
  [name: string]: number;
}

export interface ScoredSignal {
  metaConfidence: number;
  kellyFraction: number;
  positionSizePct: number;
  signal: "trade" | "skip";
  tier: "A" | "B" | "C";
  regime: string;
  breakdown: {
    rawProb: number;
    calibratedProb: number;
    regimeMult: number;
    advMult: number;
    driftMult: number;
    recencyMult: number;
  };
  warnings: Warning[];
}

export interface Warning {
  type: string;
  severity: "high" | "medium" | "info";
  msg: string;
}

export interface TradeOutcome {
  win: boolean;
  predictedProb?: number;
  pnlR?: number;
}

// ─── REGIME DETECTION ──────────────────────────────────────────────────

function detectRegime(f: FeatureVector): string {
  const atrPct = f["4h_atr_percentile"] ?? 0.5;
  const maSep = f["4h_ma_separation"] ?? 0;
  const bbW = f["4h_bb_width_pct"] ?? 0.5;
  const volZ = f["4h_volume_zscore"] ?? 0;

  if (maSep > 0.02 && bbW > 0.6 && atrPct > 0.5) return "strong_trend";
  if (maSep > 0.005 && bbW > 0.4) return "weak_trend";
  if (bbW < 0.3 && volZ > 1.0 && atrPct > 0.4) return "breakout";
  if (atrPct > 0.85) return "volatile";
  if (atrPct < 0.15 && volZ < -1.0) return "quiet";
  return "ranging";
}

// ─── RECENCY TRACKER ───────────────────────────────────────────────────

class RecencyTracker {
  private trades: { win: boolean; prob: number }[] = [];
  private readonly maxLen = 100;

  push(win: boolean, prob: number): void {
    this.trades.push({ win, prob });
    if (this.trades.length > this.maxLen) this.trades.shift();
  }

  getEMA(expectedWr = 0.5): number {
    if (this.trades.length < 10) return 1.0;
    const alpha = 2.0 / 21.0;
    let emaActual = 0.5;
    let emaExpected = 0.5;
    const recent = this.trades.slice(-20);
    for (const t of recent) {
      emaActual = alpha * (t.win ? 1 : 0) + (1 - alpha) * emaActual;
      emaExpected = alpha * t.prob + (1 - alpha) * emaExpected;
    }
    const perfRatio = emaActual / Math.max(emaExpected, 0.01);
    return Math.max(0.3, Math.min(1.7, 0.5 + 1.0 / (1.0 + Math.exp(-5.0 * (perfRatio - 1.0)))));
  }

  getRecentBrier(): number {
    if (this.trades.length < 20) return 0;
    const recent = this.trades.slice(-50);
    return recent.reduce((s, t) => s + (t.win ? 1 - t.prob : t.prob) ** 2, 0) / recent.length;
  }
}

// ─── MAIN SCORER CLASS ──────────────────────────────────────────────────

export class MetaCognitiveScorer {
  private edgeMatrix: Record<string, { weight: number }>;
  private trainingDist: { mean: number[]; std: number[] };
  private recency: RecencyTracker;
  private driftThreshold = 2.0;

  private constructor(
    private featureNames: string[],
    edgeMatrix: Record<string, any>,
    trainingDist: { mean: number[]; std: number[] },
  ) {
    this.edgeMatrix = edgeMatrix;
    this.trainingDist = trainingDist;
    this.recency = new RecencyTracker();
  }

  static async load(modelDir: string): Promise<MetaCognitiveScorer> {
    // Load feature names
    const fnPath = join(modelDir, "feature_names.json");
    if (!existsSync(fnPath)) throw new Error(`Feature names not found: ${fnPath}`);
    const featureNames: string[] = JSON.parse(readFileSync(fnPath, "utf8"));

    // Load edge matrix
    const emPath = join(modelDir, "edge_matrix.json");
    const edgeMatrix = existsSync(emPath)
      ? JSON.parse(readFileSync(emPath, "utf8"))
      : {};

    // Load training distribution
    const tdPath = join(modelDir, "training_dist.json");
    const trainingDist = existsSync(tdPath)
      ? JSON.parse(readFileSync(tdPath, "utf8"))
      : { mean: [], std: [] };

    return new MetaCognitiveScorer(featureNames, edgeMatrix, trainingDist);
  }

  /**
   * Score a feature vector and return metacognitive output.
   * This is the LOCAL scoring — use the Python infer command for the full
   * LightGBM model inference. This method applies the regime, drift, and
   * recency layers on top of a base probability you provide.
   */
  score(features: FeatureVector, baseProb?: number): ScoredSignal {
    // Build feature array
    const x = this.featureNames.map(f => features[f] ?? 0.0);

    // ── Layer 1: Base probability (provided externally or estimated) ──
    const rawProb = baseProb ?? 0.55;  // If no model, default to coin-flip+

    // ── Layer 2: Regime ──
    const regime = detectRegime(features);
    const regimeInfo = this.edgeMatrix[regime] ?? { weight: 0.5 };
    const regimeMult = regimeInfo.weight ?? 0.5;

    // ── Layer 3: Drift ──
    let driftMult = 1.0;
    let drifting = false;
    if (this.trainingDist.mean.length > 0) {
      let totalKl = 0;
      for (let i = 0; i < Math.min(x.length, this.trainingDist.mean.length); i++) {
        const p = Math.abs(x[i]) + 1e-10;
        const q = Math.abs(this.trainingDist.mean[i]) + 1e-10;
        totalKl += Math.abs(p * Math.log(p / q));
      }
      drifting = totalKl > this.driftThreshold;
      driftMult = drifting ? 0.4 : 1.0;
    }

    // ── Layer 4: Recency ──
    const recencyMult = this.recency.getEMA(rawProb);

    // ── FUSION ──
    let metaConfidence = rawProb * regimeMult * driftMult * recencyMult;
    metaConfidence = Math.max(0.01, Math.min(0.99, metaConfidence));

    const edge = 2.0 * metaConfidence - 1.0;
    const kelly = Math.max(0, edge) * 0.5;

    // Warnings
    const warnings: Warning[] = [];
    if (drifting) warnings.push({ type: "DRIFT", severity: "high", msg: "Feature distribution shifted" });
    if (regimeMult < 0.5) warnings.push({ type: "LOW_REGIME", severity: "medium", msg: `Regime '${regime}' has weak historical edge` });
    if (recencyMult < 0.7) warnings.push({ type: "RECENCY", severity: "medium", msg: "Recent performance below expectation" });

    return {
      metaConfidence: Math.round(metaConfidence * 10000) / 10000,
      kellyFraction: Math.round(kelly * 10000) / 10000,
      positionSizePct: Math.round(kelly * 1000) / 10,
      signal: metaConfidence > 0.55 ? "trade" : "skip",
      tier: metaConfidence > 0.70 ? "A" : metaConfidence > 0.55 ? "B" : "C",
      regime,
      breakdown: {
        rawProb: Math.round(rawProb * 10000) / 10000,
        calibratedProb: Math.round(rawProb * 10000) / 10000,  // No isotonic in JS
        regimeMult: Math.round(regimeMult * 1000) / 1000,
        advMult: 1.0,  // No adversary in JS
        driftMult: Math.round(driftMult * 1000) / 1000,
        recencyMult: Math.round(recencyMult * 1000) / 1000,
      },
      warnings,
    };
  }

  /** Record a trade outcome for recency tracking. */
  recordOutcome(features: FeatureVector, outcome: TradeOutcome): void {
    this.recency.push(outcome.win, outcome.predictedProb ?? 0.5);
  }

  /** Get current metacognitive state summary. */
  getState() {
    return {
      recentBrier: this.recency.getRecentBrier(),
      tradeCount: (this.recency as any).trades?.length ?? 0,
    };
  }
}

// ─── CLI ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const modelDir = args.includes("--model-dir")
    ? args[args.indexOf("--model-dir") + 1]
    : "scripts/data/models/meta";

  const scorer = await MetaCognitiveScorer.load(modelDir);

  if (cmd === "score") {
    const inputPath = args.includes("--input")
      ? args[args.indexOf("--input") + 1]
      : args[1];
    if (!inputPath) {
      console.error("Usage: npx tsx scripts/ml/metacognitive-inference.ts score <features.json>");
      process.exit(1);
    }
    const features = JSON.parse(readFileSync(inputPath, "utf8"));
    const result = scorer.score(features);
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "feedback") {
    const outcome = JSON.parse(args.includes("--outcome")
      ? args[args.indexOf("--outcome") + 1]
      : args[1]);
    scorer.recordOutcome(outcome.features ?? {}, outcome);
    console.log(JSON.stringify(scorer.getState(), null, 2));
  } else {
    console.log("Metacognitive Inference Wrapper");
    console.log("  score <features.json>       — Score a feature vector");
    console.log("  feedback <outcome.json>     — Record a trade outcome");
    console.log(`  State: ${JSON.stringify(scorer.getState())}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
