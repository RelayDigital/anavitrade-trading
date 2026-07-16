#!/usr/bin/env python3
"""
LIVE COINLEGS SIGNAL EVALUATOR — instant scoring with macro context.

Receives a Coinlegs signal dict. Returns a score (0-100) and decision (TRADE/SKIP).
Uses ONLY data available at signal time — no corpus, no lookahead, no hindsight.

Architecture:
  1. Match against replicable corpus PATTERNS (not trades — patterns)
  2. Check BTC/ETH macro context from klines
  3. Check indicator × timeframe × tier alignment
  4. Return composite score

The corpus taught us WHAT works. Now we evaluate live signals against that knowledge.
"""

import json, argparse, sys
from pathlib import Path
from typing import Dict, Tuple
import numpy as np

# ═══ REPLICABLE PATTERNS (extracted from corpus — pre-entry features ONLY) ═══
# These are templates of what WORKED. We match live signals against them.
# NO lookahead — these come from Tier B/C thresholds, indicator names, timeframes.

PATTERNS = {
    # (indicator, timeframe, tier, score_min) -> expected_win_rate
    ("MACD", "4h", "B", 24): 0.73,
    ("Stochastic", "4h", "C", 36): 0.77,
    ("CCI", "4h", "C", 24): 0.69,
    ("Ichimoku", "4h", "C", 24): 0.70,
    ("MACD", "30m", "C", 24): 0.71,
    ("CCI", "30m", "C", 0): 0.71,
    ("Stochastic", "30m", "C", 24): 0.73,
    ("Ichimoku", "30m", "C", 0): 0.73,
    ("Stochastic", "15m", "C", 0): 0.70,
    ("MACD", "15m", "C", 24): 0.66,
    ("CCI", "1h", "C", 24): 0.67,
    ("MACD", "1h", "C", 24): 0.54,
}

# Signal strength by timeframe (higher = more reliable)
TF_WEIGHT = {"4h": 1.0, "1d": 1.0, "30m": 0.7, "1h": 0.6, "15m": 0.4, "5m": 0.2}

# Indicator tier ranking (higher = more structural)
IND_TIER = {
    "MACD": 1.0, "Stochastic": 0.95, "CCI": 0.8,
    "Trend Reversal": 0.85, "Ichimoku": 0.75,
}


def load_klines(klines_path: str = None) -> dict:
    """Load klines-mtf.json for BTC/ETH macro context."""
    if klines_path is None:
        klines_path = Path(__file__).resolve().parent.parent / "data" / "klines-mtf.json"
    with open(klines_path) as f:
        return json.load(f)


def get_btc_eth_context(klines_data: dict, signal_timestamp: int) -> dict:
    """Get BTC and ETH price context at signal time."""
    ctx = {}

    for pair in klines_data:
        sym = pair.get("symbol", "")
        if sym not in ("BTCUSDT", "ETHUSDT"):
            continue

        klines = pair.get("klines", {})
        for tf in ["4h", "1h"]:
            bars = klines.get(tf, [])
            if not bars:
                continue

            # Find bar closest to signal timestamp
            closest = min(bars, key=lambda b: abs(b["timestamp"] - signal_timestamp))
            idx = bars.index(closest)

            prefix = f"{'btc' if 'BTC' in sym else 'eth'}_{tf}"

            # Price context
            ctx[f"{prefix}_price"] = closest["close"]
            ctx[f"{prefix}_volume"] = closest["volume"]

            # Trend: MA7 vs MA25
            if idx >= 25:
                ma7 = np.mean([b["close"] for b in bars[max(0, idx-6):idx+1]])
                ma25 = np.mean([b["close"] for b in bars[max(0, idx-24):idx+1]])
                ctx[f"{prefix}_trend"] = "bull" if ma7 > ma25 else "bear"
                ctx[f"{prefix}_ma7_ma25_pct"] = float((ma7 - ma25) / ma25 * 100)

            # Range: price position in recent 20-bar range
            if idx >= 20:
                recent_high = max(b["high"] for b in bars[max(0, idx-19):idx+1])
                recent_low = min(b["low"] for b in bars[max(0, idx-19):idx+1])
                rng = recent_high - recent_low
                ctx[f"{prefix}_range_pos"] = float((closest["close"] - recent_low) / rng) if rng > 0 else 0.5

    # ETH/BTC ratio (alt season indicator)
    if "eth_4h_price" in ctx and "btc_4h_price" in ctx:
        ctx["eth_btc_ratio"] = ctx["eth_4h_price"] / ctx["btc_4h_price"] if ctx["btc_4h_price"] > 0 else 0

    return ctx


