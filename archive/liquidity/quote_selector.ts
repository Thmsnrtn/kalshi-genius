// src/liquidity/quote_selector.ts — Picks markets to quote
//
// Selects the best markets for market-making based on spread width,
// volume, adverse selection history, and inventory limits.

import { config, getPhaseParams } from "../core/config.js";
import { getDb } from "../core/db.js";
import type { KalshiClient, KalshiMarket } from "../exchanges/kalshi/kalshi_client.js";
import { getAdverseSelectionScore } from "./adverse_selection.js";
import { getInventory } from "./inventory_manager.js";

export interface QuoteCandidate {
  ticker: string;
  title: string;
  spread_cents: number;
  volume_24h: number;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  score: number;        // Higher = better to quote
  reason: string;       // Why selected or skipped
}

// Markets we should NOT quote (toxic flow, scheduled events, etc.)
const SKIP_TICKERS = new Set<string>();
const COOLDOWN_MS = 10 * 60 * 1000; // 10 min cooldown after adverse selection

export function addSkipTicker(ticker: string) {
  SKIP_TICKERS.add(ticker);
  setTimeout(() => SKIP_TICKERS.delete(ticker), COOLDOWN_MS);
}

// Score a market for quoting desirability
function scoreMarket(
  market: KalshiMarket,
  bankroll: number,
  adverseScore: number,
  netInventory: number,
): QuoteCandidate {
  const spread = market.yes_ask - market.yes_bid;
  let score = 0;
  let reason = "";

  // Must have meaningful spread (>= 4 cents to post inside)
  if (spread < 4) {
    return { ticker: market.ticker, title: market.title, spread_cents: spread, volume_24h: market.volume_24h, yes_bid: market.yes_bid, yes_ask: market.yes_ask, no_bid: market.no_bid, no_ask: market.no_ask, score: -1, reason: "spread_too_tight" };
  }

  // Wider spread = more profit per fill
  score += Math.min(spread * 3, 60); // up to 60 points for 20+ cent spread

  // Volume = more fills
  if (market.volume_24h > 5000) score += 20;
  else if (market.volume_24h > 1000) score += 10;
  else if (market.volume_24h > 100) score += 5;
  else score -= 10; // Too illiquid

  // Penalize toxic flow markets
  if (adverseScore > 0.7) {
    score -= 40;
    reason = "high_adverse_selection";
  } else if (adverseScore > 0.4) {
    score -= 15;
  }

  // Penalize if we already have big inventory in this market
  if (Math.abs(netInventory) >= config.MARKET_MAKER_MAX_INVENTORY) {
    score -= 30;
    reason = reason || "inventory_full";
  }

  // Prefer mid-priced markets (25-75 cents) — more two-sided flow
  const midPrice = (market.yes_bid + market.yes_ask) / 2;
  if (midPrice >= 25 && midPrice <= 75) score += 15;
  else if (midPrice < 10 || midPrice > 90) score -= 20;

  // Skip markets about to expire (< 2 hours)
  const expiryMs = new Date(market.expected_expiration_time).getTime() - Date.now();
  if (expiryMs < 2 * 60 * 60 * 1000) {
    score -= 25;
    reason = reason || "near_expiry";
  }

  if (!reason) reason = `score=${score}`;

  return {
    ticker: market.ticker, title: market.title,
    spread_cents: spread, volume_24h: market.volume_24h,
    yes_bid: market.yes_bid, yes_ask: market.yes_ask,
    no_bid: market.no_bid, no_ask: market.no_ask,
    score, reason,
  };
}

// Select top N markets to actively quote
export async function selectMarketsToQuote(
  kalshi: KalshiClient,
  bankroll: number,
  maxMarkets = 3,
): Promise<QuoteCandidate[]> {
  const phase = getPhaseParams(bankroll);

  // Liquidity engine needs $50+ bankroll
  if (bankroll < 50) return [];

  // Scale max markets with bankroll
  const scaledMax = phase.phase >= 3 ? maxMarkets + 2 : maxMarkets;

  const { markets } = await kalshi.getMarkets({ limit: 100, status: "active" });

  const candidates: QuoteCandidate[] = [];
  for (const market of markets) {
    if (SKIP_TICKERS.has(market.ticker)) continue;
    if (market.status !== "active") continue;

    const adverseScore = getAdverseSelectionScore(market.ticker);
    const inventory = getInventory(market.ticker);
    const candidate = scoreMarket(market, bankroll, adverseScore, inventory.net);
    candidates.push(candidate);
  }

  return candidates
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, scaledMax);
}
