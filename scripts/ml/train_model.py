#!/usr/bin/env python3
"""
NN Scoring Engine (Stage 3) — Model Training Script (v3 MTF).

Loads the labeled dataset produced by build-training-data-mtf.ts and trains:
  - A LightGBM classifier to predict hitTP (trade reaches take-profit)
  - A LightGBM regressor to predict maxFavorableR (best R-multiple reached)

Works with v3 MTF data (54 features: 4h structure, 4h BB/AO, 1h SMC,
chart TF continuous, MTF confluence, interaction features).

Uses time-series cross-validation (purged k-fold) to prevent lookahead bias.
Outputs SHAP feature importance plots and an ONNX model for inference.

Usage:
  python scripts/ml/train_model.py \
    --input scripts/data/training-data-mtf-v3.json \
    --model-dir scripts/ml/models/

  python scripts/ml/train_model.py \
    --input scripts/data/training-data-mtf-v3.json \
    --model-dir scripts/ml/models/ \
    --n-folds 5

Dependencies:
  pip install numpy pandas scikit-learn lightgbm shap skl2onnx onnxruntime
"""

import argparse
import json
import os
import sys
import warnings
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=UserWarning)

# ─── Feature column definitions ────────────────────────────────────────────
# Must match the column order from build-training-data-mtf.ts (v3)

H4_STRUCTURE_FEATURES = [
    "h4_trend_bull", "h4_trend_bear", "h4_ma_separation_atr", "h4_ma25_slope",
    "h4_atr_percentile", "h4_fib_detected", "h4_fib_golden_distance_atr",
    "h4_swing_distance_atr",
]

H4_BB_AO_FEATURES = [
    "h4_bb_width_pct", "h4_bb_squeeze_intensity", "h4_bb_expanding",
    "h4_ao_value", "h4_ao_slope", "h4_ao_acceleration",
]

H1_SMC_FEATURES = [
    "h1_ob_bull", "h1_ob_bear", "h1_ob_distance_atr", "h1_ob_size_atr",
    "h1_fvg_bull", "h1_fvg_bear", "h1_fvg_distance_atr", "h1_fvg_size_atr",
    "h1_sweep_bull", "h1_sweep_bear", "h1_sweep_depth_atr",
    "h1_choch_bull", "h1_choch_bear", "h1_smc_confluence_count",
]

# Sentinel features: -1.0 = no pattern found (not NaN, distinct from 0)
SENTINEL_FEATURES = [
    "h1_ob_distance_atr", "h1_ob_size_atr",
    "h1_fvg_distance_atr", "h1_fvg_size_atr",
    "h1_sweep_depth_atr",
]

CT_FEATURES = [
    "ct_bb_width_pct", "ct_bb_squeeze_intensity", "ct_bb_expanding",
    "ct_ao_value", "ct_ao_slope", "ct_ao_acceleration",
    "ct_ao_cross_up", "ct_ao_cross_down",
    "ct_rsi", "ct_rsi_velocity",
    "ct_volume_zscore", "ct_volume_ratio",
    "ct_displacement", "ct_body_ratio", "ct_close_position",
    "ct_wick_magnitude_atr",
]

MTF_FEATURES = [
    "mtf_1h_ob_near_4h_fib", "mtf_1h_ob_near_4h_fib_distance",
    "mtf_1h_fvg_near_4h_fib", "mtf_1h_fvg_near_4h_fib_distance",
    "mtf_level_confluence_count",
]

INTERACTION_FEATURES = [
    "bb_squeeze_x_fvg_distance", "ao_accel_x_ob_distance",
    "ma_sep_x_rsi_velocity", "atr_percentile_x_bb_squeeze",
    "fvg_distance_x_mtf_fib_distance",
]

ALL_FEATURE_COLS = (
    H4_STRUCTURE_FEATURES
    + H4_BB_AO_FEATURES
    + H1_SMC_FEATURES
    + CT_FEATURES
    + MTF_FEATURES
    + INTERACTION_FEATURES
)

LABEL_COLS = ["hitTP", "hitStop", "maxFavorableR", "maxAdverseR", "pnlR", "barsToOutcome"]

META_COLS = ["symbol", "timeframe", "timestamp", "direction"]


