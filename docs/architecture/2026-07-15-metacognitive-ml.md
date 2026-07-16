# Metacognitive ML Architecture for Trading

**Date:** 2026-07-15 | **Author:** Claude Opus 4.8

## What "Metacognitive" Means in Trading

A metacognitive ML system doesn't just predict — it **thinks about its own thinking**:

```
Layer 1: PREDICT        → "This trade has 68% win probability"
Layer 2: CALIBRATE      → "But our Brier score is 0.21, actual WR at 68% prob is only 58%"
Layer 3: CONTEXT        → "We're in a ranging regime, our edge is +2% in ranges vs +8% in trends"
Layer 4: SELF-CRITIQUE  → "The adversary says: OB detection is noisy, FVG retest is cleaner"
Layer 5: ADAPT          → "Recent 20 trades: WR 45% vs expected 65% → DOWNWEIGHT signals"
Layer 6: META-LEARN     → "SHAP drift detected: bb_width dropping, impulse_score rising → retrain"
```

## Architecture

```
                    ┌──────────────────────────────┐
                    │     TRADE SIGNAL INPUT        │
                    │  (v6.0 Pine Script output)    │
                    └──────────────┬───────────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            ▼                      ▼                      ▼
   ┌────────────────┐    ┌────────────────┐    ┌────────────────┐
   │  BASE MODEL    │    │ REGIME MODEL   │    │ ADVERSARIAL    │
   │  P(win | x)    │    │ P(regime | x)  │    │ MODEL          │
   │  E(R | x)      │    │ edge per regime│    │ "Is this real?"│
   └───────┬────────┘    └───────┬────────┘    └───────┬────────┘
           │                     │                      │
           └─────────────────────┼──────────────────────┘
                                 │
                    ┌────────────▼───────────┐
                    │   METACOGNITIVE FUSION │
                    │                        │
                    │  score = f(             │
                    │    base_prob,           │
                    │    calibration_factor,  │
                    │    regime_multiplier,   │
                    │    adversarial_score,   │
                    │    recency_decay        │
                    │  )                      │
                    └────────────┬───────────┘
                                 │
                    ┌────────────▼───────────┐
                    │   POSITION SIZING       │
                    │   Kelly × confidence    │
                    │   f* = (bp - q) / b     │
                    │   × regime_factor      │
                    │   × recency_factor      │
                    └────────────┬───────────┘
                                 │
                    ┌────────────▼───────────┐
                    │   ONLINE FEEDBACK LOOP │
                    │   Actual outcome →      │
                    │   update calibration,   │
                    │   detect drift,         │
                    │   adapt weights         │
                    └────────────────────────┘
```

## Component 1: Calibrated Base Model

The standard LightGBM predicts P(win). But raw probabilities are miscalibrated.
We fix this with **isotonic regression** on a held-out calibration set.

```python
from sklearn.isotonic import IsotonicRegression

# After training base model:
calib = IsotonicRegression(out_of_bounds='clip')
calib.fit(val_probs, val_outcomes)

# At inference:
raw_prob = model.predict_proba(features)[:, 1]
calibrated_prob = calib.predict([raw_prob])[0]
```

**Key insight**: At `calibrated_prob = 0.65`, the actual WR should be ~65%.
If it's 52%, the calibration is broken → downweight.

## Component 2: Regime-Aware Model

Cluster market states and measure edge per regime:

```python
# Unsupervised regime detection
regimes = {
    'strong_trend':    (ADX > 30, ma25 > ma99, bb_width_expanding),
    'weak_trend':      (ADX 20-30, ma25 > ma99, bb_stable),
    'ranging':         (ADX < 20, bb_squeezing),
    'volatile':        (ATR > 90th_percentile, bb_wide),
    'quiet':           (ATR < 10th_percentile, volume_below_avg),
    'breakout':        (bb_width expanding from squeeze, volume_spike),
}

# Edge matrix (learned from training data)
edge_by_regime = {
    'strong_trend':    {'edge': +0.12, 'signal_rate': 0.35, 'weight': 1.5},
    'weak_trend':      {'edge': +0.05, 'signal_rate': 0.25, 'weight': 1.0},
    'ranging':         {'edge': -0.02, 'signal_rate': 0.15, 'weight': 0.5},
    'volatile':        {'edge': +0.08, 'signal_rate': 0.10, 'weight': 0.8},
    'quiet':           {'edge': -0.01, 'signal_rate': 0.05, 'weight': 0.2},
    'breakout':        {'edge': +0.18, 'signal_rate': 0.08, 'weight': 2.0},
}
```

## Component 3: Adversarial Self-Critique

Train a **second model to predict FAILURES** of the first model.
If the adversary is confident this trade will fail, reduce conviction.

