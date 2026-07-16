# Exchange API Rate Limits and Colocation Strategy

**Date:** 2026-07-15
**Status:** Research Complete
**Scope:** Top 10 centralized crypto exchanges + Aster DEX on-chain execution
**Relevance:** Anavitrade trading platform (Cloudflare Workers + Aster DEX)

---

## Executive Summary

- **Rate limits are not a bottleneck for Anavitrade's current scale.** The platform generates approximately 1 signal per minute and 5-10 orders per day. Even the most restrictive exchange (OKX public endpoints at 10 req/s) provides ~600x headroom over peak demand.
- **Binance offers the most generous limits** (1,200 weight/min, 100 weight/sec) and the richest WebSocket infrastructure (1,024 streams/connection). Bybit is close behind at 50 REST req/s. These two exchanges alone cover the majority of signal-based trading needs at 10-100x typical bot scale.
- **Colocation is unnecessary at current latency requirements.** Anavitrade operates on minute-scale signals, not microsecond arbitrage. Cloudflare Workers' global edge network provides adequate latency (< 100ms to most exchange API endpoints). If sub-10ms latency ever becomes necessary (e.g., for liquidation hunting or CEX-DEX arbitrage), the answer is to colocate on AWS us-east-1 near Binance, not to chase chain RPCs.
- **The rate limiting model that matters is order-rate limits, not data-polling limits.** For a signal-based strategy placing 5-10 orders/day, even the tightest order rate limit (OKX at 60 private req/2s) is irrelevant. The binding constraint is signal quality, not API throughput.
- **Aster DEX (on-chain) has no rate limits** in the traditional sense -- only gas/block space constraints and RPC reliability. This is both an advantage (no centralized throttling) and a risk (congestion pricing during high-traffic events).

---

## Exchange Rate Limit Comparison Table

| Exchange | REST Limit (Public) | REST Limit (Private/Trading) | Order Rate Limit | WebSocket Connections | WebSocket Subscriptions | Rate Limit Model |
|---|---|---|---|---|---|---|
| **Binance** | 1,200 weight/min, 100 weight/sec | Same (IP-based) | 50 orders/10s, 100k/24h | 300 conn/5min per IP | 1,024 streams/conn | Weight-based per IP |
| **Bybit** | 50 req/s | 50 req/s (default), higher for Pro | 20 orders/s (create+amend+cancel) | Not publicly capped | Per-endpoint limits | Fixed req/s per API key |
| **OKX** | 20 req/2s (10 req/s) | 60 req/2s (30 req/s) | Same as private | ~240 connections | 480 subscriptions | Tiered by VIP level |
| **Coinbase Advanced Trade** | 10 req/s per IP | 30 req/s per IP | Same as private | 1 conn per API key | 250 channels/socket | Fixed req/s per IP |
| **Kraken** | Decaying counter (faster recovery) | Decaying counter (slower recovery) | Separate matching engine limit | ~150 conn | ~60 subscriptions | Decaying counter system |
| **KuCoin** | 30 req/3s (10 req/s) | Same, higher for VIP | Same as private | Not publicly documented | Not publicly documented | Fixed req/s |
| **Bitget** | 20 req/s | 20 req/s | 10 orders/s | Configurable | Per-channel limits | Fixed req/s |
| **Gate.io** | 200 req/s (public UID) | 50 req/s (private UID) | 20 orders/s | Configurable | Per-channel limits | UID-based |
| **MEXC** | 20 req/s | 20 req/s (50 per 2s) | Same as private | Not publicly documented | Per-channel limits | Fixed req/s |

**Key Insight:** Binance and Bybit lead in both raw throughput and WebSocket capabilities. OKX, Kraken, and Coinbase are more conservative but still provide orders of magnitude more capacity than a retail signal-based bot requires.

---

## Detailed Exchange Analysis

### Binance

**REST API Limits (Spot, as of mid-2026)**

Binance uses a dual-layer rate limiting system: weight-based and raw request count.

| Limit Type | Value | Scope |
|---|---|---|
| Request weight (per minute) | 1,200 | Per IP |
| Request weight (per second) | 100 | Per IP |
| RAW_REQUESTS (per 5 min) | 61,000 | Per IP |
| Orders (per 10 seconds) | 50 | Per account |
| Orders (per 24 hours) | 100,000 | Per account |