def load_data(path: str) -> pd.DataFrame:
    """Load training data from JSON or CSV."""
    if path.endswith(".csv"):
        df = pd.read_csv(path)
    elif path.endswith(".json"):
        df = pd.read_json(path)
    else:
        raise ValueError(f"Unsupported file format: {path}. Use .json or .csv")

    # Validate required columns exist
    missing_features = [c for c in ALL_FEATURE_COLS if c not in df.columns]
    if missing_features:
        print(f"Warning: Missing feature columns: {missing_features}")

    missing_labels = [c for c in LABEL_COLS if c not in df.columns]
    if missing_labels:
        raise ValueError(f"Missing label columns: {missing_labels}")

    # Ensure timestamp is numeric and sort by time
    if "timestamp" in df.columns:
        df["timestamp"] = pd.to_numeric(df["timestamp"], errors="coerce")
        df = df.sort_values("timestamp").reset_index(drop=True)

    return df


def prepare_features(
    df: pd.DataFrame,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, List[str]]:
    """
    Prepare feature matrices and label vectors.

    Sentinel features (SMC distance/size) use -1.0 when no pattern found.
    NaN values in non-sentinel features are filled with 0.
    NaN values in sentinel features are filled with -1.0 (assume no pattern).

    Returns:
        X: Feature matrix (N x F)
        y_cls: Binary classification target (hitTP)
        y_reg: Regression target (maxFavorableR)
        y_pnl: Final PnL target (pnlR)
        feature_names: Ordered list of feature names
    """
    # Select available features
    feature_names = [c for c in ALL_FEATURE_COLS if c in df.columns]
    missing = [c for c in ALL_FEATURE_COLS if c not in df.columns]
    if missing:
        print(f"  Warning: {len(missing)} expected features missing: {missing[:10]}...")

    print(f"  Using {len(feature_names)} features")

    # Create feature matrix with appropriate fill values
    X_df = df[feature_names].copy()

    # Fill NaN with 0 for non-sentinel features
    non_sentinel = [c for c in feature_names if c not in SENTINEL_FEATURES]
    X_df[non_sentinel] = X_df[non_sentinel].fillna(0)

    # Fill NaN with -1.0 for sentinel features (no pattern = sentinel)
    sentinel_in_data = [c for c in feature_names if c in SENTINEL_FEATURES]
    if sentinel_in_data:
        X_df[sentinel_in_data] = X_df[sentinel_in_data].fillna(-1.0)

    # Data quality check
    for col in feature_names:
        vals = X_df[col].values
        n_nan = np.isnan(vals).sum()
        n_inf = ~np.isfinite(vals) if hasattr(np, 'isfinite') else 0
        if n_nan > 0:
            print(f"  WARNING: {col} has {n_nan} NaN values")

    X = X_df.astype(np.float64).values

    # Classification target: hitTP
    y_cls = df["hitTP"].fillna(False).astype(int).values

    # Regression targets
    y_reg = df["maxFavorableR"].fillna(0).astype(np.float64).values
    y_pnl = df["pnlR"].fillna(0).astype(np.float64).values

    return X, y_cls, y_reg, y_pnl, feature_names


def purged_kfold(
    timestamps: np.ndarray,
    n_folds: int = 5,
    purge_pct: float = 0.01,
) -> List[Tuple[np.ndarray, np.ndarray]]:
    """
    Generate time-series cross-validation splits with purging.

    Each fold trains on earlier data and tests on later data.
    A small gap (purge) is left between train and test to prevent
    information leakage from overlapping label windows.

    Args:
        timestamps: Array of bar timestamps (milliseconds), sorted ascending.
        n_folds: Number of CV folds.
        purge_pct: Fraction of total time range to purge between folds.

    Returns:
        List of (train_indices, test_indices) tuples.
    """
    n = len(timestamps)
    if n < n_folds * 2:
        # Not enough data for k-fold; use a simple 80/20 split
        split = int(n * 0.8)
        return [(np.arange(split), np.arange(split, n))]

    time_range = timestamps[-1] - timestamps[0]
    purge = int(time_range * purge_pct)

    folds = []
    fold_size = n // n_folds

    for k in range(n_folds):
        # Test set: fold k
        test_start = k * fold_size
        test_end = (k + 1) * fold_size if k < n_folds - 1 else n

        # Train set: everything before test_start, with purge gap
        # Find the last training index whose timestamp is at least `purge`
        # before the first test timestamp.
        test_ts_min = timestamps[test_start]
        purge_boundary = test_ts_min - purge

        train_end = np.searchsorted(timestamps[:test_start], purge_boundary, side="right")
        if train_end < fold_size:
            # Not enough train data; skip this fold
            continue

        train_idx = np.arange(train_end)
        test_idx = np.arange(test_start, test_end)

        if len(train_idx) > 0 and len(test_idx) > 0:
            folds.append((train_idx, test_idx))

    if not folds:
        # Fallback: simple chronological 80/20
        split = int(n * 0.8)
        folds = [(np.arange(split), np.arange(split, n))]

    return folds


