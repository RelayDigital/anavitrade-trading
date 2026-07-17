"""Leakage-resistant temporal splitting and threshold selection helpers."""

from typing import Dict, Iterable, List, Sequence, Tuple

import numpy as np


def last_closed_bar_index(open_timestamps: np.ndarray, timeframe_ms: int, decision_time_ms: int) -> int:
    """Return the latest candle whose close is at or before decision time."""
    if timeframe_ms <= 0:
        raise ValueError("timeframe_ms must be positive")
    if len(open_timestamps) == 0:
        return -1
    latest_eligible_open = int(decision_time_ms) - int(timeframe_ms)
    return int(np.searchsorted(open_timestamps, latest_eligible_open, side="right") - 1)


def purged_chronological_split(
    metadata: Sequence[Dict],
    *,
    train_ratio: float = 0.70,
    validation_ratio: float = 0.15,
    embargo_ms: int = 0,
) -> Tuple[List[int], List[int], List[int]]:
    """Split by unique timestamp and purge the label horizon before boundaries."""
    if not 0 < train_ratio < 1:
        raise ValueError("train_ratio must be between zero and one")
    if not 0 < validation_ratio < 1 or train_ratio + validation_ratio >= 1:
        raise ValueError("validation_ratio must leave a non-empty test fraction")
    if embargo_ms < 0:
        raise ValueError("embargo_ms must be non-negative")
    timestamps = sorted({int(row["timestamp"]) for row in metadata})
    if len(timestamps) < 3:
        raise ValueError("at least three unique timestamps are required")
    train_end = int(len(timestamps) * train_ratio)
    validation_end = int(len(timestamps) * (train_ratio + validation_ratio))
    if train_end <= 0 or validation_end <= train_end or validation_end >= len(timestamps):
        raise ValueError("split ratios produced an empty partition")
    validation_start_ts = timestamps[train_end]
    test_start_ts = timestamps[validation_end]
    train_times = {ts for ts in timestamps[:train_end] if ts + embargo_ms < validation_start_ts}
    validation_times = {
        ts for ts in timestamps[train_end:validation_end]
        if ts + embargo_ms < test_start_ts
    }
    test_times = set(timestamps[validation_end:])
    if not train_times or not validation_times or not test_times:
        raise ValueError("embargo produced an empty partition")

    def indices(allowed: set[int]) -> List[int]:
        return [i for i, row in enumerate(metadata) if int(row["timestamp"]) in allowed]

    return indices(train_times), indices(validation_times), indices(test_times)


def _threshold_metrics(probs: np.ndarray, pnl: np.ndarray, threshold: float) -> Dict:
    if len(probs) != len(pnl):
        raise ValueError("probability and pnl arrays must have equal length")
    if not np.isfinite(threshold):
        raise ValueError("threshold must be finite")
    selected = pnl[probs >= threshold]
    trades = int(len(selected))
    if trades == 0:
        return {"threshold": threshold, "trades": 0, "wr": 0.0, "pf": 0.0, "sharpe": 0.0}
    gross_profit = float(selected[selected > 0].sum())
    gross_loss = float(abs(selected[selected < 0].sum()))
    pf = gross_profit / gross_loss if gross_loss > 0 else 999.0
    std = float(selected.std())
    sharpe = float(selected.mean() / std * np.sqrt(trades)) if trades > 1 and std > 0 else 0.0
    return {
        "threshold": threshold,
        "trades": trades,
        "wr": float((selected > 0).mean()),
        "pf": pf,
        "sharpe": sharpe,
    }


def select_threshold_on_validation(
    validation_probs: np.ndarray,
    validation_pnl: np.ndarray,
    *,
    thresholds: Iterable[float],
    min_trades: int = 50,
    metric: str = "sharpe",
) -> Dict:
    """Choose a threshold from validation data only."""
    if metric not in {"pf", "sharpe", "wr"}:
        raise ValueError(f"unsupported selection metric: {metric}")
    if min_trades <= 0:
        raise ValueError("min_trades must be positive")
    candidates = [
        _threshold_metrics(validation_probs, validation_pnl, float(threshold))
        for threshold in thresholds
    ]
    eligible = [row for row in candidates if row["trades"] >= min_trades]
    if not eligible:
        raise ValueError("no validation threshold met min_trades")
    return max(eligible, key=lambda row: (row[metric], row["trades"], row["threshold"]))
