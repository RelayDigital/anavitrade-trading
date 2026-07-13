import type { DerivativesSnapshot } from "../types";

// Returns auth headers needed to bypass Cloudflare 451 geo-block on Binance API
function binanceAuth(): Record<string, string> {
  try {
    const k = (globalThis as any).__env?.BINANCE_API_KEY;
    return k ? { "X-MBX-APIKEY": k } : {};
  } catch { return {}; }
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: binanceAuth() });
  if (res.status === 451) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

export class DerivativesFetcher {
  private minDelayMs: number;

  constructor(minDelayMs = 200) { this.minDelayMs = minDelayMs; }

  async fetchOpenInterest(symbol: string): Promise<{ openInterest: number; oiChange24h: number }> {
    const url = `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`;
    const data = await fetchJson(url);
    if (!data || !data.openInterest) return { openInterest: 0, oiChange24h: 0 };
    return { openInterest: parseFloat(data.openInterest), oiChange24h: 0 };
  }

  async fetchFundingRate(symbol: string): Promise<{ rate: number; nextTime: number }> {
    const data = await fetchJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`);
    if (!Array.isArray(data) || data.length === 0) return { rate: 0, nextTime: 0 };
    return { rate: parseFloat(data[0].fundingRate), nextTime: data[0].fundingTime };
  }

  async fetchLongShortRatio(symbol: string): Promise<{ ratio: number; longPct: number; shortPct: number }> {
    const data = await fetchJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`);
    if (!Array.isArray(data) || data.length === 0) return { ratio: 1.0, longPct: 50, shortPct: 50 };
    return { ratio: parseFloat(data[0].longShortRatio), longPct: parseFloat(data[0].longAccount), shortPct: parseFloat(data[0].shortAccount) };
  }

  async snapshotSymbol(symbol: string): Promise<DerivativesSnapshot> {
    const [oi, fr, ls] = await Promise.all([
      this.fetchOpenInterest(symbol).catch(() => ({ openInterest: 0, oiChange24h: 0 })),
      this.fetchFundingRate(symbol).catch(() => ({ rate: 0, nextTime: 0 })),
      this.fetchLongShortRatio(symbol).catch(() => ({ ratio: 1.0, longPct: 50, shortPct: 50 })),
    ]);
    return { symbol, timestamp: Date.now(), openInterest: oi.openInterest, oiChange24h: oi.oiChange24h,
      fundingRate: fr.rate, longShortRatio: ls.ratio, longPct: ls.longPct, shortPct: ls.shortPct };
  }
}