def train_classifier(
    X_train: np.ndarray, y_train: np.ndarray,
    X_test: np.ndarray, y_test: np.ndarray,
) -> Dict:
    """Train a LightGBM classifier and return metrics + model."""
    from lightgbm import LGBMClassifier
    from sklearn.metrics import (
        accuracy_score, roc_auc_score, brier_score_loss, classification_report,
    )

    model = LGBMClassifier(
        n_estimators=300,
        max_depth=7,
        num_leaves=63,
        learning_rate=0.03,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_samples=30,
        reg_lambda=0.1,
        random_state=42,
        verbose=-1,
    )

    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    y_prob = model.predict_proba(X_test)[:, 1]

    # Handle edge case: only one class in test set
    auc = roc_auc_score(y_test, y_prob) if len(np.unique(y_test)) > 1 else 0.5
    brier = brier_score_loss(y_test, y_prob)

    return {
        "model": model,
        "accuracy": accuracy_score(y_test, y_pred),
        "auc": auc,
        "brier": brier,
        "feature_importance": dict(
            zip(model.feature_name_, model.feature_importances_)
            if hasattr(model, "feature_name_")
            else {},
        ),
    }


def train_regressor(
    X_train: np.ndarray, y_train: np.ndarray,
    X_test: np.ndarray, y_test: np.ndarray,
    target_name: str = "maxFavorableR",
) -> Dict:
    """Train a LightGBM regressor and return metrics + model."""
    from lightgbm import LGBMRegressor
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

    model = LGBMRegressor(
        n_estimators=300,
        max_depth=7,
        num_leaves=63,
        learning_rate=0.03,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_samples=30,
        reg_lambda=0.1,
        random_state=42,
        verbose=-1,
    )

    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    return {
        "model": model,
        "mae": mean_absolute_error(y_test, y_pred),
        "rmse": np.sqrt(mean_squared_error(y_test, y_pred)),
        "r2": r2_score(y_test, y_pred),
        "target": target_name,
        "feature_importance": dict(
            zip(model.feature_name_, model.feature_importances_)
            if hasattr(model, "feature_name_")
            else {},
        ),
    }


def compute_shap(model, X_sample: np.ndarray, feature_names: List[str]) -> Dict:
    """
    Compute SHAP feature importance on a sample of the data.

    Returns a dict mapping feature name -> mean absolute SHAP value.
    """
    import shap

    # Use TreeExplainer for LightGBM models
    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X_sample)

    # For classifiers, shap_values may be a list (one per class)
    if isinstance(shap_values, list):
        shap_values = shap_values[1]  # positive class

    mean_abs_shap = np.abs(shap_values).mean(axis=0)
    importance = {
        name: float(val)
        for name, val in zip(feature_names, mean_abs_shap)
    }
    return dict(
        sorted(importance.items(), key=lambda x: x[1], reverse=True)
    )


def export_onnx(model, X_sample: np.ndarray, feature_names: List[str], path: str):
    """Export a LightGBM model to ONNX format."""
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    initial_type = [("float_input", FloatTensorType([None, len(feature_names)]))]
    onnx_model = convert_sklearn(
        model,
        initial_types=initial_type,
        target_opset=14,
    )

    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(onnx_model.SerializeToString())

    size_mb = os.path.getsize(path) / (1024 * 1024)
    print(f"  Exported ONNX model to {path} ({size_mb:.2f} MB)")


