#!/usr/bin/env python3
"""
Parameter Optimization Pipeline for ICR SMC Engine.

Uses the trained LightGBM classifier and SHAP importance values to search
for Pine Script parameter combinations that maximize predicted win probability.

The 18-parameter grid has 1.38 trillion full combinations, so we use random
search with refinement around top results. For each combination, features are
estimated via SHAP-based perturbation of the training-data baseline.

Key empirical finding: the model was trained on trades that passed the default
parameters.  Within that domain it has learned a consistent relationship:
  - Lower rr_ratio  -> higher win probability  (easier targets)
  - Lower gate scores -> higher win probability (looser filters pass more
    trade-able setups; the model sees tight gate scores as over-filtered)

The signal_rate penalty prevents degenerate "pass everything" solutions.

Usage:
  python scripts/ml/optimize-params.py
  python scripts/ml/optimize-params.py --n-samples 20000 --top-n 20
  python scripts/ml/optimize-params.py --n-samples 5000 --seed 123

Outputs:
  - Console table of top N parameter sets with scores
  - Pine Script-ready parameter preset for the best combination
  - scripts/data/models/optimal_params.json  (machine-readable results)
  - scripts/data/models/optimal_pine_params.txt  (copy-paste for Pine Script)
"""

import argparse
import json
import os
import pickle
import sys
import warnings
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

# ── Paths relative to project root ───────────────────────────────────────────
MODEL_PATH = "scripts/data/models/lgbm_classifier_final.pkl"
FEATURE_NAMES_PATH = "scripts/data/models/feature_names.json"
SHAP_PATH = "scripts/data/models/shap_importance.json"
TRAINING_DATA_PATH = "scripts/data/training-data-4h.json"

# ═══════════════════════════════════════════════════════════════════════════════
# DEFAULT PINE SCRIPT PARAMETERS  (values used to generate the training data)
# ═══════════════════════════════════════════════════════════════════════════════

DEFAULTS: Dict[str, float] = {
    "minImpulseBars": 2,
    "maxImpulseBars": 14,
    "maxSignalAge": 35,
    "impulseAtrMult": 1.2,
    "impulseVolMult": 1.0,
    "minPullbackBars": 2,
    "nearMaAtrMult": 1.5,
    "pullbackVolRatio": 1.15,
    "compressionLookback": 8,
    "compRangeRatio": 0.95,
    "compAtrRatio": 0.99,
    "compNarrowAtrMult": 4.0,
    "scoreThreshold": 65,
    "minRr": 2.0,
    "tierAThresh": 75,
    "trailAtrMult": 5.0,
    "trailActivateAtR": 4.0,
    "maxBars": 60,
}

# ═══════════════════════════════════════════════════════════════════════════════
# PARAMETER SEARCH SPACE
# ═══════════════════════════════════════════════════════════════════════════════

PARAM_SPACE: Dict[str, List] = {
    # Impulse Detection
    "minImpulseBars": [1, 2, 3, 4],
    "maxImpulseBars": [8, 10, 12, 14, 16, 20],
    "impulseAtrMult": [0.8, 1.0, 1.2, 1.5, 1.8, 2.0],
    "impulseVolMult": [0.6, 0.8, 1.0, 1.2, 1.5],
    "maxSignalAge": [20, 28, 35, 42, 50],
    # Compression
    "compressionLookback": [5, 6, 8, 10, 12],
    "compRangeRatio": [0.85, 0.90, 0.95, 0.99],
    "compAtrRatio": [0.85, 0.90, 0.95, 0.99],
    "compNarrowAtrMult": [2.0, 3.0, 4.0, 5.0, 6.0],
    # Pullback
    "minPullbackBars": [1, 2, 3, 4],
    "nearMaAtrMult": [1.0, 1.5, 2.0, 2.5],
    "pullbackVolRatio": [1.0, 1.15, 1.25, 1.5],
    # Scoring
    "scoreThreshold": [50, 55, 60, 65, 70, 75],
    "minRr": [1.5, 2.0, 2.5, 3.0, 4.0],
    "tierAThresh": [65, 70, 75, 80, 85],
    # Exit Trail
    "trailAtrMult": [3.0, 4.0, 5.0, 6.0, 7.0],
    "trailActivateAtR": [2.0, 3.0, 4.0, 5.0],
    "maxBars": [40, 50, 60, 80, 100],
}

