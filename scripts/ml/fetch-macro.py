#!/usr/bin/env python3
"""
MACRO MARKET MATRIX — BTC, ETH, DXY, SPX, NASDAQ for crypto signal context.

Every altcoin signal lives inside a macro regime. This module fetches and
computes macro context features that gate every trade decision.

Key relationships:
  DXY up   → risk-off → crypto bearish (shorts favored)
  DXY down → risk-on  → crypto bullish (longs favored)
  SPX/NDQ up → equities bullish → crypto follows (positive correlation)
  ETH/BTC ratio up → alt season → smaller alts outperform
  BTC dominance → risk appetite proxy

Usage:
  python scripts/ml/fetch-macro.py              # Fetch and save
  python scripts/ml/fetch-macro.py --update      # Update existing data
"""

import json, sys, argparse
from pathlib import Path
from datetime import datetime, timedelta
import numpy as np
import yfinance as yf

# ═══ Symbols ═══
MACRO_SYMBOLS = {
    "BTC": "BTC-USD",      # Bitcoin
    "ETH": "ETH-USD",      # Ethereum
    "SPX": "^GSPC",        # S&P 500
    "NDQ": "^IXIC",        # NASDAQ
    "DXY": "DX-Y.NYB",     # US Dollar Index
    "US30": "^DJI",        # Dow Jones
    "GOLD": "GC=F",        # Gold futures
    "VIX": "^VIX",         # Volatility index
}

TIMEFRAMES = {"1d", "1h"}
LOOKBACK_YEARS = 2

OUTPUT = Path(__file__).resolve().parent.parent / "data" / "macro-context.json"


def sma(values, period):
    out = np.zeros(len(values))
    if len(values) < period: return out
    out[period-1:] = np.convolve(values, np.ones(period)/period, mode='valid')
    return out

def rsi(close, period=14):
    out = np.full(len(close), 50.0)
    if len(close) < period+1: return out
    delta = np.diff(close)
    gains = np.maximum(delta, 0)
    losses = np.maximum(-delta, 0)
    for i in range(period, len(close)):
        avg_gain = gains[i-period:i].mean()
        avg_loss = losses[i-period:i].mean()
        out[i] = 100 - 100/(1 + avg_gain/avg_loss) if avg_loss > 0 else 100
    return out


def fetch_symbol(name: str, ticker: str, interval: str = "1h",
                 period: str = "2y") -> list:
    """Fetch OHLCV for a symbol from Yahoo Finance."""
    try:
        data = yf.download(ticker, period=period, interval=interval,
                          progress=False, auto_adjust=True)
        if data.empty:
            print(f"  {name}: no data")
            return []

        bars = []
        for idx, row in data.iterrows():
            ts = int(idx.timestamp() * 1000)
            bars.append({
                "timestamp": ts,
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": float(row["Volume"]) if "Volume" in row else 0,
            })

        print(f"  {name}: {len(bars)} bars ({bars[0]['timestamp']} → {bars[-1]['timestamp']})")
        return bars
    except Exception as e:
        print(f"  {name}: ERROR — {e}")
        return []


def compute_derived_features(macro_data: dict) -> dict:
    """Compute derived macro features: ETH/BTC ratio, correlations, regimes."""
    features = {}

    # ETH/BTC ratio (alt season indicator)
    if "ETH" in macro_data and "BTC" in macro_data:
        eth = np.array([b["close"] for b in macro_data["ETH"]])
        btc = np.array([b["close"] for b in macro_data["BTC"]])
        ts_eth = np.array([b["timestamp"] for b in macro_data["ETH"]])
        ts_btc = np.array([b["timestamp"] for b in macro_data["BTC"]])

        # Align by timestamp
        eth_btc_ratio = []
        for i in range(min(len(eth), len(btc))):
            r = eth[i] / btc[i] if btc[i] > 0 else 0
            eth_btc_ratio.append({
                "timestamp": int(ts_eth[i]),
                "eth_btc_ratio": float(r),
            })

        features["eth_btc_ratio"] = eth_btc_ratio

        # BTC dominance proxy (BTC market cap / total — approximated)
        btc_dominance = []
        for i in range(len(eth_btc_ratio)):
            eth_val = eth[i] if i < len(eth) else eth[-1]
            btc_val = btc[i] if i < len(btc) else btc[-1]
            # Simplified: BTC/(BTC + ETH) as dominance proxy
            dom = btc_val / (btc_val + eth_val) if (btc_val + eth_val) > 0 else 0.5
            btc_dominance.append({
                "timestamp": int(ts_eth[i]),
                "btc_dominance": float(dom),
            })
        features["btc_dominance"] = btc_dominance

    # VIX regime (risk on/off)
    if "VIX" in macro_data:
        vix = np.array([b["close"] for b in macro_data["VIX"]])
        ts_vix = np.array([b["timestamp"] for b in macro_data["VIX"]])
        vix_regime = []
        for i in range(len(vix)):
            regime = "low_vol" if vix[i] < 20 else ("moderate" if vix[i] < 30 else "high_fear")
            vix_regime.append({
                "timestamp": int(ts_vix[i]),
                "vix_value": float(vix[i]),
                "vix_regime": regime,
            })
        features["vix_regime"] = vix_regime

    # DXY trend (dollar strength)
    if "DXY" in macro_data:
        dxy = np.array([b["close"] for b in macro_data["DXY"]])
        ts_dxy = np.array([b["timestamp"] for b in macro_data["DXY"]])
        dxy_ma20 = sma(dxy, 20)
        dxy_rsi = rsi(dxy, 14)
        dxy_trend = []
        for i in range(len(dxy)):
            dxy_trend.append({
                "timestamp": int(ts_dxy[i]),
                "dxy_value": float(dxy[i]),
                "dxy_ma20": float(dxy_ma20[i]),
                "dxy_rsi": float(dxy_rsi[i]),
                "dxy_above_ma": dxy[i] > dxy_ma20[i] if dxy_ma20[i] > 0 else None,
            })
        features["dxy_trend"] = dxy_trend

    # SPX/NDQ momentum (equities correlation)
    for name in ["SPX", "NDQ"]:
        if name in macro_data:
            close = np.array([b["close"] for b in macro_data[name]])
            ts_arr = np.array([b["timestamp"] for b in macro_data[name]])
            ma20 = sma(close, 20)
            ma50 = sma(close, 50)
            momentum = []
            for i in range(len(close)):
                momentum.append({
                    "timestamp": int(ts_arr[i]),
                    f"{name.lower()}_value": float(close[i]),
                    f"{name.lower()}_ma20": float(ma20[i]),
                    f"{name.lower()}_ma50": float(ma50[i]),
                    f"{name.lower()}_above_ma20": bool(close[i] > ma20[i]) if ma20[i] > 0 else None,
                    f"{name.lower()}_above_ma50": bool(close[i] > ma50[i]) if ma50[i] > 0 else None,
                })
            features[f"{name.lower()}_momentum"] = momentum

    # Compute correlations: 20-bar rolling correlation between BTC and SPX
    if "BTC" in macro_data and "SPX" in macro_data:
        btc_close = np.array([b["close"] for b in macro_data["BTC"]])
        spx_close = np.array([b["close"] for b in macro_data["SPX"]])
        ts_btc_arr = np.array([b["timestamp"] for b in macro_data["BTC"]])

        min_len = min(len(btc_close), len(spx_close))
        btc_ret = np.diff(btc_close[:min_len]) / btc_close[:min_len-1]
        spx_ret = np.diff(spx_close[:min_len]) / spx_close[:min_len-1]

        corr_20 = []
        for i in range(20, len(btc_ret)):
            corr = np.corrcoef(btc_ret[i-20:i], spx_ret[i-20:i])[0, 1]
            corr_20.append({
                "timestamp": int(ts_btc_arr[i+1]),
                "btc_spx_correlation_20": float(corr) if not np.isnan(corr) else 0,
            })
        features["btc_spx_correlation"] = corr_20

    return features


