from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd

from .backtester import BacktestResult, SkippedSignal
from .meta_labeling import labels_frame
from .risk import Trade
from .universe import asset_class


def trades_to_frame(trades: list[Trade]) -> pd.DataFrame:
    rows = []
    for trade in trades:
        row = trade.to_dict()
        row["exits"] = json.dumps(row["exits"])
        row["asset_class"] = asset_class(trade.symbol)
        if trade.exit_time is not None:
            row["hold_bars"] = int(trade.exit_index - trade.entry_index) if trade.exit_index is not None else None
            row["entry_hour_utc"] = pd.Timestamp(trade.entry_time).hour
            row["session"] = session_bucket(pd.Timestamp(trade.entry_time))
        rows.append(row)
    return pd.DataFrame(rows)


def skipped_to_frame(skipped: list[SkippedSignal]) -> pd.DataFrame:
    return pd.DataFrame([s.to_dict() for s in skipped])


def session_bucket(ts: pd.Timestamp) -> str:
    hour = int(pd.Timestamp(ts).hour)
    if 0 <= hour < 7:
        return "asia"
    if 7 <= hour < 13:
        return "london"
    if 13 <= hour < 20:
        return "new_york"
    return "rollover_other"


def _empty_stats(columns: list[str]) -> pd.DataFrame:
    return pd.DataFrame(columns=columns)


def per_symbol_stats(trades: list[Trade]) -> pd.DataFrame:
    df = trades_to_frame(trades)
    if df.empty:
        return _empty_stats(["symbol", "trades", "net_r", "expectancy_r", "win_rate"])
    grouped = df.groupby("symbol", as_index=False).agg(
        trades=("total_r", "count"),
        net_r=("total_r", "sum"),
        expectancy_r=("total_r", "mean"),
        wins=("total_r", lambda s: int((s > 0.05).sum())),
    )
    grouped["win_rate"] = grouped["wins"] / grouped["trades"]
    return grouped.drop(columns=["wins"])


def grouped_trade_stats(trades: list[Trade], column: str) -> pd.DataFrame:
    df = trades_to_frame(trades)
    if df.empty or column not in df.columns:
        return _empty_stats([column, "trades", "net_r", "expectancy_r", "win_rate"])
    grouped = df.groupby(column, as_index=False).agg(
        trades=("total_r", "count"),
        net_r=("total_r", "sum"),
        expectancy_r=("total_r", "mean"),
        wins=("total_r", lambda s: int((s > 0.05).sum())),
    )
    grouped["win_rate"] = grouped["wins"] / grouped["trades"]
    return grouped.drop(columns=["wins"])


def timeframe_stats(trades: list[Trade]) -> pd.DataFrame:
    return grouped_trade_stats(trades, "timeframe")


def asset_class_stats(trades: list[Trade]) -> pd.DataFrame:
    return grouped_trade_stats(trades, "asset_class")


def session_performance(trades: list[Trade]) -> pd.DataFrame:
    return grouped_trade_stats(trades, "session")


def score_bucket_stats(trades: list[Trade]) -> pd.DataFrame:
    df = trades_to_frame(trades)
    if df.empty:
        return _empty_stats(["score_bucket", "trades", "net_r", "expectancy_r", "win_rate"])
    df["score_bucket"] = pd.cut(df["score"], bins=[0, 70, 75, 80, 85, 90, 95, 100], include_lowest=True)
    grouped = df.groupby("score_bucket", observed=True, as_index=False).agg(
        trades=("total_r", "count"),
        net_r=("total_r", "sum"),
        expectancy_r=("total_r", "mean"),
        wins=("total_r", lambda s: int((s > 0.05).sum())),
    )
    grouped["win_rate"] = grouped["wins"] / grouped["trades"]
    grouped["score_bucket"] = grouped["score_bucket"].astype(str)
    return grouped.drop(columns=["wins"])


def exit_reason_stats(trades: list[Trade]) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for trade in trades:
        for exit_fill in trade.exits:
            rows.append(
                {
                    "symbol": trade.symbol,
                    "direction": trade.direction,
                    "reason": exit_fill.reason,
                    "fraction": exit_fill.fraction,
                    "piece_r": exit_fill.r_multiple,
                }
            )
    df = pd.DataFrame(rows)
    if df.empty:
        return _empty_stats(["reason", "pieces", "fraction_closed", "net_piece_r"])
    return df.groupby("reason", as_index=False).agg(
        pieces=("reason", "count"),
        fraction_closed=("fraction", "sum"),
        net_piece_r=("piece_r", "sum"),
    )


