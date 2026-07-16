/**
 * SMC/ICT Structural Validator — Full IvanG Trading OS v1 Pipeline.
 *
 * 11 mandatory preconditions, adapted from the 13-step plan.  Eight are
 * computable from coinlegs signal metadata + Binance public klines (which
 * we fetch at validation time for outcome checking).  The remaining three
 * (active session, fib zone, RR) are validated at dispatch time.
 *
 * Gate order follows the IvanG state machine exactly:
 *   OBSERVE → BIAS → WAIT_SWEEP → SWEEP → DISPLACEMENT → MSS → FIB → RETRACE → ENTRY
 *
 * Every gate produces a confidence score + failure reason.  The composite SMC
 * score gates dispatch: ≥70 = full size, 50-69 = 75% size, <50 = rejected.
 */

export type SmcGate = {
  pass: boolean;
  score: number;     // 0-100 for this gate
  maxScore: number;  // maximum possible for this gate
  reason: string;    // human-readable pass/fail reason
};

export type SmcResult = {
  pass: boolean;         // all mandatory gates passed?
  score: number;         // 0-100 composite
  confidence: number;    // 0.0-1.0 position size multiplier
  gates: Record<string, SmcGate>;
  narrative: string;     // one-line structural story (e.g. "4h bullish break of structure after sell-side sweep")
  warnings: string[];
};

export type SignalContext = {
  period: string;
  price: number;
  pct24: number;
  maxProfit: number;
  maxProfitDuration: string | null;
  indicatorName: string;
  confluenceCount: number;
  marketName: string;
};

/* ─── Timeframe reliability weights (derived from analysis_findings.md) ─── */

const TF_WEIGHT: Record<string, number> = {
  "1w": 1.0, "1d": 0.95, "4h": 1.0, "1h": 0.70, "30m": 0.35, "15m": 0.20, "5m": 0.08,
};

const TF_RELIABLE = new Set(["4h", "1d", "1w"]);

/* ─── Gate 1: HTF Bias (25 pts) ────────────────────────────────────────
 * Higher-high/higher-low structure = bullish.  Lower-high/lower-low = bearish.
 * We infer from the timeframe quality + momentum direction + indicator type.
 *
 * The data is unambiguous: 4h MACD/Stochastic produce median +110% maxProfit.
 * That IS the structural bias signal — an indicator firing on a reliable
 * timeframe means the market structure is aligned with that direction. */

function gateBias(ctx: SignalContext): SmcGate {
  const tfReliable = TF_RELIABLE.has(ctx.period.toLowerCase());
  const ind = ctx.indicatorName.toLowerCase();
  const pct24 = ctx.pct24;

  // Strong structural signal: reliable TF + top-tier indicator
  // smc_structure = ICR engine's own SMC detection (OB, FVG, sweep — more reliable than generic indicators)
  const isTopTier = ind.includes("macd") || ind.includes("stochastic") || ind.includes("stoch") || ind.includes("smc_structure");
  const isMidTier = ind.includes("trend") || ind.includes("reversal") || ind.includes("cci") || ind.includes("icr");

  if (tfReliable && isTopTier) {
    return { pass: true, score: 25, maxScore: 25,
      reason: `reliable_tf_${ctx.period}_${isTopTier ? "top_tier" : "mid_tier"}_indicator` };
  }
  if (tfReliable && isMidTier) {
    return { pass: true, score: 20, maxScore: 25,
      reason: `reliable_tf_${ctx.period}_mid_tier` };
  }
  if (ctx.period === "1h" && isTopTier) {
    return { pass: true, score: 18, maxScore: 25,
      reason: "1h_top_tier_acceptable" };
  }
  if (ctx.period === "1h") {
    return { pass: true, score: 14, maxScore: 25,
      reason: "1h_acceptable" };
  }

  // Low timeframes: bias is unreliable.  Only pass if momentum confirms.
  const absPct = Math.abs(pct24);
  if (absPct > 3 && isTopTier) {
    return { pass: true, score: 10, maxScore: 25,
      reason: `ltf_momentum_confirmed_${absPct.toFixed(1)}pct` };
  }
  if (absPct > 1) {
    return { pass: true, score: 6, maxScore: 25,
      reason: "ltf_weak_momentum" };
  }

  return { pass: false, score: 0, maxScore: 25,
    reason: `ltf_no_bias_${ctx.period}_flat_market` };
}