# ═══════════════════════════════════════════════════════════════════════════════
# FEATURE-TO-PARAMETER MAPPING
# ═══════════════════════════════════════════════════════════════════════════════
# For each gate feature we list (param_name, direction, strength).
#   direction = +1: higher param → higher expected feature value
#   direction = -1: higher param → lower expected feature value
#   strength: how strongly (0-1) this param influences the feature value

GATE_PARAM_MAP: Dict[str, List[Tuple[str, int, float]]] = {
    "impulse_score": [
        # Higher ATR mult → harder to qualify → FEWER impulse signals
        # → lower avg impulse_score on generated trades
        ("impulseAtrMult", -1, 0.50),
        ("impulseVolMult", -1, 0.25),
        # More bars allowed → more setups → but each setup may score lower
        ("maxImpulseBars", -1, 0.15),
        # Longer max age → more stale signals pass → lower average quality
        ("maxSignalAge", -1, 0.10),
    ],
    "pullback_score": [
        # Higher MA distance threshold → looser pullback → more pass → lower avg score
        ("nearMaAtrMult", -1, 0.45),
        # Higher vol ratio → stricter → fewer pass → higher avg score
        ("pullbackVolRatio", 1, 0.35),
        ("minPullbackBars", -1, 0.20),
    ],
    "compression_score": [
        # Lower range ratio → tighter compression required → fewer pass → higher avg
        ("compRangeRatio", -1, 0.35),
        # Lower ATR ratio → tighter → fewer pass → higher avg
        ("compAtrRatio", -1, 0.35),
        # Lower narrow mult → stricter → fewer pass → higher avg
        ("compNarrowAtrMult", -1, 0.20),
        ("compressionLookback", 1, 0.10),
    ],
    "trend_score": [
        ("impulseAtrMult", -1, 0.30),
        ("maxSignalAge", -1, 0.20),
        ("maxImpulseBars", 1, 0.20),
    ],
    "trigger_score": [
        # Higher score threshold = only higher quality passes = higher avg trigger
        ("scoreThreshold", 1, 0.50),
        ("tierAThresh", 1, 0.30),
    ],
    "volume_score": [
        ("impulseVolMult", -1, 0.50),
        ("pullbackVolRatio", 1, 0.25),
    ],
    "rr_score": [
        # Higher minRr → higher required R:R → higher rr_score
        ("minRr", 1, 0.70),
    ],
}