def get_macro_context(macro_data: dict, features: dict,
                      timestamp: int) -> dict:
    """
    Get macro context snapshot at a given timestamp.
    Returns: dict with all macro indicators for signal evaluation.
    """
    ctx = {}

    for name, bars in macro_data.items():
        if not bars: continue
        # Find bar closest to timestamp
        closest = min(bars, key=lambda b: abs(b["timestamp"] - timestamp))
        ctx[f"{name.lower()}_price"] = closest["close"]
        ctx[f"{name.lower()}_ts"] = closest["timestamp"]

    for feat_name, feat_data in features.items():
        if not feat_data: continue
        closest = min(feat_data, key=lambda f: abs(f["timestamp"] - timestamp))
        ctx.update({k: v for k, v in closest.items() if k != "timestamp"})

    # Derived: macro regime classification
    dxy_above = ctx.get("dxy_above_ma", None)
    spx_above = ctx.get("spx_above_ma20", None)
    vix_val = ctx.get("vix_value", 20)
    btc_spx_corr = ctx.get("btc_spx_correlation_20", 0)

    # Regime: risk-on / risk-off / mixed
    if dxy_above is False and spx_above is True:
        ctx["macro_regime"] = "risk_on"
    elif dxy_above is True and spx_above is False:
        ctx["macro_regime"] = "risk_off"
    else:
        ctx["macro_regime"] = "mixed"

    # VIX regime
    if vix_val and vix_val > 30:
        ctx["fear_level"] = "high"
    elif vix_val and vix_val < 20:
        ctx["fear_level"] = "low"
    else:
        ctx["fear_level"] = "moderate"

    # Correlation regime
    ctx["btc_equity_coupled"] = abs(btc_spx_corr) > 0.5

    return ctx


def main():
    parser = argparse.ArgumentParser(description="Fetch macro market data")
    parser.add_argument("--update", action="store_true", help="Update existing data")
    args = parser.parse_args()

    print("Fetching macro market data...")
    macro_data = {}

    for name, ticker in MACRO_SYMBOLS.items():
        bars = fetch_symbol(name, ticker, interval="1h", period=f"{LOOKBACK_YEARS}y")
        if bars:
            macro_data[name] = bars

    if not macro_data:
        print("ERROR: No macro data fetched")
        sys.exit(1)

    print(f"\nComputing derived features...")
    features = compute_derived_features(macro_data)

    # Save
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output = {
        "macro_data": macro_data,
        "derived_features": features,
        "fetched_at": datetime.now().isoformat(),
        "symbols": list(macro_data.keys()),
    }

    with open(OUTPUT, "w") as f:
        json.dump(output, f)

    size_mb = OUTPUT.stat().st_size / 1024 / 1024
    print(f"\nSaved to {OUTPUT} ({size_mb:.1f} MB)")
    print(f"Symbols: {', '.join(macro_data.keys())}")

    # Quick macro snapshot at latest time
    latest_ts = max(
        bars[-1]["timestamp"] for bars in macro_data.values() if bars
    )
    ctx = get_macro_context(macro_data, features, latest_ts)
    print(f"\nLatest macro context ({datetime.fromtimestamp(latest_ts/1000)}):")
    for k, v in sorted(ctx.items()):
        if isinstance(v, float):
            print(f"  {k}: {v:.4f}")
        else:
            print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
