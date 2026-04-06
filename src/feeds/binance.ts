// src/feeds/binance.ts — Real-time exchange price feed
// This is what gives the $313→$438k bots their edge:
// Polymarket crypto markets lag behind real exchange prices by 2-30 seconds

import WebSocket from "ws";

export interface PriceSnapshot {
  symbol: string;
  price: number;
  timestamp: number;
  change5s: number;  // % change in last 5 seconds
  change30s: number; // % change in last 30 seconds
  change60s: number; // % change in last 60 seconds
  momentum: "surging_up" | "up" | "flat" | "down" | "surging_down";
}

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt"];
const priceHistory: Map<string, { price: number; ts: number }[]> = new Map();
const latestPrices: Map<string, PriceSnapshot> = new Map();

let ws: WebSocket | null = null;

export function startPriceFeed() {
  const streams = SYMBOLS.map((s) => `${s}@trade`).join("/");
  const url = `wss://stream.binance.com:9443/ws/${streams}`;

  ws = new WebSocket(url);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.e !== "trade") return;

      const symbol = msg.s.toLowerCase();
      const price = parseFloat(msg.p);
      const ts = msg.T;

      // Store history (keep last 120 seconds)
      if (!priceHistory.has(symbol)) priceHistory.set(symbol, []);
      const hist = priceHistory.get(symbol)!;
      hist.push({ price, ts });

      // Trim old entries
      const cutoff = ts - 120_000;
      while (hist.length > 0 && hist[0].ts < cutoff) hist.shift();

      // Calculate momentum
      const now = price;
      const ago5s = findPriceAt(hist, ts - 5_000);
      const ago30s = findPriceAt(hist, ts - 30_000);
      const ago60s = findPriceAt(hist, ts - 60_000);

      const change5s = ago5s ? ((now - ago5s) / ago5s) * 100 : 0;
      const change30s = ago30s ? ((now - ago30s) / ago30s) * 100 : 0;
      const change60s = ago60s ? ((now - ago60s) / ago60s) * 100 : 0;

      let momentum: PriceSnapshot["momentum"] = "flat";
      if (change5s > 0.15) momentum = "surging_up";
      else if (change5s > 0.05) momentum = "up";
      else if (change5s < -0.15) momentum = "surging_down";
      else if (change5s < -0.05) momentum = "down";

      latestPrices.set(symbol, {
        symbol,
        price,
        timestamp: ts,
        change5s: Math.round(change5s * 1000) / 1000,
        change30s: Math.round(change30s * 1000) / 1000,
        change60s: Math.round(change60s * 1000) / 1000,
        momentum,
      });
    } catch {}
  });

  ws.on("error", (err) => console.error("[Binance WS] Error:", err.message));
  ws.on("close", () => {
    console.log("[Binance WS] Disconnected, reconnecting in 3s...");
    setTimeout(startPriceFeed, 3000);
  });

  console.log("✅ Binance price feed connected");
}

export function getPrice(symbol: string): PriceSnapshot | null {
  return latestPrices.get(symbol.toLowerCase()) ?? null;
}

export function getAllPrices(): PriceSnapshot[] {
  return Array.from(latestPrices.values());
}

// Is there a strong directional signal right now?
export function detectCryptoSignal(symbol: string): {
  signal: "strong_up" | "strong_down" | "none";
  confidence: number;
  details: string;
} | null {
  const snap = getPrice(symbol);
  if (!snap) return null;

  // Strong up: 5s momentum + 30s confirmation
  if (snap.change5s > 0.10 && snap.change30s > 0.15) {
    const conf = Math.min(0.95, 0.60 + snap.change5s * 2);
    return {
      signal: "strong_up",
      confidence: conf,
      details: `${symbol} +${snap.change5s.toFixed(3)}% (5s) +${snap.change30s.toFixed(3)}% (30s)`,
    };
  }

  if (snap.change5s < -0.10 && snap.change30s < -0.15) {
    const conf = Math.min(0.95, 0.60 + Math.abs(snap.change5s) * 2);
    return {
      signal: "strong_down",
      confidence: conf,
      details: `${symbol} ${snap.change5s.toFixed(3)}% (5s) ${snap.change30s.toFixed(3)}% (30s)`,
    };
  }

  return { signal: "none", confidence: 0, details: "" };
}

function findPriceAt(hist: { price: number; ts: number }[], targetTs: number): number | null {
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].ts <= targetTs) return hist[i].price;
  }
  return null;
}

export function stopPriceFeed() {
  ws?.close();
}
