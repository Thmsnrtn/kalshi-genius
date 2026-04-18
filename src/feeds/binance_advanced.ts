// src/feeds/binance_advanced.ts — Advanced Binance data feeds
//
// ITEMS BUILT:
// #1  Order Book Depth + Imbalance (OBI)
// #2  Funding Rate Monitor
// #3  Liquidation Cascade Detection
// #6  VWAP Engine
// #7  VPIN (Volume-Synchronized Probability of Informed Trading)

import WebSocket from "ws";
import { getPrice } from "./binance.js";

// ═══════════════════════════════════════════════════════════
// #1: ORDER BOOK DEPTH & IMBALANCE
// ═══════════════════════════════════════════════════════════

interface OrderBookSnapshot {
  symbol: string;
  bids: Array<[number, number]>; // [price, qty]
  asks: Array<[number, number]>;
  imbalance: number;  // -1 (all asks) to +1 (all bids)
  weighted_imbalance: number; // Distance-weighted
  spread_pct: number;
  timestamp: number;
}

const orderBooks: Map<string, OrderBookSnapshot> = new Map();
const OBI_SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt"];
let depthWs: WebSocket | null = null;

export function startDepthFeed() {
  const streams = OBI_SYMBOLS.map(s => `${s}@depth10@100ms`).join("/");
  const url = `wss://stream.binance.com:9443/ws/${streams}`;

  try {
    depthWs = new WebSocket(url);
  } catch {
    console.log("  ⚠️ Binance depth WebSocket failed, using REST fallback");
    startDepthPolling();
    return;
  }

  depthWs.on("open", () => {
    console.log("✅ Binance depth WebSocket connected (OBI active)");
  });

  depthWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg.bids || !msg.asks) return;

      // Extract symbol from stream name or infer
      const symbol = msg.s?.toLowerCase() ?? inferSymbolFromStream(msg);
      if (!symbol) return;

      const bids = msg.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])] as [number, number]);
      const asks = msg.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])] as [number, number]);

      const bidVol = bids.reduce((sum: number, b: [number, number]) => sum + b[1], 0);
      const askVol = asks.reduce((sum: number, a: [number, number]) => sum + a[1], 0);
      const totalVol = bidVol + askVol;

      // Simple imbalance
      const imbalance = totalVol > 0 ? (bidVol - askVol) / totalVol : 0;

      // Distance-weighted: nearer levels matter more
      const midPrice = bids.length > 0 && asks.length > 0 ? (bids[0][0] + asks[0][0]) / 2 : 0;
      let wBidVol = 0, wAskVol = 0;
      for (const [price, qty] of bids) {
        const dist = Math.max(0.0001, Math.abs(price - midPrice) / midPrice);
        wBidVol += qty / dist;
      }
      for (const [price, qty] of asks) {
        const dist = Math.max(0.0001, Math.abs(price - midPrice) / midPrice);
        wAskVol += qty / dist;
      }
      const wTotal = wBidVol + wAskVol;
      const weighted_imbalance = wTotal > 0 ? (wBidVol - wAskVol) / wTotal : 0;

      const spread_pct = midPrice > 0 && asks.length > 0 && bids.length > 0
        ? (asks[0][0] - bids[0][0]) / midPrice * 100
        : 0;

      orderBooks.set(symbol, {
        symbol, bids, asks, imbalance, weighted_imbalance, spread_pct, timestamp: Date.now(),
      });
    } catch {}
  });

  depthWs.on("error", () => {});
  depthWs.on("close", () => {
    setTimeout(() => startDepthFeed(), 5000);
  });
}

function inferSymbolFromStream(_msg: any): string | null {
  // Binance combined streams include the stream name in the wrapper
  return null;
}

// REST fallback for depth
function startDepthPolling() {
  const poll = async () => {
    for (const symbol of OBI_SYMBOLS) {
      try {
        const res = await fetch(`https://api.binance.com/api/v3/depth?symbol=${symbol.toUpperCase()}&limit=10`);
        if (!res.ok) continue;
        const data = await res.json() as any;
        const bids = (data.bids || []).map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])] as [number, number]);
        const asks = (data.asks || []).map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])] as [number, number]);

        const bidVol = bids.reduce((s: number, b: [number, number]) => s + b[1], 0);
        const askVol = asks.reduce((s: number, a: [number, number]) => s + a[1], 0);
        const total = bidVol + askVol;
        const imbalance = total > 0 ? (bidVol - askVol) / total : 0;
        const midPrice = bids.length > 0 && asks.length > 0 ? (bids[0][0] + asks[0][0]) / 2 : 0;
        const spread_pct = midPrice > 0 && asks.length > 0 && bids.length > 0
          ? (asks[0][0] - bids[0][0]) / midPrice * 100 : 0;

        orderBooks.set(symbol, {
          symbol, bids, asks, imbalance, weighted_imbalance: imbalance, spread_pct, timestamp: Date.now(),
        });
      } catch {}
    }
  };
  poll();
  setInterval(poll, 5000); // Every 5s for REST
  console.log("✅ Binance depth REST polling active (5s interval)");
}

