#!/usr/bin/env python3
"""
Live inference engine for the meta-v20 MTF model (LightGBM + isotonic).

Scoring pipeline:
  pre-computed features (30 floats)
    -> feature vector (alphabetical order matching training)
    -> LGBMClassifier.predict_proba
    -> calibrated probability
    -> threshold comparison (0.82 from training)
    -> TRADE / SKIP

Usage:
  # Single prediction (JSON string)
  python3 scripts/ml/infer.py --features '{"h1_rsi":45.2,"h4_rsi":52.1,...}'

  # Batch prediction (JSON file with array of feature dicts)
  python3 scripts/ml/infer.py --file signals.json

  # Batch prediction (verbose debug)
  python3 scripts/ml/infer.py --file signals.json --verbose

  # Import as module
  from scripts.ml.infer import InferenceEngine
  engine = InferenceEngine()
  result = engine.predict({"h1_rsi": 45.2, "h4_rsi": 52.1, ...})

INPUT: A dict with all 30 feature keys matching model_card.json "features".
       All values converted to float. Missing features raise ValueError.
       Extra keys (symbol, timestamp, etc.) are ignored with a warning.

OUTPUT: {
  "proba": 0.8734,       # LightGBM raw probability (uncalibrated — see caveat)
  "threshold": 0.82,     # Decision threshold from model_card.json
  "decision": "TRADE",   # "TRADE" if proba >= threshold, else "SKIP"
  "confidence": 0.8734,  # synonym for proba
}

CAVEAT: The 0.82 threshold was determined on isotonic-calibrated probabilities
        during training. The calibrator.pkl is NOT available in the meta-v20
        model directory, so this engine uses raw LGBMClassifier predict_proba.
        Raw probabilities differ from calibrated ones — treat the threshold
        as a selectivity dial, not a precise 80% WR guarantee.

        To calibrate in production: collect 500+ live predictions + outcomes,
        then fit a new IsotonicRegression and update the threshold.
"""

import json
import argparse
import sys
import pickle
import logging
import warnings
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np

logger = logging.getLogger(__name__)

# -- path resolution ---------------------------------------------------------

MODEL_DIR = (
    Path(__file__).resolve().parent.parent
    / "data" / "models" / "meta-v20-mtf-context"
)
DEFAULT_THRESHOLD = 0.82

FEATURE_NAMES_CACHE: List[str] | None = None
"""Cached feature list from model_card.json to avoid re-reading on every call."""


# -- inference engine --------------------------------------------------------

