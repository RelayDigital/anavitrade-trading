#!/usr/bin/env node
'use strict';
/**
 * CORTEX module: metacognitive-train
 *
 * Health-gated metacognitive model trainer. Runs the full pipeline:
 *   1. Build training data from klines
 *   2. Train LightGBM + isotonic calibration + adversary
 *   3. Verify: AUC improved (or at least didn't degrade below floor)
 *
 * Usage:
 *   node scripts/cortex/modules/metacognitive-train.js
 *   CORTEX_DATASET=scripts/data/training-data-mtf-v3.json \
 *   CORTEX_MODEL_DIR=scripts/data/models/meta-vN \
 *     node scripts/cortex/modules/metacognitive-train.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LEDGER = path.join(__dirname, '..', 'memory', 'metacognitive-train.jsonl');
const ROOT = path.join(__dirname, '..', '..', '..');
const DATASET = process.env.CORTEX_DATASET || path.join(ROOT, 'scripts/data/training-data-mtf-v3.json');
const MODEL_DIR = process.env.CORTEX_MODEL_DIR || path.join(ROOT, 'scripts/data/models/meta-v6');

fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
fs.mkdirSync(MODEL_DIR, { recursive: true });

// ── Step 1: Check if dataset exists ──
if (!fs.existsSync(DATASET)) {
  const err = `Dataset not found: ${DATASET}`;
  console.error(err);
  fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), status: 'error', error: err }) + '\n');
  process.exit(1);
}

console.log(`[CORTEX:metacognitive-train] Dataset: ${DATASET}`);
console.log(`[CORTEX:metacognitive-train] Model dir: ${MODEL_DIR}`);

// ── Step 2: Read previous AUC for comparison ──
let previousAuc = 0;
const metaStatePath = path.join(MODEL_DIR, 'meta_state.json');
if (fs.existsSync(metaStatePath)) {
  try {
    const prev = JSON.parse(fs.readFileSync(metaStatePath, 'utf8'));
    previousAuc = prev.auc || 0;
    console.log(`[CORTEX:metacognitive-train] Previous AUC: ${previousAuc.toFixed(4)}`);
  } catch (e) {}
}

// ── Step 3: Run training ──
console.log(`[CORTEX:metacognitive-train] Training...`);
const result = spawnSync('python3', [
  path.join(ROOT, 'scripts/ml/metacognitive.py'),
  'train',
  '--data', DATASET,
  '--model-dir', MODEL_DIR,
], {
  cwd: ROOT,
  timeout: 300000,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});

const stdout = result.stdout || '';
const stderr = result.stderr || '';

// ── Step 4: Extract metrics from training output ──
let auc = 0, brier = 1, threshold = 0.5, passRate = 0;

const aucMatch = stdout.match(/Avg AUC:\s+([\d.]+)/);
if (aucMatch) auc = parseFloat(aucMatch[1]);

const brierMatch = stdout.match(/Avg Brier:\s+([\d.]+)/);
if (brierMatch) brier = parseFloat(brierMatch[1]);

const thresholdMatch = stdout.match(/Threshold \(1-wr\):\s+([\d.]+)/);
if (thresholdMatch) threshold = parseFloat(thresholdMatch[1]);

const passMatch = stdout.match(/Bars above threshold:\s+[\d]+\/[\d]+\s+\(([\d.]+)%\)/);
if (passMatch) passRate = parseFloat(passMatch[1]);

// ── Step 5: Verify — health gate ──
const AUC_FLOOR = 0.55;  // Below this, model is worse than random
const BRIER_CEILING = 0.26;  // Above this, calibration is broken
const improvement = auc - previousAuc;
const degraded = improvement < -0.03;  // More than 3% AUC drop

const entry = {
  ts: new Date().toISOString(),
  status: 'trained',
  dataset: path.basename(DATASET),
  model_dir: MODEL_DIR,
  auc: Math.round(auc * 10000) / 10000,
  brier: Math.round(brier * 10000) / 10000,
  threshold: Math.round(threshold * 10000) / 10000,
  pass_rate_pct: Math.round(passRate * 100) / 100,
  previous_auc: Math.round(previousAuc * 10000) / 10000,
  improvement: Math.round(improvement * 10000) / 10000,
  exit_code: result.status,
  health: {},
};

// Health checks
const failures = [];
if (result.status !== 0) failures.push(`Training exited ${result.status}`);
if (auc < AUC_FLOOR) failures.push(`AUC ${auc.toFixed(4)} < floor ${AUC_FLOOR}`);
if (brier > BRIER_CEILING) failures.push(`Brier ${brier.toFixed(4)} > ceiling ${BRIER_CEILING}`);
if (degraded) failures.push(`AUC degraded ${improvement.toFixed(4)} from ${previousAuc.toFixed(4)}`);

entry.health.passed = failures.length === 0;
entry.health.failures = failures;
entry.health.improved = improvement > 0.005;

// ── Step 6: Write ledger ──
fs.appendFileSync(LEDGER, JSON.stringify(entry) + '\n');

// ── Step 7: Report ──
console.log(`\n[CORTEX:metacognitive-train] RESULTS:`);
console.log(`  AUC: ${auc.toFixed(4)} (prev: ${previousAuc.toFixed(4)}, delta: ${improvement.toFixed(4)})`);
console.log(`  Brier: ${brier.toFixed(4)}`);
console.log(`  Threshold: ${threshold.toFixed(4)}, Pass rate: ${passRate.toFixed(1)}%`);
console.log(`  Health: ${entry.health.passed ? 'PASS' : 'FAIL'} — ${failures.length ? failures.join('; ') : 'all checks passed'}`);

if (!entry.health.passed) {
  // Alarm but don't exit non-zero — CORTEX records the alarm, doesn't crash
  console.error(`[CORTEX:ALARM] metacognitive-train health check failed`);
}

process.exit(0);  // Always exit 0 — CORTEX reads the ledger, not the exit code
