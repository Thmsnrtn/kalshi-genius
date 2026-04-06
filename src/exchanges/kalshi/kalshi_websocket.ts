// src/exchanges/kalshi/kalshi_websocket.ts
//
// KALSHI WEBSOCKET CLIENT
//
// Real-time market data: orderbook deltas, ticker updates, trades, and
// fills. This is the equivalent of the Binance WebSocket feed but for
// Kalshi market data — and it's far better than what we had on Polymarket
// because it's a real exchange-grade WebSocket.
//
// Channels:
// - orderbook_delta: real-time orderbook updates per market
// - ticker: bid/ask/last price per market
// - trade: completed trades feed
// - fill: your fills (authenticated)
// - market_lifecycle: market open/close events

import WebSocket from "ws";
import { createSign, createPrivateKey, type KeyObject } from "crypto";
import { readFileSync } from "fs";

export type KalshiWsChannel = "orderbook_delta" | "ticker" | "trade" | "fill" | "market_lifecycle";

export interface KalshiWsConfig {
  environment: "demo" | "production";
  apiKeyId: string;
  privateKeyPath: string;
}

const WS_URLS = {
  demo: "wss://demo-api.kalshi.co/trade-api/ws/v2",
  production: "wss://api.elections.kalshi.com/trade-api/ws/v2",
};

export interface OrderbookSnapshot {
  ticker: string;
  yes: Array<[number, number]>; // [price, size] in cents
  no: Array<[number, number]>;
  timestamp: number;
}

export interface TickerUpdate {
  ticker: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  timestamp: number;
}

export class KalshiWebSocket {
  private ws: WebSocket | null = null;
  private apiKeyId: string;
  private privateKey: KeyObject;
  private url: string;
  private subscriptions = new Map<string, Set<string>>(); // channel -> tickers
  private orderbooks = new Map<string, OrderbookSnapshot>();
  private tickers = new Map<string, TickerUpdate>();
  private listeners = new Map<string, Array<(data: any) => void>>();
  private commandId = 1;
  private reconnectAttempts = 0;
  private connected = false;

  constructor(config: KalshiWsConfig) {
    this.apiKeyId = config.apiKeyId;
    const keyPem = readFileSync(config.privateKeyPath, "utf-8");
    this.privateKey = createPrivateKey({ key: keyPem, format: "pem" });
    this.url = WS_URLS[config.environment];
  }

  // ── Connect with auth headers ──
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timestamp = Date.now().toString();
      const messageToSign = `${timestamp}GET/trade-api/ws/v2`;
      const signer = createSign("sha256");
      signer.update(messageToSign);
      signer.end();
      const signature = signer.sign({
        key: this.privateKey,
        padding: 6,
        saltLength: 32,
      });

      this.ws = new WebSocket(this.url, {
        headers: {
          "KALSHI-ACCESS-KEY": this.apiKeyId,
          "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
          "KALSHI-ACCESS-TIMESTAMP": timestamp,
        },
      });