export function getOrderBookImbalance(symbol: string): {
  imbalance: number;
  weighted_imbalance: number;
  spread_pct: number;
  signal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  confidence: number;
} {
  const ob = orderBooks.get(symbol.toLowerCase());
  if (!ob || Date.now() - ob.timestamp > 10000) {
    return { imbalance: 0, weighted_imbalance: 0, spread_pct: 0, signal: "neutral", confidence: 0 };
  }

  const wi = ob.weighted_imbalance;
  let signal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell" = "neutral";
  let confidence = 0;

  if (wi > 0.5) { signal = "strong_buy"; confidence = Math.min(0.90, 0.60 + wi * 0.3); }
  else if (wi > 0.25) { signal = "buy"; confidence = Math.min(0.75, 0.50 + wi * 0.5); }
  else if (wi < -0.5) { signal = "strong_sell"; confidence = Math.min(0.90, 0.60 + Math.abs(wi) * 0.3); }
  else if (wi < -0.25) { signal = "sell"; confidence = Math.min(0.75, 0.50 + Math.abs(wi) * 0.5); }

  return { imbalance: ob.imbalance, weighted_imbalance: wi, spread_pct: ob.spread_pct, signal, confidence };
}

// ═══════════════════════════════════════════════════════════
// #2: FUNDING RATE MONITOR
// ═══════════════════════════════════════════════════════════

interface FundingState {
  rate: number;
  next_funding_time: number;
  mean_30d: number;
  std_30d: number;
  z_score: number;  // How many std devs from mean
  bias: "bullish" | "bearish" | "neutral";
  timestamp: number;
}

const fundingStates: Map<string, FundingState> = new Map();
const fundingHistory: Map<string, number[]> = new Map(); // Last 30d of rates

export function startFundingRateMonitor() {
  const poll = async () => {
    for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
      try {
        // Current funding rate
        const res = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
        if (!res.ok) continue;
        const data = await res.json() as any;
        const rate = parseFloat(data.lastFundingRate || "0");
        const nextTime = parseInt(data.nextFundingTime || "0");

        // Update history
        const key = symbol.toLowerCase();
        if (!fundingHistory.has(key)) fundingHistory.set(key, []);
        const hist = fundingHistory.get(key)!;
        hist.push(rate);
        if (hist.length > 360) hist.splice(0, hist.length - 360); // ~30 days at 8h intervals

        // Compute statistics
        const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
        const std = Math.sqrt(hist.reduce((sum, r) => sum + (r - mean) ** 2, 0) / hist.length) || 0.0001;
        const z = (rate - mean) / std;

        let bias: "bullish" | "bearish" | "neutral" = "neutral";
        if (z > 2) bias = "bearish";   // Overleveraged longs → expect reversal down
        else if (z < -2) bias = "bullish"; // Overleveraged shorts → expect squeeze up

        fundingStates.set(key, {
          rate, next_funding_time: nextTime, mean_30d: mean, std_30d: std,
          z_score: z, bias, timestamp: Date.now(),
        });
      } catch {}
    }
  };

  poll();
  setInterval(poll, 60000); // Every 1 min
  console.log("✅ Funding rate monitor active (1min poll)");
}

export function getFundingBias(symbol: string): FundingState | null {
  return fundingStates.get(symbol.toLowerCase()) ?? null;
}

// ═══════════════════════════════════════════════════════════
// #3: LIQUIDATION CASCADE DETECTION
// ═══════════════════════════════════════════════════════════

interface LiquidationEvent {
  symbol: string;
  side: "buy" | "sell"; // Forced buy = short liquidation, forced sell = long liquidation
  quantity: number;
  price: number;
  timestamp: number;
}

const liquidationBuffer: LiquidationEvent[] = [];
let liqWs: WebSocket | null = null;