def print_summary(clf_results: List[Dict], reg_results: List[Dict]):
    """Print a formatted summary of cross-validation results."""
    print("\n" + "=" * 70)
    print("  CROSS-VALIDATION SUMMARY")
    print("=" * 70)

    if clf_results:
        aucs = [r["auc"] for r in clf_results]
        briers = [r["brier"] for r in clf_results]
        accs = [r["accuracy"] for r in clf_results]
        print(f"\n  Classifier (hitTP) — {len(clf_results)} folds:")
        print(f"    AUC:    {np.mean(aucs):.4f} ± {np.std(aucs):.4f}")
        print(f"    Brier:  {np.mean(briers):.4f} ± {np.std(briers):.4f}")
        print(f"    Acc:    {np.mean(accs):.4f} ± {np.std(accs):.4f}")

    if reg_results:
        maes = [r["mae"] for r in reg_results]
        rmses = [r["rmse"] for r in reg_results]
        r2s = [r["r2"] for r in reg_results]
        print(f"\n  Regressor ({reg_results[0]['target']}) — {len(reg_results)} folds:")
        print(f"    MAE:    {np.mean(maes):.4f} ± {np.std(maes):.4f}")
        print(f"    RMSE:   {np.mean(rmses):.4f} ± {np.std(rmses):.4f}")
        print(f"    R²:     {np.mean(r2s):.4f} ± {np.std(r2s):.4f}")

    # Pass/fail checks
    print("\n  Acceptance Criteria:")
    if clf_results:
        avg_auc = np.mean(aucs)
        avg_brier = np.mean(briers)
        status_auc = "PASS" if avg_auc > 0.65 else "FAIL"
        status_brier = "PASS" if avg_brier < 0.20 else "FAIL"
        print(f"    AUC > 0.65:  {avg_auc:.4f} [{status_auc}]")
        print(f"    Brier < 0.20: {avg_brier:.4f} [{status_brier}]")
    else:
        print("    (No classifier results to evaluate)")

    print("=" * 70)


