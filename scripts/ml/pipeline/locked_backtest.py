"""Causal trade simulation and validation-only portfolio selection.

This module deliberately contains no model fitting.  It receives already-scored
candidates so the caller can keep training, calibration, validation selection,
and the final test evaluation visibly separate.
"""

from dataclasses import dataclass
from typing import Dict, Iterable, List, Sequence, Tuple


@dataclass(frozen=True)
class TradeConfig:
    stop_atr_mult: float = 2.0
    rr_target: float = 2.0
    max_bars: int = 48
    taker_fee_bps: float = 5.0
    slippage_bps: float = 2.0


def _number(row: Dict, key: str) -> float:
    return float(row[key])


def simulate_long_trade(
    bars: Sequence[Dict],
    signal_index: int,
    atr: float,
    funding_rates: Sequence[Dict],
    config: TradeConfig = TradeConfig(),
) -> Dict:
    """Enter at the next bar open and conservatively simulate one long trade.

    When a candle touches both brackets, the stop is assumed first.  A candle
    opening through a previously established stop fills at that open.  Entry and
    exit slippage are adverse, both legs pay taker fees, and each actual funding
    observation during the holding interval is applied in R units.
    """
    if atr <= 0:
        raise ValueError("atr must be positive")
    entry_index = signal_index + 1
    if entry_index >= len(bars):
        raise ValueError("no next bar is available for entry")

    slip = config.slippage_bps / 10_000.0
    fee = config.taker_fee_bps / 10_000.0
    entry_open = _number(bars[entry_index], "open")
    entry_fill = entry_open * (1.0 + slip)
    stop_distance = atr * config.stop_atr_mult
    stop_price = entry_fill - stop_distance
    target_price = entry_fill + stop_distance * config.rr_target
    if stop_price <= 0 or stop_distance <= 0:
        raise ValueError("invalid stop geometry")

    final_index = min(len(bars) - 1, entry_index + config.max_bars - 1)
    exit_index = final_index
    reason = "timeout"
    exit_reference = _number(bars[final_index], "close")

    for idx in range(entry_index, final_index + 1):
        current = bars[idx]
        current_open = _number(current, "open")
        current_low = _number(current, "low")
        current_high = _number(current, "high")

        # A gap can only occur after the entry candle has established the stop.
        if idx > entry_index and current_open <= stop_price:
            exit_index, reason, exit_reference = idx, "gap_stop", current_open
            break
        if current_low <= stop_price:
            exit_index, reason, exit_reference = idx, "stop", stop_price
            break
        if current_high >= target_price:
            exit_index, reason, exit_reference = idx, "target", target_price
            break

    exit_fill = exit_reference * (1.0 - slip)
    gross_r = (exit_fill - entry_fill) / stop_distance
    fee_r = -((entry_fill + exit_fill) * fee) / stop_distance

    entry_ts = int(bars[entry_index]["timestamp"])
    exit_ts = int(bars[exit_index]["timestamp"])
    funding_r = 0.0
    applied_funding = 0
    for observation in funding_rates:
        funding_ts = int(observation["timestamp"])
        if entry_ts < funding_ts <= exit_ts:
            rate = float(observation["rate"])
            # Positive funding is paid by longs; qty cancels in R normalization.
            funding_r -= rate * entry_fill / stop_distance
            applied_funding += 1

    net_r = gross_r + fee_r + funding_r
    return {
        "entryTimestamp": entry_ts,
        "exitTimestamp": exit_ts,
        "entryPrice": entry_fill,
        "exitPrice": exit_fill,
        "stopPrice": stop_price,
        "targetPrice": target_price,
        "grossR": gross_r,
        "feeR": fee_r,
        "fundingR": funding_r,
        "netR": net_r,
        "win": net_r > 0,
        "reason": reason,
        "barsHeld": exit_index - entry_index + 1,
        "fundingEvents": applied_funding,
    }


