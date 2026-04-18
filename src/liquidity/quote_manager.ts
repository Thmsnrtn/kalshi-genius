// src/liquidity/quote_manager.ts — Place/cancel/refresh limit orders
//
// Manages the lifecycle of market-making quotes on Kalshi:
// 1. Post bid + ask on both sides with post_only
// 2. Cancel stale quotes
// 3. Refresh quotes when spread shifts or inventory changes
// 4. Respect adverse selection signals to pull quotes

import { config, getPhaseParams } from "../core/config.js";
import type { KalshiClient } from "../exchanges/kalshi/kalshi_client.js";
import type { QuoteCandidate } from "./quote_selector.js";
import { getSkewAdjustment, recordInventoryFill, getInventory } from "./inventory_manager.js";
import { recordFill, computeAdverseScore } from "./adverse_selection.js";
import { recordSpreadCapture, recordFillEvent } from "./incentive_tracker.js";
import { addSkipTicker } from "./quote_selector.js";

interface ActiveQuote {
  ticker: string;
  yes_bid_order_id: string | null;
  yes_ask_order_id: string | null;
  yes_bid_price: number;  // cents
  yes_ask_price: number;  // cents
  contracts: number;
  placed_at: number;
  last_refresh: number;
}

// Active quotes we're managing
const activeQuotes: Map<string, ActiveQuote> = new Map();
const STALE_MS = config.MARKET_MAKER_REFRESH_MS; // Refresh stale quotes

// Place quotes for a selected market
export async function placeQuotes(
  kalshi: KalshiClient,
  candidate: QuoteCandidate,
  bankroll: number,
  dryRun: boolean,
): Promise<ActiveQuote | null> {
  const phase = getPhaseParams(bankroll);
  const inventory = getInventory(candidate.ticker);

  // If inventory is too one-sided, skip
  if (inventory.should_pause) {
    console.log(`  💹 Skipping ${candidate.ticker}: inventory too one-sided (net=${inventory.net})`);
    return null;
  }

  // Calculate our prices — post inside the existing spread
  const insideOffset = 1; // 1 cent inside the best bid/ask
  const skew = getSkewAdjustment(candidate.ticker);

  let yesBid = candidate.yes_bid + insideOffset + skew.yes_adjust;
  let yesAsk = candidate.yes_ask - insideOffset + skew.yes_adjust;

  // Ensure our spread is still positive and at least 2 cents
  if (yesAsk - yesBid < 2) {
    yesBid = candidate.yes_bid;
    yesAsk = candidate.yes_ask;
  }

  // Clamp to valid range
  yesBid = Math.max(1, Math.min(98, Math.round(yesBid)));
  yesAsk = Math.max(2, Math.min(99, Math.round(yesAsk)));

  // Size per side: phase-scaled
  const sizePerSidePct = config.MARKET_MAKER_ORDER_SIZE_PCT;
  const sideCapitalCents = Math.floor(bankroll * sizePerSidePct * 100);
  const contractsPerSide = Math.max(1, Math.floor(sideCapitalCents / Math.max(yesBid, 1)));

  const quote: ActiveQuote = {
    ticker: candidate.ticker,
    yes_bid_order_id: null,
    yes_ask_order_id: null,
    yes_bid_price: yesBid,
    yes_ask_price: yesAsk,
    contracts: contractsPerSide,
    placed_at: Date.now(),
    last_refresh: Date.now(),
  };

  if (dryRun) {
    quote.yes_bid_order_id = `dry-bid-${candidate.ticker}-${Date.now()}`;
    quote.yes_ask_order_id = `dry-ask-${candidate.ticker}-${Date.now()}`;
    console.log(`  💹 [DRY] Quote ${candidate.ticker}: bid ${yesBid}¢ / ask ${yesAsk}¢ × ${contractsPerSide}`);
  } else {
    try {
      // Place bid (buy YES at lower price)
      const bidResult = await kalshi.placeOrder({
        ticker: candidate.ticker,
        side: "yes",
        action: "buy",
        type: "limit",
        count: contractsPerSide,
        yes_price: yesBid,
        post_only: true,
        client_order_id: `liq-bid-${candidate.ticker}-${Date.now()}`,
      });
      quote.yes_bid_order_id = bidResult.order.order_id;

      // Place ask (sell YES at higher price, equivalent to buying NO)
      const askResult = await kalshi.placeOrder({
        ticker: candidate.ticker,
        side: "no",
        action: "buy",
        type: "limit",
        count: contractsPerSide,
        no_price: 100 - yesAsk, // NO price = 100 - YES price
        post_only: true,
        client_order_id: `liq-ask-${candidate.ticker}-${Date.now()}`,
      });
      quote.yes_ask_order_id = askResult.order.order_id;

      console.log(`  💹 Posted ${candidate.ticker}: bid ${yesBid}¢ / ask ${yesAsk}¢ × ${contractsPerSide}`);
    } catch (err: any) {
      console.error(`  💹 Quote error ${candidate.ticker}: ${err.message}`);
      return null;
    }
  }

  activeQuotes.set(candidate.ticker, quote);

  // Record the spread capture potential
  recordSpreadCapture(candidate.ticker, yesAsk - yesBid, contractsPerSide);

  return quote;
}

// Cancel all quotes for a ticker
export async function cancelQuotes(kalshi: KalshiClient, ticker: string, dryRun: boolean) {
  const quote = activeQuotes.get(ticker);
  if (!quote) return;

  if (!dryRun) {
    try {
      if (quote.yes_bid_order_id) await kalshi.cancelOrder(quote.yes_bid_order_id);
      if (quote.yes_ask_order_id) await kalshi.cancelOrder(quote.yes_ask_order_id);
    } catch {}
  }

  activeQuotes.delete(ticker);
}

// Cancel all active quotes (emergency pull)
export async function cancelAllQuotes(kalshi: KalshiClient, dryRun: boolean) {
  for (const ticker of [...activeQuotes.keys()]) {
    await cancelQuotes(kalshi, ticker, dryRun);
  }
}

// Check for fills and refresh stale quotes
export async function refreshQuotes(kalshi: KalshiClient, bankroll: number, dryRun: boolean) {
  const now = Date.now();

  for (const [ticker, quote] of activeQuotes) {
    // Check if quote is stale
    if (now - quote.last_refresh > STALE_MS) {
      // Check adverse selection before refreshing
      const adverseScore = computeAdverseScore(ticker);
      if (adverseScore > 0.75) {
        console.log(`  💹 Pulling quotes on ${ticker}: adverse selection score ${adverseScore.toFixed(2)}`);
        await cancelQuotes(kalshi, ticker, dryRun);
        addSkipTicker(ticker);
        continue;
      }

      // Cancel and repost with fresh prices
      await cancelQuotes(kalshi, ticker, dryRun);
    }
  }
}

// Process a fill event (called when we detect our order was filled)
export function processFill(
  ticker: string,
  side: "yes" | "no",
  priceCents: number,
  contracts: number,
) {
  recordFill(ticker, side, priceCents);
  recordInventoryFill(ticker, side, contracts, priceCents);
  recordFillEvent(ticker, side, priceCents, contracts);

  const inv = getInventory(ticker);
  console.log(`  💹 Fill: ${side.toUpperCase()} ${contracts}×${priceCents}¢ on ${ticker} (net=${inv.net})`);
}

// Get all active quotes
export function getActiveQuotes(): ActiveQuote[] {
  return [...activeQuotes.values()];
}

// Count active quote markets
export function getActiveQuoteCount(): number {
  return activeQuotes.size;
}
