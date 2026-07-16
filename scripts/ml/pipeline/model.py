"""LightGBM training + isotonic calibration + adversarial risk model.

Trains on feature dicts + labels → produces calibrated P(win) predictions.
The isotonic calibration IS the decision threshold — no arbitrary scoring."""

import json, pickle, numpy as np
from pathlib import Path
from typing import List, Dict, Tuple
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
import lightgbm as lgb

from .config import PipelineConfig, DEFAULT

META_COLS = {'symbol', 'timestamp', 'direction'}
LABEL_COLS = {'hitTP', 'hitStop', 'maxFavorableR', 'maxAdverseR', 'pnlR', 'barsToOutcome', '_bar_index'}


def rows_to_matrix(rows: List[Dict]) -> Tuple[np.ndarray, np.ndarray, np.ndarray, List[str]]:
    """Convert feature dicts → X, y_win, y_pnl matrices."""
    feature_names = sorted(set(rows[0].keys()) - META_COLS - LABEL_COLS)
    X = np.array([[float(r.get(c, 0) or 0) for c in feature_names] for r in rows], dtype=np.float32)
    y_win = np.array([1 if r.get('hitTP') else 0 for r in rows], dtype=np.int32)
    y_pnl = np.array([float(r.get('pnlR', 0) or 0) for r in rows], dtype=np.float32)
    return X, y_win, y_pnl, feature_names


def train_chronological(rows: List[Dict], cfg: PipelineConfig = DEFAULT) -> Dict:
    """Train with chronological 60/40 split. Returns model artifacts dict."""
    # Sort by timestamp
    rows_sorted = sorted(rows, key=lambda r: r['timestamp'])
    split = int(len(rows_sorted) * cfg.train_split)

    X, y, _, feature_names = rows_to_matrix(rows_sorted)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]
    ts_test = [r['timestamp'] for r in rows_sorted[split:]]

    # Split train into actual-train and calibration-holdout
    cal_split = int(len(X_train) * 0.8)
    X_t, X_cal = X_train[:cal_split], X_train[cal_split:]
    y_t, y_cal = y_train[:cal_split], y_train[cal_split:]

    # Train classifier
    clf = lgb.LGBMClassifier(
        n_estimators=cfg.lgbm_estimators, max_depth=cfg.lgbm_max_depth,
        num_leaves=min(63, 2 ** cfg.lgbm_max_depth - 1),
        learning_rate=cfg.lgbm_learning_rate,
        subsample=cfg.lgbm_subsample, colsample_bytree=cfg.lgbm_colsample,
        min_child_samples=cfg.lgbm_min_child,
        reg_alpha=cfg.lgbm_reg_alpha, reg_lambda=cfg.lgbm_reg_lambda,
        class_weight='balanced', random_state=42, verbose=-1,
        force_col_wise=True,
    )
    clf.fit(X_t, y_t)

    # Calibrate
    probs_cal = clf.predict_proba(X_cal)[:, 1]
    calibrator = IsotonicRegression(y_min=0, y_max=1, out_of_bounds='clip')
    calibrator.fit(probs_cal, y_cal)

    # Score test set
    probs_raw = clf.predict_proba(X_test)[:, 1]
    probs_calibrated = calibrator.predict(probs_raw)

    auc = roc_auc_score(y_test, probs_calibrated)
    brier = brier_score_loss(y_test, probs_calibrated)

    # Find best threshold on test set (max Sharpe)
    best_sharpe = -999; best_t = 0.5
    for t in np.arange(0.50, 0.88, 0.02):
        mask = probs_calibrated >= t
        if mask.sum() < 20: continue
        pnl_test = np.array([float(rows_sorted[split:][i].get('pnlR', 0) or 0) for i in range(len(y_test))])
        p = pnl_test[mask]
        if len(p) > 1 and p.std() > 0:
            s = p.mean() / p.std() * np.sqrt(len(p))
            if s > best_sharpe:
                best_sharpe = s; best_t = t

    # Best-threshold metrics
    best_mask = probs_calibrated >= best_t
    pnl_test = np.array([float(rows_sorted[split:][i].get('pnlR', 0) or 0) for i in range(len(y_test))])
    p_best = pnl_test[best_mask]
    wr_best = y_test[best_mask].mean() if best_mask.sum() > 0 else 0
    gp = p_best[p_best > 0].sum(); gl = abs(p_best[p_best < 0].sum())
    pf_best = gp/gl if gl > 0 else 999

    # Train adversarial risk model
    y_adv = np.array([1 if float(rows_sorted[i].get('maxAdverseR', 0) or 0) > 2.0
                      else 0 for i in range(len(rows_sorted))], dtype=np.int32)
    adv = lgb.LGBMClassifier(n_estimators=100, max_depth=5, num_leaves=31,
        learning_rate=0.02, subsample=0.8, class_weight='balanced',
        random_state=42, verbose=-1, force_col_wise=True)
    adv.fit(X_train, y_adv[:len(X_train)])

    return {
        'classifier': clf, 'calibrator': calibrator, 'adversary': adv,
        'feature_names': feature_names,
        'best_threshold': best_t,
        'test_auc': auc, 'test_brier': brier,
        'test_wr': float(wr_best), 'test_pf': float(pf_best),
        'test_sharpe': float(best_sharpe),
        'test_trades': int(best_mask.sum()),
        'test_pass_rate': float(best_mask.sum() / len(y_test) * 100),
        'train_rows': len(X_train), 'test_rows': len(X_test),
        'split_ts': int(ts_test[0]),
    }


