// src/exchanges/kalshi/kalshi_client.ts
//
// KALSHI EXCHANGE ADAPTER
//
// Replaces the Polymarket adapter. Kalshi is a CFTC-regulated event
// contract exchange — fully legal in the US, free API, real WebSocket
// orderbook, fiat settlement, RSA-PSS request signing.
//
// API Reference: https://trading-api.readme.kalshi.com/
// Demo Sandbox:  demo-api.kalshi.co (paper trading, no real money)
// Production:    api.elections.kalshi.com
//
// Authentication uses RSA-PSS (much simpler than Polymarket's EIP-712).
// You generate an RSA key pair in your Kalshi account settings, store the
// private key locally, and sign each request's timestamp+method+path.

import { createSign, createPrivateKey, type KeyObject } from "crypto";
import { readFileSync } from "fs";

// ── GLOBAL SPORTS MARKET EXCLUSION ──
// Massachusetts legal constraint: Commonwealth v. KalshiEX preliminary injunction
// blocks sports event contracts. This filter is hardcoded and cannot be disabled
// via config, env var, or dashboard toggle. The only way to change it is a code
// change requiring a redeploy.
// Precise sports league prefixes + KXMVE (multi-variable events, currently all sports).
// Category="Sports" check in isExcludedMarket() is the primary filter.
// These patterns are belt-and-suspenders for the placeOrder() guard.
// IMPORTANT: Do NOT add broad wildcards like KX.*GAME, KX.*WINS etc. —
// they false-positive on non-sports markets (Oscar scores, election wins, etc.)
const SPORTS_TICKER_PATTERNS = [
  /^KXNBA/i,
  /^KXNFL/i,
  /^KXMLB/i,
  /^KXNHL/i,
  /^KXNCAA/i,
  /^KXMVE/i,        // Multi-variable events — currently all sports on Kalshi
  /^KXSPORTS/i,     // Explicit sports prefix
];

const loggedExclusions = new Set<string>();

export function isExcludedMarket(ticker: string, category?: string, eventTicker?: string): boolean {
  // Check category
  if (category && /^sports$/i.test(category)) return true;

  // Check ticker patterns
  const t = ticker || "";
  for (const pattern of SPORTS_TICKER_PATTERNS) {
    if (pattern.test(t)) return true;
  }

  // Check event_ticker patterns (series-level exclusion)
  const et = eventTicker || "";
  for (const pattern of SPORTS_TICKER_PATTERNS) {
    if (pattern.test(et)) return true;
  }

  return false;
}

function filterAndLogExclusions(markets: KalshiMarket[]): KalshiMarket[] {
  return markets.filter(m => {
    if (isExcludedMarket(m.ticker, m.category, m.event_ticker)) {
      if (!loggedExclusions.has(m.ticker)) {
        loggedExclusions.add(m.ticker);
        console.log(`[Filter] Excluded sports market: ${m.ticker}`);
      }
      return false;
    }
    return true;
  });
}

export type KalshiEnvironment = "demo" | "production";

export interface KalshiConfig {
  environment: KalshiEnvironment;
  apiKeyId: string;
  privateKeyPath: string;
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: string;
  title: string;
  subtitle?: string;
  yes_sub_title: string;
  no_sub_title: string;
  open_time: string;
  close_time: string;
  expected_expiration_time: string;
  status: "active" | "closed" | "settled";
  // V2 API uses dollar-denominated string fields
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  no_bid_dollars: string;
  no_ask_dollars: string;
  last_price_dollars: string;
  previous_yes_bid_dollars: string;
  previous_yes_ask_dollars: string;
  previous_price_dollars: string;
  volume_fp: string;
  volume_24h_fp: string;
  liquidity_dollars: string;
  open_interest_fp: string;
  result: string;
  category?: string;
  // Convenience getters (computed) — rounded to cents
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  // Sub-cent precision (dollar values) for turbo markets
  yes_bid_precise: number;
  yes_ask_precise: number;
  no_bid_precise: number;
  no_ask_precise: number;
  volume: number;
  volume_24h: number;
}

export interface KalshiOrderBook {
  yes: Array<[number, number]>; // [price_cents, quantity]
  no: Array<[number, number]>;
}