export function startLiquidationMonitor() {
  const streams = ["btcusdt", "ethusdt", "solusdt"].map(s => `${s}@forceOrder`).join("/");
  const url = `wss://fstream.binance.com/ws/${streams}`;

  try {
    liqWs = new WebSocket(url);
  } catch {
    console.log("  ⚠️ Liquidation WebSocket failed — feature disabled");
    return;
  }

  liqWs.on("open", () => {
    console.log("✅ Liquidation cascade monitor active");
  });

  liqWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const o = msg.o;
      if (!o) return;

      liquidationBuffer.push({
        symbol: o.s.toLowerCase(),
        side: o.S.toLowerCase() as "buy" | "sell",
        quantity: parseFloat(o.q),
        price: parseFloat(o.p),
        timestamp: Date.now(),
      });

      // Keep last 30 min
      const cutoff = Date.now() - 30 * 60 * 1000;
      while (liquidationBuffer.length > 0 && liquidationBuffer[0].timestamp < cutoff) {
        liquidationBuffer.shift();
      }
    } catch {}
  });

  liqWs.on("error", () => {});
  liqWs.on("close", () => {
    setTimeout(() => startLiquidationMonitor(), 10000);
  });
}

export function detectLiquidationCascade(symbol: string): {
  active: boolean;
  direction: "long_squeeze" | "short_squeeze" | "none";
  intensity: number; // 0-1
  volume_usd: number;
  count: number;
} {
  const now = Date.now();
  const sym = symbol.toLowerCase().replace("usdt", "") + "usdt";
  const recent = liquidationBuffer.filter(l => l.symbol === sym && now - l.timestamp < 5 * 60 * 1000);

  if (recent.length < 3) {
    return { active: false, direction: "none", intensity: 0, volume_usd: 0, count: 0 };
  }

  const longLiqs = recent.filter(l => l.side === "sell"); // Forced sell = long liquidated
  const shortLiqs = recent.filter(l => l.side === "buy");  // Forced buy = short liquidated

  const longVolume = longLiqs.reduce((s, l) => s + l.quantity * l.price, 0);
  const shortVolume = shortLiqs.reduce((s, l) => s + l.quantity * l.price, 0);
  const totalVolume = longVolume + shortVolume;

  // Compare to hourly average
  const hourLiqs = liquidationBuffer.filter(l => l.symbol === sym && now - l.timestamp < 60 * 60 * 1000);
  const hourVolume = hourLiqs.reduce((s, l) => s + l.quantity * l.price, 0);
  const hourAvg5min = hourVolume / 12; // 12 five-minute periods in an hour

  const intensity = hourAvg5min > 0 ? Math.min(1, totalVolume / (hourAvg5min * 3)) : 0;
  const isCascade = intensity > 0.5 && recent.length >= 5;

  let direction: "long_squeeze" | "short_squeeze" | "none" = "none";
  if (isCascade) {
    direction = longVolume > shortVolume * 1.5 ? "long_squeeze" :
                shortVolume > longVolume * 1.5 ? "short_squeeze" : "none";
  }

  return { active: isCascade, direction, intensity, volume_usd: totalVolume, count: recent.length };
}

// ═══════════════════════════════════════════════════════════
// #6: VWAP ENGINE
// ═══════════════════════════════════════════════════════════

interface VWAPState {
  vwap: number;
  upper_band: number; // +2 std dev
  lower_band: number; // -2 std dev
  slope: number;      // Rising = trending, flat = ranging
  deviation: number;  // Current price relative to VWAP in std devs
  signal: "overbought" | "oversold" | "neutral";
}

const vwapData: Map<string, { cumPV: number; cumV: number; prices: number[]; volumes: number[] }> = new Map();

export function updateVWAP(symbol: string, price: number, volume: number) {
  const key = symbol.toLowerCase();
  if (!vwapData.has(key)) {
    vwapData.set(key, { cumPV: 0, cumV: 0, prices: [], volumes: [] });
  }
  const state = vwapData.get(key)!;
  state.cumPV += price * volume;
  state.cumV += volume;
  state.prices.push(price);
  state.volumes.push(volume);

  // Keep last 900 data points (~15 min of second-level data)
  if (state.prices.length > 900) {
    // Remove oldest contribution
    const oldP = state.prices.shift()!;
    const oldV = state.volumes.shift()!;
    state.cumPV -= oldP * oldV;
    state.cumV -= oldV;
  }
}

