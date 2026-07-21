#!/usr/bin/env python3
"""Select the next batch of not-yet-tested Binance USD-M altcoin perpetuals.

Used by vps-locked-gate.sh so the VPS honest-testing cron continuously
expands coverage across the altcoin universe instead of re-fetching fresh
candles for the same fixed pair list every run. Majors are excluded
(EMPIRICAL_FINDINGS.md: "Edge is on Alts, Not Majors" -- BTC/ETH/BNB are
net-negative on the ICR edge, same exclusion GATE_CONFIG.majors applies
live in src/server/signals/dispatch-gate.ts).

Deliberately does NOT prioritize by highest 24h quoteVolume -- the ICR edge
has repeatedly shown up on smaller, lesser-known altcoins (EMPIRICAL_FINDINGS.md
"Edge is on Alts, Not Majors"; CLAUDE.md's known-good pairs -- PLUMEUSDT,
OPNUSDT, XPLUSDT, WCTUSDT, HEIUSDT -- are mid/small-cap, not top-volume
names), and a volume-descending queue would keep testing mega-caps first and
might never reach the long tail. Instead this ranks ascending by 24h
quoteVolume (smallest liquid alts first, after a floor to skip dead/illiquid
symbols) so the search actively goes where the edge has been found, not where
the liquidity is. Once every symbol in the current universe has been tested
at least once, the cycle resets and starts again from the bottom.

Usage:
  python3 scripts/ml/select-untested-pairs.py \
    --batch-size 20 \
    --output scripts/data/pairs/locked-gate-batch-YYYYMMDD.json \
    --state scripts/cortex/memory/tested-pairs.json
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.request
from pathlib import Path

FAPI = "https://fapi.binance.com/fapi/v1"
EXCHANGE_INFO_URL = f"{FAPI}/exchangeInfo"
TICKER_24HR_URL = f"{FAPI}/ticker/24hr"
DEFAULT_MAJORS = ("BTCUSDT", "ETHUSDT", "BNBUSDT")


def _fetch_json(url: str, api_key: str = "") -> object:
    """fapi.binance.com is geo-blocked (HTTP 451) from the production VPS.
    Confirmed empirically (2026-07-19): this is a hard IP-level block, NOT an
    auth-level one -- X-MBX-APIKEY does not bypass it (tested directly against
    exchangeInfo/ticker/klines, all still 451 with a valid key). Kept here only
    for --refresh-snapshot, which must be run from a non-blocked environment;
    the VPS cron never calls this directly (see ranked_universe)."""
    request = urllib.request.Request(url)
    if api_key:
        request.add_header("X-MBX-APIKEY", api_key)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


MIN_QUOTE_VOLUME_24H = 500_000.0  # floor to skip near-dead/illiquid symbols, not a cap-size filter


DEFAULT_SNAPSHOT_PATH = Path("scripts/data/pairs/altcoin-universe-snapshot.json")


MIN_HISTORY_DAYS = 130  # locked-gate corpus wants 120 days; buffer for month-boundary rounding


def fetch_live_universe(majors: tuple[str, ...] = DEFAULT_MAJORS,
                         min_quote_volume: float = MIN_QUOTE_VOLUME_24H,
                         min_history_days: int = MIN_HISTORY_DAYS,
                         api_key: str = "") -> list[dict]:
    """Live USDT perpetuals, TRADING status, majors excluded, at least
    min_history_days old (exchangeInfo's onboardDate) -- otherwise
    binance_archive.py's strict per-symbol bar-count validation fails on
    recently-listed symbols that don't have the full requested window yet
    (confirmed empirically 2026-07-20: CHILLGUYUSDT, 1000CATUSDT, etc. --
    these skew toward the bottom of the volume-ascending queue, so without
    this filter a meaningful fraction of daily batches would fail on them).
    Only callable from a non-geo-blocked environment -- see --refresh-snapshot."""
    import time as _time
    info = _fetch_json(EXCHANGE_INFO_URL, api_key)
    tickers = _fetch_json(TICKER_24HR_URL, api_key)
    volume_by_symbol = {t["symbol"]: float(t.get("quoteVolume") or 0) for t in tickers}
    min_onboard_ms = int((_time.time() - min_history_days * 86400) * 1000)
    candidates = [
        {"symbol": s["symbol"], "quoteVolume24h": volume_by_symbol.get(s["symbol"], 0.0)}
        for s in info["symbols"]
        if s["symbol"].endswith("USDT")
        and s["symbol"].isascii() and s["symbol"].replace("USDT", "").isalnum()
        and s.get("status") == "TRADING"
        and s.get("contractType") == "PERPETUAL"
        and s["symbol"] not in majors
        and volume_by_symbol.get(s["symbol"], 0.0) >= min_quote_volume
        and s.get("onboardDate", 0) <= min_onboard_ms
    ]
    return candidates


def refresh_snapshot(output_path: Path, majors: tuple[str, ...] = DEFAULT_MAJORS,
                      min_quote_volume: float = MIN_QUOTE_VOLUME_24H, api_key: str = "") -> None:
    """Regenerate the static snapshot from a non-blocked environment (never
    run this from the VPS -- it will 451). Commit the refreshed file to git
    so the VPS cron can read it without any live Binance call."""
    import datetime
    candidates = fetch_live_universe(majors, min_quote_volume, api_key=api_key)
    payload = {
        "generatedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": "https://fapi.binance.com/fapi/v1/exchangeInfo + /fapi/v1/ticker/24hr",
        "majorsExcluded": list(majors),
        "minQuoteVolume24h": min_quote_volume,
        "symbols": candidates,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2))
    print(f"refreshed snapshot: {len(candidates)} symbols -> {output_path}")


def ranked_universe(majors: tuple[str, ...] = DEFAULT_MAJORS,
                     min_quote_volume: float = MIN_QUOTE_VOLUME_24H,
                     api_key: str = "",
                     snapshot_path: Path = DEFAULT_SNAPSHOT_PATH) -> list[str]:
    """Reads the static, periodically-refreshed snapshot (see refresh_snapshot)
    instead of querying fapi.binance.com live -- the VPS cannot reach that
    endpoint at all (geo-blocked, no auth-level bypass exists), so this must
    not depend on a live call to run there. Ranked by 24h quoteVolume
    ASCENDING (smallest liquid alts first -- see module docstring for why:
    the edge shows up on smaller alts, not the top-volume names)."""
    if not snapshot_path.exists():
        raise SystemExit(
            f"{snapshot_path} does not exist. Run with --refresh-snapshot from a "
            f"non-geo-blocked environment (not the VPS) to generate it, commit it, "
            f"then re-deploy."
        )
    payload = json.loads(snapshot_path.read_text())
    candidates = [
        row["symbol"] for row in payload.get("symbols", [])
        if row["symbol"] not in majors and row.get("quoteVolume24h", 0.0) >= min_quote_volume
    ]
    volume_by_symbol = {row["symbol"]: row.get("quoteVolume24h", 0.0) for row in payload.get("symbols", [])}
    candidates.sort(key=lambda sym: volume_by_symbol.get(sym, 0.0))
    return candidates


def select_batch(universe: list[str], tested: set[str], batch_size: int) -> tuple[list[str], bool]:
    """Returns (selected symbols, cycle_reset). Resets (clears effective `tested`
    for this selection) when fewer than batch_size untested symbols remain."""
    untested = [s for s in universe if s not in tested]
    cycle_reset = len(untested) < batch_size
    if cycle_reset:
        untested = universe  # start a fresh cycle from the smallest-liquidity end again
    return untested[:batch_size], cycle_reset


def load_state(path: Path) -> set[str]:
    if not path.exists():
        return set()
    try:
        return set(json.loads(path.read_text()).get("tested", []))
    except (json.JSONDecodeError, OSError):
        return set()


def save_state(path: Path, tested: set[str], cycle_reset: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    existing_cycles = 0
    if path.exists():
        try:
            existing_cycles = json.loads(path.read_text()).get("cycles_completed", 0)
        except (json.JSONDecodeError, OSError):
            pass
    payload = {
        "tested": sorted(tested),
        "cycles_completed": existing_cycles + (1 if cycle_reset else 0),
    }
    path.write_text(json.dumps(payload, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-size", type=int, default=20)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--majors", default=",".join(DEFAULT_MAJORS))
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT_PATH,
                         help="Static universe snapshot to read (VPS-safe, no live call). "
                              f"Default: {DEFAULT_SNAPSHOT_PATH}")
    parser.add_argument("--api-key", default=os.environ.get("BINANCE_API_KEY", ""),
                         help="Only used with --refresh-snapshot, from a non-blocked "
                              "environment. Irrelevant otherwise -- fapi.binance.com's "
                              "451 from the VPS is IP-level, not auth-level; a key "
                              "does not bypass it (confirmed empirically 2026-07-19).")
    parser.add_argument("--refresh-snapshot", action="store_true",
                         help="Regenerate --snapshot via a live Binance call. NEVER run "
                              "this on the VPS -- it will 451. Run locally/CI, then "
                              "commit and deploy the refreshed snapshot.")
    args = parser.parse_args()

    majors = tuple(m.strip() for m in args.majors.split(",") if m.strip())

    if args.refresh_snapshot:
        refresh_snapshot(args.snapshot, majors, api_key=args.api_key)
        return

    if not args.output or not args.state:
        parser.error("--output and --state are required unless --refresh-snapshot is set")

    universe = ranked_universe(majors, snapshot_path=args.snapshot)
    tested = load_state(args.state)
    batch, cycle_reset = select_batch(universe, tested, args.batch_size)

    if not batch:
        raise SystemExit("no candidate pairs found -- exchangeInfo/ticker returned nothing usable")

    tested_after = (set() if cycle_reset else tested) | set(batch)
    save_state(args.state, tested_after, cycle_reset)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(batch, indent=2))

    print(f"universe={len(universe)} tested_before={len(tested)} "
          f"{'CYCLE_RESET ' if cycle_reset else ''}batch={len(batch)} -> {args.output}")
    print(f"  {batch}")


if __name__ == "__main__":
    main()