Endpoint weights vary. A typical order placement (POST `/api/v3/order`) costs 1 weight. A depth snapshot (GET `/api/v3/depth?limit=100`) costs 5 weight. A kline query (GET `/api/v3/klines`) costs 1-2 weight depending on the number of candles requested.

**What 1,200 weight/min means in practice:**
- 1,200 order placements per minute (at 1 weight each)
- 240 depth snapshots per minute (at 5 weight each)
- Anavitrade at 1 signal/min: uses at most 5-10 weight/min (for price check + order placement)

**WebSocket Limits:**
- 1,024 streams per WebSocket connection
- 300 connection attempts per 5 minutes per IP address
- Maximum 200 combined stream connections (Spot + Futures)
- WebSocket order API: 10 orders per second

**Rate Limit Headers:**
Binance returns `X-MBX-USED-WEIGHT-1M`, `X-MBX-ORDER-COUNT-1M`, etc. in response headers, enabling real-time client-side tracking.

**IP-Based Rate Limiting:**
Critical detail: Binance rate limits are per IP, not per API key. This means a Cloudflare Worker (which shares egress IPs with other Workers on the same plan) could theoretically be rate-limited by another tenant. However, at 1 signal/min, this is a non-issue. For production at higher scale, Cloudflare Workers' paid plans offer static outbound IPs (via Cloudflare's "egress IP" feature).

