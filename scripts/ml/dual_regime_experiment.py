#!/usr/bin/env python3
"""
Dual-regime ML experiment: test whether training two regime-specific models
(OVERSOLD_REVERSAL vs MOMENTUM_CONTINUATION) recovers edge that gets averaged
away in a single pooled model.

Background: the false-negative study (commit ddda40c) found the two regimes
are statistically distinct populations (Mann-Whitney U, p<0.0001 on RSI,
stoch, AO, MACD, swing_dist). unified-engine.ts already classifies regime in
production but scores each with a hand-tuned formula, not a trained model.
This script trains one LightGBM model per regime on real labeled data and
compares each regime's standalone metrics against the pooled meta-v24 model.

Regime split approximates src/server/signals/unified-engine.ts::classifyRegime.
Two known deviations from the TS logic, called out because they matter:
  1. No MACD field exists in this Python feature pipeline (features.py never
     computes it), so the MACD>-0.5 condition is dropped here.
  2. TS's `ao > -1` / `ao > -0.5` thresholds use raw (unnormalized) AO, which
     is on a different scale per pair (e.g. BTC's ao_value ~ -300, an altcoin's
     ~ -0.01). That threshold is effectively meaningless cross-pair. This
     script uses ao_value > 0 (sign only) instead, which is scale-invariant.

Usage:
  python3 -m scripts.ml.dual_regime_experiment --input scripts/data/training-data-1h-extended.json
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from scripts.ml.pipeline.config import DEFAULT
from scripts.ml.pipeline.model import train_chronological, save_model


def classify_regime(row: dict) -> str:
    rsi = row.get("rsi", 50.0)
    if rsi < 35:
        return "OVERSOLD_REVERSAL"
    ao = row.get("ao_value", 0.0)
    swing_dist = row.get("swing_dist_atr", 999.0)
    if ao > 0 and rsi >= 35 and swing_dist < 2:
        return "MOMENTUM_CONTINUATION"
    return "MOMENTUM_CONTINUATION"  # same default fallback as production


def load_rows(path: str) -> list:
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def summarize(name: str, artifacts: dict) -> str:
    return (
        f"{name:24s} n={artifacts['train_rows'] + artifacts['test_rows']:>7,} "
        f"AUC={artifacts['test_auc']:.3f} WR={artifacts['test_wr']*100:5.1f}% "
        f"PF={artifacts['test_pf']:.2f} trades={artifacts['test_trades']:>4} "
        f"pass_rate={artifacts['test_pass_rate']:.3f}%"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--version-prefix", default="meta-v25")
    args = parser.parse_args()

    print(f"Loading {args.input}...")
    rows = load_rows(args.input)
    print(f"  {len(rows):,} rows")

    oversold, continuation = [], []
    for row in rows:
        (oversold if classify_regime(row) == "OVERSOLD_REVERSAL" else continuation).append(row)

    print(f"\nRegime split:")
    print(f"  OVERSOLD_REVERSAL:     {len(oversold):>7,} rows ({len(oversold)/len(rows)*100:.1f}%)")
    print(f"  MOMENTUM_CONTINUATION: {len(continuation):>7,} rows ({len(continuation)/len(rows)*100:.1f}%)")

    models_root = Path(__file__).resolve().parent.parent.parent / "scripts" / "data" / "models"
    results = {}

    for label, subset in [("OVERSOLD_REVERSAL", oversold), ("MOMENTUM_CONTINUATION", continuation)]:
        if len(subset) < 500:
            print(f"\nSkipping {label}: only {len(subset)} rows, too few to train.")
            continue
        print(f"\nTraining {label} model ({len(subset):,} rows)...")
        artifacts = train_chronological(subset, DEFAULT)
        version = f"{args.version_prefix}-{label.lower().replace('_', '-')}"
        save_model(artifacts, models_root / version)
        results[label] = artifacts
        print(f"  Saved to scripts/data/models/{version}")

    print(f"\n{'='*100}")
    print("COMPARISON (pooled meta-v24-extended-window: AUC=0.531 WR=44.4% PF=2.00 trades=54 pass_rate=0.050%)")
    print(f"{'='*100}")
    for label, artifacts in results.items():
        print(summarize(label, artifacts))


if __name__ == "__main__":
    main()
