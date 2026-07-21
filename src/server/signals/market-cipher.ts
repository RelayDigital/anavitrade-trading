/**
 * Market Cipher B by WeloTrades — TypeScript port
 *
 * A sophisticated multi-indicator confluence system.  The original PineScript v5
 * combines WaveTrend, Money Flow, RSI, Stochastic RSI, and MACD-based divergence
 * detection into a unified market structure signal.
 *
 * The highest-edge signals occur when MULTIPLE components converge:
 *  1. WaveTrend bottom divergence + WT oversold + WT bull cross
 *  2. Money Flow (fast + slow) turning positive from deep negative
 *  3. Regular bullish divergence on the MACD oscillator
 *  4. Stoch RSI emerging from oversold (<20)
 *
 * Ported signal types:
 *  - mcb_top_bottom: WT divergence with price structure (rarest, strongest)
 *  - mcb_wt_cross: WaveTrend channel 1 crossing channel 2 (medium frequency)
 *  - mcb_money_flow: Fast+slow money flow regime change (medium frequency)
 *  - mcb_divergence: MACD-oscillator based regular/hidden divergence (lower frequency)
 *  - mcb_oversold_bounce: Multiple oscillators hitting oversold simultaneously (filtering)
 */

export type MarketCipherSignal = {
  type: "mcb_bottom" | "mcb_top" | "mcb_wt_bull_cross" | "mcb_wt_bear_cross" |
        "mcb_money_flow_bull" | "mcb_money_flow_bear" |
        "mcb_regular_bull_div" | "mcb_regular_bear_div" |
        "mcb_hidden_bull_div" | "mcb_hidden_bear_div" |
        "mcb_confluence_buy" | "mcb_confluence_sell";
  pair: string;
  period: string;
  price: number;
  confidence: number;  // 0-100, higher = stronger convergence
  details: Record<string, number>;  // component values for debugging
};

type McbParams = {
  wtChannelLen: number;        // n1 (default 9)
  wtAvgLen: number;            // n2 (default 21)
  wtObLevel1: number;          // 60
  wtObLevel2: number;          // 53
  wtOsLevel1: number;           // -60
  wtOsLevel2: number;           // -53
  wtDivergenceLen: number;      // 28
  moneyFlowFastLen: number;     // 9
  moneyFlowSlowLen: number;     // 10
  rsiLen: number;               // 14
  rsiSmoothLen: number;         // 5
  stochLen: number;             // 14
  stochSmoothK: number;         // 21
  stochSmoothD: number;         // 9
  divPivotLeft: number;         // lbL (10)
  divPivotRight: number;        // lbR (10)
  divRangeMin: number;          // 10
  divRangeMax: number;          // 100
};

const DEFAULTS: McbParams = {
  wtChannelLen: 9, wtAvgLen: 21,
  wtObLevel1: 60, wtObLevel2: 53,
  wtOsLevel1: -60, wtOsLevel2: -53,
  wtDivergenceLen: 28,
  moneyFlowFastLen: 9, moneyFlowSlowLen: 10,
  rsiLen: 14, rsiSmoothLen: 5,
  stochLen: 14, stochSmoothK: 21, stochSmoothD: 9,
  divPivotLeft: 10, divPivotRight: 10,
  divRangeMin: 10, divRangeMax: 100,
};

/* ─── Math ─────────────────────────────────────────────────────────── */

function sma(v: number[], n: number): number {
  if (v.length < n) return v[v.length - 1] || 0;
  return v.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function ema(series: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const r = [series[0]];
  for (let i = 1; i < series.length; i++) r.push(series[i] * k + r[i - 1] * (1 - k));
  return r;
}
function stdev(v: number[], n: number): number {
  const avg = sma(v, n); const slice = v.slice(-n);
  return Math.sqrt(slice.reduce((a, x) => a + (x - avg) ** 2, 0) / n);
}
function rsi(closes: number[], period: number): number[] {
  const gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0); losses.push(d < 0 ? -d : 0);
  }
  const result: number[] = [];
  for (let i = period; i < closes.length; i++) {
    const avgG = gains.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    const avgL = losses.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    const rs = avgG / (avgL || 1);
    result.push(100 - (100 / (1 + rs)));
  }
  return result;
}
function arraySma(series: number[], period: number): number[] {
  return series.map((_, i) => sma(series.slice(0, i + 1), period));
}