def select_non_overlapping(
    candidates: Iterable[Dict], threshold: float, max_positions: int = 4,
) -> Tuple[List[Dict], List[Dict]]:
    """Apply a deterministic one-position-per-symbol and portfolio risk cap."""
    eligible = [dict(row) for row in candidates if float(row["probability"]) >= threshold]
    eligible.sort(key=lambda row: (
        int(row["entryTimestamp"]), -float(row["probability"]), str(row["symbol"])
    ))

    active: List[Dict] = []
    accepted: List[Dict] = []
    rejected: List[Dict] = []
    for row in eligible:
        entry_ts = int(row["entryTimestamp"])
        active = [trade for trade in active if int(trade["exitTimestamp"]) > entry_ts]
        if any(trade["symbol"] == row["symbol"] for trade in active):
            row["rejectionReason"] = "symbol_open"
            rejected.append(row)
            continue
        if len(active) >= max_positions:
            row["rejectionReason"] = "portfolio_cap"
            rejected.append(row)
            continue
        accepted.append(row)
        active.append(row)
    return accepted, rejected


def portfolio_metrics(
    trades: Sequence[Dict], initial_equity: float = 10_000.0,
    fixed_risk_usd: float = 100.0,
) -> Dict:
    """Return trade-event metrics with fixed initial-equity risk sizing."""
    ordered = sorted(trades, key=lambda row: (
        int(row["exitTimestamp"]), int(row["entryTimestamp"]), str(row["symbol"])
    ))
    rs = [float(row["netR"]) for row in ordered]
    gross_profit = sum(value for value in rs if value > 0)
    gross_loss = -sum(value for value in rs if value < 0)
    profit_factor = (
        gross_profit / gross_loss if gross_loss > 0
        else (float("inf") if gross_profit > 0 else 0.0)
    )
    equity = initial_equity
    peak = equity
    max_drawdown_pct = 0.0
    equity_curve = [equity]
    for value in rs:
        equity += value * fixed_risk_usd
        peak = max(peak, equity)
        if peak > 0:
            max_drawdown_pct = max(max_drawdown_pct, (peak - equity) / peak * 100.0)
        equity_curve.append(equity)
    wins = sum(value > 0 for value in rs)
    return {
        "trades": len(rs),
        "wins": wins,
        "winRate": wins / len(rs) if rs else 0.0,
        "profitFactor": profit_factor,
        "totalR": sum(rs),
        "averageR": sum(rs) / len(rs) if rs else 0.0,
        "maxDrawdownPct": max_drawdown_pct,
        "initialEquity": initial_equity,
        "finalEquity": equity,
        "equityCurve": equity_curve,
    }


def select_threshold_locked(
    validation_candidates: Sequence[Dict],
    thresholds: Sequence[float],
    min_trades: int = 200,
    max_positions: int = 4,
    max_drawdown_pct: float = 15.0,
) -> Dict:
    """Choose a threshold using validation candidates only.

    Passing configurations are preferred.  If none pass, the strongest
    validation configuration with the minimum trade count is returned with an
    explicit failed gate, allowing the caller to test the locked choice once
    without silently changing acceptance rules.
    """
    evaluations = []
    for threshold in sorted(set(float(value) for value in thresholds)):
        accepted, rejected = select_non_overlapping(
            validation_candidates, threshold, max_positions=max_positions,
        )
        metrics = portfolio_metrics(accepted)
        pf = metrics["profitFactor"]
        passed = (
            metrics["trades"] >= min_trades
            and metrics["totalR"] > 0
            and pf > 1.0
            and metrics["maxDrawdownPct"] <= max_drawdown_pct
        )
        evaluations.append({
            "threshold": threshold,
            "metrics": metrics,
            "trades": accepted,
            "rejections": rejected,
            "validationGatePassed": passed,
        })
    if not evaluations:
        raise ValueError("at least one threshold is required")

    passing = [row for row in evaluations if row["validationGatePassed"]]
    pool = passing or [row for row in evaluations if row["metrics"]["trades"] >= min_trades]
    pool = pool or evaluations
    selected = max(pool, key=lambda row: (
        float(row["metrics"]["totalR"]),
        float(row["metrics"]["profitFactor"]),
        int(row["metrics"]["trades"]),
        float(row["threshold"]),
    ))
    selected["sweep"] = [
        {
            "threshold": row["threshold"],
            "validationGatePassed": row["validationGatePassed"],
            "metrics": row["metrics"],
            "rejections": len(row["rejections"]),
        }
        for row in evaluations
    ]
    return selected