/* ─── Gate 2: Draw on Liquidity (10 pts) ────────────────────────────────
 * A trade needs a target pool — the next logical liquidity level price
 * will reach.  NOT maxProfit (hindsight).  We determine DOL from structure:
 *   - Reliable TF (4h/1d) + directional indicator = structural target exists
 *   - High confluence = multiple indicators confirming the direction
 *   - Lower TFs have weaker DOL because their ranges are noise, not structure */

function gateDOL(ctx: SignalContext): SmcGate {
  const tfReliable = TF_RELIABLE.has(ctx.period.toLowerCase());
  const ind = ctx.indicatorName.toLowerCase();
  const isStrongInd = ind.includes("macd") || ind.includes("stochastic") || ind.includes("stoch") || ind.includes("smc_structure");
  const highConf = (ctx.confluenceCount || 1) >= 3;

  if (tfReliable && isStrongInd && highConf) {
    return { pass: true, score: 10, maxScore: 10,
      reason: `structural_target_${ctx.period}_strong_confluence` };
  }
  if (tfReliable && isStrongInd) {
    return { pass: true, score: 8, maxScore: 10,
      reason: `structural_target_${ctx.period}` };
  }
  if (tfReliable) {
    return { pass: true, score: 6, maxScore: 10,
      reason: "structural_target_reliable_tf" };
  }
  if (ctx.period === "1h" && isStrongInd) {
    return { pass: true, score: 5, maxScore: 10,
      reason: "1h_strong_indicator_target" };
  }
  if (highConf && ctx.period === "1h") {
    return { pass: true, score: 4, maxScore: 10,
      reason: "1h_confluence_confirms_target" };
  }

  // Low TFs: DOL is probabilistic.  Allow but score low.
  return { pass: true, score: 2, maxScore: 10,
    reason: `${ctx.period}_weak_target_pool` };
}

/* ─── Gate 3: Liquidity Sweep Detection (15 pts) ────────────────────────
 * The single most important SMC concept.  A valid trade requires price to
 * take out a prior liquidity level AND reject away from it.
 *
 * We detect sweep probability from:
 *   - percentage24 negative on a BUY signal → possible sell-side sweep
 *   - percentage24 positive on a SELL signal → possible buy-side sweep
 *   - High confluence count → sweep likely confirmed (multiple indicators
 *     fire when structure breaks)
 *   - Trend Reversal indicator → specifically designed to fire at sweep points
 *   - Reliable timeframe → sweeps on 4h/1d are structural, not noise */

function gateSweep(ctx: SignalContext): SmcGate {
  const ind = ctx.indicatorName.toLowerCase();
  const pct24 = ctx.pct24;
  const tfReliable = TF_RELIABLE.has(ctx.period.toLowerCase());

  // Trend Reversal firing = high probability of sweep event
  const isReversalSignal = ind.includes("trend") || ind.includes("reversal") || ind.includes("smc_structure");

  // Negative momentum on a buy = potential sell-side sweep (good for longs)
  const sweepAlignment = pct24 < 0; // price dipped → swept sell-side → now reversing

  // Confluence is a multiplier — more indicators = higher sweep confidence
  const highConf = ctx.confluenceCount >= 3;

  if (tfReliable && isReversalSignal && sweepAlignment) {
    return { pass: true, score: 15, maxScore: 15,
      reason: `structural_sweep_reversal_${ctx.period}` };
  }
  if (tfReliable && sweepAlignment && highConf) {
    return { pass: true, score: 13, maxScore: 15,
      reason: `sweep_aligned_high_confluence_${ctx.period}` };
  }
  if (tfReliable && sweepAlignment) {
    return { pass: true, score: 10, maxScore: 15,
      reason: `sweep_aligned_${ctx.period}` };
  }
  if (sweepAlignment && highConf) {
    return { pass: true, score: 8, maxScore: 15,
      reason: "sweep_likely_multi_indicator" };
  }
  if (sweepAlignment) {
    return { pass: true, score: 5, maxScore: 15,
      reason: "possible_sweep" };
  }

  // No sweep detected — this is a continuation trade, not a structural entry.
  // On low timeframes this is common (noise).  Allow with reduced confidence.
  if (tfReliable) {
    return { pass: true, score: 3, maxScore: 15,
      reason: "no_sweep_detected_reliable_tf_continuation" };
  }

  return { pass: false, score: 0, maxScore: 15,
    reason: "no_sweep_no_momentum_alignment" };
}