def estimate_features(
    params: Dict[str, float],
    baseline_medians: np.ndarray,
    baseline_stds: np.ndarray,
    distribution_data: Dict[str, Dict[str, float]],
    feature_names: List[str],
    shap_importance: Dict[str, float],
) -> np.ndarray:
    """
    Estimate the 29-dim feature vector for a given parameter combination.

    Three categories:

    1. **Gate features** (impulse_score, pullback_score, etc.):
       Parameters act as thresholds/filters.  Stricter parameters mean fewer
       setups pass the gate, but those that do have higher scores on average.
       We model this by shifting the gate feature value proportionally to
       how much the parameter deviates from the default.

       IMPORTANT: The model was trained on data where higher gate scores
       sometimes correlate with LOWER win prob (because very "clean" setups
       may already have moved).  We let the model decide via predict_proba.

    2. **Trade-structure features** (rr_ratio, stop_dist_atr, target_dist_atr):
       Directly constrained by parameters.  minRr is a hard floor on rr_ratio.
       trailAtrMult scales stop distance.

    3. **Market-structure and context features**: Held at baseline median.
       These depend on the market, not on parameters.
    """
    result = baseline_medians.copy()
    gate_features = set(GATE_PARAM_MAP.keys())
    trade_features = {"rr_ratio", "stop_dist_atr", "target_dist_atr"}

    for i, name in enumerate(feature_names):
        if name in gate_features:
            # Compute aggregate direction factor for this gate feature.
            # factor > 0: params push this feature HIGHER than baseline
            # factor < 0: params push this feature LOWER than baseline
            factor = 0.0
            total_strength = 0.0
            for param_name, direction, strength in GATE_PARAM_MAP[name]:
                if param_name not in params or param_name not in DEFAULTS:
                    continue
                default_val = DEFAULTS[param_name]
                if abs(default_val) < 1e-9:
                    continue
                # Relative change from default
                rel_change = (params[param_name] - default_val) / default_val
                factor += direction * rel_change * strength
                total_strength += strength

            if total_strength > 0:
                factor /= total_strength

            # SHAP weight: features with higher importance get larger
            # perturbations from the same parameter change.
            shap_weight = shap_importance.get(name, 0.01)

            # Scale factor by SHAP and map to feature value shift.
            # Use sigmoid-style scaling to avoid extreme values.
            scaled_factor = factor * (0.5 + 2.0 * shap_weight)
            shift = scaled_factor * baseline_stds[i]

            # Clamp: gate features observed range is [0, 30] in training data.
            result[i] = np.clip(baseline_medians[i] + shift, 0.0, 30.0)

        elif name in trade_features:
            if name == "rr_ratio":
                # minRr acts as a hard floor on the R:R ratio of generated signals.
                # The expected rr_ratio of signals = max(median_observed, minRr * padding)
                min_rr = params.get("minRr", DEFAULTS["minRr"])
                # Blend: weights baseline median and the parameter floor.
                # min_rr=1.5 -> rr_ratio ~1.6; min_rr=4.0 -> rr_ratio ~4.2
                expected_rr = distribution_data.get("rr_ratio", {}).get("p50", 2.0)
                result[i] = max(expected_rr * 0.8, min_rr * 1.08)
                # Don't exceed reasonable range
                result[i] = min(result[i], 10.0)

            elif name == "stop_dist_atr":
                # trailAtrMult directly scales the trailing stop distance
                trail_m = params.get("trailAtrMult", DEFAULTS["trailAtrMult"])
                default_trail = DEFAULTS["trailAtrMult"]
                expected_stop = distribution_data.get("stop_dist_atr", {}).get("p50", 1.5)
                ratio = trail_m / default_trail
                result[i] = expected_stop * (0.7 + 0.3 * ratio)
                result[i] = np.clip(result[i], 0.5, 4.0)

            elif name == "target_dist_atr":
                # target = stop * rr.  Affected by minRr and trailAtrMult.
                min_rr = params.get("minRr", DEFAULTS["minRr"])
                trail_m = params.get("trailAtrMult", DEFAULTS["trailAtrMult"])
                default_rr = DEFAULTS["minRr"]
                default_trail = DEFAULTS["trailAtrMult"]
                expected_tgt = distribution_data.get("target_dist_atr", {}).get("p50", 3.0)
                rr_ratio_f = min_rr / default_rr
                trail_ratio = trail_m / default_trail
                result[i] = expected_tgt * (0.5 + 0.3 * rr_ratio_f + 0.2 * trail_ratio)
                result[i] = np.clip(result[i], 1.5, 15.0)

    return result


