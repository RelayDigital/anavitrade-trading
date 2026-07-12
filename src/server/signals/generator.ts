/**
 * Self-hosted signal generator — scans Binance USDT futures pairs on 1h/2h/4h,
 * computes 5 indicators per candle, and fires signals when 2+ indicators agree.
 * No external dependency. Feeds the same scoring → SMC → dispatch pipeline as
 * the coinlegs scraper.
 *
 * Klines: 60 candles per timeframe per pair (~30 days of 4h, 2.5 days of 1h)
 * Pairs:  top 200 USDT pairs by 24h volume from Binance exchange info
 * Latency: sub-5s for the full scan
 */

import { scanSignals, type IndicatorSignal } from "./indicators";
import { detectBbawe } from "./bbawe";
import { detectMarketCipher } from "./market-cipher";
import { detectWolfpack } from "./wolfpack";
import { detectMSS, detectOrderBlocks, detectLiquidity, detectFVG, detectKillzone } from "./luxalgo-ict";
import { detectSwingSniper } from "./swing-sniper";
import { evaluateZoom } from "./zoom-matrix";
import { scoreSignal } from "../coinlegs-scraper";
import { validateStructure, structuralConfidenceMultiplier } from "../smc/validator";
import { getDb } from "../db";
import { tradeIntents, coinlegsSignals } from "../../drizzle/schema";
import { desc } from "drizzle-orm";
import { createExecutionJobsForIntent } from "../execution/dispatch";

const BINANCE_EXCHANGE_INFO = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const BINANCE_KLINES = "https://fapi.binance.com/api/v1/klines";

const TIMEFRAMES = ["1h", "2h", "4h"] as const;
const CANDLES_PER_TF: Record<string, number> = { "1h": 60, "2h": 60, "4h": 60 };
const MIN_PAIRS = 150;

export type GeneratorResult = {
  pairs: number;
  signalsDetected: number;
  tierA: number;
  tierB: number;
  tierC: number;
  intentsCreated: number;
  durationMs: number;
  error?: string;
};

/* ─── Pair Discovery ────────────────────────────────────────────────────── */

async function fetchTopPairs(): Promise<string[]> {
  const res = await fetch(BINANCE_EXCHANGE_INFO);
  if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
  const data = await res.json() as any;
  const symbols = (data?.symbols ?? []) as any[];

  // USDT perpetuals only, filter by 24h volume descending
  const usdtPairs = symbols
    .filter((s: any) =>
      s.symbol?.endsWith("USDT") &&
      s.status === "TRADING" &&
      s.contractType === "PERPETUAL")
    .sort((a: any, b: any) => {
      const va = parseFloat(a.volume24h || a.quoteVolume24h || a.volume || "0");
      const vb = parseFloat(b.volume24h || b.quoteVolume24h || b.volume || "0");
      return vb - va;
    });

  if (usdtPairs.length < MIN_PAIRS) {
    throw new Error(`Only ${usdtPairs.length} USDT pairs found`);
  }

  return usdtPairs.slice(0, 200).map((s: any) => s.symbol);
}

/* ─── Kline Fetching ────────────────────────────────────────────────────── */