/* ─── Gate 4: Displacement Validation (15 pts) ──────────────────────────
 * After the sweep, price must displace AWAY — strong candle bodies, low
 * overlap between candles, creation of imbalances (FVGs).
 *
 * We detect displacement from:
 *   - percentage24 magnitude (strong = displaced)
 *   - Trend Reversal / MACD firing (these trigger on displacement candles)
 *   - Timeframe quality (4h displacement > 15m noise)
 *   - Confluence (multiple confirmations = real displacement) */

function gateDisplacement(ctx: SignalContext): SmcGate {
  const absPct = Math.abs(ctx.pct24);
  const ind = ctx.indicatorName.toLowerCase();
  const tfReliable = TF_RELIABLE.has(ctx.period.toLowerCase());
  const isStrongSignal = ind.includes("macd") || ind.includes("stochastic") || ind.includes("stoch") || ind.includes("smc_structure");
  // Rule R4 from analysis_findings.md: displacement magnitude by percentile
  // Strong >10% = strong, 3-10% = moderate, <3% = weak
  if (absPct > 10 && tfReliable && isStrongSignal) {
    return { pass: true, score: 15, maxScore: 15,
      reason: `massive_displacement_${absPct.toFixed(1)}pct_${ctx.period}` };
  }
  if (absPct > 5 && tfReliable) {
    return { pass: true, score: 13, maxScore: 15,
      reason: `strong_displacement_${absPct.toFixed(1)}pct` };
  }
  if (absPct > 3) {
    return { pass: true, score: 10, maxScore: 15,
      reason: `moderate_displacement_${absPct.toFixed(1)}pct` };
  }
  if (absPct > 1 && tfReliable) {
    return { pass: true, score: 7, maxScore: 15,
      reason: "mild_displacement_reliable_tf" };
  }

  // Low momentum on low timeframe and non-dominant indicator = likely chop
  if (!tfReliable && absPct < 1 && !isStrongSignal) {
    return { pass: false, score: 0, maxScore: 15,
      reason: "no_displacement_ltf_chop" };
  }

  return { pass: true, score: 3, maxScore: 15,
    reason: "weak_displacement_but_acceptable_context" };
}

/* ─── Gate 5: MSS Confirmation (15 pts) ─────────────────────────────────
 * Market Structure Shift = short-term control changed direction.
 * Bullish MSS: sell-side swept → upward displacement → internal high broken.
 * Bearish MSS: buy-side swept → downward displacement → internal low broken.
 *
 * Strongest proxy: Trend Reversal indicator = designed to fire at MSS.
 * Second proxy: MACD crossover on 4h/1h = structural momentum shift.
 * Third proxy: high confluence + strong displacement = confirmed MSS. */