def evaluate_signal(signal: dict, klines_data: dict = None) -> dict:
    """
    Evaluate a live Coinlegs signal. Returns score, decision, and reasoning.

    signal dict must have: indicator, period, marketName, tier, qualityScore
    """
    ind = (signal.get("indicatorName") or signal.get("indicator") or "").strip()
    period = (signal.get("period") or "").strip()
    tier = (signal.get("qualityTier") or signal.get("tier") or "C").strip()
    score_val = signal.get("qualityScore") or signal.get("score") or 0
    symbol = signal.get("marketName") or signal.get("symbol") or "UNKNOWN"
    price = float(signal.get("price") or signal.get("entry") or 0)
    ts = signal.get("signalDate") or signal.get("scrapedAt") or 0

    reasons = []
    pts = 0
    max_pts = 100

    # ═══ 1. PATTERN MATCH (40 pts) ═══
    pattern_match = False
    for (p_ind, p_tf, p_tier, p_score_min), expected_wr in PATTERNS.items():
        if p_tf != period:
            continue
        if not ind.lower().startswith(p_ind.lower()):
            continue
        if tier != p_tier:
            continue
        if score_val < p_score_min:
            continue
        pattern_match = True
        pattern_pts = int(expected_wr * 40)
        pts += pattern_pts
        reasons.append(f"pattern:{p_ind}/{p_tf}/{p_tier}/s≥{p_score_min} @{expected_wr*100:.0f}% WR ({pattern_pts}pts)")
        break

    if not pattern_match:
        # Fallback: score based on tier and score alone
        if tier == "B":
            base = 25
        elif score_val >= 36:
            base = 20
        elif score_val >= 24:
            base = 15
        else:
            base = 5
        pts += base
        reasons.append(f"no_pattern_match tier={tier} score={score_val} ({base}pts)")

    # ═══ 2. TIMEFRAME QUALITY (25 pts) ═══
    tf_weight = TF_WEIGHT.get(period, 0.3)
    tf_pts = int(25 * tf_weight)
    pts += tf_pts
    reasons.append(f"tf_quality:{period} ({tf_pts}pts)")

    # ═══ 3. INDICATOR QUALITY (20 pts) ═══
    ind_weight = IND_TIER.get(ind, 0.5)
    ind_pts = int(20 * ind_weight)
    pts += ind_pts
    reasons.append(f"ind_quality:{ind} ({ind_pts}pts)")

    # ═══ 4. MACRO CONTEXT (15 pts) ═══
    if klines_data:
        macro = get_btc_eth_context(klines_data, ts)

        # BTC trend alignment (longs favored when BTC bullish)
        btc_bull = macro.get("btc_4h_trend") == "bull"
        btc_range = macro.get("btc_4h_range_pos", 0.5)
        eth_btc = macro.get("eth_btc_ratio", 0)

        macro_pts = 0

        # BTC trending up = favorable for all longs
        if btc_bull:
            macro_pts += 5
            reasons.append("btc_bullish_trend (+5)")

        # BTC not at extreme (not overbought)
        if 0.2 < btc_range < 0.8:
            macro_pts += 3
            reasons.append("btc_mid_range (+3)")

        # ETH/BTC ratio (alt season proxy)
        # Rising ETH/BTC = alt season = smaller alts outperform
        if eth_btc > 0.05:  # ETH/BTC > 5%
            macro_pts += 5
            reasons.append("alt_season_eth_btc (+5)")
        elif eth_btc > 0.03:
            macro_pts += 2
            reasons.append("neutral_eth_btc (+2)")

        macro_pts = min(15, macro_pts)
        pts += macro_pts
        reasons.append(f"macro_context ({macro_pts}/15 pts)")
    else:
        reasons.append("macro_context unavailable")

    # ═══ DECISION ═══
    pts = min(100, pts)
    decision = "TRADE" if pts >= 50 else "SKIP"
    confidence = pts / 100

    return {
        "score": pts,
        "max_score": max_pts,
        "decision": decision,
        "confidence": round(confidence, 3),
        "reasons": reasons,
        "signal": {
            "indicator": ind,
            "period": period,
            "tier": tier,
            "score": score_val,
            "symbol": symbol,
            "price": price,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate Coinlegs signals")
    parser.add_argument("--signal", type=str, help="Signal JSON string")
    parser.add_argument("--file", type=str, help="JSON file with signals array")
    parser.add_argument("--klines", type=str, help="Path to klines-mtf.json")
    args = parser.parse_args()

    # Load klines
    klines_path = args.klines or str(
        Path(__file__).resolve().parent.parent / "data" / "klines-mtf.json"
    )
    klines_data = None
    if Path(klines_path).exists():
        with open(klines_path) as f:
            klines_data = json.load(f)

    if args.signal:
        signal = json.loads(args.signal)
        result = evaluate_signal(signal, klines_data)
        print(json.dumps(result, indent=2))

    elif args.file:
        with open(args.file) as f:
            signals = json.load(f)
        if isinstance(signals, dict):
            signals = signals.get("signals", signals.get("results", [signals]))

        results = []
        for sig in signals[:50]:  # Limit to first 50
            r = evaluate_signal(sig, klines_data)
            results.append(r)

        # Summary
        trades = [r for r in results if r["decision"] == "TRADE"]
        skips = [r for r in results if r["decision"] == "SKIP"]

        print(f"Evaluated {len(results)} signals")
        print(f"  TRADE: {len(trades)} ({len(trades)/max(1,len(results))*100:.0f}%)")
        print(f"  SKIP:  {len(skips)} ({len(skips)/max(1,len(results))*100:.0f}%)")

        if trades:
            avg_score = np.mean([r["score"] for r in trades])
            tiers = {}
            for r in trades:
                t = r["signal"]["tier"]
                tiers[t] = tiers.get(t, 0) + 1
            print(f"  Avg TRADE score: {avg_score:.0f}/100")
            print(f"  Tiers: {tiers}")

        # Show top 5
        results.sort(key=lambda r: -r["score"])
        for r in results[:5]:
            s = r["signal"]
            print(f"\n  {s['symbol']} {s['indicator']} {s['period']} {s['tier']} → "
                  f"{r['score']}/100 {r['decision']}")
            for reason in r["reasons"][:4]:
                print(f"    {reason}")


if __name__ == "__main__":
    main()
