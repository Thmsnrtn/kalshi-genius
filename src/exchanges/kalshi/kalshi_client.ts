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
  subtitle: string;
  yes_sub_title: string;
  no_sub_title: string;
  open_time: string;
  close_time: string;
  expected_expiration_time: string;
  status: "active" | "closed" | "settled";
  yes_bid: number;          // Cents 0-100
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  previous_yes_bid: number;
  previous_yes_ask: number;
  volume: number;
  volume_24h: number;
  liquidity: number;
  open_interest: number;
  result: string;
  category: string;
  // Subpenny pricing in dollars
  yes_price_dollars?: string;
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

const HOSTS: Record<KalshiEnvironment, string> = {
  demo: "https://demo-api.kalshi.co/trade-api/v2",
  production: "https://api.elections.kalshi.com/trade-api/v2",
};

export class KalshiClient {
  private host: string;
  private apiKeyId: string;
  private privateKey: KeyObject;

  constructor(config: KalshiConfig) {
    this.host = HOSTS[config.environment];
    this.apiKeyId = config.apiKeyId;
    const keyPem = readFileSync(config.privateKeyPath, "utf-8");
    this.privateKey = createPrivateKey({ key: keyPem, format: "pem" });
  }

  // ── RSA-PSS request signing ──
  // Kalshi requires the timestamp + HTTP method + path to be signed
  // and sent in the KALSHI-ACCESS-* headers.
  private signRequest(method: string, path: string): { headers: Record<string, string> } {
    const timestamp = Date.now().toString();
    const messageToSign = `${timestamp}${method}${path}`;
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

  // ── Generic authenticated request ──
  private async request<T>(method: string, path: string, body?: any): Promise<T> {
    const { headers } = this.signRequest(method, path);
    const url = `${this.host}${path}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kalshi ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Public market data (no auth required, but signing doesn't hurt) ──
  async getMarkets(opts: {
    limit?: number;
    cursor?: string;
    event_ticker?: string;
    series_ticker?: string;
    status?: "active" | "closed" | "settled";
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
    return this.request<{ markets: KalshiMarket[]; cursor: string }>("GET", path);
  }

  async getMarket(ticker: string): Promise<{ market: KalshiMarket }> {
    return this.request("GET", `/markets/${ticker}`);
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
  const yesPrice = (km.yes_bid + km.yes_ask) / 2 / 100; // Mid-price in dollars
  const noPrice = (km.no_bid + km.no_ask) / 2 / 100;
  return {
    condition_id: km.ticker,
    question: km.title,
    description: km.subtitle,
    category: km.category,
    volume: km.volume_24h,
    yes_price: yesPrice,
    no_price: noPrice,
    yes_token_id: `${km.ticker}-yes`,
    no_token_id: `${km.ticker}-no`,
    end_date: km.expected_expiration_time,
    raw: km,
  };
}