      this.ws.on("open", () => {
        console.log("✅ Kalshi WebSocket connected");
        this.connected = true;
        this.reconnectAttempts = 0;
        // Re-subscribe to existing channels
        for (const [channel, tickers] of this.subscriptions.entries()) {
          if (tickers.size > 0) {
            this.send({
              id: this.commandId++,
              cmd: "subscribe",
              params: { channels: [channel], market_tickers: Array.from(tickers) },
            });
          }
        }
        resolve();
      });

      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleMessage(msg);
        } catch (err: any) {
          console.error(`Kalshi WS message parse error: ${err.message}`);
        }
      });

      this.ws.on("error", (err) => {
        console.error(`Kalshi WS error: ${err.message}`);
        if (!this.connected) reject(err);
      });

      this.ws.on("close", () => {
        this.connected = false;
        console.log("⚠️  Kalshi WebSocket disconnected, reconnecting...");
        this.reconnect();
      });
    });
  }

  private reconnect() {
    if (this.reconnectAttempts >= 10) {
      console.error("Kalshi WS: max reconnect attempts reached");
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts));
    setTimeout(() => this.connect().catch(() => {}), delay);
  }

  private send(payload: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // ── Handle incoming messages ──
  private handleMessage(msg: any) {
    const type = msg.type;

    if (type === "orderbook_snapshot") {
      const snap: OrderbookSnapshot = {
        ticker: msg.msg.market_ticker,
        yes: msg.msg.yes ?? [],
        no: msg.msg.no ?? [],
        timestamp: Date.now(),
      };
      this.orderbooks.set(snap.ticker, snap);
      this.emit("orderbook", snap);
    } else if (type === "orderbook_delta") {
      // Apply delta to existing snapshot
      const ticker = msg.msg.market_ticker;
      const existing = this.orderbooks.get(ticker);
      if (existing) {
        const side = msg.msg.side === "yes" ? "yes" : "no";
        const price = msg.msg.price;
        const newSize = msg.msg.delta;
        const levels = existing[side];
        const idx = levels.findIndex(([p]) => p === price);
        if (newSize === 0 && idx >= 0) {
          levels.splice(idx, 1);
        } else if (idx >= 0) {
          levels[idx][1] = newSize;
        } else {
          levels.push([price, newSize]);
          levels.sort((a, b) => side === "yes" ? b[0] - a[0] : a[0] - b[0]);
        }
        existing.timestamp = Date.now();
        this.emit("orderbook", existing);
      }
    } else if (type === "ticker") {
      const t: TickerUpdate = {
        ticker: msg.msg.market_ticker,
        yes_bid: msg.msg.yes_bid ?? 0,
        yes_ask: msg.msg.yes_ask ?? 100,
        no_bid: msg.msg.no_bid ?? 0,
        no_ask: msg.msg.no_ask ?? 100,
        last_price: msg.msg.price ?? 50,
        volume: msg.msg.volume ?? 0,
        timestamp: Date.now(),
      };
      this.tickers.set(t.ticker, t);
      this.emit("ticker", t);
    } else if (type === "trade") {
      this.emit("trade", msg.msg);
    } else if (type === "fill") {
      this.emit("fill", msg.msg);
    } else if (type === "subscribed") {
      console.log(`  Subscribed to ${msg.msg.channel} for ${(msg.msg.market_tickers || []).length} markets`);
    } else if (type === "error") {
      console.error(`Kalshi WS error: ${JSON.stringify(msg.msg)}`);
    }
  }

  // ── Subscribe to a channel for specific markets ──
  subscribe(channel: KalshiWsChannel, marketTickers: string[]) {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }
    const set = this.subscriptions.get(channel)!;
    for (const t of marketTickers) set.add(t);

    this.send({
      id: this.commandId++,
      cmd: "subscribe",
      params: { channels: [channel], market_tickers: marketTickers },
    });
  }

  unsubscribe(channel: KalshiWsChannel, marketTickers: string[]) {
    const set = this.subscriptions.get(channel);
    if (set) for (const t of marketTickers) set.delete(t);

    this.send({
      id: this.commandId++,
      cmd: "unsubscribe",
      params: { channels: [channel], market_tickers: marketTickers },
    });
  }

  // ── Event listener API ──
  on(event: "orderbook" | "ticker" | "trade" | "fill", handler: (data: any) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler);
  }

  private emit(event: string, data: any) {
    const handlers = this.listeners.get(event) ?? [];
    for (const h of handlers) {
      try { h(data); } catch (err: any) { console.error(`Handler error: ${err.message}`); }
    }
  }

  // ── Synchronous getters for current state ──
  getOrderbook(ticker: string): OrderbookSnapshot | undefined {
    return this.orderbooks.get(ticker);
  }

  getTicker(ticker: string): TickerUpdate | undefined {
    return this.tickers.get(ticker);
  }

  isConnected(): boolean {
    return this.connected;
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