/* ─── Core ────────────────────────────────────────────────────────── */

export function detectMarketCipher(
  closes: number[], highs: number[], lows: number[],
  pair: string, period: string, params: Partial<McbParams> = {},
): MarketCipherSignal[] {
  const p = { ...DEFAULTS, ...params };
  const L = closes.length;
  const signals: MarketCipherSignal[] = [];
  const last = L - 1, prev = L - 2;
  if (L < Math.max(p.wtAvgLen, p.moneyFlowSlowLen, p.rsiLen, p.stochSmoothK) + p.divPivotLeft + p.divPivotRight + 5) return signals;

  // ── 1. WaveTrend ──────────────────────────────────────────────
  const ap = closes;
  const esaArr = ema(ap, p.wtChannelLen);
  const dArr: number[] = [];
  for (let i = 0; i < esaArr.length; i++) {
    dArr.push(Math.abs(ap[i] - esaArr[i]));
  }
  const dEmaArr = ema(dArr, p.wtChannelLen);
  const ciArr: number[] = [];
  for (let i = 0; i < L; i++) {
    ciArr.push(dEmaArr[i] > 0 ? (ap[i] - esaArr[i]) / (0.015 * dEmaArr[i]) : 0);
  }
  const wt1 = ema(ciArr, p.wtAvgLen);
  const wt2 = arraySma(wt1, 2);

  const wt1Curr = wt1[last], wt1Prev = wt1[prev];
  const wt2Curr = wt2[last], wt2Prev = wt2[prev];

  // WT cross: wt1 crosses wt2
  const wtBullCross = wt1Prev <= wt2Prev && wt1Curr > wt2Curr && wt1Curr < 0;
  const wtBearCross = wt1Prev >= wt2Prev && wt1Curr < wt2Curr && wt1Curr > 0;
  const wtDeepOs = wt1Curr <= p.wtOsLevel1;
  const wtDeepOb = wt1Curr >= p.wtObLevel1;

  // WT divergence: compare recent troughs/peaks with price
  const wtWindow = p.wtDivergenceLen;
  const wtHigh = Math.max(...wt1.slice(-wtWindow));
  const wtLow = Math.min(...wt1.slice(-wtWindow));
  const priceHigh = Math.max(...highs.slice(-wtWindow));
  const priceLow = Math.min(...lows.slice(-wtWindow));
  const priceCurr = closes[last];

  // WT bottom: price making lower low but WT making higher low (divergence)
  const wtBottomSignal = wt1Curr > wtLow && priceCurr <= priceLow;
  // WT top: price making higher high but WT making lower high
  const wtTopSignal = wt1Curr < wtHigh && priceCurr >= priceHigh;

  // ── 2. Money Flow ──────────────────────────────────────────────
  const hlc3 = closes.map((c, i) => (highs[i] + lows[i] + closes[i]) / 3);
  const hlc3Sma = arraySma(hlc3, p.moneyFlowFastLen);
  const hlRange = highs.map((h, i) => h - lows[i]);
  const hlSma = arraySma(hlRange, p.moneyFlowFastLen);
  const rawMoneyFlow: number[] = [];
  for (let i = 0; i < L; i++) {
    const num = 2 * (hlc3[i] - hlc3Sma[i]);
    const den = hlSma[i] || 1;
    rawMoneyFlow.push(num / den);
  }
  const moneyFlowFast = rawMoneyFlow.map(v => v * 5); // multiplier=5
  const moneyFlowSlow = arraySma(rawMoneyFlow, p.moneyFlowSlowLen).map(v => v * 5);

  const mfFastCurr = moneyFlowFast[last], mfFastPrev = moneyFlowFast[prev];
  const mfSlowCurr = moneyFlowSlow[last], mfSlowPrev = moneyFlowSlow[prev];
  const mfFastBull = mfFastPrev <= 0 && mfFastCurr > 0;
  const mfSlowBull = mfSlowPrev <= 0 && mfSlowCurr > 0;
  const mfBullRegime = mfFastBull && mfSlowBull;
  const mfFastBear = mfFastPrev >= 0 && mfFastCurr < 0;
  const mfSlowBear = mfSlowPrev >= 0 && mfSlowCurr < 0;
  const mfBearRegime = mfFastBear && mfSlowBear;

  // ── 3. RSI + Stochastic RSI ───────────────────────────────────
  const rsiVals = rsi(closes, p.rsiLen);
  const rsiCurr = rsiVals[rsiVals.length - 1];
  const rsiOs = rsiCurr <= 30;

  const stochRsiVals: number[] = [];
  for (let i = 1; i < rsiVals.length; i++) {
    const min14 = Math.min(...rsiVals.slice(Math.max(0, i - p.stochLen + 1), i + 1));
    const max14 = Math.max(...rsiVals.slice(Math.max(0, i - p.stochLen + 1), i + 1));
    const range = max14 - min14 || 1;
    stochRsiVals.push(((rsiVals[i] - min14) / range) * 100);
  }
  const stochK = arraySma(stochRsiVals, p.stochSmoothK);
  const stochD = arraySma(stochK, p.stochSmoothD);
  const stochKCurr = stochK[stochK.length - 1];
  const stochDCurr = stochD[stochD.length - 1];
  const stochOs = stochKCurr <= 20;
  const stochOb = stochKCurr >= 80;

  // ── 4. MACD-based divergence ──────────────────────────────────
  const fastMa = arraySma(closes, p.wtChannelLen);
  const slowMa = arraySma(closes, p.wtAvgLen);
  const macdOsc: number[] = [];
  for (let i = 0; i < L; i++) {
    macdOsc.push(slowMa[i] > 0 ? (fastMa[i] - slowMa[i]) / slowMa[i] : 0);
  }

  // Find pivot lows/highs on the oscillator within the range window
  const lbL = p.divPivotLeft, lbR = p.divPivotRight;
  const pivotsLow: number[] = [];  // indices of pivot lows
  for (let i = lbL; i < macdOsc.length - lbR; i++) {
    let isPivot = true;
    for (let j = i - lbL; j <= i + lbR && isPivot; j++) {
      if (j !== i && macdOsc[j] <= macdOsc[i]) isPivot = false;
    }
    if (isPivot) pivotsLow.push(i);
  }
  const pivotsHigh: number[] = [];
  for (let i = lbL; i < macdOsc.length - lbR; i++) {
    let isPivot = true;
    for (let j = i - lbL; j <= i + lbR && isPivot; j++) {
      if (j !== i && macdOsc[j] >= macdOsc[i]) isPivot = false;
    }
    if (isPivot) pivotsHigh.push(i);
  }

  // Regular bullish divergence: lower price low, higher oscillator low
  let regularBullDiv = false;
  if (pivotsLow.length >= 2) {
    const pl2 = pivotsLow[pivotsLow.length - 1];
    const pl1 = pivotsLow[pivotsLow.length - 2];
    const range = pl2 - pl1;
    if (range >= p.divRangeMin && range <= p.divRangeMax) {
      regularBullDiv = lows[pl2] < lows[pl1] && macdOsc[pl2] > macdOsc[pl1] && macdOsc[pl2] < 0;
    }
  }
  let regularBearDiv = false;
  if (pivotsHigh.length >= 2) {
    const ph2 = pivotsHigh[pivotsHigh.length - 1];
    const ph1 = pivotsHigh[pivotsHigh.length - 2];
    const range = ph2 - ph1;
    if (range >= p.divRangeMin && range <= p.divRangeMax) {
      regularBearDiv = highs[ph2] > highs[ph1] && macdOsc[ph2] < macdOsc[ph1] && macdOsc[ph2] > 0;
    }
  }

  // ── 5. Signal generation ───────────────────────────────────────
  // Each component that fires adds to a confluence score.
  // Max confluence = 5 (WT bottom + WT cross + MF bull + stoch OS + bull div)

  const price = closes[last];

  // WT bottom divergence (strongest single signal)
  if (wtBottomSignal) {
    signals.push({
      type: "mcb_bottom", pair, period, price,
      confidence: wtDeepOs ? 70 : 55,
      details: { wt1: wt1Curr, wt_low: wtLow, price_low: priceLow },
    });
  }
  if (wtTopSignal) {
    signals.push({
      type: "mcb_top", pair, period, price,
      confidence: wtDeepOb ? 70 : 55,
      details: { wt1: wt1Curr, wt_high: wtHigh, price_high: priceHigh },
    });
  }

  // WT cross signals
  if (wtBullCross) {
    signals.push({
      type: "mcb_wt_bull_cross", pair, period, price,
      confidence: wtDeepOs ? 50 : 30,
      details: { wt1: wt1Curr, wt2: wt2Curr, oversold: wtDeepOs ? 1 : 0 },
    });
  }
  if (wtBearCross) {
    signals.push({
      type: "mcb_wt_bear_cross", pair, period, price,
      confidence: wtDeepOb ? 50 : 30,
      details: { wt1: wt1Curr, wt2: wt2Curr, overbought: wtDeepOb ? 1 : 0 },
    });
  }

  // Money flow regime change
  if (mfBullRegime) {
    signals.push({
      type: "mcb_money_flow_bull", pair, period, price,
      confidence: 45,
      details: { mf_fast: mfFastCurr, mf_slow: mfSlowCurr },
    });
  }
  if (mfBearRegime) {
    signals.push({
      type: "mcb_money_flow_bear", pair, period, price,
      confidence: 45,
      details: { mf_fast: mfFastCurr, mf_slow: mfSlowCurr },
    });
  }

  // Regular divergences
  if (regularBullDiv) {
    signals.push({
      type: "mcb_regular_bull_div", pair, period, price,
      confidence: 65,
      details: { osc_low: macdOsc[pivotsLow[pivotsLow.length - 1]] },
    });
  }
  if (regularBearDiv) {
    signals.push({
      type: "mcb_regular_bear_div", pair, period, price,
      confidence: 65,
      details: { osc_high: macdOsc[pivotsHigh[pivotsHigh.length - 1]] },
    });
  }

  // ── Confluence scoring ──────────────────────────────────────────
  let confluenceCount = 0;
  let confluenceConf = 0;
  if (wtBottomSignal) { confluenceCount++; confluenceConf += 35; }
  if (wtBullCross && wtDeepOs) { confluenceCount++; confluenceConf += 20; }
  if (mfBullRegime) { confluenceCount++; confluenceConf += 15; }
  if (stochOs) { confluenceCount++; confluenceConf += 15; }
  if (regularBullDiv) { confluenceCount++; confluenceConf += 15; }

  if (confluenceCount >= 2) {
    signals.push({
      type: "mcb_confluence_buy", pair, period, price,
      confidence: Math.min(100, confluenceConf),
      details: { confluence_count: confluenceCount, wt_os: wtDeepOs ? 1 : 0, mf_bull: mfBullRegime ? 1 : 0, stoch_os: stochOs ? 1 : 0, bull_div: regularBullDiv ? 1 : 0 },
    });
  }

  // ── Confluence scoring (short side — exact mirror of the long side) ──
  let confluenceSellCount = 0;
  let confluenceSellConf = 0;
  if (wtTopSignal) { confluenceSellCount++; confluenceSellConf += 35; }
  if (wtBearCross && wtDeepOb) { confluenceSellCount++; confluenceSellConf += 20; }
  if (mfBearRegime) { confluenceSellCount++; confluenceSellConf += 15; }
  if (stochOb) { confluenceSellCount++; confluenceSellConf += 15; }
  if (regularBearDiv) { confluenceSellCount++; confluenceSellConf += 15; }

  if (confluenceSellCount >= 2) {
    signals.push({
      type: "mcb_confluence_sell", pair, period, price,
      confidence: Math.min(100, confluenceSellConf),
      details: { confluence_count: confluenceSellCount, wt_ob: wtDeepOb ? 1 : 0, mf_bear: mfBearRegime ? 1 : 0, stoch_ob: stochOb ? 1 : 0, bear_div: regularBearDiv ? 1 : 0 },
    });
  }

  return signals;
}