def estimate_signal_rate(params: Dict[str, float]) -> float:
    """
    Estimate what fraction of bars would generate valid trading signals.

    Gate parameters affect how often setups pass the detection pipeline.
    Stricter = fewer signals.  We model this multiplicatively:

        rate = base_rate * product(gate_factors)

    Each parameter group (impulse, pullback, compression, scoring) has an
    independent multiplicative effect on the pass rate.
    """
    # --- Impulse gate factor ---
    # impulseAtrMult: higher = fewer impulses detected
    imp_atr_ratio = params["impulseAtrMult"] / DEFAULTS["impulseAtrMult"]
    imp_vol_ratio = params["impulseVolMult"] / DEFAULTS["impulseVolMult"]
    imp_bars_ratio = params["maxImpulseBars"] / DEFAULTS["maxImpulseBars"]
    age_ratio = params["maxSignalAge"] / DEFAULTS["maxSignalAge"]
    impulse_factor = (imp_atr_ratio ** -1.5) * (imp_vol_ratio ** -0.5) * \
                     (imp_bars_ratio ** 0.3) * (age_ratio ** 0.2)

    # --- Pullback gate factor ---
    pb_ma_ratio = params["nearMaAtrMult"] / DEFAULTS["nearMaAtrMult"]
    pb_vol_ratio = params["pullbackVolRatio"] / DEFAULTS["pullbackVolRatio"]
    pb_bars_ratio = params["minPullbackBars"] / DEFAULTS["minPullbackBars"]
    pullback_factor = (pb_ma_ratio ** 0.5) * (pb_vol_ratio ** -0.3) * (pb_bars_ratio ** -0.1)

    # --- Compression gate factor ---
    comp_range_ratio = DEFAULTS["compRangeRatio"] / params["compRangeRatio"]
    comp_atr_ratio = DEFAULTS["compAtrRatio"] / params["compAtrRatio"]
    comp_narrow_ratio = DEFAULTS["compNarrowAtrMult"] / params["compNarrowAtrMult"]
    comp_look_ratio = params["compressionLookback"] / DEFAULTS["compressionLookback"]
    compression_factor = (comp_range_ratio ** 0.5) * (comp_atr_ratio ** 0.5) * \
                         (comp_narrow_ratio ** 0.3) * (comp_look_ratio ** 0.2)

    # --- Scoring gate factor ---
    score_ratio = params["scoreThreshold"] / DEFAULTS["scoreThreshold"]
    tier_ratio = params["tierAThresh"] / DEFAULTS["tierAThresh"]
    rr_ratio = DEFAULTS["minRr"] / params["minRr"]  # inverted: higher minRr = fewer pass
    scoring_factor = (score_ratio ** -1.5) * (tier_ratio ** -1.0) * (rr_ratio ** 0.5)

    base_rate = 0.012  # 1.2% base rate from training data
    rate = base_rate * impulse_factor * pullback_factor * compression_factor * scoring_factor

    return float(np.clip(rate, 0.00005, 0.50))


def score_params(
    params: Dict[str, float],
    model,
    baseline_medians: np.ndarray,
    baseline_stds: np.ndarray,
    distribution_data: Dict[str, Dict[str, float]],
    feature_names: List[str],
    shap_importance: Dict[str, float],
) -> Tuple[float, float, float, float]:
    """
    Score a parameter combination.

    Returns (composite_score, win_prob, signal_rate, raw_margin).

    The composite score is an economically meaningful metric:
      adjusted_win_prob = sigmoid(raw_margin + signal_bonus)

    where signal_bonus = log(signal_rate / base_rate) encoded as an
    additive shift to the log-odds margin.

    This converts the signal-rate penalty into log-odds space, which
    creates meaningful differentiation even when predict_proba saturates.

    For interpretability we also return the plain win_prob.
    """
    features = estimate_features(
        params, baseline_medians, baseline_stds, distribution_data,
        feature_names, shap_importance,
    )
    features_df = pd.DataFrame([features], columns=feature_names)

    proba = model.predict_proba(features_df)[0]
    win_prob = float(proba[1])
    # Invert sigmoid to get log-odds (raw margin)
    eps = 1e-12
    p_clipped = np.clip(win_prob, eps, 1.0 - eps)
    raw_margin = float(np.log(p_clipped / (1.0 - p_clipped)))

    signal_rate = estimate_signal_rate(params)

    # Signal bonus in log-odds space.
    # signal_rate / 0.01: how many times the baseline 1% rate.
    # log transform: additive effect on log-odds.
    base_rate = 0.01  # 1% reference signal rate
    signal_ratio = signal_rate / base_rate
    signal_bonus = np.log(max(signal_ratio, 0.001)) * 0.15  # scaling factor

    adjusted_margin = raw_margin + signal_bonus
    composite = float(1.0 / (1.0 + np.exp(-adjusted_margin)))

    return composite, win_prob, signal_rate, raw_margin


