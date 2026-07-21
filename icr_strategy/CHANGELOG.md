# Changelog

## v8 Segment Validation

- Added `icr/segment_validation.py`: honest sub-segment discovery + validation
  (session, direction, symbol, day-of-week, entry-year, score bucket,
  ICT killzone flag, divergence class — pre-entry attributes only).
- Gates per segment: within-axis max-statistic permutation test (cluster-aware
  by entry timestamp for time-derived axes), family-wide Holm-Bonferroni,
  chronological split-half consistency, leave-one-symbol-out expectancy,
  cluster bootstrap CI, and a minimum n=30 for any VALIDATED verdict.
- Wired into `write_reports` so every backtest now emits
  `segment_candidates.csv` + `segment_validation.json` by default.
- CLI: `python -m icr.segment_validation --trades OUT/trades.csv --output DIR`.
- Added missing `scipy` pin to requirements.txt (used by edge_decision/stats/audit).
- Tests: `tests/test_segment_validation.py` (noise yields no VALIDATED verdicts;
  injected effects detected; concentration and half-life effects blocked).

## v7 Real Edge

- Added real-edge research harness.
- Added HTF coil gate into the actual ICR signal path.
- Added causal candle-level coil score annotation.
- Added requested four-combo ablation report: base ICR, ICR+HTF coil, ICR+Coinlegs, ICR+HTF coil+Coinlegs.
- Added yearly walk-forward report.
- Added false-positive trap report.
- Added best-threshold sweep report.
- Added edge_decision.json with explicit deploy/no-deploy decision.
- Added optional Playwright Coinlegs renderer with `requirements-browser.txt`.
- Fixed 200-litmus audit timeout by separating fast/bounded audit from real combo ablations.
- Preserved no-live-trading, no-API-key, no-login-bypass, and non-recursive file loading constraints.
