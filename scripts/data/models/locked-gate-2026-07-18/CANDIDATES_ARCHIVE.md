# candidates.jsonl — archived off git (2026-07-21)

`report.json`'s `artifacts.candidates` field points at `candidates.jsonl` in
this directory. That file is no longer in git — at 507,891,502 bytes it
exceeded GitHub's 100MB limit and was stripped from history (`git-filter-repo`,
2026-07-21) after being pushed here as a blocker on the first push attempt
of this branch.

## What it is

Row-level output of `scripts/ml/locked-walkforward-backtest.py`'s purged
walk-forward run against `meta-v22-definitive` on the 49-pair/120-day corpus
(`scripts/data/klines-mtf-extended.json`) — every symbol/bar candidate the
backtest scored, before threshold filtering and the train/70%/val/15%/test/15%
split. This is the audit trail behind `report.json`'s finding (0 qualified
test trades, calibrated probabilities never exceed 0.243 against the 0.52
threshold) — not the finding itself. You very likely do not need this file;
`report.json` already has the actual result.

## Where it lives now

VPS `5.161.229.209` (Hetzner execution server), at:

```
/opt/anavitrade/backtest-archive/locked-gate-2026-07-18/candidates.jsonl
```

sha256 (verified matching before the git blob was deleted):
```
1dfafc5e56fa49c5b165b3dc6a9616c2d6b90532c1099c9c4954bb3d6cf4fab6
```

## Retrieving it

```bash
scp root@5.161.229.209:/opt/anavitrade/backtest-archive/locked-gate-2026-07-18/candidates.jsonl \
  scripts/data/models/locked-gate-2026-07-18/candidates.jsonl

# verify integrity after transfer:
sha256sum scripts/data/models/locked-gate-2026-07-18/candidates.jsonl
# expect: 1dfafc5e56fa49c5b165b3dc6a9616c2d6b90532c1099c9c4954bb3d6cf4fab6
```

Do not re-commit it to git if you pull it back down locally — it will hit
the same 100MB limit. If it ever needs to travel with the repo, use Git LFS.

## Regenerating it from scratch (if the VPS copy is ever lost)

The input corpus is hash-verified in `report.json.input.sha256`, so a rerun
against the same input file reproduces this exactly:

```bash
python3 scripts/ml/locked-walkforward-backtest.py \
  --input scripts/data/klines-mtf-extended.json \
  --output-dir scripts/data/models/locked-gate-2026-07-18 \
  --n-jobs 2
```

Confirm `scripts/data/klines-mtf-extended.json`'s sha256 still matches
`report.json.input.sha256` before trusting a regenerated file as identical.