export interface KalshiOrderRequest {
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  type: "limit" | "market";
  count: number;             // Number of contracts
  yes_price?: number;        // Cents (0-99) for limit orders on YES
  no_price?: number;         // Cents (0-99) for limit orders on NO
  expiration_ts?: number;    // Optional: when order expires (unix seconds)
  client_order_id?: string;  // Idempotency key
  post_only?: boolean;       // Maker-only (avoids taker fees)
}

export interface KalshiOrderResponse {
  order: {
    order_id: string;
    user_id: string;
    ticker: string;
    status: "resting" | "canceled" | "executed" | "pending";
    yes_price?: number;
    no_price?: number;
    action: string;
    side: string;
    type: string;
    remaining_count: number;
    placed_time: string;
    last_update_time: string;
  };
}

export interface KalshiPosition {
  ticker: string;
  market_exposure: number;   // Cents
  position: number;          // Net contracts (positive = YES, negative = NO)
  realized_pnl: number;      // Cents
  fees_paid: number;         // Cents
  total_traded: number;
  resting_orders_count: number;
}

export interface KalshiBalance {
  balance: number;           // Cents
  payout: number;
}

const BASE_URLS: Record<KalshiEnvironment, string> = {
  demo: "https://demo-api.kalshi.co",
  production: "https://api.elections.kalshi.com",
};

const API_PREFIX = "/trade-api/v2";

export class KalshiClient {
  private baseUrl: string;
  private apiKeyId: string;
  private privateKey: KeyObject;

  constructor(config: KalshiConfig) {
    this.baseUrl = BASE_URLS[config.environment];
    this.apiKeyId = config.apiKeyId;
    const keyPem = readFileSync(config.privateKeyPath, "utf-8");
    this.privateKey = createPrivateKey({ key: keyPem, format: "pem" });
  }

  // ── RSA-PSS request signing ──
  // Kalshi requires signing: timestamp + method + FULL path (including /trade-api/v2 prefix)
  // Query parameters must be stripped before signing.
  private signRequest(method: string, path: string): { headers: Record<string, string> } {
    const timestamp = Date.now().toString();
    const fullPath = `${API_PREFIX}${path}`.split("?")[0];
    const messageToSign = `${timestamp}${method}${fullPath}`;
    const signer = createSign("sha256");
    signer.update(messageToSign);
    signer.end();
    const signature = signer.sign({
      key: this.privateKey,
      padding: 6, // RSA_PKCS1_PSS_PADDING
      saltLength: 32, // DIGEST_LENGTH for SHA-256
    });

    return {
      headers: {
        "KALSHI-ACCESS-KEY": this.apiKeyId,
        "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "Content-Type": "application/json",
      },
    };
  }