export function getVWAP(symbol: string): VWAPState | null {
  const key = symbol.toLowerCase();
  const state = vwapData.get(key);
  if (!state || state.cumV === 0 || state.prices.length < 30) return null;

  const vwap = state.cumPV / state.cumV;
  const currentPrice = state.prices[state.prices.length - 1];

  // Standard deviation of price from VWAP
  const deviations = state.prices.map(p => p - vwap);
  const std = Math.sqrt(deviations.reduce((sum, d) => sum + d * d, 0) / deviations.length) || 0.01;

  const deviation = (currentPrice - vwap) / std;

  // VWAP slope: compare VWAP of last 60 entries vs previous 60
  let slope = 0;
  if (state.prices.length >= 120) {
    const recent60 = state.prices.slice(-60);
    const prev60 = state.prices.slice(-120, -60);
    const recentVWAP = recent60.reduce((a, b) => a + b, 0) / 60;
    const prevVWAP = prev60.reduce((a, b) => a + b, 0) / 60;
    slope = (recentVWAP - prevVWAP) / prevVWAP * 100;
  }

  let signal: VWAPState["signal"] = "neutral";
  if (deviation > 2) signal = "overbought";
  else if (deviation < -2) signal = "oversold";

  return {
    vwap,
    upper_band: vwap + 2 * std,
    lower_band: vwap - 2 * std,
    slope,
    deviation,
    signal,
  };
}

// Reset VWAP at contract boundaries (every 15 min for turbo markets)
export function resetVWAP(symbol: string) {
  vwapData.delete(symbol.toLowerCase());
}

// ═══════════════════════════════════════════════════════════
// #7: VPIN (Volume-Synchronized Probability of Informed Trading)
// ═══════════════════════════════════════════════════════════

interface VPINState {
  vpin: number;          // 0-1, higher = more informed trading
  bucket_imbalance: number;
  signal: "high_informed" | "moderate" | "low";
}

// Track buy/sell classified trades
const tradeClassifier: Map<string, Array<{ price: number; qty: number; isBuy: boolean; ts: number }>> = new Map();

export function classifyTrade(symbol: string, price: number, qty: number) {
  const key = symbol.toLowerCase();
  if (!tradeClassifier.has(key)) tradeClassifier.set(key, []);
  const trades = tradeClassifier.get(key)!;

  // Tick rule: if price > last price, it's a buy. If lower, sell. Same = use last classification.
  let isBuy = true;
  if (trades.length > 0) {
    const last = trades[trades.length - 1];
    if (price > last.price) isBuy = true;
    else if (price < last.price) isBuy = false;
    else isBuy = last.isBuy;
  }

  trades.push({ price, qty, isBuy, ts: Date.now() });

  // Keep last 5 minutes
  const cutoff = Date.now() - 5 * 60 * 1000;
  while (trades.length > 0 && trades[0].ts < cutoff) trades.shift();

  // Update VWAP with volume
  updateVWAP(symbol, price, qty);
}

export function getVPIN(symbol: string): VPINState {
  const key = symbol.toLowerCase();
  const trades = tradeClassifier.get(key);
  if (!trades || trades.length < 50) {
    return { vpin: 0, bucket_imbalance: 0, signal: "low" };
  }

  // Split into volume buckets (10 buckets over the window)
  const totalVol = trades.reduce((s, t) => s + t.qty, 0);
  const bucketSize = totalVol / 10;

  let currentBucket = 0;
  let buyVol = 0, sellVol = 0;
  let totalImbalance = 0;
  let bucketCount = 0;

  for (const trade of trades) {
    if (trade.isBuy) buyVol += trade.qty;
    else sellVol += trade.qty;
    currentBucket += trade.qty;

    if (currentBucket >= bucketSize && bucketSize > 0) {
      totalImbalance += Math.abs(buyVol - sellVol) / (buyVol + sellVol + 0.0001);
      bucketCount++;
      currentBucket = 0;
      buyVol = 0;
      sellVol = 0;
    }
  }

  const vpin = bucketCount > 0 ? totalImbalance / bucketCount : 0;

  // Current window imbalance
  const windowBuyVol = trades.filter(t => t.isBuy).reduce((s, t) => s + t.qty, 0);
  const windowSellVol = trades.filter(t => !t.isBuy).reduce((s, t) => s + t.qty, 0);
  const bucket_imbalance = (windowBuyVol - windowSellVol) / (windowBuyVol + windowSellVol + 0.0001);

  let signal: VPINState["signal"] = "low";
  if (vpin > 0.7) signal = "high_informed";
  else if (vpin > 0.4) signal = "moderate";

  return { vpin, bucket_imbalance, signal };
}

// ═══════════════════════════════════════════════════════════
// UNIFIED STARTUP
// ═══════════════════════════════════════════════════════════

export function startAdvancedFeeds() {
  startDepthFeed();
  startFundingRateMonitor();
  startLiquidationMonitor();
  console.log("🧠 Advanced feeds initialized: Depth/OBI, Funding Rates, Liquidation Cascade, VWAP, VPIN");
}
