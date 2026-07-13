import type { Kline } from "./types";
import { getLatestTimestamp, upsertKlines } from "./kline-repository";

const BINANCE_REST = "https://api.binance.com";

const INTERVAL_MAP: Record<string, string> = {
  "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w",
};
const MAX_PER_CALL = 500;

const FALLBACK_WATCHLIST = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT",
  "DOTUSDT","LINKUSDT","MATICUSDT","UNIUSDT","SHIBUSDT","LTCUSDT","ATOMUSDT","ETCUSDT",
  "XLMUSDT","BCHUSDT","ALGOUSDT","TRXUSDT","NEARUSDT","FILUSDT","APTUSDT","ARBUSDT",
  "OPUSDT","SUIUSDT","PEPEUSDT","INJUSDT","TIAUSDT","SEIUSDT","RUNEUSDT","AAVEUSDT",
  "MKRUSDT","COMPUSDT","CRVUSDT","FXSUSDT","GMXUSDT","PENDLEUSDT","STXUSDT",
  "FETUSDT","AGIXUSDT","OCEANUSDT","RNDRUSDT","ICPUSDT","EGLDUSDT","FLOWUSDT",
  "SANDUSDT","MANAUSDT","APEUSDT","AXSUSDT","YGGUSDT","GALAUSDT","IMXUSDT","BLURUSDT",
];

async function fetchTopUsdtPairs(limit?: number): Promise<string[]> {
  try {
    const fres = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
    if (fres.ok) {
      const data = await fres.json() as any;
      const symbols = (data?.symbols ?? []) as any[];
      const filtered = symbols
        .filter((s: any) => s.symbol?.endsWith("USDT") && s.status === "TRADING" && s.contractType === "PERPETUAL")
        .sort((a: any, b: any) => (parseFloat(b.volume24h || "0") - parseFloat(a.volume24h || "0")))
        .slice(0, limit ?? 150)
        .map((s: any) => s.symbol);
      if (filtered.length > 0) return filtered;
    }
  } catch { /* fall through */ }
  return FALLBACK_WATCHLIST.slice(0, limit ?? undefined);
}

export class KlineFetcher {
  private watchlist: string[] | null = null;
  private watchlistSize: number | undefined;
  private minDelayMs: number;

  constructor(watchlistSize?: number, minDelayMs = 200) {
    this.watchlistSize = watchlistSize;
    this.minDelayMs = minDelayMs;
  }

  async fetchKlines(
    symbol: string, interval: string, limit: number = MAX_PER_CALL,
    startTime?: number, endTime?: number,
  ): Promise<Kline[]> {
    const binanceInterval = INTERVAL_MAP[interval];
    if (!binanceInterval) throw new Error(`Unknown interval: ${interval}`);
    const params = new URLSearchParams({
      symbol, interval: binanceInterval,
      limit: String(Math.min(limit, MAX_PER_CALL)),
    });
    if (startTime) params.set("startTime", String(Math.floor(startTime)));
    if (endTime) params.set("endTime", String(Math.floor(endTime)));
    const res = await fetch(`${BINANCE_REST}/api/v3/klines?${params}`);
    if (!res.ok) throw new Error(`Binance API error ${res.status}: ${await res.text()}`);
    const raw: any[] = await res.json();
    return raw.map((k: any) => ({
      symbol, timeframe: interval,
      timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
  }

  async backfill(symbol: string, interval: string, lookbackBars: number = 500): Promise<Kline[]> {
    const allCandles: Kline[] = [];
    let remaining = lookbackBars;
    let endTime: number | undefined;
    while (remaining > 0) {
      const batch = Math.min(remaining, MAX_PER_CALL);
      const candles = await this.fetchKlines(symbol, interval, batch, undefined, endTime);
      if (candles.length === 0) break;
      allCandles.unshift(...candles);
      remaining -= candles.length;
      endTime = candles[0].timestamp;
      await this.delay();
    }
    if (allCandles.length > 0) await upsertKlines(allCandles);
    return allCandles;
  }

  async updateSymbol(symbol: string, interval: string): Promise<number> {
    const latestTs = await getLatestTimestamp(symbol, interval);
    const newCandles = await this.fetchKlines(symbol, interval, MAX_PER_CALL, latestTs ?? undefined);
    const fresh = latestTs ? newCandles.filter((c) => c.timestamp > latestTs) : newCandles;
    if (fresh.length > 0) await upsertKlines(fresh);
    return fresh.length;
  }

  async updateTimeframe(interval: string): Promise<number> {
    if (!this.watchlist) this.watchlist = await fetchTopUsdtPairs(this.watchlistSize);
    let total = 0;
    for (const symbol of this.watchlist) {
      total += await this.updateSymbol(symbol, interval);
      await this.delay();
    }
    return total;
  }

  async updateAll(): Promise<Record<string, number>> {
    if (!this.watchlist) this.watchlist = await fetchTopUsdtPairs(this.watchlistSize);
    const results: Record<string, number> = {};
    for (const interval of Object.keys(INTERVAL_MAP)) {
      results[interval] = await this.updateTimeframe(interval);
    }
    return results;
  }

  async backfillAll(lookbackBars: number = 500): Promise<Record<string, number>> {
    if (!this.watchlist) this.watchlist = await fetchTopUsdtPairs(this.watchlistSize);
    const results: Record<string, number> = {};
    for (const interval of Object.keys(INTERVAL_MAP)) {
      let total = 0;
      for (const symbol of this.watchlist) {
        total += (await this.backfill(symbol, interval, lookbackBars)).length;
      }
      results[interval] = total;
    }
    return results;
  }

  async getWatchlist(): Promise<string[]> {
    if (!this.watchlist) this.watchlist = await fetchTopUsdtPairs(this.watchlistSize);
    return [...this.watchlist];
  }

  private delay(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.minDelayMs));
  }
}
