#!/usr/bin/env python3
"""Download checksum-verified Binance Vision USD-M futures archives."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple


BASE_URL = "https://data.binance.vision/data/futures/um/monthly"
TIMEFRAME_MS = {"15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000}


def archive_months(start: date, end: date) -> List[str]:
    if end < start:
        raise ValueError("end date must not precede start date")
    cursor = date(start.year, start.month, 1)
    final = date(end.year, end.month, 1)
    months: List[str] = []
    while cursor <= final:
        months.append(cursor.strftime("%Y-%m"))
        cursor = date(cursor.year + (cursor.month == 12), 1 if cursor.month == 12 else cursor.month + 1, 1)
    return months


def kline_archive_url(symbol: str, timeframe: str, month: str) -> str:
    filename = f"{symbol}-{timeframe}-{month}.zip"
    return f"{BASE_URL}/klines/{symbol}/{timeframe}/{filename}"


def funding_archive_url(symbol: str, month: str) -> str:
    filename = f"{symbol}-fundingRate-{month}.zip"
    return f"{BASE_URL}/fundingRate/{symbol}/{filename}"


def parse_kline_csv(csv_text: str, *, start_ms: int, end_ms: int) -> List[Dict]:
    rows: List[Dict] = []
    for raw in csv.reader(io.StringIO(csv_text)):
        if not raw or not raw[0].lstrip("-").isdigit():
            continue
        timestamp = int(raw[0])
        if start_ms <= timestamp < end_ms:
            rows.append({
                "timestamp": timestamp,
                "open": float(raw[1]),
                "high": float(raw[2]),
                "low": float(raw[3]),
                "close": float(raw[4]),
                "volume": float(raw[5]),
            })
    return rows


def parse_funding_csv(csv_text: str, *, start_ms: int, end_ms: int) -> List[Dict]:
    rows: List[Dict] = []
    for raw in csv.reader(io.StringIO(csv_text)):
        if not raw or not raw[0].lstrip("-").isdigit():
            continue
        timestamp = int(raw[0])
        if start_ms <= timestamp < end_ms:
            rows.append({
                "timestamp": timestamp,
                "intervalHours": int(raw[1]),
                "rate": float(raw[2]),
            })
    return rows


def _fetch(url: str, attempts: int = 5) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "anavitrade-backtest/1.0"})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code not in {418, 429, 500, 502, 503, 504} or attempt + 1 == attempts:
                raise
            retry_after = exc.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else min(30.0, 2.0 ** attempt)
        except (TimeoutError, urllib.error.URLError):
            if attempt + 1 == attempts:
                raise
            delay = min(30.0, 2.0 ** attempt)
        time.sleep(delay)
    raise RuntimeError(f"unreachable retry state for {url}")


def _verified_zip(url: str, verify_checksums: bool) -> str:
    payload = _fetch(url)
    if verify_checksums:
        checksum_line = _fetch(f"{url}.CHECKSUM").decode("utf-8").strip()
        expected = checksum_line.split()[0]
        actual = hashlib.sha256(payload).hexdigest()
        if actual != expected:
            raise ValueError(f"checksum mismatch for {url}: {actual} != {expected}")
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        csv_names = [name for name in archive.namelist() if name.endswith(".csv")]
        if len(csv_names) != 1:
            raise ValueError(f"expected one CSV in {url}, found {len(csv_names)}")
        return archive.read(csv_names[0]).decode("utf-8")


def _load_symbols(path: Path) -> List[str]:
    data = json.loads(path.read_text())
    if isinstance(data, dict):
        data = data.get("symbols", data.get("pairs", []))
    symbols: List[str] = []
    for item in data:
        symbol = item if isinstance(item, str) else item.get("symbol")
        if not isinstance(symbol, str) or not symbol.endswith("USDT"):
            raise ValueError(f"invalid symbol entry: {item!r}")
        symbols.append(symbol)
    if len(symbols) != len(set(symbols)):
        raise ValueError("pairs file contains duplicate symbols")
    return symbols


def _download_one(
    kind: str,
    symbol: str,
    timeframe: str | None,
    month: str,
    start_ms: int,
    end_ms: int,
    verify_checksums: bool,
) -> Tuple[Tuple[str, str, str], List[Dict]]:
    if kind == "kline":
        assert timeframe is not None
        url = kline_archive_url(symbol, timeframe, month)
        rows = parse_kline_csv(_verified_zip(url, verify_checksums), start_ms=start_ms, end_ms=end_ms)
        return (symbol, timeframe, month), rows
    url = funding_archive_url(symbol, month)
    rows = parse_funding_csv(_verified_zip(url, verify_checksums), start_ms=start_ms, end_ms=end_ms)
    return (symbol, "funding", month), rows


def _validate_series(symbol: str, timeframe: str, rows: Sequence[Dict], expected: int) -> None:
    step = TIMEFRAME_MS[timeframe]
    if len(rows) != expected:
        raise ValueError(f"{symbol} {timeframe}: expected {expected} bars, found {len(rows)}")
    for index, row in enumerate(rows):
        values = [row[key] for key in ("open", "high", "low", "close", "volume")]
        if not all(isinstance(value, (int, float)) and value == value for value in values):
            raise ValueError(f"{symbol} {timeframe}[{index}]: non-finite OHLCV")
        if row["high"] < max(row["open"], row["close"]) or row["low"] > min(row["open"], row["close"]):
            raise ValueError(f"{symbol} {timeframe}[{index}]: invalid OHLC range")
        if row["high"] < row["low"] or row["volume"] < 0:
            raise ValueError(f"{symbol} {timeframe}[{index}]: invalid high/low/volume")
        if index and row["timestamp"] != rows[index - 1]["timestamp"] + step:
            raise ValueError(f"{symbol} {timeframe}[{index}]: gap or duplicate timestamp")


def download_dataset(
    *,
    symbols: Sequence[str],
    start: date,
    end: date,
    timeframes: Sequence[str],
    workers: int,
    verify_checksums: bool,
) -> List[Dict]:
    unknown = set(timeframes) - set(TIMEFRAME_MS)
    if unknown:
        raise ValueError(f"unsupported timeframes: {sorted(unknown)}")
    start_ms = int(datetime(start.year, start.month, start.day, tzinfo=timezone.utc).timestamp() * 1000)
    end_exclusive = end + timedelta(days=1)
    end_ms = int(datetime(end_exclusive.year, end_exclusive.month, end_exclusive.day, tzinfo=timezone.utc).timestamp() * 1000)
    months = archive_months(start, end)

    jobs = [
        ("kline", symbol, timeframe, month, start_ms, end_ms, verify_checksums)
        for symbol in symbols
        for timeframe in timeframes
        for month in months
    ] + [
        ("funding", symbol, None, month, start_ms, end_ms, verify_checksums)
        for symbol in symbols
        for month in months
    ]
    collected: Dict[Tuple[str, str], List[Dict]] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_download_one, *job) for job in jobs]
        for completed, future in enumerate(as_completed(futures), start=1):
            (symbol, stream, _month), rows = future.result()
            collected.setdefault((symbol, stream), []).extend(rows)
            if completed % 100 == 0 or completed == len(futures):
                print(f"downloaded {completed}/{len(futures)} archives", flush=True)

    duration_ms = end_ms - start_ms
    output: List[Dict] = []
    for symbol in symbols:
        klines: Dict[str, List[Dict]] = {}
        for timeframe in timeframes:
            rows_by_ts = {row["timestamp"]: row for row in collected.get((symbol, timeframe), [])}
            rows = [rows_by_ts[key] for key in sorted(rows_by_ts)]
            expected = duration_ms // TIMEFRAME_MS[timeframe]
            _validate_series(symbol, timeframe, rows, expected)
            klines[timeframe] = rows
        funding_by_ts = {row["timestamp"]: row for row in collected.get((symbol, "funding"), [])}
        funding = [funding_by_ts[key] for key in sorted(funding_by_ts)]
        if not funding:
            raise ValueError(f"{symbol}: no funding history in selected window")
        output.append({"symbol": symbol, "klines": klines, "fundingRates": funding})
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pairs-file", required=True, type=Path)
    parser.add_argument("--start", required=True, type=date.fromisoformat)
    parser.add_argument("--end", required=True, type=date.fromisoformat)
    parser.add_argument("--timeframes", default="15m,1h,4h")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--verify-checksums", action="store_true")
    args = parser.parse_args()

    symbols = _load_symbols(args.pairs_file)
    timeframes = [value.strip() for value in args.timeframes.split(",") if value.strip()]
    data = download_dataset(
        symbols=symbols,
        start=args.start,
        end=args.end,
        timeframes=timeframes,
        workers=args.workers,
        verify_checksums=args.verify_checksums,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    payload = json.dumps(data, separators=(",", ":"))
    temporary.write_text(payload)
    os.replace(temporary, args.output)
    print(f"saved {len(data)} symbols to {args.output} ({len(payload) / 1024 / 1024:.1f} MiB)")


if __name__ == "__main__":
    main()