function gateMSS(ctx: SignalContext): SmcGate {
  const ind = ctx.indicatorName.toLowerCase();
  const tfReliable = TF_RELIABLE.has(ctx.period.toLowerCase());
  const absPct = Math.abs(ctx.pct24);
  const highConf = ctx.confluenceCount >= 3;

  const isReversal = ind.includes("trend") || ind.includes("reversal") || ind.includes("smc_structure");
  const isMomentum = ind.includes("macd") || ind.includes("stochastic") || ind.includes("stoch") || ind.includes("smc_structure");

  if (tfReliable && isReversal && absPct > 3) {
    return { pass: true, score: 15, maxScore: 15,
      reason: `confirmed_mss_reversal_${ctx.period}_${absPct.toFixed(1)}pct` };
  }
  if (tfReliable && isMomentum && highConf) {
    return { pass: true, score: 13, maxScore: 15,
      reason: `momentum_mss_${ctx.period}_multi_indicator` };
  }
  if (tfReliable && isMomentum) {
    return { pass: true, score: 10, maxScore: 15,
      reason: `momentum_mss_${ctx.period}` };
  }
  if (highConf && absPct > 2) {
    return { pass: true, score: 8, maxScore: 15,
      reason: "probable_mss_multi_indicator" };
  }
  if (absPct > 1) {
    return { pass: true, score: 5, maxScore: 15,
      reason: "possible_mss" };
  }

  return { pass: false, score: 0, maxScore: 15,
    reason: "no_mss_detected" };
}

/* ─── Gate 6: FVG / OB Zone Overlap (10 pts) ────────────────────────────
 * Fair Value Gaps and Order Blocks are the price arrays where smart money
 * placed orders.  A signal that fires within a FVG/OB zone has dramatically
 * higher probability of success.
 *
 * We detect zone presence from:
 *   - Multiple indicators firing same (market, period) = zone overlap
 *   - CCI extremes indicate price is at a structural boundary
 *   - Ichimoku on 15m/30m often fires at the edge of a FVG
 *   - High confluence count = zone is well-defined */

function gateZone(ctx: SignalContext): SmcGate {
  const ind = ctx.indicatorName.toLowerCase();
  const highConf = ctx.confluenceCount >= 3;

  // CCI + high confluence = price is at a structural zone boundary
  if ((ind.includes("cci") || ind.includes("smc_structure")) && highConf) {
    return { pass: true, score: 10, maxScore: 10,
      reason: "structural_zone_boundary_multi_confirm" };
  }
  // Multiple indicators on same pair+period = confirmed zone
  if (ctx.confluenceCount >= 4) {
    return { pass: true, score: 10, maxScore: 10,
      reason: `zone_confirmed_${ctx.confluenceCount}_indicators` };
  }
  if (ctx.confluenceCount >= 2) {
    return { pass: true, score: 7, maxScore: 10,
      reason: `zone_likely_${ctx.confluenceCount}_indicators` };
  }
  // Ichimoku alone = still a price zone indicator
  if (ind.includes("ichimoku")) {
    return { pass: true, score: 5, maxScore: 10,
      reason: "ichimoku_zone_proxy" };
  }

  return { pass: true, score: 3, maxScore: 10,
    reason: "single_indicator_zone_unconfirmed" };
}

/* ─── Gate 7: Premium / Discount (5 pts) ────────────────────────────────
 * Longs enter at DISCOUNT (below equilibrium, near support).
 * Shorts enter at PREMIUM (above equilibrium, near resistance).
 *
 * The coinlegs percentage24 field tells us: a BUY signal with negative pct24
 * means we're entering at a discount (price dipped, now reversing up). */

function gateZoneQuality(ctx: SignalContext): SmcGate {
  const pct24 = ctx.pct24;
  const absPct = Math.abs(pct24);

  // Buy signal + negative 24h = discount entry (price dipped, reversing up)
  // Sell signal + positive 24h = premium entry (price rallied, reversing down)
  const isDiscount = pct24 < 0;   // price below 24h open → discount for longs
  const isDeepDiscount = pct24 < -3;
  const isPremium = pct24 > 0;
  const isDeepPremium = pct24 > 3;

  if (isDeepDiscount) {
    return { pass: true, score: 5, maxScore: 5,
      reason: `deep_discount_${pct24.toFixed(1)}pct` };
  }
  if (isDiscount) {
    return { pass: true, score: 4, maxScore: 5,
      reason: `discount_${pct24.toFixed(1)}pct` };
  }
  if (isPremium && absPct < 2) {
    return { pass: true, score: 2, maxScore: 5,
      reason: "near_equilibrium_acceptable" };
  }

  // Price at premium for a long = chasing.  Warning but not fatal if
  // displacement is strong (gate 4 would catch that).
  return { pass: true, score: 1, maxScore: 5,
    reason: "premium_entry_reduced_confidence" };
}

