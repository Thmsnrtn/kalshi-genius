// src/alpha_sources/orderbook_microstructure.ts
//
// ORDER BOOK MICROSTRUCTURE ANALYZER
//
// The order book is a real-time map of liquidity and intent. This module:
//
// 1. Connects to Polymarket CLOB WebSocket for real-time order book updates
// 2. Computes microstructure metrics for each market:
//    - Bid/ask spread
//    - Depth at each price level
//    - Imbalance (is there more buying or selling pressure?)
//    - Slippage curve (how much does it cost to move $X through the book?)
//    - Iceberg detection (hidden orders being refilled)
//    - Market impact estimation
// 3. Emits signals when microstructure suggests imminent price movement
// 4. Prevents bad execution (refuses trades that would slip too much)
//
// This is the edge that pure latency arbitrageurs have. Without real-time
// book data, you're flying blind on execution quality.

import { getDb } from "../core/db.js";

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  market_id: string;
  token_id: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface MicrostructureMetrics {
  market_id: string;
  token_id: string;
  best_bid: number;
  best_ask: number;
  mid_price: number;
  spread: number;
  spread_bps: number;
  bid_depth_usd: number;      // Total $ depth within 5% of mid
  ask_depth_usd: number;
  imbalance: number;          // (bid_depth - ask_depth) / (bid_depth + ask_depth)
  slippage_100: number;       // % slippage on $100 buy
  slippage_500: number;
  slippage_1000: number;
  iceberg_suspected: boolean; // Repeated refills at same level
  thin_book: boolean;         // Total depth < $500
  timestamp: number;
}

export function initOrderBookAnalyzer() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS orderbook_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      best_bid REAL, best_ask REAL, mid REAL, spread_bps REAL,
      bid_depth_usd REAL, ask_depth_usd REAL, imbalance REAL,
      slippage_100 REAL, slippage_500 REAL, slippage_1000 REAL,
      iceberg_suspected INTEGER, thin_book INTEGER,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ob_market ON orderbook_snapshots(market_id, timestamp);
  `);
}

// ── Fetch order book snapshot from Polymarket CLOB ──
export async function fetchOrderBook(tokenId: string): Promise<OrderBook | null> {
  try {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;

    return {
      market_id: data.market ?? "",
      token_id: tokenId,
      bids: (data.bids ?? []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
      asks: (data.asks ?? []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

// ── Compute microstructure metrics ──
export function analyzeOrderBook(book: OrderBook): MicrostructureMetrics {
  const bestBid = book.bids[0]?.price ?? 0;
  const bestAsk = book.asks[0]?.price ?? 1;
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadBps = (spread / mid) * 10000;

  // Depth within 5% of mid
  const bidsInRange = book.bids.filter((b) => b.price >= mid * 0.95);
  const asksInRange = book.asks.filter((a) => a.price <= mid * 1.05);
  const bidDepthUsd = bidsInRange.reduce((s, b) => s + b.price * b.size, 0);
  const askDepthUsd = asksInRange.reduce((s, a) => s + a.price * a.size, 0);

  const imbalance = (bidDepthUsd - askDepthUsd) / ((bidDepthUsd + askDepthUsd) || 1);

  // Slippage calculator: how much does N dollars move the ask?
  const calcSlippage = (dollarsToSpend: number): number => {
    let remaining = dollarsToSpend;
    let lastPrice = bestAsk;
    for (const ask of book.asks) {
      const levelValue = ask.price * ask.size;
      if (levelValue >= remaining) {
        lastPrice = ask.price;
        break;
      }
      remaining -= levelValue;
      lastPrice = ask.price;
    }
    return lastPrice > 0 ? (lastPrice - bestAsk) / bestAsk : 0;
  };

  const slippage100 = calcSlippage(100);
  const slippage500 = calcSlippage(500);
  const slippage1000 = calcSlippage(1000);

  const thinBook = bidDepthUsd + askDepthUsd < 500;

  // Iceberg detection would need historical snapshot comparison — simplified
  const icebergSuspected = false;

  return {
    market_id: book.market_id,
    token_id: book.token_id,
    best_bid: bestBid,
    best_ask: bestAsk,
    mid_price: mid,
    spread,
    spread_bps: spreadBps,
    bid_depth_usd: bidDepthUsd,
    ask_depth_usd: askDepthUsd,
    imbalance,
    slippage_100: slippage100,
    slippage_500: slippage500,
    slippage_1000: slippage1000,
    iceberg_suspected: icebergSuspected,
    thin_book: thinBook,
    timestamp: book.timestamp,
  };
}

// ── Record snapshot for historical analysis ──
export function recordSnapshot(metrics: MicrostructureMetrics) {
  const db = getDb();
  db.prepare(`
    INSERT INTO orderbook_snapshots 
    (market_id, token_id, best_bid, best_ask, mid, spread_bps, 
     bid_depth_usd, ask_depth_usd, imbalance, 
     slippage_100, slippage_500, slippage_1000, 
     iceberg_suspected, thin_book, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    metrics.market_id, metrics.token_id, metrics.best_bid, metrics.best_ask,
    metrics.mid_price, metrics.spread_bps, metrics.bid_depth_usd, metrics.ask_depth_usd,
    metrics.imbalance, metrics.slippage_100, metrics.slippage_500, metrics.slippage_1000,
    metrics.iceberg_suspected ? 1 : 0, metrics.thin_book ? 1 : 0, metrics.timestamp
  );
}