def target_path_stats(trades: list[Trade]) -> pd.DataFrame:
    rows = []
    for trade in trades:
        reasons = [e.reason for e in trade.exits]
        rows.append(
            {
                "symbol": trade.symbol,
                "direction": trade.direction,
                "hit_tp1": "tp1" in reasons,
                "hit_tp2": "tp2" in reasons,
                "hit_tp3": "tp3" in reasons,
                "stopped": "stop" in reasons,
                "ended_at_eod": "end_of_data" in reasons,
                "total_r": trade.total_r,
            }
        )
    df = pd.DataFrame(rows)
    if df.empty:
        return _empty_stats(["path", "trades", "expectancy_r"])
    def path(row: pd.Series) -> str:
        if row["hit_tp3"]:
            return "tp1_tp2_runner"
        if row["hit_tp2"]:
            return "tp1_tp2_no_runner"
        if row["hit_tp1"]:
            return "tp1_only"
        if row["stopped"]:
            return "stop"
        return "end_of_data"
    df["path"] = df.apply(path, axis=1)
    return df.groupby("path", as_index=False).agg(trades=("total_r", "count"), expectancy_r=("total_r", "mean"), net_r=("total_r", "sum"))


def regime_report_from_trades(trades: list[Trade]) -> pd.DataFrame:
    df = trades_to_frame(trades)
    if df.empty:
        return _empty_stats(["regime", "trades", "expectancy_r"])
    # Minimal executable regime proxy until richer candle-level regime buckets are
    # added: high-score continuation, normal continuation, or weak continuation.
    df["regime"] = pd.cut(df["score"], bins=[0, 75, 85, 100], labels=["weak_or_filtered", "qualified", "a_plus"], include_lowest=True)
    return df.groupby("regime", observed=True, as_index=False).agg(trades=("total_r", "count"), expectancy_r=("total_r", "mean"), net_r=("total_r", "sum"))


def config_snapshot(result: BacktestResult) -> dict[str, Any]:
    return {
        "report_schema": "ICR_REPORTS_v4",
        "trade_count": len(result.trades),
        "signal_count": len(result.signals),
        "skipped_signal_count": len(result.skipped_signals),
        "safety": {
            "live_trading": False,
            "broker_login": False,
            "api_keys": False,
            "recursive_file_scan": False,
        },
    }


def write_reports(result: BacktestResult, output_dir: str | Path) -> dict[str, Path]:
    out = Path(output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)

    paths = {
        "trades": out / "trades.csv",
        "summary": out / "summary.json",
        "equity_curve": out / "equity_curve.csv",
        "per_symbol_stats": out / "per_symbol_stats.csv",
        "timeframe_stats": out / "timeframe_stats.csv",
        "asset_class_stats": out / "asset_class_stats.csv",
        "session_performance": out / "session_performance.csv",
        "score_bucket_stats": out / "score_bucket_stats.csv",
        "exit_reason_stats": out / "exit_reason_stats.csv",
        "target_path_stats": out / "target_path_stats.csv",
        "regime_report": out / "regime_report.csv",
        "signals": out / "signals.csv",
        "skipped_signals": out / "skipped_signals.csv",
        "meta_labels": out / "meta_labels.csv",
        "config_snapshot": out / "config_snapshot.json",
        "equity_plot": out / "equity_curve.png",
    }

    trades_to_frame(result.trades).to_csv(paths["trades"], index=False)
    pd.DataFrame([s.to_dict() for s in result.signals]).to_csv(paths["signals"], index=False)
    skipped_to_frame(result.skipped_signals).to_csv(paths["skipped_signals"], index=False)
    result.equity_curve.to_csv(paths["equity_curve"], index=False)
    per_symbol_stats(result.trades).to_csv(paths["per_symbol_stats"], index=False)
    timeframe_stats(result.trades).to_csv(paths["timeframe_stats"], index=False)
    asset_class_stats(result.trades).to_csv(paths["asset_class_stats"], index=False)
    session_performance(result.trades).to_csv(paths["session_performance"], index=False)
    score_bucket_stats(result.trades).to_csv(paths["score_bucket_stats"], index=False)
    exit_reason_stats(result.trades).to_csv(paths["exit_reason_stats"], index=False)
    target_path_stats(result.trades).to_csv(paths["target_path_stats"], index=False)
    regime_report_from_trades(result.trades).to_csv(paths["regime_report"], index=False)
    labels_frame(result.signals, result.trades).to_csv(paths["meta_labels"], index=False)

    # Honest-by-default segment discovery: multiple-comparisons-aware
    # validation of session/direction/symbol/etc. subgroups. Imported lazily
    # to avoid a circular import (segment_validation uses session_bucket).
    from .segment_validation import run_segment_validation, write_segment_validation_reports

    segment_report = run_segment_validation(trades_to_frame(result.trades))
    paths.update(write_segment_validation_reports(segment_report, out))
    with paths["summary"].open("w", encoding="utf-8") as f:
        json.dump(result.summary, f, indent=2, allow_nan=False)
    with paths["config_snapshot"].open("w", encoding="utf-8") as f:
        json.dump(config_snapshot(result), f, indent=2, allow_nan=False)

    if not result.equity_curve.empty:
        fig = plt.figure()
        ax = fig.add_subplot(111)
        result.equity_curve["equity"].astype(float).plot(ax=ax)
        ax.set_title("ICR Equity Curve")
        ax.set_xlabel("Closed Trade")
        ax.set_ylabel("Equity")
        fig.tight_layout()
        fig.savefig(paths["equity_plot"])
        plt.close(fig)

    return paths