def main():
    parser = argparse.ArgumentParser(
        description="Train NN scoring models on labeled ICR data"
    )
    parser.add_argument(
        "--input", required=True,
        help="Path to training data (JSON or CSV from build-training-data.ts)"
    )
    parser.add_argument(
        "--model-dir", default="models/",
        help="Directory to save trained models (default: models/)"
    )
    parser.add_argument(
        "--n-folds", type=int, default=5,
        help="Number of time-series CV folds (default: 5)"
    )
    parser.add_argument(
        "--no-shap", action="store_true",
        help="Skip SHAP analysis (faster)"
    )
    parser.add_argument(
        "--shap-samples", type=int, default=5000,
        help="Number of samples for SHAP computation (default: 5000)"
    )
    parser.add_argument(
        "--skip-classifier", action="store_true",
        help="Skip classifier training"
    )
    parser.add_argument(
        "--skip-regressor", action="store_true",
        help="Skip regressor training"
    )
    parser.add_argument(
        "--skip-onnx", action="store_true",
        help="Skip ONNX export"
    )
    args = parser.parse_args()

    # ── Load data ───────────────────────────────────────────────────────
    print(f"Loading data from {args.input}...")
    df = load_data(args.input)
    print(f"  {len(df)} rows, {len(df.columns)} columns")

    # Quick data stats
    if "hitTP" in df.columns:
        tp_pct = df["hitTP"].mean() * 100
        stop_pct = df["hitStop"].mean() * 100
        print(f"  hitTP: {tp_pct:.1f}%, hitStop: {stop_pct:.1f}%")

    # Sentinel prevalence
    for sf in SENTINEL_FEATURES:
        if sf in df.columns:
            pct = (df[sf] == -1.0).mean() * 100
            print(f"  {sf} sentinel (-1.0): {pct:.1f}% of rows")

    X, y_cls, y_reg, y_pnl, feature_names = prepare_features(df)
    timestamps = df["timestamp"].values if "timestamp" in df.columns else np.arange(len(X))

    print(f"  Feature matrix: {X.shape}")

    # ── Time-series CV splits ───────────────────────────────────────────
    folds = purged_kfold(timestamps, n_folds=args.n_folds)
    print(f"\nTime-series CV: {len(folds)} purged folds")

    # ── Train across folds ──────────────────────────────────────────────
    clf_results: List[Dict] = []
    reg_results: List[Dict] = []
    all_shap: List[Dict] = []
    best_clf = None
    best_reg = None
    best_clf_auc = 0
    best_reg_r2 = -float("inf")

    for fold_idx, (train_idx, test_idx) in enumerate(folds):
        print(f"\n--- Fold {fold_idx + 1}/{len(folds)} "
              f"(train={len(train_idx)}, test={len(test_idx)}) ---")

        X_train, X_test = X[train_idx], X[test_idx]

        # ── Classifier ──────────────────────────────────────────────
        if not args.skip_classifier:
            yt_cls = y_cls[train_idx]
            ye_cls = y_cls[test_idx]
            class_counts = np.bincount(yt_cls, minlength=2)
            if class_counts[0] > 0 and class_counts[1] > 0:
                result = train_classifier(X_train, yt_cls, X_test, ye_cls)
                clf_results.append(result)
                print(f"  Classifier: AUC={result['auc']:.4f}, "
                      f"Brier={result['brier']:.4f}, Acc={result['accuracy']:.4f}")

                if result["auc"] > best_clf_auc:
                    best_clf_auc = result["auc"]
                    best_clf = result["model"]
            else:
                print("  Classifier: SKIP (only one class in train set)")

        # ── Regressor ────────────────────────────────────────────────
        if not args.skip_regressor:
            yt_reg = y_reg[train_idx]
            ye_reg = y_reg[test_idx]
            result = train_regressor(X_train, yt_reg, X_test, ye_reg)
            reg_results.append(result)
            print(f"  Regressor: MAE={result['mae']:.4f}, "
                  f"RMSE={result['rmse']:.4f}, R²={result['r2']:.4f}")

            if result["r2"] > best_reg_r2:
                best_reg_r2 = result["r2"]
                best_reg = result["model"]

    # ── Summary ────────────────────────────────────────────────────────
    print_summary(clf_results, reg_results)

    # ── SHAP Analysis ──────────────────────────────────────────────────
    if not args.no_shap and best_clf is not None:
        print("\n--- SHAP Feature Importance (Classifier) ---")
        try:
            n_samples = min(args.shap_samples, len(X))
            indices = np.random.choice(len(X), n_samples, replace=False)
            shap_importance = compute_shap(best_clf, X[indices], feature_names)
            print("  Top 15 features:")
            for i, (name, val) in enumerate(shap_importance.items()):
                if i >= 15:
                    break
                print(f"    {i+1:2d}. {name:25s} {val:.6f}")

            # Save SHAP report
            os.makedirs(args.model_dir, exist_ok=True)
            shap_path = os.path.join(args.model_dir, "shap_importance.json")
            with open(shap_path, "w") as f:
                json.dump(shap_importance, f, indent=2)
            print(f"  Full SHAP report saved to {shap_path}")
        except Exception as e:
            print(f"  SHAP analysis failed: {e}")

    # ── ONNX Export ────────────────────────────────────────────────────
    if not args.skip_onnx:
        os.makedirs(args.model_dir, exist_ok=True)

        if best_clf is not None:
            clf_path = os.path.join(args.model_dir, "hitTP_classifier.onnx")
            try:
                export_onnx(best_clf, X[:100], feature_names, clf_path)
            except Exception as e:
                print(f"  ONNX export (classifier) failed: {e}")

        if best_reg is not None:
            reg_path = os.path.join(args.model_dir, "maxFavorableR_regressor.onnx")
            try:
                export_onnx(best_reg, X[:100], feature_names, reg_path)
            except Exception as e:
                print(f"  ONNX export (regressor) failed: {e}")

    # ── Feature importance from LightGBM ───────────────────────────────
    if best_clf is not None:
        imp_path = os.path.join(args.model_dir, "feature_importance.json")
        try:
            importance = dict(
                sorted(
                    zip(feature_names, best_clf.feature_importances_),
                    key=lambda x: x[1], reverse=True,
                )
            )
            with open(imp_path, "w") as f:
                json.dump(importance, f, indent=2)
            print(f"\nLightGBM feature importance saved to {imp_path}")
        except Exception as e:
            print(f"  Feature importance save failed: {e}")

    print("\nTraining complete.")


if __name__ == "__main__":
    main()