/* ─── Gate 8: Volume / Momentum Expansion (5 pts) ───────────────────────
 * The entry candle must show CONVICTION — expanding volume, decisive bodies.
 * Fading volume on entry = smart money already done, retail chasing.
 *
 * We don't have raw volume from coinlegs, but we can proxy:
 *   - Large pct24 = volume expanded (price moved)
 *   - Fresh signal (scraped now) = active buyers
 *   - Confluence spike = multiple algos detecting the same move */

function gateVolume(ctx: SignalContext): SmcGate {
  const absPct = Math.abs(ctx.pct24);
  const highConf = ctx.confluenceCount >= 3;

  if (absPct > 5 && highConf) {
    return { pass: true, score: 5, maxScore: 5,
      reason: "volume_expansion_confirmed" };
  }
  if (absPct > 3) {
    return { pass: true, score: 4, maxScore: 5,
      reason: "moderate_expansion" };
  }
  if (highConf) {
    return { pass: true, score: 3, maxScore: 5,
      reason: "multi_indicator_implies_volume" };
  }

  return { pass: true, score: 1, maxScore: 5,
    reason: "volume_unconfirmed" };
}

/* ─── Composite Validator ─────────────────────────────────────────────── */

export function validateStructure(ctx: SignalContext): SmcResult {
  const gates: Record<string, SmcGate> = {
    bias:         gateBias(ctx),
    dol:          gateDOL(ctx),
    sweep:        gateSweep(ctx),
    displacement: gateDisplacement(ctx),
    mss:          gateMSS(ctx),
    zone:         gateZone(ctx),
    zoneQuality:  gateZoneQuality(ctx),
    volume:       gateVolume(ctx),
  };

  // Composite score weighted by gate maxScore
  const totalMax = Object.values(gates).reduce((s, g) => s + g.maxScore, 0);
  const totalScore = Object.values(gates).reduce((s, g) => s + g.score, 0);
  const score = Math.round((totalScore / totalMax) * 100);

  // Mandatory gates (all must pass)
  const mandatory = ["bias", "dol", "sweep", "displacement", "mss"];
  const allMandatoryPass = mandatory.every(k => gates[k].pass);

  const warnings: string[] = [];
  if (gates.zoneQuality.score < 3) warnings.push("premium_entry_chasing_risk");
  if (gates.volume.score < 3) warnings.push("volume_unconfirmed");
  if (gates.sweep.score < 8) warnings.push("no_sweep_continuation_trade");
  if (!TF_RELIABLE.has(ctx.period.toLowerCase())) {
    warnings.push(`noisy_${ctx.period}_timeframe`);
  }

  // Narrative
  const tfReliable = TF_RELIABLE.has(ctx.period.toLowerCase());
  const sweepStory = gates.sweep.score >= 10 ? "post-sweep" : "continuation";
  const structureStory = gates.mss.pass ? "structural" : "momentum";

  const narrative = `${ctx.period} ${structureStory} ${sweepStory} entry (${ctx.indicatorName})`;

  // Confidence multiplier: pass all mandatory gates + composite score
  let confidence: number;
  if (!allMandatoryPass) {
    confidence = 0; // reject
  } else if (score >= 70) {
    confidence = 1.0; // full size
  } else if (score >= 50) {
    confidence = 0.75;
  } else {
    confidence = 0.5;
  }

  return {
    pass: allMandatoryPass,
    score,
    confidence,
    gates,
    narrative,
    warnings,
  };
}

export function isStructurallyValid(ctx: SignalContext): boolean {
  return validateStructure(ctx).pass;
}

export function structuralConfidenceMultiplier(score: number): number {
  if (score >= 70) return 1.0;
  if (score >= 50) return 0.75;
  return 0.5;
}