```python
# Train adversarial model:
# Label = 1 if base_model predicted >0.6 but trade LOST
# This model learns: "what do the base model's failures look like?"

adv_labels = []
for trade in training_data:
    base_prob = base_model.predict(trade.features)
    if base_prob > 0.6 and not trade.win:
        adv_labels.append(1)  # This is a high-conviction failure
    elif base_prob > 0.6 and trade.win:
        adv_labels.append(0)  # High-conviction success
    else:
        adv_labels.append(None)  # Low-conviction trades not used

adv_model = LGBMClassifier()
adv_model.fit(adv_features[adv_labels is not None], adv_labels[adv_labels is not None])

# At inference:
base_prob = base_model.predict_proba(features)[:, 1]
adv_prob = adv_model.predict_proba(features)[:, 1]  # P(this will fail despite high base confidence)

# Adversarial score: 1.0 = adversary thinks this is clean, 0.0 = adversary is worried
adv_score = 1.0 - adv_prob
```

## Component 4: Online Drift Detection

Compare recent trade features to training distribution:

```python
from scipy.special import rel_entr

def detect_drift(recent_features, training_distribution, window=50):
    """KL divergence between recent and training feature distributions."""
    recent_mean = recent_features[-window:].mean(axis=0)
    recent_std = recent_features[-window:].std(axis=0)
    
    # KL divergence per feature
    drift_scores = []
    for i, feat in enumerate(features):
        kl = rel_entr(recent_mean[i], training_distribution['mean'][i])
        drift_scores.append(kl)
    
    total_drift = sum(drift_scores)
    if total_drift > 2.0:  # Threshold from backtest
        return {'drifting': True, 'severity': total_drift, 'top_drifters': [...]}
    return {'drifting': False}
```

## Component 5: Recency-Weighted Confidence

Recent outcomes are more informative than old ones:

```python
def recency_weighted_accuracy(recent_trades, expected_wr, window=20):
    """EMA of actual WR vs expected, with recency bias."""
    alpha = 2 / (window + 1)  # EMA decay
    ema_actual = 0.5
    ema_expected = 0.5
    
    for trade in recent_trades[-window:]:
        ema_actual = alpha * trade.win + (1 - alpha) * ema_actual
        ema_expected = alpha * trade.predicted_prob + (1 - alpha) * ema_expected
    
    # Ratio > 1 = outperforming, < 1 = underperforming
    performance_ratio = ema_actual / max(ema_expected, 0.01)
    
    # Sigmoid squash to [0.5, 1.5] multiplier
    return 0.5 + 1.0 / (1 + math.exp(-5 * (performance_ratio - 1.0)))
```

## Component 6: Metacognitive Fusion

All components feed into a final confidence score:

```python
def metacognitive_score(features, recent_trades, regime, training_dist):
    """The master scoring function."""
    
    # Layer 1: Base prediction
    raw_prob = base_model.predict_proba(features)[:, 1]
    calibrated_prob = calib.predict([raw_prob])[0]
    
    # Layer 2: Regime context
    regime_info = edge_by_regime.get(regime, {'weight': 0.5})
    regime_mult = regime_info['weight']
    
    # Layer 3: Adversarial check
    if calibrated_prob > 0.55:  # Only critique high-conviction trades
        adv_prob = adv_model.predict_proba(features)[:, 1]
        adv_mult = 1.0 - adv_prob * 0.5  # Adversary can halve confidence
    else:
        adv_mult = 1.0
    
    # Layer 4: Drift check
    drift = detect_drift(features, training_dist)
    drift_mult = 0.5 if drift['drifting'] else 1.0
    
    # Layer 5: Recency
    recency_mult = recency_weighted_accuracy(recent_trades, calibrated_prob)
    
    # Layer 6: FUSION
    meta_confidence = (
        calibrated_prob *
        regime_mult *
        adv_mult *
        drift_mult *
        recency_mult
    )
    
    # Clamp to [0, 1]
    meta_confidence = max(0.0, min(1.0, meta_confidence))
    
    # Position size: Kelly criterion scaled by meta-confidence
    edge = meta_confidence - (1 - meta_confidence)  # p - q
    kelly_fraction = max(0, edge)  # Half-Kelly for safety
    
    return {
        'meta_confidence': meta_confidence,
        'kelly_fraction': kelly_fraction,
        'breakdown': {
            'base_prob': raw_prob,
            'calibrated_prob': calibrated_prob,
            'regime_mult': regime_mult,
            'adv_mult': adv_mult,
            'drift_mult': drift_mult,
            'recency_mult': recency_mult,
        },
        'warnings': [
            'DRIFT' if drift['drifting'] else None,
            'LOW_REGIME' if regime_mult < 0.5 else None,
            'ADVERSARY_WARN' if adv_mult < 0.7 else None,
            'LOW_RECENCY' if recency_mult < 0.7 else None,
        ]
    }
```

## Self-Improving Loop

Every N trades, the system:
1. Computes actual vs expected outcomes
2. If Brier score degraded > 10% → recalibrate isotonic regression
3. If KL drift > threshold → flag for retraining
4. If regime edge matrix stale (>30 days) → recompute edge_by_regime
5. Logs metacognitive state to database for debugging

## Implementation Priority

| Component | Complexity | Impact | Build First? |
|-----------|-----------|--------|-------------|
| Calibrated probabilities | Low | High | ✅ YES |
| Regime detection | Low | High | ✅ YES |
| Recency weighting | Low | Medium | ✅ YES |
| Adversarial model | Medium | High | ✅ YES |
| Drift detection | Medium | Medium | After |
| Online retraining | High | High | After |
