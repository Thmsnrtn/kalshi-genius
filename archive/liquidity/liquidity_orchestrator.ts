// src/liquidity/liquidity_orchestrator.ts — Wire 5 liquidity modules together
//
// Provides init/start/stop/getState for the liquidity engine.
// Bankroll gate: $150 minimum to activate.
// Falls back to REST polling when WebSocket unavailable.

import { config } from "../core/config.js";
import type { KalshiClient } from "../exchanges/kalshi/kalshi_client.js";
import type { KalshiWebSocket } from "../exchanges/kalshi/kalshi_websocket.js";
import { selectMarketsToQuote } from "./quote_selector.js";
import { placeQuotes, refreshQuotes, cancelAllQuotes, getActiveQuotes, getActiveQuoteCount } from "./quote_manager.js";
import { refreshAllScores, recordPrice } from "./adverse_selection.js";
import { getAllInventory, getTotalInventoryExposure } from "./inventory_manager.js";
import { getAggregateMetrics, getTopMarkets } from "./incentive_tracker.js";

const MIN_BANKROLL = 150;
const QUOTE_CYCLE_MS = config.MARKET_MAKER_REFRESH_MS; // 2 min default
const ADVERSE_REFRESH_MS = 60_000; // Refresh adverse scores every 1 min

let running = false;
let quoteTimer: ReturnType<typeof setInterval> | null = null;
let adverseTimer: ReturnType<typeof setInterval> | null = null;
let kalshiRef: KalshiClient | null = null;
let getBankrollFn: (() => number) | null = null;
let cycleCount = 0;

export interface LiquidityState {
  running: boolean;
  active_quotes: number;
  total_inventory_exposure: number;
  cycle_count: number;
  metrics: ReturnType<typeof getAggregateMetrics>;
  top_markets: ReturnType<typeof getTopMarkets>;
  inventory: ReturnType<typeof getAllInventory>;
}

// Initialize — store references, don't start yet
export function initLiquidityEngine(
  getBankroll: () => number,
) {
  getBankrollFn = getBankroll;
  console.log("  💹 Liquidity engine initialized (waiting for $150 bankroll)");
}

// Wire Kalshi client (called after client is ready)
export function wireLiquidityEngine(
  kalshi: KalshiClient,
  kalshiWs: KalshiWebSocket | null,
) {
  kalshiRef = kalshi;

  // If WebSocket available, subscribe to fill events
  if (kalshiWs) {
    // Fill channel gives us real-time fill notifications
    // The WebSocket processes these internally — we poll for fills via REST
    console.log("  💹 Liquidity engine: WebSocket available for real-time data");
  } else {
    console.log("  💹 Liquidity engine: REST-only mode (no WebSocket)");
  }
}

// Start the quote cycle
export function startLiquidityEngine() {
  if (running) return;

  const bankroll = getBankrollFn?.() ?? 0;
  if (bankroll < MIN_BANKROLL) {
    console.log(`  💹 Liquidity engine deferred: $${bankroll.toFixed(2)} < $${MIN_BANKROLL} minimum`);
    return;
  }

  running = true;
  console.log("  💹 Liquidity engine STARTED");

  // Main quote cycle
  quoteTimer = setInterval(runQuoteCycle, QUOTE_CYCLE_MS);

  // Adverse selection refresh
  adverseTimer = setInterval(() => {
    refreshAllScores();
  }, ADVERSE_REFRESH_MS);

  // Run first cycle immediately
  setTimeout(runQuoteCycle, 5000);
}

async function runQuoteCycle() {
  if (!running || !kalshiRef || !getBankrollFn) return;

  const bankroll = getBankrollFn();

  // Auto-stop if bankroll drops below minimum
  if (bankroll < MIN_BANKROLL) {
    console.log(`  💹 Liquidity engine paused: bankroll $${bankroll.toFixed(2)} < $${MIN_BANKROLL}`);
    await cancelAllQuotes(kalshiRef, config.DRY_RUN);
    running = false;
    return;
  }

  cycleCount++;

  try {
    // Refresh stale quotes and check for adverse selection
    await refreshQuotes(kalshiRef, bankroll, config.DRY_RUN);

    // Select new markets to quote
    const currentCount = getActiveQuoteCount();
    const maxNew = 3 - currentCount; // Target 3 active quote markets
    if (maxNew > 0) {
      const candidates = await selectMarketsToQuote(kalshiRef, bankroll, maxNew);

      for (const candidate of candidates) {
        // Skip if we already have quotes on this market
        const existing = getActiveQuotes().find(q => q.ticker === candidate.ticker);
        if (existing) continue;

        await placeQuotes(kalshiRef, candidate, bankroll, config.DRY_RUN);
      }
    }

    // Update price records for adverse selection tracking
    for (const quote of getActiveQuotes()) {
      const midPrice = Math.round((quote.yes_bid_price + quote.yes_ask_price) / 2);
      recordPrice(quote.ticker, midPrice);
    }
  } catch (err: any) {
    console.error(`  💹 Quote cycle error: ${err.message}`);
  }
}

// Stop engine and cancel all quotes
export async function stopLiquidityEngine() {
  running = false;
  if (quoteTimer) { clearInterval(quoteTimer); quoteTimer = null; }
  if (adverseTimer) { clearInterval(adverseTimer); adverseTimer = null; }
  if (kalshiRef) {
    await cancelAllQuotes(kalshiRef, config.DRY_RUN);
  }
  console.log("  💹 Liquidity engine STOPPED");
}

// Get current state (for dashboard API)
export function getLiquidityState(): LiquidityState {
  return {
    running,
    active_quotes: getActiveQuoteCount(),
    total_inventory_exposure: getTotalInventoryExposure(),
    cycle_count: cycleCount,
    metrics: getAggregateMetrics(),
    top_markets: getTopMarkets(3),
    inventory: getAllInventory(),
  };
}