  // ── Generic authenticated request with retry ──
  private async request<T>(method: string, path: string, body?: any): Promise<T> {
    const maxRetries = method === "GET" ? 3 : 1; // Only retry idempotent reads
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { headers } = this.signRequest(method, path);
        const url = `${this.baseUrl}${API_PREFIX}${path}`;

        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15000),
        });

        // Rate limited — back off and retry
        if (res.status === 429 && attempt < maxRetries) {
          const retryAfter = parseInt(res.headers.get("retry-after") ?? "5");
          console.log(`  ⏳ Kalshi rate limited, waiting ${retryAfter}s...`);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          continue;
        }

        // Server error — retry after exponential backoff
        if (res.status >= 500 && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.log(`  ⚠️ Kalshi ${res.status} on ${method} ${path.split("?")[0]}, retry in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Kalshi ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
        }

        return res.json() as Promise<T>;
      } catch (err: any) {
        lastError = err;
        // Network errors / timeouts — retry on GET
        if (attempt < maxRetries && method === "GET" && (err.name === "TimeoutError" || err.name === "AbortError" || err.code === "ECONNRESET" || err.code === "ENOTFOUND" || err.message?.includes("fetch failed"))) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.log(`  ⚠️ Kalshi ${err.name || err.code} on ${method} ${path.split("?")[0]}, retry in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error(`Kalshi request failed after ${maxRetries + 1} attempts`);
  }

  // ── Public market data (no auth required, but signing doesn't hurt) ──
  async getMarkets(opts: {
    limit?: number;
    cursor?: string;
    event_ticker?: string;
    series_ticker?: string;
    status?: string;
    tickers?: string[];
  } = {}): Promise<{ markets: KalshiMarket[]; cursor: string }> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.event_ticker) params.set("event_ticker", opts.event_ticker);
    if (opts.series_ticker) params.set("series_ticker", opts.series_ticker);
    if (opts.status) params.set("status", opts.status);
    if (opts.tickers) params.set("tickers", opts.tickers.join(","));

    const path = `/markets?${params.toString()}`;
    const raw = await this.request<{ markets: any[]; cursor: string }>("GET", path);
    const parsed = raw.markets.map(parseKalshiMarket);
    return { cursor: raw.cursor, markets: filterAndLogExclusions(parsed) };
  }

  async getMarket(ticker: string): Promise<{ market: KalshiMarket }> {
    if (isExcludedMarket(ticker)) {
      if (!loggedExclusions.has(ticker)) {
        loggedExclusions.add(ticker);
        console.log(`[Filter] Excluded sports market: ${ticker}`);
      }
      throw new Error(`Market ${ticker} is excluded (sports)`);
    }
    const raw = await this.request<{ market: any }>("GET", `/markets/${ticker}`);
    const market = parseKalshiMarket(raw.market);
    if (isExcludedMarket(market.ticker, market.category, market.event_ticker)) {
      if (!loggedExclusions.has(market.ticker)) {
        loggedExclusions.add(market.ticker);
        console.log(`[Filter] Excluded sports market: ${market.ticker}`);
      }
      throw new Error(`Market ${market.ticker} is excluded (sports)`);
    }
    return { market };
  }

  async getEvents(opts: {
    limit?: number;
    cursor?: string;
    status?: "active" | "closed" | "settled";
    series_ticker?: string;
    with_nested_markets?: boolean;
  } = {}): Promise<any> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.status) params.set("status", opts.status);
    if (opts.series_ticker) params.set("series_ticker", opts.series_ticker);
    if (opts.with_nested_markets) params.set("with_nested_markets", "true");

    return this.request("GET", `/events?${params.toString()}`);
  }

  // ── Fetch all non-sports markets via events endpoint ──
  // The default /markets listing is flooded with thousands of KXMVE sports
  // markets. The events endpoint groups by category, so we can skip Sports
  // and collect everything else in a few paginated calls.
  async getAllNonSportsMarkets(): Promise<KalshiMarket[]> {
    const EXCLUDED_CATEGORIES = new Set(["Sports"]);
    const allMarkets: KalshiMarket[] = [];
    let cursor = "";
    const maxPages = 8;

    for (let page = 0; page < maxPages; page++) {
      const result = await this.getEvents({
        limit: 100,
        cursor: cursor || undefined,
        with_nested_markets: true,
      });

      const events = result.events ?? [];
      if (events.length === 0) break;

      for (const event of events) {
        const category = event.category ?? "";
        if (EXCLUDED_CATEGORIES.has(category)) continue;
        // Also skip KXMVE event tickers (sports multi-variable events)
        if ((event.event_ticker ?? "").startsWith("KXMVE")) continue;

        for (const rawMarket of event.markets ?? []) {
          const parsed = parseKalshiMarket(rawMarket);
          if (!isExcludedMarket(parsed.ticker, parsed.category, parsed.event_ticker)) {
            allMarkets.push(parsed);
          }
        }
      }

      cursor = result.cursor ?? "";
      if (!cursor) break;
    }

    return allMarkets;
  }

  async getOrderbook(ticker: string, depth = 10): Promise<{ orderbook: KalshiOrderBook }> {
    return this.request("GET", `/markets/${ticker}/orderbook?depth=${depth}`);
  }

  async getMarketCandles(ticker: string, opts: {
    series_ticker: string;
    start_ts?: number;
    end_ts?: number;
    period_interval?: number; // 1, 60, 1440 minutes
  }): Promise<any> {
    const params = new URLSearchParams();
    params.set("series_ticker", opts.series_ticker);
    if (opts.start_ts) params.set("start_ts", String(opts.start_ts));
    if (opts.end_ts) params.set("end_ts", String(opts.end_ts));
    if (opts.period_interval) params.set("period_interval", String(opts.period_interval));
    return this.request("GET", `/series/${opts.series_ticker}/markets/${ticker}/candlesticks?${params.toString()}`);
  }

  // ── Authenticated trading endpoints ──
  async getBalance(): Promise<KalshiBalance> {
    return this.request("GET", "/portfolio/balance");
  }

  async getPositions(opts: { limit?: number; status?: string } = {}): Promise<{ positions: KalshiPosition[] }> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.status) params.set("status", opts.status);
    return this.request("GET", `/portfolio/positions?${params.toString()}`);
  }

  async placeOrder(order: KalshiOrderRequest): Promise<KalshiOrderResponse> {
    // Belt-and-suspenders: block sports orders even if market filter was somehow bypassed
    if (isExcludedMarket(order.ticker)) {
      console.log(`[Filter] BLOCKED order on excluded sports market: ${order.ticker}`);
      throw new Error(`Order blocked: ${order.ticker} is an excluded sports market`);
    }
    return this.request("POST", "/portfolio/orders", order);
  }

  async cancelOrder(orderId: string): Promise<any> {
    return this.request("DELETE", `/portfolio/orders/${orderId}`);
  }

  async getOrders(opts: { ticker?: string; status?: string; limit?: number } = {}): Promise<any> {
    const params = new URLSearchParams();
    if (opts.ticker) params.set("ticker", opts.ticker);
    if (opts.status) params.set("status", opts.status);
    if (opts.limit) params.set("limit", String(opts.limit));
    return this.request("GET", `/portfolio/orders?${params.toString()}`);
  }

  async getFills(opts: { ticker?: string; limit?: number } = {}): Promise<any> {
    const params = new URLSearchParams();
    if (opts.ticker) params.set("ticker", opts.ticker);
    if (opts.limit) params.set("limit", String(opts.limit));
    return this.request("GET", `/portfolio/fills?${params.toString()}`);
  }
}

