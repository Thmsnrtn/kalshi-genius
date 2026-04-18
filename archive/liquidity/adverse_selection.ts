// src/liquidity/adverse_selection.ts — Detect toxic flow
//
// 6 detectors that signal when informed traders are picking off our quotes:
// 1. Price moves after our fills (adverse price movement)
// 2. Volume spikes (informed burst)
// 3. Orderbook velocity (one-sided aggression)
// 4. Regime risk (volatile regime = more adverse selection)
// 5. News velocity (breaking news = informed flow)
// 6. Scheduled events (known catalysts)

import { getCurrentRegime } from "../evolution/regime_detector.js";

interface FillRecord {
  ticker: string;
  side: "yes" | "no";
  price_cents: number;
  timestamp: number;
}

interface PriceRecord {
  ticker: string;
  price_cents: number;
  timestamp: number;
}

// Rolling windows
const recentFills: FillRecord[] = [];
const priceHistory: Map<string, PriceRecord[]> = new Map();
const volumeHistory: Map<string, number[]> = new Map(); // timestamps of recent volume bursts
const adverseScores: Map<string, number> = new Map();

const MAX_HISTORY = 200;
const LOOKBACK_MS = 30 * 60 * 1000; // 30 min lookback

// Record a fill on one of our quotes
export function recordFill(ticker: string, side: "yes" | "no", priceCents: number) {
  recentFills.push({ ticker, side, price_cents: priceCents, timestamp: Date.now() });
  if (recentFills.length > MAX_HISTORY) recentFills.splice(0, recentFills.length - MAX_HISTORY);
}

// Record a price snapshot for adverse movement detection
export function recordPrice(ticker: string, priceCents: number) {
  if (!priceHistory.has(ticker)) priceHistory.set(ticker, []);
  const hist = priceHistory.get(ticker)!;
  hist.push({ ticker, price_cents: priceCents, timestamp: Date.now() });
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
}

// Record a volume burst event
export function recordVolumeBurst(ticker: string) {
  if (!volumeHistory.has(ticker)) volumeHistory.set(ticker, []);
  const hist = volumeHistory.get(ticker)!;
  hist.push(Date.now());
  if (hist.length > 50) hist.splice(0, hist.length - 50);
}

// ── Detector 1: Adverse Price Movement ──
// After we get filled, did price move against us?
function detectAdversePriceMove(ticker: string): number {
  const fills = recentFills.filter(f => f.ticker === ticker && Date.now() - f.timestamp < LOOKBACK_MS);
  if (fills.length === 0) return 0;

  const prices = priceHistory.get(ticker) ?? [];
  let adverseCount = 0;

  for (const fill of fills) {
    // Find price 2-5 minutes after fill
    const postFillPrices = prices.filter(p =>
      p.timestamp > fill.timestamp + 2 * 60 * 1000 &&
      p.timestamp < fill.timestamp + 5 * 60 * 1000
    );
    if (postFillPrices.length === 0) continue;

    const avgPostPrice = postFillPrices.reduce((s, p) => s + p.price_cents, 0) / postFillPrices.length;
    const moveCents = avgPostPrice - fill.price_cents;

    // If we bought YES and price dropped, or sold YES and price rose = adverse
    if (fill.side === "yes" && moveCents < -2) adverseCount++;
    if (fill.side === "no" && moveCents > 2) adverseCount++;
  }

  return fills.length > 0 ? adverseCount / fills.length : 0;
}

// ── Detector 2: Volume Spike ──
function detectVolumeSpike(ticker: string): number {
  const bursts = (volumeHistory.get(ticker) ?? []).filter(t => Date.now() - t < 5 * 60 * 1000);
  // 3+ bursts in 5 min = suspicious
  if (bursts.length >= 5) return 0.8;
  if (bursts.length >= 3) return 0.5;
  return 0;
}

// ── Detector 3: Orderbook Velocity ──
// Tracked externally via recordOrderbookAggression()
const orderbookAggression: Map<string, number> = new Map();

export function recordOrderbookAggression(ticker: string, aggressionScore: number) {
  orderbookAggression.set(ticker, aggressionScore);
}

function detectOrderbookVelocity(ticker: string): number {
  return orderbookAggression.get(ticker) ?? 0;
}

// ── Detector 4: Regime Risk ──
function detectRegimeRisk(): number {
  const regime = getCurrentRegime();
  if (!regime) return 0;
  if (regime.regime === "VOLATILE") return 0.7;
  if (regime.regime === "TRENDING_UP" || regime.regime === "TRENDING_DOWN") return 0.3;
  return 0;
}

// ── Detector 5: News Velocity ──
const newsEvents: Map<string, number[]> = new Map();

export function recordNewsEvent(ticker: string) {
  if (!newsEvents.has(ticker)) newsEvents.set(ticker, []);
  newsEvents.get(ticker)!.push(Date.now());
}

function detectNewsVelocity(ticker: string): number {
  const events = (newsEvents.get(ticker) ?? []).filter(t => Date.now() - t < 15 * 60 * 1000);
  if (events.length >= 3) return 0.8;
  if (events.length >= 1) return 0.4;
  return 0;
}

// ── Detector 6: Scheduled Events ──
const scheduledEvents: Map<string, number> = new Map(); // ticker -> event timestamp

export function registerScheduledEvent(ticker: string, eventTimestamp: number) {
  scheduledEvents.set(ticker, eventTimestamp);
}

function detectScheduledEvent(ticker: string): number {
  const eventTs = scheduledEvents.get(ticker);
  if (!eventTs) return 0;
  const hoursUntil = (eventTs - Date.now()) / (60 * 60 * 1000);
  if (hoursUntil <= 0) return 0; // Already passed
  if (hoursUntil < 1) return 0.9;  // Very close
  if (hoursUntil < 4) return 0.4;
  return 0;
}

// ── Combined Score (0-1, higher = more toxic) ──
export function computeAdverseScore(ticker: string): number {
  const weights = {
    priceMove: 0.30,
    volume: 0.15,
    orderbook: 0.15,
    regime: 0.10,
    news: 0.15,
    scheduled: 0.15,
  };

  const score =
    weights.priceMove * detectAdversePriceMove(ticker) +
    weights.volume * detectVolumeSpike(ticker) +
    weights.orderbook * detectOrderbookVelocity(ticker) +
    weights.regime * detectRegimeRisk() +
    weights.news * detectNewsVelocity(ticker) +
    weights.scheduled * detectScheduledEvent(ticker);

  const clamped = Math.min(1, Math.max(0, score));
  adverseScores.set(ticker, clamped);
  return clamped;
}

// Get last computed score (cheap lookup)
export function getAdverseSelectionScore(ticker: string): number {
  return adverseScores.get(ticker) ?? 0;
}

// Refresh scores for all tracked tickers
export function refreshAllScores(): Map<string, number> {
  const allTickers = new Set([
    ...recentFills.map(f => f.ticker),
    ...priceHistory.keys(),
  ]);
  for (const ticker of allTickers) {
    computeAdverseScore(ticker);
  }
  return adverseScores;
}
