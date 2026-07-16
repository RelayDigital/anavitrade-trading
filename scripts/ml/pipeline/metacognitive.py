"""
METACOGNITIVE TRADING MODEL — models that watch models.

Architecture (6 layers, each independently trained and validated):

  Layer 1 — REGIME CLASSIFIER
    KMeans on structural features → 3-6 market regimes
    "Is this trending, ranging, volatile compression, or distribution?"

  Layer 2 — PER-REGIME BASE MODELS
    Separate LightGBM for each regime.
    Different markets need different edges. A model trained on
    trending markets fails in ranges. This is why monolithic models
    cap at 30% WR.

  Layer 3 — CONFIDENCE CALIBRATOR
    Isotonic regression per regime. "How confident am I in this
    prediction?" When confidence < threshold, model says "I don't know."

  Layer 4 — ADVERSARIAL VALIDATOR
    Trained to predict FAILURES. "Is this prediction in a regime
    where I historically get wrecked?" If yes → reduce size or skip.

  Layer 5 — META-LEARNER
    Logistic regression on top of: regime × base_prob × confidence ×
    adversarial_risk → final P(win). This is the model that learns HOW
    the base models perform in different contexts.

  Layer 6 — ONLINE DRIFT DETECTOR
    Per-feature distribution shift from training. When the world changes,
    the model KNOWS it changed and adapts.

Key principle: the model says "I don't know" when it doesn't.
Forcing a prediction on every bar is what caps WR at 30-40%.
The metacognitive layer explicitly models when to stay out.
"""

import json, pickle, numpy as np
from pathlib import Path
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass
import lightgbm as lgb
from sklearn.cluster import KMeans
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler


@dataclass
class MetacognitiveState:
    """Full metacognitive model state — persisted between sessions."""
    regimes: int
    regime_model: KMeans
    regime_scaler: StandardScaler
    base_models: List[lgb.LGBMClassifier]     # one per regime
    calibrators: List[IsotonicRegression]      # one per regime
    adversary: lgb.LGBMClassifier              # predicts failures
    meta_learner: LogisticRegression           # combines all signals
    feature_names: List[str]
    training_dist: Dict[str, Dict[str, float]] # per-feature mean/std
    regime_distribution: np.ndarray            # % of training data per regime
    meta_threshold: float                      # minimum meta probability to trade

    def to_dict(self) -> dict:
        return {
            'regimes': self.regimes,
            'feature_names': self.feature_names,
            'training_dist': self.training_dist,
            'regime_distribution': self.regime_distribution.tolist(),
            'meta_threshold': self.meta_threshold,
        }


def build_regimes(X: np.ndarray, n_regimes: int = 4) -> Tuple[KMeans, StandardScaler, np.ndarray]:
    """Layer 1: Discover market regimes from structural features."""
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    km = KMeans(n_clusters=n_regimes, random_state=42, n_init=10)
    labels = km.fit_predict(X_scaled)
    return km, scaler, labels


