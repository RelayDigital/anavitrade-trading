/**
 * Test-only helper: build EnrichedCandle arrays with neutral, exhaustion-safe
 * defaults so exit tests can isolate the swing-stop and ratchet-trail logic.
 *
 * Not part of the production API — imported only by *.test.ts in this folder.
 */

import type { EnrichedCandle } from "../types";

export interface CandleOverrides {
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  atr14?: number;
  rsi14?: number;
}

/**
 * A candle whose indicator fields are deliberately neutral: no exhaustion
 * sub-signal can fire (rsi 50, no volume spike, no over-extension, price inside
 * the Bollinger band, moderate body). Price fields default around 100.
 */
export function makeCandle(overrides: CandleOverrides = {}): EnrichedCandle {
  const close = overrides.close ?? 100;
  const high = overrides.high ?? close + 1;
  const low = overrides.low ?? close - 1;
  const open = overrides.open ?? close;
  const range = high - low;
  const body = Math.abs(close - open);
  return {
    symbol: "TESTUSDT",
    timeframe: "4h",
    timestamp: 0,
    open,
    high,
    low,
    close,
    volume: 100,
    ma7: close,
    ma25: close,
    ma99: close,
    atr14: overrides.atr14 ?? 1,
    volumeMa20: 100, // volume == volumeMa20 → no climax
    volumeZscore: 0,
    range,
    body,
    bodyRatio: range > 0 ? body / range : 0.5,
    closePosition: 0.5,
    ma25Slope: 0,
    rsi14: overrides.rsi14 ?? 50, // neutral → no RSI divergence
    bbMid: close,
    bbUpper: close + 1000, // price well inside band → no bollinger return
    bbLower: close - 1000,
    bbWidth: 2000,
    wt1: 0,
    wt2: 0,
    moneyFlow: 0,
    stochRsiK: 50,
    stochRsiD: 50,
    displacement: 0, // → no over-extension
  };
}

/** Build a series of neutral candles from partial overrides. */
export function makeSeries(rows: CandleOverrides[]): EnrichedCandle[] {
  return rows.map((r) => makeCandle(r));
}