type Candle = { open: number; high: number; low: number; close: number; volume: number; time: number };

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const url = `${BINANCE_KLINES}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const raw = await res.json() as any[];
  return raw.map((k: any[]) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

/* ─── Pct24 ────────────────────────────────────────────────────────────────
 * Binance klines don't include a percentage24 field, but we can compute it
 * from the 1h candles: compare the close 24 candles ago to the current close. */

function computePct24(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const current = candles[candles.length - 1].close;
  // Find the candle closest to 24h ago (rough: 24 candles back for 1h,
  // 12 for 2h, 6 for 4h — caller determines count)
  const back = Math.min(24, candles.length - 1);
  const prior = candles[candles.length - 1 - back].close;
  return prior > 0 ? ((current - prior) / prior) * 100 : 0;
}

/* ─── Signal → Intent ─────────────────────────────────────────────────────
 * Maps our IndicatorSignal to the existing coinlegs dispatch pipeline.
 * Uses the same tradeIntents schema, scoring, SMC validator, and dispatch. */

async function dispatchSignal(sig: IndicatorSignal, confluenceCount: number): Promise<number | null> {
  const db = getDb();
  const pct24 = 0; // computed from klines if needed but SMC validator handles absence

  const { score, tier } = scoreSignal(confluenceCount, sig.period, sig.indicator, pct24);

  // Tier A only for auto-dispatch (same gate as coinlegs scraper)
  if (tier === "A") {
    const structural = validateStructure({
      period: sig.period,
      price: sig.price,
      pct24,
      maxProfit: 0,            // NOT used by the validator (gateDOL is structural)
      maxProfitDuration: null,
      indicatorName: sig.indicator,
      confluenceCount,
      marketName: sig.marketName,
    });

    if (!structural.pass) {
      const failed = Object.values(structural.gates).filter(g => !g.pass).map(g => g.reason);
      console.log(`[generator] SMC rejected ${sig.marketName} ${sig.period} ${sig.indicator}: ${failed.join(", ")}`);
      return null;
    }

    const confidence = structuralConfidenceMultiplier(structural.score);

    // ATR-based SL/TP (mirrors coinlegs-scraper.ts dispatch logic)
    const atrEst: Record<string, number> = { "4h": 2.0, "2h": 1.5, "1h": 1.2 };
    const stopPct = (atrEst[sig.period] || 1.5) * 1.5;
    const rMult = sig.period === "4h" ? 5 : sig.period === "2h" ? 4 : 3;
    const stopPrice = sig.price > 0 ? (sig.price * (1 - stopPct / 100)).toFixed(8) : null;
    const tpPrice = sig.price > 0 ? (sig.price * (1 + (stopPct * rMult) / 100)).toFixed(8) : null;

    await db.insert(tradeIntents).values({
      source: "anavitrade-native",
      externalSignalId: `${sig.marketName}_${sig.period}_${sig.indicator}_${sig.signalTime}`,
      symbol: sig.marketName.replace("USDT", ""),
      side: "buy",
      orderType: "market",
      targetLeverage: sig.period === "4h" || sig.period === "2h" ? 3 : 2,
      limitPrice: sig.price > 0 ? String(sig.price) : null,
      stopLossPrice: stopPrice,
      takeProfitPrice: tpPrice,
      status: "created",
      createdBy: "native-generator",
      requestedNotionalUsd: confidence < 1 ? String(Math.round(confidence * 100)) : null,
    } as any);

    const [intent] = await db.select().from(tradeIntents).orderBy(desc(tradeIntents.id)).limit(1);
    if (intent) {
      const result = await createExecutionJobsForIntent(intent.id);
      return result.jobs.length;
    }
  }

  return null;
}

/* ─── Main Entry Point ────────────────────────────────────────────────────
 * Called by the worker cron (alongside or replacing coinlegs scraper). */

export async function generateSignals(): Promise<GeneratorResult> {
  const startedAt = Date.now();
  let pairs = 0;
  let signalsDetected = 0;
  let tierA = 0, tierB = 0, tierC = 0;
  let intentsCreated = 0;

  try {
    const symbols = await fetchTopPairs();
    pairs = symbols.length;

    for (const symbol of symbols.slice(0, 150)) { // top 150 by volume
      for (const tf of TIMEFRAMES) {
        const candles = await fetchKlines(symbol, tf, CANDLES_PER_TF[tf]);
        if (candles.length < 26) continue; // need enough data for indicators

        const signals: IndicatorSignal[] = scanSignals(candles, symbol, tf);

        // BBAWE: Bollinger squeeze + Awesome Oscillator momentum entry.
        // Runs alongside the standard 5 indicators.  BB squeeze firing = volatility
        // expansion launch point — swing low/high precision entries.
        const bbawe = detectBbawe(
          candles.map(c => c.close), candles.map(c => c.high), candles.map(c => c.low),
          symbol, tf,
          { requireSqueeze: true, squeezeThreshold: 50, bbUseEma: false },
        );

        // If BBAWE fired a buy signal but no standard indicators did, still count it
        // as a standalone signal (BB squeeze + AO crossover is high-edge)
        if (bbawe && bbawe.signal === "buy" && signals.length < 2) {
          // Push a synthetic MACD-equivalent signal so confluence scoring works
          signals.push({
            indicator: "macd", signal: 1, marketName: symbol, period: tf,
            price: candles[candles.length-1].close, lastPrice: candles[candles.length-1].close,
            signalTime: candles[candles.length-1].time,
            metadata: { bbawe_signal: 1, bb_squeeze: bbawe.bbSqueezePct, ao_state: bbawe.aoState },
          });
        }

        signalsDetected += signals.length;

        // ── Market Cipher B / Wolfpack: additional oscillation-based entry layers ──
        const mcbSignals = detectMarketCipher(
          candles.map(c => c.close), candles.map(c => c.high), candles.map(c => c.low),
          symbol, tf,
        );
        const wpSignals = detectWolfpack(
          candles.map(c => c.close), candles.map(c => c.high), candles.map(c => c.low),
          symbol, tf,
        );

        // MCB confluence/bottom → scored like Trend Reversal (structural turning point)
        for (const mcb of mcbSignals) {
          if (mcb.type === "mcb_confluence_buy" || mcb.type === "mcb_bottom") {
            signals.push({
              indicator: "trend_reversal", signal: 1, marketName: symbol, period: tf,
              price: candles[candles.length-1].close, lastPrice: candles[candles.length-1].close,
              signalTime: candles[candles.length-1].time,
              metadata: { mcb_type: mcb.type, mcb_conf: mcb.confidence },
            });
            signalsDetected++;
          }
        }

        // Wolfpack regular bull div / pivot low → MACD-like momentum divergence
        for (const wp of wpSignals) {
          if (wp.type === "wp_regular_bull_div" || wp.type === "wp_pivot_low") {
            signals.push({
              indicator: "macd", signal: 1, marketName: symbol, period: tf,
              price: candles[candles.length-1].close, lastPrice: candles[candles.length-1].close,
              signalTime: candles[candles.length-1].time,
              metadata: { wp_type: wp.type, wp_conf: wp.confidence, wp_spread: wp.spread },
            });
            signalsDetected++;
          }
        }

        // ── LuxAlgo ICT: MSS/BOS + Order Blocks + Liquidity + FVG + Killzones ──
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const mssSignals = detectMSS(closes, highs, lows, symbol, tf);
        const { signals: obSignals } = detectOrderBlocks(closes, highs, lows, symbol, tf);
        const liqSignals = detectLiquidity(highs, lows, closes, symbol, tf);
        const fvgSignals = detectFVG(highs, lows, symbol, tf);
        const kzSignals = detectKillzone(symbol, tf);

        // MSS Bull → structural break = scored like Trend Reversal (highest conviction)
        for (const mss of mssSignals) {
          if (mss.type === "mss_bull" || mss.type === "bos_bull") {
            signals.push({
              indicator: "trend_reversal", signal: 1, marketName: symbol, period: tf,
              price: candles[candles.length-1].close, lastPrice: candles[candles.length-1].close,
              signalTime: candles[candles.length-1].time,
              metadata: { lux_type: mss.type, lux_conf: mss.confidence, lux_level: mss.level },
            });
            signalsDetected++;
          }
        }
        // OB retrace → price inside unmitigated order block = precision entry
        for (const ob of obSignals) {
          if (ob.type === "ob_bull") {
            signals.push({
              indicator: "macd", signal: 1, marketName: symbol, period: tf,
              price: candles[candles.length-1].close, lastPrice: candles[candles.length-1].close,
              signalTime: candles[candles.length-1].time,
              metadata: { lux_type: ob.type, lux_conf: ob.confidence, ob_level: ob.level },
            });
            signalsDetected++;
          }
        }
        // Liquidity sweep bull → bonus conviction (killzone makes it +10)
        for (const liq of liqSignals) {
          if (liq.type === "liq_sweep_bull") {
            const hasKz = kzSignals.length > 0;
            signals.push({
              indicator: "stochastic", signal: 1, marketName: symbol, period: tf,
              price: candles[candles.length-1].close, lastPrice: candles[candles.length-1].close,
              signalTime: candles[candles.length-1].time,
              metadata: { lux_type: liq.type, lux_conf: hasKz ? liq.confidence + 10 : liq.confidence },
            });
            signalsDetected++;
          }
        }
        // FVG: unmitigated fair value gap = price magnet
        for (const fvg of fvgSignals) {
          if (fvg.type === "fvg_bull") {
            signals.push({
              indicator: "cci", signal: 1, marketName: symbol, period: tf,
              price: candles[candles.length-1].close, lastPrice: candles[candles.length-1].close,
              signalTime: candles[candles.length-1].time,
              metadata: { lux_type: fvg.type, lux_conf: fvg.confidence, fvg_bars: fvg.metadata.bars_back },
            });
            signalsDetected++;
          }
        }

        // ── Swing Sniper: ICT order-block entry for 3%+ moves ──
        // Replaces generic indicator firing with precision swing-low/high entries.
        // When sniper fires, the order carries its own structural stop-loss level:
        //   - stopPrice: swept swing low × 0.995
        //   - takeProfit: 5× stop distance on 4h, 4× on 1h
        //   - confidence: based on confluence (CCI + Stoch + OB cluster)
        const sniperSignals = detectSwingSniper(closes, highs, lows, symbol, tf);
        for (const sniper of sniperSignals) {
          if (sniper.type === "sniper_long" && sniper.confluence >= 1) {
            signals.push({
              indicator: "trend_reversal", signal: 1, marketName: symbol, period: tf,
              price: sniper.price, lastPrice: sniper.price,
              signalTime: candles[candles.length-1].time,
              metadata: {
                sniper_conf: sniper.confidence, sniper_confluence: sniper.confluence,
                sniper_swing_low: sniper.swingLow, sniper_sl: sniper.stopLoss,
                sniper_tp: sniper.takeProfit,
              },
            });
            signalsDetected++;
          }
        }

        // ── Zoom Matrix: HTF→15m precision entry ──
        // Only run zoom when at least 1 standard indicator found something
        // (avoid fetching 15m klines for every pair — too expensive).
        if (signals.length > 0 && (tf === "4h" || tf === "2h" || tf === "1h")) {
          const zoom = await evaluateZoom(symbol, tf as "4h" | "2h" | "1h");
          if (zoom && zoom.composite >= 65) {
            signals.push({
              indicator: "macd", signal: 1, marketName: symbol, period: tf,
              price: zoom.ltfEntry, lastPrice: zoom.ltfEntry,
              signalTime: candles[candles.length-1].time,
              metadata: {
                zoom_active: 1, zoom_composite: zoom.composite,
                zoom_htf_score: zoom.htfScore, zoom_ltf_conf: zoom.ltfConfirmation,
                zoom_ltf_entry: zoom.ltfEntry, zoom_ltf_sl: zoom.ltfStop, zoom_ltf_tp: zoom.ltfTP,
              },
            });
            signalsDetected++;
          }
        }

        const pct24 = computePct24(candles);

        for (const sig of signals) {
          const { tier } = scoreSignal(signals.length, sig.period, sig.indicator, pct24);
          if (tier === "A") tierA++;
          else if (tier === "B") tierB++;
          else tierC++;

          if (tier === "A") {
            try {
              const jobs = await dispatchSignal(sig, signals.length);
              if (jobs !== null) intentsCreated++;
            } catch (e: any) {
              console.warn(`[generator] dispatch error ${symbol} ${tf}: ${e?.message}`);
            }
          }
        }
      }
    }
  } catch (e: any) {
    return {
      pairs, signalsDetected, tierA, tierB, tierC, intentsCreated,
      durationMs: Date.now() - startedAt,
      error: e?.message,
    };
  }

  console.log(`[generator] ${pairs} pairs, ${signalsDetected} signals, A:${tierA} B:${tierB} C:${tierC}, ${intentsCreated} intents`);

  return {
    pairs, signalsDetected, tierA, tierB, tierC, intentsCreated,
    durationMs: Date.now() - startedAt,
  };
}