@dataclass
class OptimizationResult:
    """A single parameter combination and its scores."""
    params: Dict[str, float]
    score: float
    win_prob: float
    signal_rate: float
    rank: int = 0


# ──────────────────────────────────────────────────────────────────────────────
# DATA LOADING
# ──────────────────────────────────────────────────────────────────────────────

def load_model(path: str = MODEL_PATH):
    """Load the trained LightGBM classifier."""
    with open(path, "rb") as f:
        return pickle.load(f)


def load_shap(path: str = SHAP_PATH) -> Dict[str, float]:
    """Load SHAP feature importance as {feature_name: importance} dict."""
    with open(path) as f:
        data = json.load(f)
    if "top_features" in data:
        return {item["feature"]: item["importance"] for item in data["top_features"]}
    return data


def compute_baselines(
    training_path: str = TRAINING_DATA_PATH,
    feature_path: str = FEATURE_NAMES_PATH,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Dict[str, float]], List[str]]:
    """
    Compute baseline features from training data.

    Returns (medians, stds, distribution_data, feature_names).

    distribution_data stores per-feature distribution info (median, p25, p75, etc.)
    for use in feature estimation.
    """
    with open(feature_path) as f:
        feature_names: List[str] = json.load(f)

    with open(training_path) as f:
        data = json.load(f)

    feature_values: Dict[str, List[float]] = {name: [] for name in feature_names}
    for row in data:
        for name in feature_names:
            if name in row:
                feature_values[name].append(float(row[name]))

    n_features = len(feature_names)
    medians = np.zeros(n_features)
    stds = np.ones(n_features)
    dist_data: Dict[str, Dict[str, float]] = {}

    BINARY_FEATURES = {
        "direction_encoded", "ma_regime", "vol_regime",
        "pair_encoded", "timeframe_encoded",
        "day_of_week", "hour_of_day",
    }

    for i, name in enumerate(feature_names):
        vals = np.array(feature_values[name])
        med = np.median(vals)
        std = np.std(vals)

        medians[i] = med
        stds[i] = std if std > 1e-8 else 1.0

        dist_data[name] = {
            "p50": float(med),
            "mean": float(np.mean(vals)),
            "std": float(std),
            "p25": float(np.percentile(vals, 25)),
            "p75": float(np.percentile(vals, 75)),
        }

        # For binary features, use mode as baseline
        if name in BINARY_FEATURES:
            unique, counts = np.unique(vals, return_counts=True)
            mode_val = unique[np.argmax(counts)]
            medians[i] = float(mode_val)

    return medians, stds, dist_data, feature_names


# ──────────────────────────────────────────────────────────────────────────────
# SAMPLING
# ──────────────────────────────────────────────────────────────────────────────

def sample_param_combinations(
    param_space: Dict[str, List],
    n_samples: int,
    rng: np.random.RandomState,
) -> List[Dict[str, float]]:
    """Randomly sample parameter combinations uniformly from allowed values."""
    param_names = list(param_space.keys())
    samples: List[Dict[str, float]] = []

    for _ in range(n_samples):
        params: Dict[str, float] = {}
        for name in param_names:
            values = param_space[name]
            idx = rng.randint(0, len(values))
            params[name] = float(values[idx])
        samples.append(params)

    return samples


def refine_around_best(
    best_params: Dict[str, float],
    param_space: Dict[str, List],
    n_refine: int,
    rng: np.random.RandomState,
) -> List[Dict[str, float]]:
    """
    Generate refined samples around a promising parameter set.

    For each parameter, perturb to a neighboring value with probability p=0.5.
    """
    param_names = list(param_space.keys())
    refined: List[Dict[str, float]] = []

    for _ in range(n_refine):
        new_params: Dict[str, float] = {}
        for name in param_names:
            values = param_space[name]
            if best_params[name] in values:
                current_idx = values.index(best_params[name])
            else:
                # Find nearest value
                current_idx = min(range(len(values)),
                                  key=lambda ii: abs(values[ii] - best_params[name]))
            if rng.random() < 0.5:
                delta = rng.choice([-1, 0, 1])
                new_idx = int(np.clip(current_idx + delta, 0, len(values) - 1))
            else:
                new_idx = current_idx
            new_params[name] = float(values[new_idx])
        refined.append(new_params)

    return refined


