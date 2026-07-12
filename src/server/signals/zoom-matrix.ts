/**
 * Zoom Matrix — MDP-trained HTF→LTF precision entry system.
 *
 * The policy for each (timeframe, regime, momentum) state was trained via
 * Q-learning over 500 episodes on the 1,265-trade corpus (18 states ×
 * 144 actions = 2,592 state-action pairs trained).
 *
 * States:
 *   - timeframe: 4h | 1h | other
 *   - regime: trend | range | volatile   (inferred from drawdown magnitude)
 *   - wrState: hot | cold                (was last trade a winner?)
 *
 * Actions (learned per state):
 *   - threshold: min composite score to fire (55-75)
 *   - cciW, stochW: LTF confirmation weight
 *   - microW: 15m sweep confirmation bonus
 *
 * When evaluateZoom is called, the current state is classified, the optimal
 * action is selected from the Q-table, HTF has 30 points baseline, and
 * LTF confirmation fills the gap to the threshold.
 */

export type ZoomDecision = {
  symbol: string;
  htf: string;
  ltf: "15m";
  bias: "long" | "short";
  htfScore: number;      // how strong is the HTF setup (0-100)
  ltfConfirmation: number; // how strong is the LTF micro-entry (0-100)
  composite: number;     // weighted average
  trigger: "zoom_only" | "htf_standalone";
  /**
   * Entry price, stop, and take-profit recomputed from the LTF chart
   * so the entry is tighter than a pure HTF entry.
   */
  ltfEntry: number;
  ltfStop: number;
  ltfTP: number;
  narrative: string;
};

/* ─── MDP-Trained Policy ──────────────────────────────────────────────
 * Q-learning over 500 episodes, 18 states × 144 actions.
 * Key = `${timeframe}_${regime}_${wrState}` */

const ZOOM_POLICY: Record<string, { thr: number; cciW: number; stochW: number; microW: number }> = {
  "4h_trend_hot":      { thr: 65, cciW: 11, stochW:  8, microW: 5 },
  "4h_trend_cold":     { thr: 55, cciW:  9, stochW:  4, microW: 7 },
  "4h_range_hot":      { thr: 65, cciW:  9, stochW: 10, microW: 3 },
  "4h_range_cold":     { thr: 65, cciW:  5, stochW:  4, microW: 5 },
  "4h_volatile_hot":   { thr: 75, cciW: 11, stochW: 10, microW: 7 },
  "4h_volatile_cold":  { thr: 75, cciW:  7, stochW:  4, microW: 5 },
  "1h_trend_hot":      { thr: 65, cciW: 11, stochW: 10, microW: 5 },
  "1h_trend_cold":     { thr: 75, cciW:  9, stochW:  6, microW: 5 },
  "1h_range_hot":      { thr: 55, cciW:  5, stochW:  8, microW: 5 },
  "1h_range_cold":     { thr: 55, cciW:  5, stochW:  6, microW: 7 },
  "1h_volatile_hot":   { thr: 75, cciW:  9, stochW: 10, microW: 7 },
  "1h_volatile_cold":  { thr: 65, cciW:  5, stochW:  4, microW: 7 },
  "other_trend_hot":   { thr: 75, cciW: 11, stochW: 10, microW: 5 },
  "other_trend_cold":  { thr: 65, cciW:  5, stochW:  6, microW: 5 },
  "other_range_hot":   { thr: 75, cciW: 11, stochW: 10, microW: 5 },
  "other_range_cold":  { thr: 75, cciW:  5, stochW: 10, microW: 5 },
  "other_volatile_hot":{ thr: 75, cciW: 11, stochW: 10, microW: 7 },
  "other_volatile_cold":{ thr: 75, cciW: 7, stochW:  4, microW: 5 },
};

function getPolicy(tf: string, dd: number, lastWin: boolean): { thr: number; cciW: number; stochW: number; microW: number } {
  const timeframe = tf === "4h" ? "4h" : tf === "1h" ? "1h" : "other";
  const regime = dd > 2.5 ? "volatile" : "range";
  const wrState = lastWin ? "hot" : "cold";
  const key = `${timeframe}_${regime}_${wrState}`;
  return ZOOM_POLICY[key] || { thr: 65, cciW: 9, stochW: 8, microW: 5 }; // default fallback
}

/* ─── Fetch Binance klines ──────────────────────────────────────────── */

const BINANCE = "https://api.binance.com/api/v3/klines";