**Sources:** [[Binance API Docs - Limits](https://developers.binance.com/legacy-docs/binance-spot-api-docs/rest-api/limits), [Binance Rate Limits - APIs.io](https://apis.io/rate-limits/binance/binance-rate-limits/), [GoCryptoTrader rate_limiter](https://github.com/thrasher-corp/gocryptotrader/blob/7e0257651955/exchanges/binance/ratelimit.go#L99)]

---

### Bybit

**REST API Limits (V5, as of mid-2026)**

Bybit uses a simpler fixed request-per-second model, which is easier to reason about than Binance's weight system.

| Limit Type | Value | Scope |
|---|---|---|
| REST requests (per second) | 50 | Per API key |
| Order create/amend/cancel (per second) | 20 (combined) | Per API key |
| Order queries (per second) | 50 | Per API key |

**Tier Structure:**
- **Default/Non-VIP:** 50 req/s for most endpoints
- **Pro users:** Can request custom rate limits via the API (using the rate limit management endpoints)
- **Market Makers:** Higher limits available through application

**Key Feature:** Bybit exposes rate limit query APIs (`GET /v5/market/rate-limit-cap`, `GET /v5/market/rate-limit`) so clients can programmatically check their current limits and usage.

**WebSocket:**
- Separate rate limits apply per WebSocket connection
- Public channels have higher limits than private channels
- Ping/pong keep-alive required (20-second interval)

**For Anavitrade:**
50 req/s is overkill for 1 signal/min. Even a high-frequency bot placing 100 orders/day would use << 1% of the limit.

**Sources:** [[Bybit API Docs - Rate Limit](https://bybit-exchange.github.io/docs/v5/rate-limit), [Bybit Rate Limit Rules for Pros](https://bybit-exchange.github.io/docs/v5/rate-limit/rules-for-pros/introduction), [DexterTD Bybit Docs](https://dextertd.github.io/docs/v5/rate-limit#trade)]

---

### OKX

**REST API Limits (V5, as of mid-2026)**

OKX has the most restrictive base limits among Tier 1 exchanges, but VIP tiers unlock significantly more capacity.

| Limit Type | Value (Base) | Value (VIP 1-3) | Value (VIP 4+) |
|---|---|---|---|
| Public endpoints (per 2s) | 20 | 40-60 | 100+ |
| Private endpoints (per 2s) | 60 | 120-180 | 300+ |
| Order placement | Same as private | Same as private | Same as private |

**VIP Tier Progression:**
OKX VIP tiers are based on 30-day trading volume. VIP 1 requires ~$100K volume, VIP 4 requires ~$10M. A retail signal-based bot would operate at base tier.

**WebSocket:**
- Maximum of 240 connections
- 480 subscriptions per connection
- Separate rate limits for WebSocket order operations

**User Data Stream:**
OKX uses a user data stream model similar to Binance. The listenKey expires after 60 minutes if not pinged.

**For Anavitrade:**
At 1 signal/min, even the base tier (60 private requests per 2 seconds = 1,800 per minute) is ~1,800x our peak demand. OKX's restrictive reputation is only relevant for high-frequency scalpers and market makers.

**Sources:** [[OKX API Rate Limits](https://trading-strategies.academy/archives/47205), [Best Proxies for OKX API Trading](https://dataresearchtools.com/best-proxies-binance-bybit-okx-api-trading/)]

---

### Coinbase Advanced Trade

**REST API Limits (as of mid-2026)**

| Limit Type | Value | Scope |
|---|---|---|
| Public endpoints | 10 req/s | Per IP |
| Private endpoints | 30 req/s | Per IP |
| Order placement | Included in private | Per IP |
| WebSocket channels | 250 per socket | Per connection |

**Rate Limit Model:**
Coinbase uses a simple token-bucket model. Public endpoints are more restrictive (10 req/s) than private endpoints (30 req/s). This is unusual -- most exchanges are stricter on private/order endpoints than public ones.

**WebSocket:**
- 1 connection per API key
- 250 active channels per WebSocket connection
- Channel subscriptions count against the limit
- Dedicated rate limits for WebSocket order operations

**For Anavitrade:**
30 private req/s = 1,800 requests per minute. At 1 signal/min, we use < 0.1% of capacity.

**Sources:** [[Coinbase Advanced Trade Rate Limits](https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/websocket/websocket-rate-limits), [Coinbase Rate Limits Overview](https://docs.cdp.coinbase.com/exchange/introduction/rate-limits-overview)]

---

### Kraken

**REST API Limits (as of mid-2026)**

Kraken uses a unique "decaying counter" model rather than fixed requests-per-second. Each API call decreases a counter by a specific "cost" value, and the counter recovers at a fixed rate per second. When the counter hits 0, further requests receive HTTP 429.

| Tier | Counter Start | Recovery Rate | Typical Calls Before Exhaustion |
|---|---|---|---|
| Public API | ~15-20 | ~1/sec | 15-20 quick calls, then wait |
| Private API (Tier 2) | ~10-15 | ~0.5/sec | 10-15 calls, slower recovery |
| Private API (Tier 3+) | ~20+ | ~1-2/sec | Higher volume |

**Matching Engine Limits (Orders):**
Separate from the REST counter system, the matching engine has its own rate limits:
- Spot orders: Limited by matching engine capacity (varies by pair liquidity)
- Futures orders: Separate limits per contract

**WebSocket:**
- 60 subscriptions per authenticated WebSocket connection
- ~150 maximum connections

**For Anavitrade:**
Kraken's decaying counter is the most restrictive model among Tier 1 exchanges. But even so, 10-15 API calls before exhaustion (with ~1/sec recovery) means we can place an order and check balances once per minute with zero issues.

**Sources:** [[Kraken Spot REST Rate Limits](https://docs.kraken.com/exchange/guides/rest/ratelimits#matching-engine-limits), [Kraken Spot Trading Limits](https://docs.kraken.com/exchange/guides/general/ratelimits)]

---

### Other Exchanges

#### KuCoin
- **REST:** ~30 requests per 3 seconds (10 req/s effective)
- **VIP Tiers:** Higher limits for VIP 1-5 (30-day volume based)
- **WebSocket:** Per-channel subscription limits
- **Notes:** KuCoin provides a dedicated rate limit query API (`GET /api/v1/api/rate-limit`)
- **For Anavitrade:** 10 req/s is 600 requests/min. Not a constraint.

**Sources:** [[KuCoin REST API Rate Limits](https://www.kucoin.com.tr/docs/basic-info/request-rate-limit/rest-api)]

#### Bitget
- **REST:** 20 requests per second
- **Order:** 10 orders per second
- **WebSocket:** Per-channel limits, configurable
- **Pro/MM tiers:** Higher limits available
- **For Anavitrade:** 20 req/s = 1,200 requests/min. More than sufficient.

**Sources:** [[Bitget API Rate Limits](https://www.bitget.com/wiki/bitget-api-rate-limits)]

#### Gate.io
- **REST Public:** Up to 200 req/s (UID-based)
- **REST Private:** 50 req/s (UID-based)
- **Order:** ~20 orders/s
- **Notes:** Gate.io uses UID-based (not IP-based) rate limiting, which is more Cloudflare-Worker-friendly
- **For Anavitrade:** No concerns at all.

**Sources:** [[Gate.io API v4](https://github.com/gateio/rest-v4)]

#### MEXC
- **REST:** 20 requests per second (50 requests per 2 seconds)
- **WebSocket:** Per-channel limits
- **Notes:** MEXC has less mature API infrastructure than Tier 1 exchanges.
- **For Anavitrade:** 20 req/s is adequate for any signal-based strategy.

**Sources:** [[MEXC API Introduction](https://www.mexc.io/api-docs/spot-v3/introduction)]

---

## WebSocket vs REST Polling Analysis

### Latency Comparison

| Method | Typical Latency | Data Freshness | Resource Cost | Rate Limit Consumption |
|---|---|---|---|---|
| REST Polling (1s interval) | 500-1000ms | Stale up to 1s | High (1 req/s) | 60 req/min per endpoint |
| REST Polling (10s interval) | 5-10s stale | Stale up to 10s | Moderate (0.1 req/s) | 6 req/min per endpoint |
| WebSocket Stream | < 100ms | Real-time | Low (persistent) | 1 stream slot |
| WebSocket User Data | < 100ms | Real-time | Low (persistent) | 1 listenKey |

### For Anavitrade Specifically

The platform uses Coinlegs for signal generation (external data source, Cloudflare Worker), not direct exchange data polling. The key API interactions are:

1. **Order placement** (REST POST to exchange) -- 5-10 times/day
2. **Order status check** (REST GET or WebSocket user data) -- 5-10 times/day
3. **Balance/position query** (REST) -- periodically

**Recommendation:** REST polling is sufficient. WebSocket adds complexity without benefit at this scale. If real-time order status updates become necessary (e.g., for TP/SL monitoring), use exchange-specific user data streams (WebSocket listenKey model used by Binance/OKX).

**Exchanges where WebSocket is worth it even at low frequency:**
- Binance (user data stream for order fills, easy to implement)
- Bybit (WebSocket is the recommended method for order status in V5 API)

**Exchanges where REST is fine:**
- Kraken, Coinbase, KuCoin, Bitget, Gate.io, MEXC (REST order status checks have negligible rate limit cost)

---

## Typical Trading Bot Needs vs. Limits

### Anavitrade's Current Scale

| Metric | Peak Value | Closest Rate Limit | Headroom |
|---|---|---|---|
| Signal frequency | 1 signal/min | OKX public: 10 req/s (600/min) | **600x** |
| Daily orders | 10 orders/day | Binance: 100,000/day | **10,000x** |
| Orders per second (burst) | 1 order | Bybit: 20 orders/s | **20x** |
| Balance checks | 1 per order | Kraken: ~10-15 calls before throttle | **10x** |
| Total REST req/min | ~2-5 req/min | Coinbase public: 600/min | **120x** |

### Scaling Projections

At what scale do rate limits become a concern?

| Bot Scale | Signals/min | Orders/day | First Bottleneck | At What Multiplier |
|---|---|---|---|---|
| Current (Anavitrade) | 1 | 5-10 | None | N/A |
| Moderate scaling | 5 | 50 | None | N/A |
| Aggressive scaling | 60 | 500 | Kraken counter limit for balance checks | 60x current |
| HFT/scalping | 600 | 5,000 | OKX public tier for data, Coinbase private for orders | 600x current |
| Market making | 3,600 | 50,000+ | Binance order limit (100k/day), Bybit order limit (20/s) | 3,600x current |

**Finding:** Rate limits become a practical concern only at 50-100x Anavitrade's current scale. Before reaching that point, signal quality, risk management, and exchange diversification are more pressing concerns.

### Comparison: What Rate Limits Actually Constrain

| Bot Type | What Matters | Example Bottleneck |
|---|---|---|
| Signal-based (Anavitrade) | Signal quality, not API | N/A -- rate limits are irrelevant |
| Grid bot | Order amendments/sec | Bybit 20 orders/s limit |
| Arbitrage bot | Data freshness + order speed | Cross-exchange latency, not rate limits |
| Market maker | Quote update frequency | Binance 50 orders/10s for tight spread pairs |
| Liquidation hunter | Sub-second data + order speed | Network latency, not rate limits |
| Portfolio rebalancer | Batch order throughput | Daily order caps on Kraken/OKX |

---

## Colocation Strategy Analysis

### The Fundamental Question

> Should we colocate near Binance (AWS us-east-1) or near Aster's chain RPC?

### Exchange Infrastructure Locations

| Exchange | Primary Cloud/Infra | Known Region | Notes |
|---|---|---|---|
| **Binance** | AWS | us-east-1 (Northern Virginia) | Well-known; many trading firms colocate here |
| **Bybit** | AWS (suspected) | us-east-1 / ap-northeast-1 | Less public about infra, but AWS dependency is confirmed |
| **OKX** | AWS + proprietary | ap-northeast-1 (Tokyo) + others | Multi-region, less centralized than Binance |
| **Coinbase** | AWS | us-east-1 | Same region as Binance for many services |
| **Kraken** | Proprietary DCs | Multiple regions | Less AWS-dependent |
| **Aster DEX** | On-chain (Solana/EVM) | Depends on validators | RPC proximity matters, not exchange colocation |

### Latency Budget Analysis

For Anavitrade's signal-based strategy (minute-scale), here is the latency budget:

| Component | Typical Latency | Tolerable? |
|---|---|---|
| Coinlegs signal detection | 1-5 minutes (scraper interval) | Yes -- this dominates all other latency |
| Signal processing in Worker | < 10ms | Yes |
| Exchange API call (REST) | 100-500ms | Yes -- negligible vs. signal interval |
| Order execution on exchange | 1-50ms | Yes -- market orders fill quickly |
| On-chain execution (Aster) | 1-15 seconds (block time) | Yes -- acceptable for non-HFT |

**Conclusion: Latency is not a bottleneck.** The binding constraint is Coinlegs signal generation, which operates on 1-5 minute intervals. Adding 100ms of network latency to an exchange API call changes nothing.

### Colocation Scenarios

#### Scenario A: Colocate near Binance (AWS us-east-1)

**When to do this:**
- If order submission latency must be < 10ms (e.g., CEX arbitrage, liquidation hunting)
- If running WebSocket streams for 50+ pairs simultaneously
- If doing high-frequency order amendments (market making)

**What it costs:**
- AWS EC2 instance in us-east-1: ~$50-200/month (c6i.large to c6i.xlarge)
- Additional infrastructure: VPC, NAT Gateway, load balancer

**What it buys:**
- < 1ms latency to Binance API (same region)
- < 50ms to Bybit/Coinbase (also us-east-1)
- Reliable WebSocket streaming (no cross-region disconnects)

**For Anavitrade at current scale: Overkill.**

#### Scenario B: Run on Cloudflare Workers (Current Architecture)

**What it provides:**
- Global edge network (300+ data centers)
- Automatic routing to nearest PoP
- No infrastructure management
- Free tier: 100,000 requests/day (easily covers our needs)

**Latency from Cloudflare edge to AWS us-east-1:**
- From Cloudflare Ashburn (IAD) PoP: ~1-2ms
- From Cloudflare Newark (EWR) PoP: ~5-10ms
- From Cloudflare London (LHR) PoP: ~70-90ms
- From Cloudflare Tokyo (NRT) PoP: ~150-180ms

**Key insight:** Anavitrade developers/users are likely in Europe/Asia. Cloudflare routes their traffic to the nearest PoP, but the outbound API call from the Worker to Binance (us-east-1) still crosses the Atlantic/Pacific. This adds 70-150ms of latency. For minute-scale signals, this is irrelevant.

#### Scenario C: Colocate near Aster DEX Chain RPC

**When to do this:**
- If executing on-chain trades where block inclusion speed matters
- If monitoring mempool for MEV protection
- If running a custom RPC node

**For Anavitrade:**
Aster DEX on-chain execution is not latency-sensitive at minute-scale signals. A 1-15 second block inclusion time is perfectly acceptable. RPC proximity matters for reliability (fewer dropped transactions) but not for speed.

**Recommendation:** Use a geographically diverse RPC provider (e.g., Helius for Solana, Alchemy for EVM chains) rather than self-hosting.

### Colocation Recommendation

**For current scale:** Cloudflare Workers are the right choice. Zero infrastructure overhead, adequate latency, and cost-effective on the free tier.

**For moderate scaling (10-50x current):** Stay on Cloudflare Workers. Upgrade to paid plan if needed for static egress IPs.

**For aggressive scaling (100x+ current, market making, or HFT):** Migrate order execution to a dedicated AWS us-east-1 instance. Keep signal generation and the frontend dashboard on Cloudflare Workers.

**For Aster DEX at any scale:** Use a high-quality RPC provider with global endpoints. Self-hosting an RPC node is not warranted unless doing MEV-sensitive operations.

---

## Rate Limit Management Strategy

### Architecture Principles

Even though rate limits are not a binding constraint today, implementing proper rate limit management early prevents issues at scale:

1. **Client-side rate limit tracking:** Every exchange adapter should track its own rate limit consumption using response headers (Binance's `X-MBX-USED-WEIGHT-1M`) or internal counters.

2. **Request queuing with backpressure:** When approaching limits, queue requests rather than immediately retry. Use exponential backoff with jitter.

3. **WebSocket-first for real-time data:** Use WebSocket streams for price data, order book updates, and user data (fills, order status) on exchanges that support it well (Binance, Bybit, OKX).

4. **Circuit breaker on 429:** If a 429 is received, pause all requests to that exchange for 1 second, then resume at reduced rate.

5. **Multi-exchange fan-out:** The existing architecture (fanning TradeIntent to all active CEX connections) is correct. If one exchange rate-limits, others continue unaffected.

### Implementation Plan (Priority Order)

| Priority | Feature | Complexity | When Needed |
|---|---|---|---|
| P0 | Response header parsing (track weight/counter) | Low | Now |
| P1 | Exponential backoff on 429 responses | Low | Now |
| P2 | Request queuing with rate-aware scheduler | Medium | 10x scale |
| P3 | WebSocket user data streams (Binance, Bybit) | Medium | 50x scale |
| P4 | Per-exchange rate limit metrics dashboard | Low | 10x scale |
| P5 | Predictive rate limiting (throttle before 429) | High | 100x scale |

### Code Pattern: Rate-Limited Request

```typescript
// Conceptual pattern for rate-limited exchange requests
async function rateLimitedRequest(
  adapter: ExchangeAdapter,
  endpoint: string,
  options: RequestOptions
): Promise<Response> {
  const limits = adapter.getRateLimits();
  
  // Check if we have capacity
  if (!limits.hasCapacity(endpoint)) {
    const waitMs = limits.timeUntilCapacity(endpoint);
    await sleep(waitMs + Math.random() * 100); // jitter
  }
  
  const response = await fetch(endpoint, options);
  
  // Update limits from response headers
  limits.update(response.headers);
  
  // Handle 429
  if (response.status === 429) {
    adapter.circuitBreak(1_000); // 1 second cooldown
    throw new RateLimitError(endpoint);
  }
  
  return response;
}
```

---

## Implications for Anavitrade

### 1. Exchange Adapter Design

Each exchange adapter in `src/server/execution/` should implement a `RateLimitManager` interface:

```typescript
interface RateLimitManager {
  hasCapacity(endpoint: string): boolean;
  timeUntilCapacity(endpoint: string): number;
  consume(endpoint: string, weight: number): void;
  update(responseHeaders: Headers): void;
  reset(): void;
}
```

### 2. Exchange Selection Priority

Based on rate limit generosity and API quality, the recommended exchange integration order is:

| Priority | Exchange | Reason |
|---|---|---|
| 1 | **Binance** | Best limits, best WebSocket, largest liquidity |
| 2 | **Bybit** | Clean V5 API, good limits, programmatic rate limit queries |
| 3 | **Aster DEX** | Already integrated, no rate limits (on-chain) |
| 4 | OKX | Tier 1 but more restrictive base limits |
| 5 | Coinbase | Good API, US-regulated, complementary to Binance |
| 6 | Kraken | Unique counter model, good for diversification |
| 7 | KuCoin | Wide token coverage, moderate limits |
| 8 | Bitget/Gate.io/MEXC | Long-tail exchanges, integrate only if needed for specific pairs |

### 3. Cloudflare Worker Limitations

Cloudflare Workers have their own constraints:

| Limit | Free Tier | Paid Tier | Relevant? |
|---|---|---|---|
| CPU time per request | 10ms | 30-400ms (varies by plan) | No -- exchange API calls are I/O bound |
| Subrequests | 50 per request | 1,000 per request | No -- at 2-5 req/min |
| Duration (Wall clock) | No hard limit | No hard limit (but 30s CPU for Workers Paid) | No |
| Concurrent connections | ~6 per Worker | Higher tiers available | Potentially relevant at scale |

The key Worker constraint for trading is **outbound concurrency**. A single Worker can only maintain ~6 concurrent outbound connections. At 1 signal/min, this is never reached. At 100 signals/min fanning to 5 exchanges simultaneously, it could become a bottleneck. The fix at that scale is to use Cloudflare Queues for fan-out or run a dedicated execution service outside Workers.

### 4. Egress IP Strategy

Binance rate limits are per IP. Cloudflare Workers share egress IPs. At current scale this is fine. At higher scale:

- **Cloudflare Paid Plan:** Offers dedicated egress IPs (via their "egress IP" add-on)
- **Alternative:** Route high-frequency exchange traffic through a dedicated EC2 instance with a static IP
- **Alternative:** Use a proxy service like QuotaGuard Static IPs

### 5. Testing and Monitoring

Implement rate limit usage monitoring from day one, even if limits are far from being reached:

```
Rate Limit Dashboard (per exchange):
- Current usage % (last 1 min)
- Peak usage % (last 24h)
- 429 count (last 24h)
- Average latency (ms)
- WebSocket connection status
```

This provides early warning if traffic patterns change (e.g., a new signal source generates 100 signals/min instead of 1/min).

---

## Risks and Caveats

### 1. Exchange Rate Limit Changes

Exchanges change rate limits without notice. Binance has historically adjusted weight values for specific endpoints. Mitigation: use rate limit response headers (where available) to dynamically adapt, rather than hardcoding values.

### 2. Cloudflare Worker Shared Egress IP

If another Cloudflare Worker tenant (on the same plan and PoP) aggressively hits Binance, our Worker could be collateral damage in an IP-based rate limit. **Probability: Very low** at current scale, but worth monitoring. Mitigation: upgrade to a plan with dedicated egress IP if this becomes an issue.

### 3. Exchange API Deprecation

Exchanges deprecate API versions. Binance has deprecated the v1 Spot API; Bybit migrated from V3 to V5. Mitigation: subscribe to exchange API changelogs, version pin all SDK dependencies.

### 4. Order Rate Limits Are the Real Binding Constraint

For any strategy that scales beyond 100 orders/day, order rate limits (not data rate limits) become the constraint. Binance's 50 orders/10s is generous; Kraken's matching engine limits are less transparent. Mitigation: design order dispatch to spread orders over time rather than bursting.

### 5. On-Chain Congestion (Aster DEX)

Aster DEX has no centralized rate limits but is subject to chain congestion. Solana has historically experienced degraded performance during NFT mints and high-traffic events. EVM chains face gas price spikes. Mitigation: use priority fees when needed, monitor chain health, have a fallback to CEX execution.

### 6. Speculation Acknowledgment

Some rate limit details in this document are based on documentation and community sources that may be outdated. Specific numbers to verify before production use:
- Kraken's exact counter values (varies by verification tier)
- OKX VIP tier progression rates (subject to change)
- Gate.io and MEXC WebSocket limits (less publicly documented)

**Recommendation:** Verify all rate limits against the current exchange API documentation during integration, not from this research document alone.

---

## Recommendation

1. **Continue with Cloudflare Workers for execution.** No colocation needed at current scale. The ~100ms latency from Cloudflare edge to AWS us-east-1 is negligible for minute-scale signals.

2. **Integrate exchanges in priority order:** Binance first, then Bybit, then additional CEXs as needed. Each integration should include a `RateLimitManager` implementation even if we never approach limits.

3. **Implement basic rate limit tracking now** (response header parsing, 429 backoff). This is low effort (< 50 lines per adapter) and prevents future technical debt.

4. **Use WebSocket user data streams for Binance and Bybit** (order status, fills). This is the recommended pattern by both exchanges and eliminates polling.

5. **Re-evaluate colocation at 100x current scale.** The threshold is approximately 100 signals/min and 500+ orders/day. At that point, move execution to a dedicated AWS us-east-1 instance.

6. **For Aster DEX, use a managed RPC provider** (Helius for Solana, Alchemy/QuickNode for EVM chains). Self-hosting an RPC node is not warranted.

7. **Document rate limits in each exchange adapter's source code.** Future developers should not need to re-read this document to understand the limits they're working with.

---

## Sources

1. Binance API Documentation - Limits and Rate Limiting: https://developers.binance.com/legacy-docs/binance-spot-api-docs/rest-api/limits
2. Binance Rate Limits (APIs.io): https://apis.io/rate-limits/binance/binance-rate-limits/
3. Binance Developer Community - Rate Limit Discussions: https://dev.binance.vision/t/rate-limits-calculated-wrongly/6340
4. Binance WebSocket Order Limits Discussion: https://dev.binance.vision/t/due-to-websocket-api-limits-can-only-10-orders-per-second-be-sent/27262
5. Bybit API V5 Rate Limit Documentation: https://bybit-exchange.github.io/docs/v5/rate-limit
6. Bybit Rate Limit Rules for Pro Users: https://bybit-exchange.github.io/docs/v5/rate-limit/rules-for-pros/introduction
7. Bybit Rate Limit - DexterTD Mirror: https://dextertd.github.io/docs/v5/rate-limit#trade
8. Bybit API Risk Limits Guide: https://trading-strategies.academy/archives/46769
9. OKX API Rate Limits Guide: https://trading-strategies.academy/archives/47205
10. Best Proxies for Binance, Bybit, and OKX API Trading: https://dataresearchtools.com/best-proxies-binance-bybit-okx-api-trading/
11. Coinbase Advanced Trade Rate Limits: https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/websocket/websocket-rate-limits
12. Coinbase Rate Limits Overview: https://docs.cdp.coinbase.com/exchange/introduction/rate-limits-overview
13. Kraken Spot REST Rate Limits: https://docs.kraken.com/exchange/guides/rest/ratelimits
14. Kraken Spot Trading Limits: https://docs.kraken.com/exchange/guides/general/ratelimits
15. Kraken Derivatives Rate Limits: https://docs.kraken.com/exchange/guides/futures/ratelimits
16. KuCoin REST API Rate Limits: https://www.kucoin.com.tr/docs/basic-info/request-rate-limit/rest-api
17. KuCoin API Rate Limits Guide: https://trading-strategies.academy/archives/47123
18. Bitget API Rate Limits: https://www.bitget.com/wiki/bitget-api-rate-limits
19. Gate.io API V4 on GitHub: https://github.com/gateio/rest-v4
20. MEXC API Introduction: https://www.mexc.io/api-docs/spot-v3/introduction
21. The Rate Limit Asymmetry Index: https://decentralised.news/rate-limit-asymmetry-index-crypto-exchange-api-trading
22. A Developer's Guide to Comparing Crypto Exchange APIs in 2026: https://dev.to/steven_hansen_04c7f869e72/a-developers-guide-to-comparing-crypto-exchange-apis-in-2026published-false-3nn0
23. Handling Crypto Exchange API Rate Limits Without Losing Your Mind: https://dev.to/kerryhank/handling-crypto-exchange-api-rate-limits-without-losing-your-mind-ag9
24. Crypto Trading Bots and API Rate Limiting: https://blockchain.news/flashnews/crypto-trading-bots-and-api-rate-limiting-why-politeness-prevents-429-errors-and-order-rejections
25. Binance AWS Latency Optimization (CSDN): https://blog.csdn.net/weixin_29219189/article/details/158826982
26. GoCryptoTrader Binance Rate Limit Implementation: https://github.com/thrasher-corp/gocryptotrader/blob/7e0257651955/exchanges/binance/ratelimit.go#L99
27. CCXT Binance Rate Limiter: https://docs.rs/ccxt-exchanges/latest/ccxt_exchanges/binance/rate_limiter/

---

## Document History

| Date | Change | Author |
|---|---|---|
| 2026-07-15 | Initial research and document creation | Claude (Opus 4.8) |