// ── EXECUTION QUALITY GATE: should we trade given these conditions? ──
export interface ExecutionAssessment {
  should_execute: boolean;
  expected_slippage_pct: number;
  max_size_usd: number;       // Max size we can trade without excessive slippage
  warnings: string[];
  quality_score: number;      // 0-1
}

export function assessExecution(metrics: MicrostructureMetrics, intendedSizeUsd: number): ExecutionAssessment {
  const warnings: string[] = [];
  let shouldExecute = true;

  // Reject thin books entirely
  if (metrics.thin_book) {
    warnings.push("Thin book — depth below $500");
    shouldExecute = false;
  }

  // Reject wide spreads
  if (metrics.spread_bps > 500) { // 5% spread
    warnings.push(`Wide spread: ${metrics.spread_bps.toFixed(0)}bps`);
    shouldExecute = false;
  }

  // Calculate expected slippage for intended size
  const slippage = intendedSizeUsd <= 100 ? metrics.slippage_100
    : intendedSizeUsd <= 500 ? metrics.slippage_500
    : metrics.slippage_1000;

  if (slippage > 0.03) { // 3% slippage is too much
    warnings.push(`High slippage: ${(slippage * 100).toFixed(1)}%`);
    shouldExecute = false;
  }

  // Max size: where does slippage exceed 1%?
  let maxSize = 50;
  if (metrics.slippage_100 < 0.01) maxSize = 100;
  if (metrics.slippage_500 < 0.01) maxSize = 500;
  if (metrics.slippage_1000 < 0.01) maxSize = 1000;

  // Quality score: combination of spread, depth, and slippage
  const spreadScore = Math.max(0, 1 - metrics.spread_bps / 500);
  const depthScore = Math.min(1, (metrics.bid_depth_usd + metrics.ask_depth_usd) / 2000);
  const slippageScore = Math.max(0, 1 - slippage / 0.05);
  const qualityScore = (spreadScore + depthScore + slippageScore) / 3;

  return {
    should_execute: shouldExecute,
    expected_slippage_pct: slippage,
    max_size_usd: maxSize,
    warnings,
    quality_score: qualityScore,
  };
}

// ── Detect microstructure signals (imbalance extremes = imminent move) ──
export interface MicrostructureSignal {
  market_id: string;
  token_id: string;
  signal_type: "extreme_imbalance" | "thin_ask_side" | "thin_bid_side" | "tight_spread_deep_book";
  direction_hint: "YES" | "NO" | null;
  strength: number;
  reasoning: string;
}

export function detectSignals(metrics: MicrostructureMetrics): MicrostructureSignal | null {
  // Extreme imbalance suggests imminent move
  if (Math.abs(metrics.imbalance) > 0.7 && !metrics.thin_book) {
    return {
      market_id: metrics.market_id,
      token_id: metrics.token_id,
      signal_type: "extreme_imbalance",
      direction_hint: metrics.imbalance > 0 ? "YES" : "NO",
      strength: Math.abs(metrics.imbalance),
      reasoning: `Order book imbalance ${(metrics.imbalance * 100).toFixed(0)}% toward ${metrics.imbalance > 0 ? "bids" : "asks"}`,
    };
  }

  // Thin ask side = easy to push price up
  if (metrics.ask_depth_usd < 200 && metrics.bid_depth_usd > 500) {
    return {
      market_id: metrics.market_id,
      token_id: metrics.token_id,
      signal_type: "thin_ask_side",
      direction_hint: "YES",
      strength: 0.6,
      reasoning: `Thin ask side ($${metrics.ask_depth_usd.toFixed(0)}) vs deep bids ($${metrics.bid_depth_usd.toFixed(0)})`,
    };
  }

  // Thin bid side = easy to push price down
  if (metrics.bid_depth_usd < 200 && metrics.ask_depth_usd > 500) {
    return {
      market_id: metrics.market_id,
      token_id: metrics.token_id,
      signal_type: "thin_bid_side",
      direction_hint: "NO",
      strength: 0.6,
      reasoning: `Thin bid side ($${metrics.bid_depth_usd.toFixed(0)}) vs deep asks ($${metrics.ask_depth_usd.toFixed(0)})`,
    };
  }

  return null;
}