# ──────────────────────────────────────────────────────────────────────────────
# OUTPUT FORMATTING
# ──────────────────────────────────────────────────────────────────────────────

def format_pine_script_params(params: Dict[str, float], score: float) -> str:
    """Generate copy-pasteable Pine Script parameter preset."""
    lines = [
        "// ═══════════════════════════════════════════════════════════════════",
        "// OPTIMAL PARAMETERS -- ML-derived via LightGBM + SHAP",
        "// Composite score: {:.4f}".format(score),
        "// Set these in the Settings panel of icr-smc-engine.pine",
        "// ═══════════════════════════════════════════════════════════════════",
        "",
        "// -- Impulse Detection --",
    ]
    for name in ["minImpulseBars", "maxImpulseBars", "maxSignalAge",
                 "impulseAtrMult", "impulseVolMult"]:
        if name in params:
            val = params[name]
            lines.append("{} = {}".format(
                name, int(val) if val == int(val) else val))

    lines.append("")
    lines.append("// -- Pullback --")
    for name in ["minPullbackBars", "nearMaAtrMult", "pullbackVolRatio"]:
        if name in params:
            val = params[name]
            lines.append("{} = {}".format(
                name, int(val) if val == int(val) else val))

    lines.append("")
    lines.append("// -- Compression --")
    for name in ["compressionLookback", "compRangeRatio",
                 "compAtrRatio", "compNarrowAtrMult"]:
        if name in params:
            val = params[name]
            lines.append("{} = {}".format(
                name, int(val) if val == int(val) else val))

    lines.append("")
    lines.append("// -- Scoring --")
    for name in ["scoreThreshold", "minRr", "tierAThresh"]:
        if name in params:
            val = params[name]
            lines.append("{} = {}".format(
                name, int(val) if val == int(val) else val))

    lines.append("")
    lines.append("// -- Exit Trail --")
    for name in ["trailAtrMult", "trailActivateAtR", "maxBars"]:
        if name in params:
            val = params[name]
            lines.append("{} = {}".format(
                name, int(val) if val == int(val) else val))

    return "\n".join(lines)


def print_results_table(results: List[OptimizationResult]):
    """Pretty-print a table of top results with score differentiation."""
    print(f"\n{'Rank':<5} {'Score':<9} {'WinProb':<9} {'SigRate':<9} {'Key Changes from Default'}")
    print(f"{'--':<5} {'--':<9} {'--':<9} {'--':<9} {'--':<55}")

    for r in results:
        changes = []
        for name in sorted(r.params):
            default_val = DEFAULTS.get(name)
            if default_val is not None and abs(r.params[name] - default_val) > 1e-9:
                val = r.params[name]
                formatted = str(int(val)) if val == int(val) else str(val)
                changes.append("{}={}".format(name, formatted))

        # Prioritize scoring/impulse params
        prioritized = [c for c in changes if any(k in c for k in [
            "minRr", "scoreThreshold", "tierAThresh",
            "impulseAtrMult", "compRangeRatio", "compAtrRatio"])]
        remaining = [c for c in changes if c not in prioritized]
        change_str = ", ".join((prioritized + remaining)[:8])

        print("{:<5} {:<9.4f} {:<9.4f} {:<9.4f} {}".format(
            r.rank, r.score, r.win_prob, r.signal_rate, change_str))


