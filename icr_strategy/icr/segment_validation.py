"""Honest sub-segment discovery and validation for ICR backtest trades.

Motivation: an aggregate "no edge" verdict can hide a real sub-segment effect
(session, direction, symbol, regime), while naive subgroup eyeballing is
noise-mining. This module tests every pre-entry segment the trade log
supports, then gates each apparent effect through:

1. A within-axis max-statistic permutation test (controls "best of K levels"
   selection — the p-value answers: how often does the BEST level of this axis
   look this good under label shuffling?). Time-derived axes are permuted at
   the entry-timestamp cluster level so simultaneous correlated entries are
   not treated as independent evidence.
2. Family-wide Holm-Bonferroni correction across ALL segments tested.
3. A chronological split-half consistency gate (effect must be positive in
   both halves of the sample, not just one lucky year).
4. A leave-one-symbol-out (LOSO) gate (effect must survive removing its best
   single symbol — kills "one hot coin carried the whole segment").
5. A minimum sample-size gate for any VALIDATED claim.

Only pre-entry attributes are ever used to define segments. Outcome-derived
columns (hold_bars, exit reason, pnl) are deliberately excluded: segmenting on
them is lookahead bias.

Verdicts:
- VALIDATED: passed every gate. Worth an out-of-sample confirmation run.
- CANDIDATE: raw permutation p < alpha but failed >= 1 gate (listed).
- NOISE: everything else.

CLI:
    python -m icr.segment_validation --trades OUT/trades.csv --output OUT/segments
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from .audit import holm_bonferroni_correction
from .reporting import session_bucket


@dataclass(frozen=True)
class SegmentValidationConfig:
    min_trades: int = 15
    min_validated_trades: int = 30
    n_permutations: int = 2000
    n_bootstrap: int = 2000
    alpha: float = 0.05
    seed: int = 7
    max_symbol_levels: int = 40


@dataclass(frozen=True)
class SegmentResult:
    axis: str
    level: str
    n_trades: int
    net_r: float
    expectancy_r: float
    win_rate: float
    bootstrap_ci_low: float | None
    bootstrap_ci_high: float | None
    p_permutation: float
    p_holm: float | None
    holm_significant: bool
    split_half_expectancy_first: float | None
    split_half_expectancy_second: float | None
    split_half_consistent: bool
    loso_min_expectancy_r: float | None
    loso_worst_symbol: str | None
    verdict: str
    failed_gates: tuple[str, ...]

    def to_dict(self) -> dict:
        row = asdict(self)
        row["failed_gates"] = ";".join(self.failed_gates)
        return row


@dataclass(frozen=True)
class SegmentValidationReport:
    segments: list[SegmentResult]
    n_trades: int
    config: SegmentValidationConfig
    notes: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Frame preparation: derive pre-entry axes only.
# ---------------------------------------------------------------------------

_DIV_RE = re.compile(r"DIV\(\d+\):\s*([a-z_]+)/")
_KILLZONE_RE = re.compile(r"ny_killzone=(True|False)")


def _parse_reason_flag(reason: str, pattern: re.Pattern[str], default: str) -> str:
    match = pattern.search(reason or "")
    return match.group(1) if match else default


def prepare_trades_frame(trades: pd.DataFrame) -> pd.DataFrame:
    """Return a NEW frame with derived pre-entry segmentation columns."""
    df = trades.copy(deep=True)
    if df.empty:
        return df
    entry_dt = pd.to_datetime(df["entry_time"], utc=True, format="ISO8601")
    df["entry_dt"] = entry_dt
    if "session" not in df.columns:
        df["session"] = entry_dt.map(session_bucket)
    df["day_of_week"] = entry_dt.dt.day_name().str.lower()
    df["entry_year"] = entry_dt.dt.year.astype(str)
    if "score" in df.columns:
        df["score_bucket"] = pd.cut(
            df["score"], bins=[0, 80, 90, 100], labels=["score_le80", "score_81_90", "score_91_100"], include_lowest=True
        ).astype(str)
    reason = df["reason"] if "reason" in df.columns else pd.Series([""] * len(df), index=df.index)
    df["ny_killzone"] = reason.map(lambda r: "killzone_" + _parse_reason_flag(str(r), _KILLZONE_RE, "unknown").lower())
    df["divergence_class"] = reason.map(lambda r: _parse_reason_flag(str(r), _DIV_RE, "none"))
    return df


# (axis column, permute at entry-timestamp cluster level?)
_AXES: tuple[tuple[str, bool], ...] = (
    ("session", True),
    ("day_of_week", True),
    ("entry_year", True),
    ("direction", False),
    ("symbol", False),
    ("asset_class", False),
    ("timeframe", False),
    ("score_bucket", False),
    ("ny_killzone", False),
    ("divergence_class", False),
)


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def _max_stat_permutation_pvalues(
    labels: np.ndarray,
    r_values: np.ndarray,
    qualifying: list[str],
    cluster_ids: np.ndarray | None,
    cfg: SegmentValidationConfig,
    rng: np.random.Generator,
) -> dict[str, float]:
    """Permutation p per qualifying level against the MAX level-mean null.

    For each shuffle of labels (cluster-aware when cluster_ids given), record
    the maximum mean R across qualifying levels. Each observed level mean is
    compared against that max distribution, which controls within-axis
    selection ("we looked at every level and picked the best").
    """
    observed = {lvl: float(r_values[labels == lvl].mean()) for lvl in qualifying}
    if cluster_ids is not None:
        # Labels are constant within a cluster: permute label-per-cluster.
        cluster_frame = pd.DataFrame({"cluster": cluster_ids, "label": labels})
        per_cluster = cluster_frame.drop_duplicates("cluster").set_index("cluster")["label"]
        cluster_keys = per_cluster.index.to_numpy()
        cluster_labels = per_cluster.to_numpy()
        max_null = np.empty(cfg.n_permutations)
        for i in range(cfg.n_permutations):
            shuffled = rng.permutation(cluster_labels)
            mapping = dict(zip(cluster_keys, shuffled))
            perm = np.array([mapping[c] for c in cluster_ids])
            means = [r_values[perm == lvl].mean() for lvl in qualifying if (perm == lvl).sum() > 0]
            max_null[i] = max(means) if means else -np.inf
    else:
        max_null = np.empty(cfg.n_permutations)
        for i in range(cfg.n_permutations):
            perm = rng.permutation(labels)
            means = [r_values[perm == lvl].mean() for lvl in qualifying if (perm == lvl).sum() > 0]
            max_null[i] = max(means) if means else -np.inf
    return {
        lvl: float((np.sum(max_null >= observed[lvl]) + 1) / (cfg.n_permutations + 1))
        for lvl in qualifying
    }


def _cluster_bootstrap_ci(
    segment: pd.DataFrame, cfg: SegmentValidationConfig, rng: np.random.Generator
) -> tuple[float | None, float | None]:
    """95% CI on mean R, resampling entry-timestamp clusters (not trades)."""
    clusters = [g["total_r"].to_numpy() for _, g in segment.groupby("entry_dt")]
    if len(clusters) < 3:
        return None, None
    means = np.empty(cfg.n_bootstrap)
    n_clusters = len(clusters)
    for i in range(cfg.n_bootstrap):
        picks = rng.integers(0, n_clusters, size=n_clusters)
        sample = np.concatenate([clusters[p] for p in picks])
        means[i] = sample.mean()
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def _split_half(df: pd.DataFrame, mask: np.ndarray) -> tuple[float | None, float | None, bool]:
    order = df["entry_dt"].argsort(kind="stable").to_numpy()
    ranks = np.empty(len(df), dtype=int)
    ranks[order] = np.arange(len(df))
    first = mask & (ranks < len(df) // 2)
    second = mask & (ranks >= len(df) // 2)
    if first.sum() < 3 or second.sum() < 3:
        return None, None, False
    m1 = float(df.loc[first, "total_r"].mean())
    m2 = float(df.loc[second, "total_r"].mean())
    return m1, m2, bool(m1 > 0 and m2 > 0)


def _leave_one_symbol_out(segment: pd.DataFrame) -> tuple[float | None, str | None]:
    symbols = segment["symbol"].unique() if "symbol" in segment.columns else []
    if len(symbols) < 2:
        return None, None
    worst, worst_symbol = None, None
    for symbol in symbols:
        expectancy = float(segment.loc[segment["symbol"] != symbol, "total_r"].mean())
        if worst is None or expectancy < worst:
            worst, worst_symbol = expectancy, str(symbol)
    return worst, worst_symbol


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def run_segment_validation(
    trades: pd.DataFrame, cfg: SegmentValidationConfig | None = None
) -> SegmentValidationReport:
    cfg = cfg or SegmentValidationConfig()
    notes: list[str] = []
    if trades is None or trades.empty:
        return SegmentValidationReport(segments=[], n_trades=0, config=cfg, notes=["no trades"])
    df = prepare_trades_frame(trades)
    df = df[pd.notna(df["total_r"])].reset_index(drop=True)
    rng = np.random.default_rng(cfg.seed)
    r_values = df["total_r"].to_numpy(dtype=float)
    cluster_ids = df["entry_dt"].astype("int64").to_numpy()

    raw_rows: list[dict] = []
    for axis, cluster_level in _AXES:
        if axis not in df.columns:
            continue
        labels = df[axis].astype(str).to_numpy()
        counts = pd.Series(labels).value_counts()
        qualifying = [str(lvl) for lvl, n in counts.items() if n >= cfg.min_trades]
        if axis == "symbol" and len(counts) > cfg.max_symbol_levels:
            notes.append(f"axis symbol skipped: {len(counts)} levels > {cfg.max_symbol_levels}")
            continue
        if len(counts) < 2 or not qualifying:
            continue
        pvals = _max_stat_permutation_pvalues(
            labels, r_values, qualifying, cluster_ids if cluster_level else None, cfg, rng
        )
        for level in qualifying:
            mask = labels == level
            segment = df.loc[mask]
            ci_low, ci_high = _cluster_bootstrap_ci(segment, cfg, rng)
            m1, m2, consistent = _split_half(df, mask)
            loso, loso_symbol = _leave_one_symbol_out(segment)
            raw_rows.append(
                {
                    "axis": axis,
                    "level": level,
                    "n_trades": int(mask.sum()),
                    "net_r": float(segment["total_r"].sum()),
                    "expectancy_r": float(segment["total_r"].mean()),
                    "win_rate": float((segment["total_r"] > 0.05).mean()),
                    "bootstrap_ci_low": ci_low,
                    "bootstrap_ci_high": ci_high,
                    "p_permutation": pvals[level],
                    "split_half_expectancy_first": m1,
                    "split_half_expectancy_second": m2,
                    "split_half_consistent": consistent,
                    "loso_min_expectancy_r": loso,
                    "loso_worst_symbol": loso_symbol,
                }
            )

    family_p = [row["p_permutation"] for row in raw_rows]
    holm = holm_bonferroni_correction(family_p, alpha=cfg.alpha)
    adjusted = holm.get("corrected_p_values") or [None] * len(raw_rows)
    rejected = list(holm.get("significant") or [False] * len(raw_rows))
    # Enforce the Holm step-down stopping rule (once one sorted hypothesis
    # fails, every later one must also fail) — the shared helper omits it.
    failed_yet = False
    for idx in np.argsort(family_p):
        if failed_yet:
            rejected[idx] = False
        elif not rejected[idx]:
            failed_yet = True

    segments: list[SegmentResult] = []
    for row, p_holm, holm_sig in zip(raw_rows, adjusted, rejected):
        failed: list[str] = []
        if row["expectancy_r"] <= 0:
            failed.append("negative_expectancy")
        if row["n_trades"] < cfg.min_validated_trades:
            failed.append(f"n<{cfg.min_validated_trades}")
        if not holm_sig:
            failed.append("holm_not_significant")
        if not row["split_half_consistent"]:
            failed.append("split_half_inconsistent")
        if row["loso_min_expectancy_r"] is not None and row["loso_min_expectancy_r"] <= 0:
            failed.append("fails_leave_one_symbol_out")
        if row["bootstrap_ci_low"] is not None and row["bootstrap_ci_low"] <= 0:
            failed.append("bootstrap_ci_includes_zero")
        if not failed:
            verdict = "VALIDATED"
        elif row["p_permutation"] < cfg.alpha and row["expectancy_r"] > 0:
            verdict = "CANDIDATE"
        else:
            verdict = "NOISE"
        segments.append(
            SegmentResult(
                **row,
                p_holm=None if p_holm is None else float(p_holm),
                holm_significant=bool(holm_sig),
                verdict=verdict,
                failed_gates=tuple(failed),
            )
        )

    segments.sort(key=lambda s: (s.verdict != "VALIDATED", s.verdict != "CANDIDATE", s.p_permutation))
    return SegmentValidationReport(segments=segments, n_trades=len(df), config=cfg, notes=notes)


def write_segment_validation_reports(
    report: SegmentValidationReport, output_dir: str | Path
) -> dict[str, Path]:
    out = Path(output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    paths = {
        "segment_candidates": out / "segment_candidates.csv",
        "segment_validation": out / "segment_validation.json",
    }
    frame = pd.DataFrame([s.to_dict() for s in report.segments])
    frame.to_csv(paths["segment_candidates"], index=False)
    payload = {
        "schema": "ICR_SEGMENT_VALIDATION_v1",
        "n_trades": report.n_trades,
        "family_size": len(report.segments),
        "config": asdict(report.config),
        "notes": report.notes,
        "validated": [s.to_dict() for s in report.segments if s.verdict == "VALIDATED"],
        "candidates": [s.to_dict() for s in report.segments if s.verdict == "CANDIDATE"],
        "reminder": (
            "VALIDATED means in-sample gates passed. It is NOT tradable until the same "
            "segment is positive on an out-of-sample run (different symbols or window)."
        ),
    }
    with paths["segment_validation"].open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, default=str)
    return paths


def main() -> int:
    parser = argparse.ArgumentParser(description="Honest segment discovery/validation on an ICR trades.csv.")
    parser.add_argument("--trades", type=str, required=True, help="Path to trades.csv from a backtest run.")
    parser.add_argument("--output", type=str, required=True, help="Directory for segment reports.")
    parser.add_argument("--min-trades", type=int, default=15)
    parser.add_argument("--min-validated-trades", type=int, default=30)
    parser.add_argument("--permutations", type=int, default=5000)
    parser.add_argument("--bootstrap", type=int, default=5000)
    parser.add_argument("--alpha", type=float, default=0.05)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    trades_path = Path(args.trades).expanduser().resolve()
    if not trades_path.exists():
        raise SystemExit(f"trades file not found: {trades_path}")
    cfg = SegmentValidationConfig(
        min_trades=args.min_trades,
        min_validated_trades=args.min_validated_trades,
        n_permutations=args.permutations,
        n_bootstrap=args.bootstrap,
        alpha=args.alpha,
        seed=args.seed,
    )
    report = run_segment_validation(pd.read_csv(trades_path), cfg)
    paths = write_segment_validation_reports(report, args.output)
    summary = {
        "n_trades": report.n_trades,
        "family_size": len(report.segments),
        "validated": [f"{s.axis}={s.level}" for s in report.segments if s.verdict == "VALIDATED"],
        "candidates": [f"{s.axis}={s.level} (p={s.p_permutation:.3f}, gates: {';'.join(s.failed_gates)})" for s in report.segments if s.verdict == "CANDIDATE"],
        "paths": {k: str(v) for k, v in paths.items()},
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