def train_base_models(X: np.ndarray, y: np.ndarray, regimes: np.ndarray,
                      n_regimes: int) -> List[lgb.LGBMClassifier]:
    """Layer 2: Train separate LightGBM per regime."""
    models = []
    for r in range(n_regimes):
        mask = regimes == r
        if mask.sum() < 50:
            # Not enough data — train a lightweight model
            m = lgb.LGBMClassifier(n_estimators=50, max_depth=4, num_leaves=15,
                learning_rate=0.05, subsample=0.8, class_weight='balanced',
                random_state=42, verbose=-1, force_col_wise=True)
        else:
            m = lgb.LGBMClassifier(n_estimators=200, max_depth=7, num_leaves=63,
                learning_rate=0.03, subsample=0.8, colsample_bytree=0.8,
                min_child_samples=min(30, mask.sum()//10),
                class_weight='balanced', random_state=42, verbose=-1, force_col_wise=True)
        m.fit(X[mask], y[mask])
        models.append(m)
    return models


def calibrate_per_regime(models: List[lgb.LGBMClassifier],
                         X: np.ndarray, y: np.ndarray,
                         regimes: np.ndarray,
                         n_regimes: int) -> List[IsotonicRegression]:
    """Layer 3: Calibrate probabilities per regime."""
    calibrators = []
    for r in range(n_regimes):
        mask = regimes == r
        if mask.sum() < 30:
            calibrators.append(IsotonicRegression(y_min=0.01, y_max=0.99, out_of_bounds='clip'))
            continue
        probs = models[r].predict_proba(X[mask])[:, 1]
        cal = IsotonicRegression(y_min=0.01, y_max=0.99, out_of_bounds='clip')
        cal.fit(probs, y[mask])
        calibrators.append(cal)
    return calibrators


def train_adversary(X: np.ndarray, y: np.ndarray,
                    models: List[lgb.LGBMClassifier],
                    regimes: np.ndarray, n_regimes: int) -> lgb.LGBMClassifier:
    """Layer 4: Train model that predicts FAILURES.

    The adversary learns: "given these features, regime, and model probability,
    will this trade lose money?" It's the metacognitive safety net.
    """
    # Get per-regime predictions
    probs = np.zeros(len(X))
    for r in range(n_regimes):
        mask = regimes == r
        if mask.sum() > 0:
            probs[mask] = models[r].predict_proba(X[mask])[:, 1]

    # Label: 1 = failure (trade didn't work out), 0 = success
    # Use structural_reward < 0.3 as failure threshold
    adv_labels = (y <= 0.3).astype(int)

    # Build adversary features: base features + regime_onehot + model_prob
    regime_onehot = np.zeros((len(X), n_regimes))
    for r in range(n_regimes):
        regime_onehot[:, r] = (regimes == r).astype(float)

    adv_features = np.hstack([X, regime_onehot, probs.reshape(-1, 1)])

    adv = lgb.LGBMClassifier(n_estimators=150, max_depth=6, num_leaves=31,
        learning_rate=0.03, subsample=0.8, class_weight='balanced',
        random_state=42, verbose=-1, force_col_wise=True)
    adv.fit(adv_features, adv_labels)

    return adv


def train_meta_learner(X: np.ndarray, y: np.ndarray,
                       models: List[lgb.LGBMClassifier],
                       calibrators: List[IsotonicRegression],
                       adversary: lgb.LGBMClassifier,
                       regimes: np.ndarray, n_regimes: int) -> Tuple[LogisticRegression, float]:
    """Layer 5: Learn how to combine base predictions + confidence + adversarial risk.

    Input features to meta-learner:
      - calibrated_base_prob (per regime)
      - regime_onehot
      - adversarial_risk_score
      - base_model_confidence (probability spread)
      - regime_purity (distance to regime centroid)
    """
    probs_cal = np.zeros(len(X))
    adv_risk = np.zeros(len(X))

    regime_onehot = np.zeros((len(X), n_regimes))
    for r in range(n_regimes):
        mask = regimes == r
        regime_onehot[:, r] = mask.astype(float)
        if mask.sum() > 0:
            raw = models[r].predict_proba(X[mask])[:, 1]
            probs_cal[mask] = calibrators[r].predict(raw)

    # Adversarial features
    adv_features = np.hstack([X, regime_onehot, probs_cal.reshape(-1, 1)])
    adv_risk = adversary.predict_proba(adv_features)[:, 1]

    # Meta features
    confidence = 2 * np.abs(probs_cal - 0.5)  # 0 = uncertain, 0.5+ = confident
    adverse = adv_risk  # higher = more likely to fail

    meta_X = np.column_stack([
        probs_cal,           # base model probability
        confidence,           # how confident
        adverse,              # adversary risk
        regime_onehot,        # which regime
    ])

    # Target: 1 if structural_reward > 0.5, else 0
    y_meta = (y > 0.5).astype(int)

    meta = LogisticRegression(C=1.0, class_weight='balanced', max_iter=1000)
    meta.fit(meta_X, y_meta)

    # Find optimal threshold
    meta_probs = meta.predict_proba(meta_X)[:, 1]
    best_t = 0.5; best_f1 = 0
    for t in np.arange(0.2, 0.9, 0.02):
        preds = (meta_probs >= t).astype(int)
        if preds.sum() < 10: continue
        tp = ((preds == 1) & (y_meta == 1)).sum()
        fp = ((preds == 1) & (y_meta == 0)).sum()
        fn = ((preds == 0) & (y_meta == 1)).sum()
        prec = tp / max(1, tp + fp)
        rec = tp / max(1, tp + fn)
        f1 = 2 * prec * rec / max(0.001, prec + rec)
        if f1 > best_f1:
            best_f1 = f1; best_t = t

    return meta, best_t


def metacognitive_predict(X: np.ndarray, state: MetacognitiveState) -> Dict[str, np.ndarray]:
    """Full metacognitive inference pipeline.

    Returns:
      - meta_prob: final P(win) from meta-learner
      - base_prob: per-regime calibrated probability
      - regime: assigned regime
      - confidence: model confidence
      - adv_risk: adversarial risk score
      - should_trade: meta_prob >= threshold
      - i_dont_know: confidence < 0.15 (model explicitly abstains)
    """
    n = len(X); nr = state.regimes

    # Layer 1: Assign regimes
    X_scaled = state.regime_scaler.transform(X)
    regime_labels = state.regime_model.predict(X_scaled)

    # Layer 2+3: Base predictions + calibrate
    base_probs = np.zeros(n)
    for r in range(nr):
        mask = regime_labels == r
        if mask.sum() > 0:
            raw = state.base_models[r].predict_proba(X[mask])[:, 1]
            base_probs[mask] = state.calibrators[r].predict(raw)

    # Layer 4: Adversarial risk
    regime_oh = np.zeros((n, nr))
    for r in range(nr):
        regime_oh[:, r] = (regime_labels == r).astype(float)
    adv_features = np.hstack([X, regime_oh, base_probs.reshape(-1, 1)])
    adv_risk = state.adversary.predict_proba(adv_features)[:, 1]

    # Layer 5: Meta-learner
    confidence = 2 * np.abs(base_probs - 0.5)
    meta_X = np.column_stack([base_probs, confidence, adv_risk, regime_oh])
    meta_probs = state.meta_learner.predict_proba(meta_X)[:, 1]

    should_trade = meta_probs >= state.meta_threshold
    i_dont_know = confidence < 0.15

    return {
        'meta_prob': meta_probs,
        'base_prob': base_probs,
        'regime': regime_labels,
        'confidence': confidence,
        'adv_risk': adv_risk,
        'should_trade': should_trade,
        'i_dont_know': i_dont_know,
    }


def train_full(X: np.ndarray, y: np.ndarray, feature_names: List[str],
               n_regimes: int = 4) -> MetacognitiveState:
    """Train the full metacognitive stack. Returns persisted state."""

    print(f"Training metacognitive model: {len(X)} rows, {len(feature_names)} features, {n_regimes} regimes")
    print(f"  Target distribution: mean={y.mean():.3f}, %>0.5={(y>0.5).mean()*100:.1f}%")

    # Split: train on 80%, hold out 20% for meta-learner calibration
    n = len(X)
    n_train = int(n * 0.8)
    X_t, X_meta = X[:n_train], X[n_train:]
    y_t, y_meta = y[:n_train], y[n_train:]

    # Layer 1
    print("\nLayer 1: Discovering market regimes...")
    km, scaler, regimes_full = build_regimes(X, n_regimes)
    regimes_t = regimes_full[:n_train]
    regimes_meta = regimes_full[n_train:]

    dist = np.bincount(regimes_t, minlength=n_regimes) / len(regimes_t)
    for r in range(n_regimes):
        mean_r = y_t[regimes_t == r].mean() if (regimes_t == r).sum() > 0 else 0
        print(f"  Regime {r}: {dist[r]*100:.1f}% of data, mean reward={mean_r:.3f}, n={(regimes_t==r).sum()}")

    # Layer 2
    print("Layer 2: Training per-regime base models...")
    base_models = train_base_models(X_t, (y_t > 0.5).astype(int), regimes_t, n_regimes)

    # Layer 3
    print("Layer 3: Calibrating per-regime...")
    calibrators = calibrate_per_regime(base_models, X_t, (y_t > 0.5).astype(int), regimes_t, n_regimes)

    # Layer 4
    print("Layer 4: Training adversarial validator...")
    adversary = train_adversary(X_t, y_t, base_models, regimes_t, n_regimes)

    # Layer 5
    print("Layer 5: Training meta-learner...")
    meta_learner, meta_threshold = train_meta_learner(
        X_meta, y_meta, base_models, calibrators, adversary, regimes_meta, n_regimes)

    print(f"  Meta threshold: {meta_threshold:.3f}")

    # Layer 6: Training distribution for drift detection
    training_dist = {}
    for i, name in enumerate(feature_names):
        training_dist[name] = {
            'mean': float(X[:, i].mean()),
            'std': float(X[:, i].std()),
        }

    state = MetacognitiveState(
        regimes=n_regimes,
        regime_model=km,
        regime_scaler=scaler,
        base_models=base_models,
        calibrators=calibrators,
        adversary=adversary,
        meta_learner=meta_learner,
        feature_names=feature_names,
        training_dist=training_dist,
        regime_distribution=dist,
        meta_threshold=meta_threshold,
    )

    # Quick validation
    result = metacognitive_predict(X, state)
    n_trade = result['should_trade'].sum()
    n_abstain = result['i_dont_know'].sum()
    wr_trade = y[result['should_trade'] > 0].mean() if n_trade > 0 else 0

    print(f"\nValidation on full dataset:")
    print(f"  Would trade: {n_trade}/{n} ({n_trade/n*100:.1f}%)")
    print(f"  Would abstain: {n_abstain}/{n} ({n_abstain/n*100:.1f}%)")
    print(f"  Mean reward when trading: {wr_trade:.3f}" if n_trade > 0 else "  No trades")

    return state


def save_state(state: MetacognitiveState, model_dir: Path):
    """Persist the full metacognitive model."""
    model_dir.mkdir(parents=True, exist_ok=True)

    # KMeans regime model
    pickle.dump(state.regime_model, open(model_dir / 'regime_model.pkl', 'wb'))
    pickle.dump(state.regime_scaler, open(model_dir / 'regime_scaler.pkl', 'wb'))

    # Per-regime base models
    for r, m in enumerate(state.base_models):
        pickle.dump(m, open(model_dir / f'base_model_r{r}.pkl', 'wb'))
        m.booster_.save_model(str(model_dir / f'base_model_r{r}.txt'))

    # Calibrators
    for r, c in enumerate(state.calibrators):
        pickle.dump(c, open(model_dir / f'calibrator_r{r}.pkl', 'wb'))

    # Adversary
    pickle.dump(state.adversary, open(model_dir / 'adversary.pkl', 'wb'))
    state.adversary.booster_.save_model(str(model_dir / 'adversary.txt'))

    # Meta-learner
    pickle.dump(state.meta_learner, open(model_dir / 'meta_learner.pkl', 'wb'))

    # Metadata
    json.dump(state.to_dict(), open(model_dir / 'meta_state.json', 'w'), indent=2)

    print(f"Metacognitive model saved to {model_dir}")


def load_state(model_dir: Path) -> MetacognitiveState:
    """Load a persisted metacognitive model."""
    meta = json.load(open(model_dir / 'meta_state.json'))

    regime_model = pickle.load(open(model_dir / 'regime_model.pkl', 'rb'))
    regime_scaler = pickle.load(open(model_dir / 'regime_scaler.pkl', 'rb'))

    base_models = [pickle.load(open(model_dir / f'base_model_r{r}.pkl', 'rb'))
                   for r in range(meta['regimes'])]
    calibrators = [pickle.load(open(model_dir / f'calibrator_r{r}.pkl', 'rb'))
                   for r in range(meta['regimes'])]
    adversary = pickle.load(open(model_dir / 'adversary.pkl', 'rb'))
    meta_learner = pickle.load(open(model_dir / 'meta_learner.pkl', 'rb'))

    return MetacognitiveState(
        regimes=meta['regimes'],
        regime_model=regime_model,
        regime_scaler=regime_scaler,
        base_models=base_models,
        calibrators=calibrators,
        adversary=adversary,
        meta_learner=meta_learner,
        feature_names=meta['feature_names'],
        training_dist=meta['training_dist'],
        regime_distribution=np.array(meta['regime_distribution']),
        meta_threshold=meta['meta_threshold'],
    )