def print_detailed_comparison(best: OptimizationResult, baseline_win: float):
    """Print a detailed comparison of best params vs defaults."""
    print("\n" + "-" * 70)
    print("  BASELINE vs OPTIMAL COMPARISON")
    print("-" * 70)
    print("  {:<25s} {:>10s} {:>10s} {:}".format(
        "Parameter", "Default", "Optimal", "Change"))
    print("  {:<25s} {:>10s} {:>10s} {:>20s}".format("---", "---", "---", "---"))

    for name in sorted(DEFAULTS.keys()):
        default_val = DEFAULTS[name]
        optimal_val = best.params.get(name, default_val)
        if abs(optimal_val - default_val) > 1e-9:
            if isinstance(default_val, (int, float)) and abs(default_val) > 1e-9:
                pct = (optimal_val - default_val) / default_val * 100
                change = "{:+.0f}%".format(pct)
            else:
                change = "{} -> {}".format(default_val, optimal_val)
            print("  {:<25s} {:>10} {:>10} {:}".format(
                name,
                int(default_val) if default_val == int(default_val) else default_val,
                int(optimal_val) if optimal_val == int(optimal_val) else optimal_val,
                change))

    print("\n  Baseline win probability: {:.4f}".format(baseline_win))
    print("  Optimal  win probability: {:.4f}  (+{:.4f})".format(
        best.win_prob, best.win_prob - baseline_win))
    print("  Optimal  signal rate:     {:.4f}".format(best.signal_rate))


