#!/usr/bin/env python3
"""Purged meta-v22 walk-forward backtest on Binance USD-M archive data.

This runner retrains the recovered meta-v22-definitive contract without changing
its 21 features, LightGBM architecture, isotonic calibration, or model-card
threshold.  It corrects the old harness's temporal leaks and evaluates the final
test partition exactly once at the fixed threshold.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pickle
import sys
import time
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Mapping, Sequence, Tuple

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.ml.pipeline.locked_backtest import portfolio_metrics, select_non_overlapping  # noqa: E402
from scripts.ml.pipeline.validation import last_closed_bar_index, purged_chronological_split  # noqa: E402


DEFAULT_MODEL_DIR = REPO_ROOT / "scripts/data/models/meta-v22-definitive"
MS_15M = 15 * 60_000
MS_1H = 60 * 60_000
MS_4H = 4 * MS_1H
STRUCTURE_LOOKBACK = 30
STRUCTURE_ATR = 2.0
STOP_ATR = 1.0
RR_TARGET = 2.5
MAX_BARS = 48
MODEL_SEED = 42
EXPECTED_FEATURES = {
    "m15_rsi", "m15_bb_w", "m15_bb_p", "m15_ao", "m15_macd",
    "m15_vz", "m15_m7s", "m15_trend", "m15_atr_pct",
    "h1_rsi", "h1_bb_w", "h1_bb_p", "h1_ao", "h1_macd", "h1_m7s",
    "h4_rsi", "h4_bb_w", "h4_bb_p", "h4_ao", "h4_macd", "h4_trend",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_contract(model_dir: Path) -> Dict:
    """Load and validate the frozen model card used as the retraining contract."""
    card_path = model_dir / "model_card.json"
    card = json.loads(card_path.read_text())
    features = card.get("features")
    if not isinstance(features, list) or len(features) != 21 or set(features) != EXPECTED_FEATURES:
        raise ValueError("meta-v22 model card must contain the exact 21-feature contract")
    threshold = float(card.get("threshold"))
    if not math.isfinite(threshold) or abs(threshold - 0.52) > 1e-12:
        raise ValueError(f"expected frozen threshold 0.52, found {threshold}")
    return {
        "card": card,
        "features": tuple(features),
        "threshold": threshold,
        "modelCardPath": str(card_path),
        "modelCardSha256": sha256_file(card_path),
    }


def _rolling_mean(values: np.ndarray, period: int) -> np.ndarray:
    result = np.zeros(len(values), dtype=np.float64)
    if len(values) >= period:
        sums = np.cumsum(np.insert(values, 0, 0.0))
        result[period - 1:] = (sums[period:] - sums[:-period]) / period
    return result


def _training_ema_bug(values: np.ndarray, period: int) -> np.ndarray:
    """Reproduce the frozen model's accidental one-step EMA implementation.

    The recovered trainer returned from inside its EMA loop.  Fixing this would
    change two model features and invalidate comparison with meta-v22, so this
    contract defect is preserved and reported explicitly.
    """
    result = np.zeros(len(values), dtype=np.float64)
    if not len(values):
        return result
    result[0] = values[0]
    if len(values) > 1:
        weight = 2.0 / (period + 1.0)
        result[1] = weight * values[1] + (1.0 - weight) * result[0]
    return result


def compute_indicators(rows: Sequence[Dict]) -> Dict[str, np.ndarray]:
    """Compute the exact recovered meta-v22 feature ingredients causally."""
    open_ = np.asarray([row["open"] for row in rows], dtype=np.float64)
    high = np.asarray([row["high"] for row in rows], dtype=np.float64)
    low = np.asarray([row["low"] for row in rows], dtype=np.float64)
    close = np.asarray([row["close"] for row in rows], dtype=np.float64)
    volume = np.asarray([row["volume"] for row in rows], dtype=np.float64)
    timestamps = np.asarray([row["timestamp"] for row in rows], dtype=np.int64)

    previous_close = np.roll(close, 1)
    previous_close[0] = close[0]
    true_range = np.maximum(high - low, np.maximum(abs(high - previous_close), abs(low - previous_close)))
    atr = _rolling_mean(true_range, 14)

    delta = np.diff(close, prepend=close[0])
    average_gain = _rolling_mean(np.maximum(delta, 0.0), 14)
    average_loss = _rolling_mean(np.maximum(-delta, 0.0), 14)
    rsi = np.full(len(close), 50.0, dtype=np.float64)
    valid_rsi = np.arange(len(close)) >= 15
    gain = average_gain[valid_rsi]
    loss = average_loss[valid_rsi]
    computed = np.where(
        loss > 0,
        100.0 - 100.0 / (1.0 + gain / np.maximum(loss, 1e-300)),
        np.where(gain > 0, 100.0, 50.0),
    )
    rsi[valid_rsi] = computed

    bb_mid = _rolling_mean(close, 20)
    bb_std = np.zeros(len(close), dtype=np.float64)
    for index in range(19, len(close)):
        bb_std[index] = close[index - 19:index + 1].std()
    bb_upper = bb_mid + 2.0 * bb_std
    bb_lower = bb_mid - 2.0 * bb_std
    bb_width = np.divide(
        bb_upper - bb_lower,
        bb_mid,
        out=np.zeros(len(close), dtype=np.float64),
        where=bb_mid > 0,
    ) * 100.0

    ao = _rolling_mean((high + low) / 2.0, 5) - _rolling_mean((high + low) / 2.0, 34)
    ema_fast = _training_ema_bug(close, 12)
    ema_slow = _training_ema_bug(close, 26)
    macd_line = ema_fast - ema_slow
    signal = np.zeros(len(close), dtype=np.float64)
    if len(signal):
        signal[0] = macd_line[0]
    for index in range(1, len(signal)):
        signal[index] = 0.2 * macd_line[index] + 0.8 * signal[index - 1]
    macd = macd_line - signal

    ma7 = _rolling_mean(close, 7)
    ma25 = _rolling_mean(close, 25)
    ma7_slope = np.zeros(len(close), dtype=np.float64)
    for index in range(5, len(close)):
        ma7_slope[index] = (ma7[index] - ma7[index - 5]) / max(ma7[index - 5], 0.0001) * 100.0
    volume_z = np.zeros(len(close), dtype=np.float64)
    for index in range(19, len(close)):
        window = volume[index - 19:index + 1]
        volume_z[index] = (volume[index] - window.mean()) / max(window.std(), 0.0001)

    pivot_low = np.zeros(len(close), dtype=np.bool_)
    pivot_high = np.zeros(len(close), dtype=np.bool_)
    if len(close) >= 5:
        pivot_low[2:-2] = (
            (low[2:-2] <= low[1:-3]) & (low[2:-2] <= low[:-4])
            & (low[2:-2] <= low[3:-1]) & (low[2:-2] <= low[4:])
        )
        pivot_high[2:-2] = (
            (high[2:-2] >= high[1:-3]) & (high[2:-2] >= high[:-4])
            & (high[2:-2] >= high[3:-1]) & (high[2:-2] >= high[4:])
        )
    return {
        "timestamp": timestamps, "open": open_, "high": high, "low": low,
        "close": close, "volume": volume, "atr": atr, "rsi": rsi,
        "bb_upper": bb_upper, "bb_lower": bb_lower, "bb_width": bb_width,
        "ao": ao, "macd": macd, "ma7": ma7, "ma25": ma25,
        "ma7_slope": ma7_slope, "volume_z": volume_z,
        "pivot_low": pivot_low, "pivot_high": pivot_high,
    }


def _bb_position(indicators: Mapping[str, np.ndarray], index: int) -> float:
    span = indicators["bb_upper"][index] - indicators["bb_lower"][index]
    return float((indicators["close"][index] - indicators["bb_lower"][index]) / span) if span > 0 else 0.5


def _trend_15m(close: np.ndarray, index: int) -> float:
    mean_21 = float(close[index - 20:index + 1].mean())
    mean_50 = float(close[index - 49:index + 1].mean())
    return (mean_21 - mean_50) / max(mean_50, 0.0001) * 100.0


def _closed_index(opens: np.ndarray, timeframe_ms: int, decision_time: int) -> int:
    return last_closed_bar_index(opens, timeframe_ms, decision_time)


def _feature_values(
    m15: Mapping[str, np.ndarray], h1: Mapping[str, np.ndarray], h4: Mapping[str, np.ndarray],
    index: int, h1_index: int, h4_index: int,
) -> Dict[str, float]:
    close15 = float(m15["close"][index])
    values = {
        "m15_rsi": float(m15["rsi"][index]),
        "m15_bb_w": float(m15["bb_width"][index]),
        "m15_bb_p": _bb_position(m15, index),
        "m15_ao": float(m15["ao"][index]),
        "m15_macd": float(m15["macd"][index]),
        "m15_vz": float(m15["volume_z"][index]),
        "m15_m7s": float(m15["ma7_slope"][index]),
        "m15_trend": _trend_15m(m15["close"], index),
        "m15_atr_pct": float(m15["atr"][index] / max(close15, 0.0001) * 100.0),
        "h1_rsi": float(h1["rsi"][h1_index]),
        "h1_bb_w": float(h1["bb_width"][h1_index]),
        "h1_bb_p": _bb_position(h1, h1_index),
        "h1_ao": float(h1["ao"][h1_index]),
        "h1_macd": float(h1["macd"][h1_index]),
        "h1_m7s": float(h1["ma7_slope"][h1_index]),
        "h4_rsi": float(h4["rsi"][h4_index]),
        "h4_bb_w": float(h4["bb_width"][h4_index]),
        "h4_bb_p": _bb_position(h4, h4_index),
        "h4_ao": float(h4["ao"][h4_index]),
        "h4_macd": float(h4["macd"][h4_index]),
        "h4_trend": float(h4["ma7"][h4_index] > h4["ma25"][h4_index]),
    }
    if not all(math.isfinite(value) for value in values.values()):
        raise ValueError("non-finite model feature")
    return values


def simulate_structural_trade(
    bars: Sequence[Dict], signal_index: int, direction: str, swing: float, atr: float,
    funding_rates: Sequence[Dict], *, max_bars: int, rr_target: float,
    stop_atr_mult: float, round_trip_fee_bps: float, slippage_bps: float,
) -> Dict | None:
    """Simulate long/short next-open execution with conservative ambiguity rules."""
    entry_index = signal_index + 1
    if entry_index >= len(bars) or direction not in {"long", "short"}:
        return None
    side = 1.0 if direction == "long" else -1.0
    slip = slippage_bps / 10_000.0
    entry_open = float(bars[entry_index]["open"])
    entry_fill = entry_open * (1.0 + side * slip)
    stop = swing - atr * stop_atr_mult if direction == "long" else swing + atr * stop_atr_mult
    risk = entry_fill - stop if direction == "long" else stop - entry_fill
    if risk <= 0 or stop <= 0:
        return None
    target = entry_fill + side * risk * rr_target
    final_index = min(len(bars) - 1, entry_index + max_bars - 1)
    exit_index = final_index
    exit_reference = entry_fill
    reason = "timeout"
    gross_r = 0.0
    for current_index in range(entry_index, final_index + 1):
        row = bars[current_index]
        current_open = float(row["open"])
        low, high = float(row["low"]), float(row["high"])
        if current_index > entry_index and (
            (direction == "long" and current_open <= stop)
            or (direction == "short" and current_open >= stop)
        ):
            exit_index, exit_reference, reason = current_index, current_open, "gap_stop"
            break
        stop_hit = low <= stop if direction == "long" else high >= stop
        target_hit = high >= target if direction == "long" else low <= target
        if stop_hit:  # stop-first if both brackets touch in one candle
            exit_index, exit_reference, reason = current_index, stop, "stop"
            break
        if target_hit:
            exit_index, exit_reference, reason = current_index, target, "target"
            break
    if reason != "timeout":
        exit_fill = exit_reference * (1.0 - side * slip)
        gross_r = side * (exit_fill - entry_fill) / risk
    else:
        # Standing PRD gate: timeouts are 0R losses before costs, never marked to close.
        exit_fill = entry_fill
    fee_r = -(round_trip_fee_bps / 10_000.0) * entry_fill / risk
    entry_ts = int(bars[entry_index]["timestamp"])
    exit_ts = int(bars[exit_index]["timestamp"])
    funding_r = 0.0
    funding_events = 0
    for observation in funding_rates:
        funding_ts = int(observation["timestamp"])
        if entry_ts < funding_ts <= exit_ts:
            funding_r -= side * float(observation["rate"]) * entry_fill / risk
            funding_events += 1
    net_r = gross_r + fee_r + funding_r
    return {
        "direction": direction,
        "entryTimestamp": entry_ts, "exitTimestamp": exit_ts,
        "entryPrice": entry_fill, "exitPrice": exit_fill,
        "stopPrice": stop, "targetPrice": target,
        "grossR": gross_r, "feeR": fee_r, "fundingR": funding_r, "netR": net_r,
        "win": net_r > 0, "reason": reason,
        "barsHeld": exit_index - entry_index + 1, "fundingEvents": funding_events,
    }


def build_pair_candidates(pair: Dict, feature_order: Sequence[str], args: argparse.Namespace) -> Tuple[np.ndarray, List[Dict]]:
    symbol = str(pair["symbol"])
    bars15 = pair["klines"]["15m"]
    bars1h = pair["klines"]["1h"]
    bars4h = pair["klines"]["4h"]
    if min(len(bars15), len(bars1h), len(bars4h)) < 60:
        raise ValueError(f"{symbol}: insufficient MTF history")
    m15, h1, h4 = compute_indicators(bars15), compute_indicators(bars1h), compute_indicators(bars4h)
    funding = pair.get("fundingRates", [])
    funding_ts = np.asarray([row["timestamp"] for row in funding], dtype=np.int64)
    vectors: List[List[float]] = []
    candidates: List[Dict] = []
    for index in range(50, len(bars15) - args.max_bars):
        atr = float(m15["atr"][index])
        close = float(m15["close"][index])
        if atr <= 0 or close <= 0:
            continue
        direction = None
        swing = 0.0
        # k+2 <= index ensures every pivot is fully confirmed by decision time.
        for pivot_index in range(max(3, index - STRUCTURE_LOOKBACK), index - 1):
            if m15["pivot_low"][pivot_index] and m15["low"][pivot_index] < close:
                if (close - m15["low"][pivot_index]) / atr < STRUCTURE_ATR:
                    direction, swing = "long", float(m15["low"][pivot_index])
                    break
            if m15["pivot_high"][pivot_index] and m15["high"][pivot_index] > close:
                if (m15["high"][pivot_index] - close) / atr < STRUCTURE_ATR:
                    direction, swing = "short", float(m15["high"][pivot_index])
                    break
        if direction is None:
            continue
        decision_time = int(m15["timestamp"][index]) + MS_15M
        h1_index = _closed_index(h1["timestamp"], MS_1H, decision_time)
        h4_index = _closed_index(h4["timestamp"], MS_4H, decision_time)
        if h1_index < 34 or h4_index < 34:
            continue
        values = _feature_values(m15, h1, h4, index, h1_index, h4_index)
        vector = [values[name] for name in feature_order]
        entry_ts = int(bars15[index + 1]["timestamp"])
        horizon_ts = int(bars15[index + args.max_bars]["timestamp"])
        funding_start = int(np.searchsorted(funding_ts, entry_ts, side="right"))
        funding_end = int(np.searchsorted(funding_ts, horizon_ts, side="right"))
        trade = simulate_structural_trade(
            bars15, index, direction, swing, atr, funding[funding_start:funding_end],
            max_bars=args.max_bars, rr_target=RR_TARGET, stop_atr_mult=STOP_ATR,
            round_trip_fee_bps=args.round_trip_fee_bps, slippage_bps=args.slippage_bps,
        )
        if trade is None:
            continue
        vectors.append(vector)
        candidates.append({
            "symbol": symbol, "timestamp": int(m15["timestamp"][index]),
            "signalIndex": index, "swingPrice": swing, "atr": atr,
            "features": values, **trade,
        })
    return np.asarray(vectors, dtype=np.float32), candidates


def _load_json(path: Path):
    try:
        import orjson
    except ImportError:
        return json.loads(path.read_text())
    return orjson.loads(path.read_bytes())


def _json_safe(value):
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, np.ndarray):
        return _json_safe(value.tolist())
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, (np.floating, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    return value


def _write_json(path: Path, value) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(_json_safe(value), indent=2, sort_keys=True) + "\n")
    os.replace(temporary, path)


def _write_jsonl(path: Path, rows: Iterable[Mapping]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as handle:
        for row in rows:
            handle.write(json.dumps(_json_safe(row), separators=(",", ":")) + "\n")
    os.replace(temporary, path)


def _candidate_for_portfolio(candidate: Dict, probability: float, row_index: int) -> Dict:
    return {
        "rowIndex": row_index, "symbol": candidate["symbol"],
        "entryTimestamp": candidate["entryTimestamp"], "exitTimestamp": candidate["exitTimestamp"],
        "probability": float(probability), "netR": candidate["netR"],
    }


def run(args: argparse.Namespace) -> Dict:
    started = time.time()
    contract = load_contract(args.contract_model_dir)
    data = _load_json(args.input)
    if not isinstance(data, list) or not data:
        raise ValueError("archive JSON must be a non-empty list")
    requested = set(args.symbols.split(",")) if args.symbols else None
    if requested is not None:
        data = [pair for pair in data if pair.get("symbol") in requested]
        missing = requested - {pair.get("symbol") for pair in data}
        if missing:
            raise ValueError(f"requested symbols absent from archive: {sorted(missing)}")
    if args.limit_symbols:
        data = data[:args.limit_symbols]

    feature_blocks: List[np.ndarray] = []
    candidates: List[Dict] = []
    for pair_number, pair in enumerate(data, start=1):
        matrix, rows = build_pair_candidates(pair, contract["features"], args)
        feature_blocks.append(matrix)
        candidates.extend(rows)
        print(f"candidates {pair_number}/{len(data)} {pair['symbol']}: {len(rows):,}", flush=True)
    if not candidates:
        raise ValueError("no structural candidates were produced")
    matrix = np.vstack(feature_blocks)
    if matrix.shape != (len(candidates), 21) or not np.isfinite(matrix).all():
        raise ValueError("invalid feature matrix")

    embargo_ms = args.embargo_bars * MS_15M
    train_list, validation_list, test_list = purged_chronological_split(
        candidates,
        train_ratio=args.train_ratio,
        validation_ratio=args.validation_ratio,
        embargo_ms=embargo_ms,
    )
    train_indices = np.asarray(train_list, dtype=np.int64)
    validation_indices = np.asarray(validation_list, dtype=np.int64)
    test_indices = np.asarray(test_list, dtype=np.int64)
    labels = np.asarray([row["netR"] > 0 for row in candidates], dtype=np.int8)
    for name, indices in (("train", train_indices), ("validation", validation_indices), ("test", test_indices)):
        if len(np.unique(labels[indices])) < 2:
            raise ValueError(f"{name} partition must contain both wins and losses")

    import lightgbm as lgb
    from sklearn.isotonic import IsotonicRegression

    sample_weight = np.ones(len(train_indices), dtype=np.float64)
    sample_weight[labels[train_indices] > 0] = 3.0
    model = lgb.LGBMClassifier(
        n_estimators=300, max_depth=7, num_leaves=63, learning_rate=0.02,
        subsample=0.8, colsample_bytree=0.8,
        min_child_samples=min(30, max(1, len(train_indices) // 50)),
        random_state=MODEL_SEED, verbose=-1, force_col_wise=True, n_jobs=args.n_jobs,
    )
    model.fit(matrix[train_indices], labels[train_indices], sample_weight=sample_weight)
    validation_raw = model.predict_proba(matrix[validation_indices])[:, 1]
    calibrator = IsotonicRegression(y_min=0, y_max=1, out_of_bounds="clip")
    calibrator.fit(validation_raw, labels[validation_indices])

    # The final partition is scored and evaluated once at the immutable model-card threshold.
    test_raw = model.predict_proba(matrix[test_indices])[:, 1]
    test_probabilities = calibrator.predict(test_raw)
    threshold = contract["threshold"]
    test_portfolio_candidates = [
        _candidate_for_portfolio(candidates[int(index)], float(probability), int(index))
        for index, probability in zip(test_indices, test_probabilities)
    ]
    accepted, rejected = select_non_overlapping(
        test_portfolio_candidates, threshold, max_positions=args.max_positions,
    )
    metrics = portfolio_metrics(
        accepted, initial_equity=args.initial_equity, fixed_risk_usd=args.fixed_risk_usd,
    )
    threshold_qualified = int((test_probabilities >= threshold).sum())
    acceptance = {
        "minimumTrades": 200, "minimumWinRate": 0.55, "minimumProfitFactor": 2.0,
        "passed": bool(
            metrics["trades"] >= 200 and metrics["winRate"] >= 0.55
            and metrics["profitFactor"] >= 2.0
        ),
    }

    output_dir = args.output_dir
    model_dir = output_dir / "model"
    model_dir.mkdir(parents=True, exist_ok=True)
    with (model_dir / "classifier.pkl").open("wb") as handle:
        pickle.dump(model, handle)
    model.booster_.save_model(str(model_dir / "classifier.txt"))
    with (model_dir / "calibrator.pkl").open("wb") as handle:
        pickle.dump(calibrator, handle)

    partition_by_index = {int(index): "train" for index in train_indices}
    partition_by_index.update({int(index): "validation" for index in validation_indices})
    partition_by_index.update({int(index): "test" for index in test_indices})
    validation_probability = calibrator.predict(validation_raw)
    probability_by_index = {
        **{int(index): float(value) for index, value in zip(validation_indices, validation_probability)},
        **{int(index): float(value) for index, value in zip(test_indices, test_probabilities)},
    }
    candidate_path = output_dir / "candidates.jsonl"
    _write_jsonl(candidate_path, (
        {
            **candidates[index], "partition": partition_by_index[index],
            "probability": probability_by_index.get(index), "fixedThreshold": threshold,
        }
        for index in sorted(partition_by_index)
    ))
    accepted_indices = {int(row["rowIndex"]): float(row["probability"]) for row in accepted}
    trade_path = output_dir / "trades.jsonl"
    _write_jsonl(trade_path, (
        {**candidates[index], "probability": probability, "fixedThreshold": threshold}
        for index, probability in accepted_indices.items()
    ))

    input_hash = None if args.skip_input_hash else sha256_file(args.input)
    model_card = {
        "version": "meta-v22-locked-walkforward-20260717",
        "features": contract["features"], "threshold": threshold,
        "sourceContractSha256": contract["modelCardSha256"],
        "trainingRows": len(train_indices), "calibrationRows": len(validation_indices),
        "testRows": len(test_indices), "testMetrics": metrics, "acceptance": acceptance,
    }
    _write_json(model_dir / "model_card.json", model_card)
    artifact_hashes = {
        name: sha256_file(model_dir / name)
        for name in ("classifier.pkl", "classifier.txt", "calibrator.pkl", "model_card.json")
    }
    report = {
        "version": model_card["version"],
        "input": {"path": str(args.input), "sha256": input_hash, "symbols": [pair["symbol"] for pair in data]},
        "sourceContract": contract,
        "integrityControls": {
            "split": "purged chronological 70/15/15 by unique timestamp",
            "embargoBars": args.embargo_bars,
            "pivotConfirmation": "k+2 <= decision bar",
            "atr": "signal bar i only",
            "higherTimeframes": "latest candle closed by 15m decision close",
            "entry": "next 15m open; entry candle included",
            "sameBarAmbiguity": "stop first",
            "gapStop": "next candle open",
            "timeout": "0 gross R, retained as loss after costs/funding",
            "funding": "actual archived observations; longs pay positive, shorts receive positive",
            "roundTripFeeBps": args.round_trip_fee_bps,
            "slippageBpsPerLeg": args.slippage_bps,
            "fixedThreshold": threshold,
            "testEvaluations": 1,
            "modelContractDefect": "EMA helper returned after one iteration; MACD behavior preserved for feature compatibility",
        },
        "rows": {
            "candidates": len(candidates), "trainAfterPurge": len(train_indices),
            "validationAfterPurge": len(validation_indices), "test": len(test_indices),
            "testThresholdQualifiedBeforePortfolio": threshold_qualified,
            "testAccepted": len(accepted), "testRejectedByOverlapOrCap": len(rejected),
        },
        "test": {"metrics": metrics, "acceptance": acceptance},
        "artifacts": {
            "report": str(output_dir / "report.json"), "candidates": str(candidate_path),
            "trades": str(trade_path), "modelDir": str(model_dir), "hashes": artifact_hashes,
        },
        "runtimeSeconds": time.time() - started,
    }
    _write_json(output_dir / "report.json", report)
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="checksum-verified Binance archive JSON")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--contract-model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--symbols", help="optional comma-separated symbol subset")
    parser.add_argument("--limit-symbols", type=int, default=0, help="first N symbols for smoke runs")
    parser.add_argument("--train-ratio", type=float, default=0.70)
    parser.add_argument("--validation-ratio", type=float, default=0.15)
    parser.add_argument("--embargo-bars", type=int, default=MAX_BARS)
    parser.add_argument("--max-bars", type=int, default=MAX_BARS)
    parser.add_argument("--round-trip-fee-bps", type=float, default=6.0,
                        help="total entry+exit fee contract (default: 0.06%%)")
    parser.add_argument("--slippage-bps", type=float, default=3.0, help="adverse slippage per leg")
    parser.add_argument("--max-positions", type=int, default=4)
    parser.add_argument("--initial-equity", type=float, default=10_000.0)
    parser.add_argument("--fixed-risk-usd", type=float, default=100.0)
    parser.add_argument("--n-jobs", type=int, default=-1)
    parser.add_argument("--skip-input-hash", action="store_true")
    args = parser.parse_args(argv)
    if args.limit_symbols < 0 or args.max_bars <= 0 or args.embargo_bars < args.max_bars:
        parser.error("limit-symbols must be non-negative and embargo-bars must be >= positive max-bars")
    if args.round_trip_fee_bps < 0 or args.slippage_bps < 0 or args.max_positions <= 0:
        parser.error("costs must be non-negative and max-positions positive")
    return args


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = run(args)
    print(json.dumps(_json_safe({
        "report": report["artifacts"]["report"],
        "fixedThreshold": report["integrityControls"]["fixedThreshold"],
        "test": report["test"], "runtimeSeconds": report["runtimeSeconds"],
    }), indent=2))


if __name__ == "__main__":
    main()