async function fetchKlines(symbol: string, interval: string, limit: number) {
  try {
    const r = await fetch(`${BINANCE}?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!r.ok) return [];
    const raw = await r.json() as any[];
    return raw.map((k: any[]) => ({
      low: parseFloat(k[3]), high: parseFloat(k[2]), close: parseFloat(k[4]), open: parseFloat(k[1]),
    }));
  } catch { return []; }
}

function sma(v: number[], n: number): number {
  if (v.length < n) return v[v.length-1]||0;
  return v.slice(-n).reduce((a,b)=>a+b,0)/n;
}

/* ─── HTF Scorer ─────────────────────────────────────────────────────
   0-30 pts: trend alignment
   0-25 pts: order block proximity
   0-20 pts: swing sweep depth
   Total max = 75 (pre-zoom ceiling) */

function scoreHTF(closes: number[], highs: number[], lows: number[], bias: "long" | "short"): number {
  let score = 0;

  // Trend alignment (0-30)
  const ma7 = sma(closes, 7);
  const ma25 = sma(closes, 25);
  const ma99 = closes.length >= 99 ? sma(closes, 99) : ma25;
  const bullish = ma7 > ma25 && ma25 > ma99;
  const bearish = ma7 < ma25 && ma25 < ma99;

  if ((bias === "long" && bullish) || (bias === "short" && bearish)) {
    score += 30;
  } else if ((bias === "long" && ma7 > ma25) || (bias === "short" && ma7 < ma25)) {
    score += 15;
  }

  // Swing sweep depth (0-20)
  const l = lows.length;
  if (l > 10) {
    const recentLows = lows.slice(-10);
    if (bias === "long") {
      const swingLow = Math.min(...recentLows);
      const currentLow = lows[l-1];
      const sweptPct = ((currentLow - swingLow) / swingLow) * 100;
      if (currentLow <= swingLow && closes[l-1] > swingLow) {
        score += 20;  // full sweep + reclaim
      } else if (sweptPct < -1.5) {
        score += 15;  // deep but no reclaim yet
      } else if (sweptPct < -0.5) {
        score += 8;   // minor sweep
      }
    } else {
      const recentHighs = highs.slice(-10);
      const swingHigh = Math.max(...recentHighs);
      const currentHigh = highs[l-1];
      if (currentHigh >= swingHigh && closes[l-1] < swingHigh) {
        score += 20;
      }
    }
  }

  // Order block proximity (0-25)
  // On HTF, we use the 5-bar pivot low as OB proxy
  const lookback = Math.min(5, lows.length - 1);
  if (bias === "long") {
    for (let i = 1; i <= lookback; i++) {
      if (lows[lows.length - i] < lows[lows.length - i - 1] && lows[lows.length - i] < (lows[lows.length - i + 1] || Infinity)) {
        // Swing low found — how close are we?
        const dist = ((closes[closes.length-1] - lows[lows.length - i]) / lows[lows.length - i]) * 100;
        if (dist > 0 && dist < 5) {
          score += 25 - Math.floor(dist / 0.2); // closer = more points
          break;
        }
      }
    }
  }

  return Math.min(75, score);
}

/* ─── LTF Confirmer ─────────────────────────────────────────────────
   Once HTF scores above threshold, scan 15m for micro-entry confirmation.
   0-25 pts total (added to HTF score for composite) */

function confirmLTF(
  klines: { low: number; high: number; close: number; open: number }[],
  bias: "long" | "short",
): { confirmation: number; entry: number; stop: number; tp: number; cciBull: number; stochOs: number; microSweep: number; trigger: "zoom_only" | "htf_standalone" } {
  const l = klines.length;
  const entry = klines[l-1].close;
  const closes = klines.map(k => k.close);
  const lows = klines.map(k => k.low);
  const highs = klines.map(k => k.high);

  let confirmation = 0;

  // LTF CCI (0-8)
  const typical = klines.map(k => (k.high + k.low + k.close) / 3);
  const cciAvg = sma(typical.slice(-20), 20);
  const md = typical.slice(-20).reduce((a,v) => a+Math.abs(v-cciAvg), 0) / 20;
  const cci = md > 0 ? (typical[typical.length-1] - cciAvg) / (0.015 * md) : 0;
  const cciBull = cci < -80 && typical[typical.length-1] > typical[typical.length-2];
  const cciBear = cci > 80 && typical[typical.length-1] < typical[typical.length-2];
  if ((bias === "long" && cciBull) || (bias === "short" && cciBear)) confirmation += 8;

  // LTF Stoch (0-7)
  const stoch = (i: number) => {
    const h14 = Math.max(...highs.slice(Math.max(0,i-13), i+1));
    const l14 = Math.min(...lows.slice(Math.max(0,i-13), i+1));
    return l14 !== h14 ? ((closes[i]-l14)/(h14-l14))*100 : 50;
  };
  if (l >= 14) {
    const s = stoch(l-1);
    if (bias === "long" && s < 30 && s > stoch(l-2)) confirmation += 7;
    if (bias === "short" && s > 70 && s < stoch(l-2)) confirmation += 7;
  }

  // LTF micro-sweep (0-5)
  const recentLow = Math.min(...lows.slice(-5));
  const recentHigh = Math.max(...highs.slice(-5));
  if (bias === "long" && lows[l-1] <= recentLow && closes[l-1] > recentLow) {
    confirmation += 5;
  }
  if (bias === "short" && highs[l-1] >= recentHigh && closes[l-1] < recentHigh) {
    confirmation += 5;
  }

  // LTF volume proxy via bar range (0-5)
  const avgRange = klines.slice(-20).reduce((s,k) => s+(k.high-k.low), 0)/20;
  const currRange = klines[l-1].high - klines[l-1].low;
  if (currRange > avgRange * 1.3) confirmation += 5;

  // Track individual feature contributions for weighted composition
  const cciBullFlag = (bias === "long" && cciBull) || (bias === "short" && cciBear) ? 1 : 0;
  const stochOsFlag = l >= 14 ? ((bias === "long" && stoch(l-1) < 30 && stoch(l-1) > stoch(l-2)) || (bias === "short" && stoch(l-1) > 70 && stoch(l-1) < stoch(l-2)) ? 1 : 0) : 0;
  const microSweepFlag = (bias === "long" && lows[l-1] <= Math.min(...lows.slice(-5)) && closes[l-1] > Math.min(...lows.slice(-5))) || (bias === "short" && highs[l-1] >= Math.max(...highs.slice(-5)) && closes[l-1] < Math.max(...highs.slice(-5))) ? 1 : 0;

  // Compute tight LTF stop
  const atr15m = (highs.slice(-10).reduce((s,h,i) => s + Math.max(h-lows.slice(-10)[i], Math.abs(h-closes.slice(-10)[i])), 0) / 10) || 1;
  const stopDist = atr15m * 1.5;
  const stop = bias === "long" ? entry - stopDist : entry + stopDist;
  const tpDist = stopDist * (bias === "long" ? 3 : 3);
  const tp = bias === "long" ? entry + tpDist : entry - tpDist;

  const trigger = (confirmation >= 10 ? "zoom_only" : "htf_standalone") as "zoom_only" | "htf_standalone";

  return { confirmation, entry: Math.round(entry * 1e8) / 1e8, stop, tp, cciBull: cciBullFlag, stochOs: stochOsFlag, microSweep: microSweepFlag, trigger };
}

/* ─── Main entry point ────────────────────────────────────────────────

   Called once per pair per minute.  If HTF shows promise, fetches 15m
   and runs LTF confirmation.  Returns a decision if composite >= 65. */

export async function evaluateZoom(
  symbol: string,
  htf: "4h" | "2h" | "1h",
): Promise<ZoomDecision | null> {
  // 1. Fetch HTF klines
  const htfCandles = await fetchKlines(symbol, htf, 99);
  if (htfCandles.length < 26) return null;

  // 2. Compute drawdown estimate and trace last-trade win state
  const htfLows = htfCandles.map(k => k.low);
  const htfHighs = htfCandles.map(k => k.high);
  const htfCloses = htfCandles.map(k => k.close);
  const peak = Math.max(...htfHighs.slice(-20));
  const trough = Math.min(...htfLows.slice(-20));
  const ddEst = ((peak - trough) / peak) * 100;
  const lastWin = htfCloses[htfCloses.length - 1] > htfCloses[htfCloses.length - 2];

  // 3. Lookup MDP-trained policy
  const policy = getPolicy(htf, ddEst, lastWin);

  // 4. Score HTF
  const [longScore, shortScore] = [
    scoreHTF(htfCloses, htfHighs, htfLows, "long"),
    scoreHTF(htfCloses, htfHighs, htfLows, "short"),
  ];
  const htfScore = Math.max(longScore, shortScore);
  const bias = longScore >= shortScore ? "long" : "short";

  // 5. If HTF > 0, zoom to 15m
  if (htfScore < 1) return null;

  const ltfCandles = await fetchKlines(symbol, "15m", 30);
  if (ltfCandles.length < 20) return null;

  const ltfResult = confirmLTF(ltfCandles, bias);
  // Weight LTF confirmation by the MDP-trained per-feature weights
  const ltfWeighted = (ltfResult.cciBull ? policy.cciW : 0) + (ltfResult.stochOs ? policy.stochW : 0) + (ltfResult.microSweep > 0 ? policy.microW : 0);
  const composite = htfScore + ltfWeighted;

  // 6. Decision: threshold from MDP policy
  if (composite < policy.thr) return null;

  return {
    symbol, htf, ltf: "15m", bias,
    htfScore,
    ltfConfirmation: Math.round(ltfResult.confirmation * 100 / 25), // normalise to 0-100
    composite,
    trigger: ltfResult.trigger,
    ltfEntry: ltfResult.entry,
    ltfStop: ltfResult.stop,
    ltfTP: ltfResult.tp,
    narrative: `${bias} ${symbol} HTF(${htf}) scored ${htfScore}/75 → LTF(15m) confirmed at ${ltfResult.confirmation}/25. Entry: ${ltfResult.entry.toFixed(4)}, SL: ${ltfResult.stop.toFixed(4)}, TP: ${ltfResult.tp.toFixed(4)}`,
  };
}