# ──────────────────────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Optimize Pine Script parameters using trained LightGBM model"
    )
    parser.add_argument(
        "--n-samples", type=int, default=20000,
        help="Number of random parameter combinations (default: 20000)"
    )
    parser.add_argument(
        "--n-refine", type=int, default=1000,
        help="Additional samples around top results (default: 1000)"
    )
    parser.add_argument(
        "--top-n", type=int, default=20,
        help="Number of top results to display and save (default: 20)"
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed (default: 42)"
    )
    args = parser.parse_args()
    rng = np.random.RandomState(args.seed)

    # ── Load model and data ────────────────────────────────────────────
    print("=" * 70)
    print("  PARAMETER OPTIMIZATION")
    print("  ICR SMC Engine -- LightGBM + SHAP Grid Search")
    print("=" * 70)

    print("\n[1/5] Loading trained model...")
    model = load_model()
    n_trees = getattr(model, "n_estimators_", "?")
    print("  Model: {} ({} trees)".format(type(model).__name__, n_trees))

    print("\n[2/5] Loading SHAP importance...")
    shap_importance = load_shap()
    sorted_shap = sorted(shap_importance.items(), key=lambda x: x[1], reverse=True)
    print("  Top 10 SHAP features:")
    for i, (name, imp) in enumerate(sorted_shap[:10], 1):
        gate = " [GATE]" if name in GATE_PARAM_MAP else ""
        trade = " [TRADE]" if name in {"rr_ratio", "stop_dist_atr", "target_dist_atr"} else ""
        print("    {:2d}. {:25s} {:.4f}{}{}".format(i, name, imp, gate, trade))

    print("\n[3/5] Computing baseline features from training data...")
    medians, stds, dist_data, feature_names = compute_baselines()
    print("  {} features, {} tunable parameters".format(
        len(feature_names), len(PARAM_SPACE)))
    baseline_df = pd.DataFrame([medians], columns=feature_names)
    baseline_win = float(model.predict_proba(baseline_df)[0][1])
    print("  Baseline (default params) win probability: {:.4f}".format(baseline_win))

    print("\n[4/5] Random search ({:,} samples)...".format(args.n_samples))
    samples = sample_param_combinations(PARAM_SPACE, args.n_samples, rng)

    all_results: List[OptimizationResult] = []
    for i, params in enumerate(samples):
        score, win_prob, signal_rate, _ = score_params(
            params, model, medians, stds, dist_data,
            feature_names, shap_importance,
        )
        all_results.append(OptimizationResult(
            params=params, score=score, win_prob=win_prob,
            signal_rate=signal_rate,
        ))

        if (i + 1) % 5000 == 0:
            cur_best = max(r.score for r in all_results)
            print("  Evaluated {:,} / {:,}...  current best: {:.4f}".format(
                i + 1, args.n_samples, cur_best))

    # Sort by score descending
    all_results.sort(key=lambda x: x.score, reverse=True)

    # ── Refinement around top results ──────────────────────────────────
    if args.n_refine > 0:
        print("\n[5/5] Refining around top 3 results ({:,} extra)...".format(
            args.n_refine))
        refined_results: List[OptimizationResult] = []
        n_top_for_refine = min(3, len(all_results))
        for rank in range(n_top_for_refine):
            per = args.n_refine // n_top_for_refine
            refined = refine_around_best(
                all_results[rank].params, PARAM_SPACE, per, rng)
            for params in refined:
                score, win_prob, signal_rate, _ = score_params(
                    params, model, medians, stds, dist_data,
                    feature_names, shap_importance,
                )
                refined_results.append(OptimizationResult(
                    params=params, score=score, win_prob=win_prob,
                    signal_rate=signal_rate,
                ))
        all_results.extend(refined_results)
        all_results.sort(key=lambda x: x.score, reverse=True)
        print("  Total evaluated: {:,}".format(len(all_results)))
    else:
        print("\n[5/5] Skipping refinement.")

    # ── Top N ──────────────────────────────────────────────────────────
    # Deduplicate: keep only unique parameter sets, highest score each
    seen = set()
    unique_results: List[OptimizationResult] = []
    for r in all_results:
        key = tuple(sorted(r.params.items()))
        if key not in seen:
            seen.add(key)
            unique_results.append(r)

    top = unique_results[:args.top_n]
    for rank, r in enumerate(top, 1):
        r.rank = rank

    print_results_table(top)

    # ── Detailed best comparison ───────────────────────────────────────
    best = top[0]
    print_detailed_comparison(best, baseline_win)

    # ── Pine Script preset ─────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("  PINE SCRIPT PRESET  (best score: {:.4f})".format(best.score))
    print("=" * 70)
    preset = format_pine_script_params(best.params, best.score)
    print(preset)

    # ── Save outputs ───────────────────────────────────────────────────
    out_dir = "scripts/data/models"
    os.makedirs(out_dir, exist_ok=True)

    json_path = os.path.join(out_dir, "optimal_params.json")
    output = {
        "metadata": {
            "model": "lgbm_classifier_final",
            "baseline_win_prob": round(baseline_win, 6),
            "n_samples": args.n_samples,
            "n_refine": args.n_refine,
            "seed": args.seed,
            "total_evaluated": len(all_results),
            "default_params": {k: int(v) if v == int(v) else v
                               for k, v in DEFAULTS.items()},
        },
        "results": [
            {
                "rank": r.rank,
                "score": round(r.score, 6),
                "win_prob": round(r.win_prob, 6),
                "signal_rate": round(r.signal_rate, 6),
                "params": {k: int(v) if v == int(v) else v
                           for k, v in r.params.items()},
            }
            for r in top
        ],
    }
    with open(json_path, "w") as f:
        json.dump(output, f, indent=2)
    print("\nMachine-readable results: {}".format(json_path))

    txt_path = os.path.join(out_dir, "optimal_pine_params.txt")
    with open(txt_path, "w") as f:
        f.write(preset + "\n")
    print("Pine Script preset:       {}".format(txt_path))

    # ── Summary stats ──────────────────────────────────────────────────
    scores = [r.score for r in unique_results[:100]]
    win_probs = [r.win_prob for r in unique_results[:100]]
    print("\n" + "=" * 70)
    print("  SUMMARY")
    print("=" * 70)
    print("  Baseline win prob:   {:.4f}".format(baseline_win))
    print("  Best win prob:       {:.4f}".format(best.win_prob))
    print("  Best signal rate:    {:.4f}".format(best.signal_rate))
    print("  Best composite:      {:.4f}".format(best.score))
    print("  Top-10 mean score:   {:.4f}  (std={:.4f})".format(
        np.mean(scores[:10]), np.std(scores[:10])))
    print("  Top-10 win prob range: [{:.4f}, {:.4f}]".format(
        min(win_probs[:10]), max(win_probs[:10])))
    print("  Top-100 mean score:  {:.4f}".format(np.mean(scores)))
    print("  Unique param sets:   {:,}".format(len(unique_results)))
    print("  Score range:         [{:.4f}, {:.4f}]".format(
        unique_results[-1].score, unique_results[0].score))
    print("\nDone.")


if __name__ == "__main__":
    main()