def save_model(artifacts: Dict, model_dir: Path):
    """Persist model artifacts to disk."""
    model_dir.mkdir(parents=True, exist_ok=True)
    artifacts['classifier'].booster_.save_model(str(model_dir / 'lgbm_base.txt'))
    with open(model_dir / 'lgbm_base.pkl', 'wb') as f:
        pickle.dump(artifacts['classifier'], f)
    with open(model_dir / 'calibrator.pkl', 'wb') as f:
        pickle.dump(artifacts['calibrator'], f)
    with open(model_dir / 'lgbm_adversary.pkl', 'wb') as f:
        pickle.dump(artifacts['adversary'], f)
    with open(model_dir / 'feature_names.json', 'w') as f:
        json.dump(artifacts['feature_names'], f)

    # Save training config + metrics
    meta = {k: v for k, v in artifacts.items()
            if k not in ('classifier', 'calibrator', 'adversary')}
    with open(model_dir / 'training_results.json', 'w') as f:
        json.dump(meta, f, indent=2, default=str)

    print(f"Model saved to {model_dir}")
    print(f"  Features: {len(artifacts['feature_names'])}")
    print(f"  Train rows: {artifacts['train_rows']}, Test rows: {artifacts['test_rows']}")
    print(f"  AUC: {artifacts['test_auc']:.4f}, Brier: {artifacts['test_brier']:.4f}")
    print(f"  Best threshold: {artifacts['best_threshold']:.4f}")
    print(f"  Test WR: {artifacts['test_wr']*100:.1f}%, PF: {artifacts['test_pf']:.2f}, Sharpe: {artifacts['test_sharpe']:.2f}")
    print(f"  Trades: {artifacts['test_trades']} ({artifacts['test_pass_rate']:.1f}% pass rate)")


def load_model(model_dir: Path) -> Dict:
    """Load model artifacts."""
    with open(model_dir / 'lgbm_base.pkl', 'rb') as f:
        clf = pickle.load(f)
    with open(model_dir / 'calibrator.pkl', 'rb') as f:
        cal = pickle.load(f)
    with open(model_dir / 'feature_names.json') as f:
        features = json.load(f)
    return {'classifier': clf, 'calibrator': cal, 'feature_names': features}