// ── Parse raw API response into typed KalshiMarket ──
function parseKalshiMarket(raw: any): KalshiMarket {
  const yesBid = parseFloat(raw.yes_bid_dollars ?? "0");
  const yesAsk = parseFloat(raw.yes_ask_dollars ?? "0");
  const noBid = parseFloat(raw.no_bid_dollars ?? "0");
  const noAsk = parseFloat(raw.no_ask_dollars ?? "0");
  // Use Math.round for cent-precision, but also store raw dollar values for sub-cent markets
  return {
    ...raw,
    yes_bid: Math.round(yesBid * 100),
    yes_ask: Math.round(yesAsk * 100),
    no_bid: Math.round(noBid * 100),
    no_ask: Math.round(noAsk * 100),
    // Sub-cent precision for turbo markets (0.1¢ increments)
    yes_bid_precise: yesBid,
    yes_ask_precise: yesAsk,
    no_bid_precise: noBid,
    no_ask_precise: noAsk,
    volume: parseFloat(raw.volume_fp ?? "0"),
    volume_24h: parseFloat(raw.volume_24h_fp ?? "0"),
  };
}

// ── Helper: convert cents to probability (0-1) ──
export function centsToProbability(cents: number): number {
  return cents / 100;
}

// ── Helper: convert probability to cents (1-99) ──
export function probabilityToCents(prob: number): number {
  return Math.max(1, Math.min(99, Math.round(prob * 100)));
}

// ── Helper: convert Kalshi market to unified Market interface ──
export function kalshiMarketToUnified(km: KalshiMarket) {
  const yesPrice = km.yes_bid + km.yes_ask > 0
    ? (km.yes_bid + km.yes_ask) / 2 / 100
    : parseFloat((km as any).last_price_dollars ?? "0.50");
  const noPrice = km.no_bid + km.no_ask > 0
    ? (km.no_bid + km.no_ask) / 2 / 100
    : 1 - yesPrice;
  return {
    condition_id: km.ticker,
    question: km.title,
    description: km.subtitle ?? km.yes_sub_title,
    category: km.category ?? km.event_ticker.split("-")[0],
    volume: km.volume_24h,
    yes_price: yesPrice,
    no_price: noPrice,
    yes_token_id: `${km.ticker}-yes`,
    no_token_id: `${km.ticker}-no`,
    end_date: km.close_time || km.expected_expiration_time,
    raw: km,
  };
}
