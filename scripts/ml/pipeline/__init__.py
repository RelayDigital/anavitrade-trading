"""
Anavitrade ML Pipeline — composable, swap-any-stage architecture.

Each module does ONE thing:
  features   — Indicator computation from raw klines
  smc        — SMC pattern detection (OB, FVG, Sweep, CHoCH)
  enrichment — Merge indicators + SMC into feature vectors
  labels     — Forward outcome computation (NO lookahead)
  model      — LightGBM training + isotonic calibration
  backtest   — Chronological backtest, threshold sweep, metrics
  registry   — Model versioning with comparable metrics

Modules are INDEPENDENT. Change the SMC detector without touching
indicator computation. Swap LightGBM for XGBoost without rebuilding
features. Test each stage in isolation.
"""