class InferenceEngine:
    """Predict TRADE/SKIP for a single trade feature vector.

    Parameters
    ----------
    model_dir : Path
        Directory containing classifier.pkl and model_card.json.
    threshold : float, optional
        Override the decision threshold from model_card.json.
    """

    def __init__(
        self,
        model_dir: Path = MODEL_DIR,
        threshold: Optional[float] = None,
    ) -> None:
        self.model_dir = model_dir
        self._load_model()
        self.threshold = (
            threshold if threshold is not None else self._load_threshold()
        )

    # -- private -------------------------------------------------------------

    def _load_model(self) -> None:
        """Load the LightGBM classifier and feature name list."""
        clf_path = self.model_dir / "classifier.pkl"
        if not clf_path.exists():
            raise FileNotFoundError(
                f"Model file not found: {clf_path} "
                f"(expected classifier.pkl in {self.model_dir})"
            )

        with open(clf_path, "rb") as f:
            self.classifier = pickle.load(f)

        # feature names live in model_card.json
        card_path = self.model_dir / "model_card.json"
        with open(card_path) as f:
            card = json.load(f)

        raw_features = card.get("features", [])
        if not raw_features:
            raise ValueError(
                "model_card.json contains an empty or missing 'features' array"
            )

        self.feature_names: List[str] = raw_features
        global FEATURE_NAMES_CACHE
        FEATURE_NAMES_CACHE = self.feature_names

        n_model = getattr(self.classifier, "n_features_in_", None)
        logger.info(
            "Model loaded: %s  |  features=%d (model expects %s)  "
            "|  estimators=%s",
            type(self.classifier).__name__,
            len(self.feature_names),
            n_model,
            getattr(self.classifier, "n_estimators", "?"),
        )

    def _load_threshold(self) -> float:
        """Read the decision threshold from model_card.json."""
        card_path = self.model_dir / "model_card.json"
        with open(card_path) as f:
            card = json.load(f)
        return float(card.get("threshold", DEFAULT_THRESHOLD))

    def _build_feature_vector(self, features: Dict) -> np.ndarray:
        """Build a (1, n_features) float32 array in the correct column order.

        The training pipeline used ``sorted(set(keys) - meta_cols - label_cols)``
        which is a plain alphabetical sort.  ``model_card.json['features']``
        preserves that same alphabetical order, so we iterate it directly.
        """
        missing = set(self.feature_names) - set(features.keys())
        if missing:
            raise ValueError(
                f"Missing {len(missing)} required feature(s): "
                f"{sorted(missing)[:10]}..."
                if len(missing) > 10
                else f"Missing features: {sorted(missing)}"
            )

        extra = (
            set(features.keys())
            - set(self.feature_names)
            - {"symbol", "timestamp", "direction"}
        )
        if extra:
            logger.warning("Extra keys ignored (not model features): %s", extra)

        # alphabetical order matching training
        row = [float(features.get(c, 0) or 0) for c in self.feature_names]
        return np.array([row], dtype=np.float32)

    # -- public API ----------------------------------------------------------

    def predict(self, features: Dict) -> Dict:
        """Score a single trade.

        Parameters
        ----------
        features : dict
            Must contain all 30 feature keys listed in model_card.json.
            Values are cast to float (None/0 treated as 0).

        Returns
        -------
        dict with keys: proba, threshold, decision, confidence
        """
        X = self._build_feature_vector(features)

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            proba = float(self.classifier.predict_proba(X)[0, 1])

        decision = "TRADE" if proba >= self.threshold else "SKIP"

        return {
            "proba": round(proba, 6),
            "threshold": self.threshold,
            "decision": decision,
            "confidence": round(proba, 6),
        }

    def predict_batch(self, feature_dicts: List[Dict]) -> List[Dict]:
        """Score multiple trades.

        Parameters
        ----------
        feature_dicts : list[dict]
            Each dict must contain all 30 feature keys.

        Returns
        -------
        list[dict]
            One result per input; failed rows get ``{"decision": "ERROR"}``
            with an ``"error"`` key.
        """
        results: List[Dict] = []
        for i, fd in enumerate(feature_dicts):
            try:
                result = self.predict(fd)
                result["index"] = i
                results.append(result)
            except Exception as exc:
                results.append(
                    {"index": i, "decision": "ERROR", "error": str(exc)}
                )
        return results


# -- CLI --------------------------------------------------------------------

def _parse_args(argv: List[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="meta-v20 MTF live inference — TRADE / SKIP per feature vector"
    )
    parser.add_argument(
        "--features",
        type=str,
        help="JSON dict (or array of dicts) of feature values",
    )
    parser.add_argument(
        "--file",
        type=str,
        help="JSON file containing a single feature dict or an array of them",
    )
    parser.add_argument(
        "--model-dir",
        type=str,
        default=None,
        help="Override model directory (default: scripts/data/models/meta-v20-mtf-context)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=None,
        help="Override decision threshold (default: 0.82 from model_card.json)",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable DEBUG-level logging",
    )
    return parser.parse_args(argv)


def main(argv: List[str] | None = None) -> None:
    args = _parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    model_dir = Path(args.model_dir) if args.model_dir else MODEL_DIR
    engine = InferenceEngine(model_dir=model_dir, threshold=args.threshold)

    if args.features:
        data = json.loads(args.features)
        if isinstance(data, list):
            results = engine.predict_batch(data)
        else:
            results = engine.predict(data)
        print(json.dumps(results, indent=2))

    elif args.file:
        src = Path(args.file)
        if not src.exists():
            print(f"ERROR: file not found: {src}", file=sys.stderr)
            sys.exit(1)
        with open(src) as f:
            data = json.load(f)
        if isinstance(data, dict):
            # unwrap common wrappers
            data = data.get("signals", data.get("features", data.get("trades", [data])))
        if isinstance(data, dict):
            data = [data]  # single dict -> single-element list
        results = engine.predict_batch(data)
        print(json.dumps(results, indent=2))

    else:
        _parse_args(["--help"])


if __name__ == "__main__":
    main()
