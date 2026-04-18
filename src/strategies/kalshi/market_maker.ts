// src/strategies/kalshi/market_maker.ts — Market making on Kalshi
//
// Post limit orders on both sides of wide-spread markets to collect the spread.
// Low-risk strategy that profits from bid-ask spread capture rather than
// directional views. Requires active management to avoid inventory buildup.

import { config, getPhaseParams } from "../../core/config.js";
import { getDb } from "../../core/db.js";
import {
  KalshiClient,
  type KalshiMarket,
  type KalshiOrderBook,
  type KalshiOrderRequest,
} from "../../exchanges/kalshi/kalshi_client.js";

export interface MarketMakerQuote {
  ticker: string;
  market_question: string;
  yes_bid_price: number;     // Our bid in cents (we buy YES here)
  yes_ask_price: number;     // Our ask in cents (we sell YES here)
  spread_cents: number;      // Our spread (ask - bid)
  contracts_per_side: number;
  expected_profit_per_round_trip: number; // Cents per contract round trip
  reasoning: string;
}

// ── Scan for wide-spread markets suitable for market making ──
export async function findMarketMakingOpportunities(
  kalshi: KalshiClient,
  bankroll: number,
): Promise<MarketMakerQuote[]> {
  const quotes: MarketMakerQuote[] = [];

  try {
    const { markets } = await kalshi.getMarkets({ limit: 100 });

    for (const market of markets) {
      // Skip markets with no activity
      if (market.volume_24h < 50) continue;

      // Need both sides to have valid prices
      if (market.yes_bid <= 0 || market.yes_ask <= 0) continue;

      const marketSpread = market.yes_ask - market.yes_bid;

      // Only make markets with wide enough spreads
      if (marketSpread < config.MARKET_MAKER_MIN_SPREAD_CENTS) continue;

      try {
        // Fetch orderbook for more precise quoting
        const { orderbook } = await kalshi.getOrderbook(market.ticker, 5);

        const bestBid = getBestPrice(orderbook.yes, "bid");
        const bestAsk = getBestPrice(orderbook.yes, "ask");

        if (bestBid <= 0 || bestAsk <= 0 || bestAsk <= bestBid) continue;

        const bookSpread = bestAsk - bestBid;
        if (bookSpread < config.MARKET_MAKER_MIN_SPREAD_CENTS) continue;

        // Improve the market: bid 1 cent above best bid, ask 1 cent below best ask
        const ourBid = bestBid + 1;
        const ourAsk = bestAsk - 1;
        const ourSpread = ourAsk - ourBid;

        // Need at least 4 cents spread to cover fees on both sides
        // Kalshi taker fee is ~2-3 cents, maker fee is lower/zero
        if (ourSpread < 4) continue;

        // Fee estimate: ~1 cent per side for maker orders (conservative)
        const feesPerSide = 1;
        const profitPerRoundTrip = ourSpread - feesPerSide * 2;

        if (profitPerRoundTrip <= 0) continue;

        // Size: percentage of bankroll per side, in contract count
        const bankrollCents = bankroll * 100;
        const maxExposureCents = bankrollCents * config.MARKET_MAKER_ORDER_SIZE_PCT;
        const priceForSizing = Math.max(ourBid, 100 - ourAsk); // Use the more expensive side
        const contractsPerSide = Math.max(1, Math.floor(maxExposureCents / priceForSizing));

        const expectedProfit = profitPerRoundTrip * contractsPerSide;

        // Only return if expected profit is meaningful (> $0.10 = 10 cents)
        if (expectedProfit < 10) continue;

        quotes.push({
          ticker: market.ticker,
          market_question: market.title,
          yes_bid_price: ourBid,
          yes_ask_price: ourAsk,
          spread_cents: ourSpread,
          contracts_per_side: contractsPerSide,
          expected_profit_per_round_trip: profitPerRoundTrip,
          reasoning: `Spread: ${bookSpread}¢ (book) → ${ourSpread}¢ (ours) | ${contractsPerSide} contracts/side | ~${(expectedProfit / 100).toFixed(2)} USD/round trip | Vol24h: ${market.volume_24h}`,
        });
      } catch {
        // Orderbook fetch failed for this market — skip
        continue;
      }
    }
  } catch (err: any) {
    console.error(`Market maker scan error: ${err.message}`);
  }

  // Sort by expected profit descending
  return quotes.sort((a, b) =>
    b.expected_profit_per_round_trip * b.contracts_per_side -
    a.expected_profit_per_round_trip * a.contracts_per_side
  );
}

// ── Place both sides of a market-making quote ──
export async function placeMarketMakerOrders(
  kalshi: KalshiClient,
  quote: MarketMakerQuote,
  bankroll: number,
): Promise<{ yes_order_id?: string; no_order_id?: string }> {
  const result: { yes_order_id?: string; no_order_id?: string } = {};
  const db = getDb();

  // Expiration: 10 minutes from now (force refresh to avoid stale quotes)
  const expirationTs = Math.floor(Date.now() / 1000) + 600;

  try {
    // 1. Buy YES at our bid price (post_only to ensure maker)
    const bidClientId = `mm-bid-${quote.ticker}-${Date.now()}`;
    const bidOrder: KalshiOrderRequest = {
      ticker: quote.ticker,
      side: "yes",
      action: "buy",
      type: "limit",
      count: quote.contracts_per_side,
      yes_price: quote.yes_bid_price,
      expiration_ts: expirationTs,
      client_order_id: bidClientId,
      post_only: true,
    };

    const bidResponse = await kalshi.placeOrder(bidOrder);
    result.yes_order_id = bidResponse.order.order_id;

    // Store in limit_orders table
    db.prepare(`
      INSERT INTO limit_orders (order_id, client_order_id, ticker, side, action, order_type, price_cents, count, status, strategy, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bidResponse.order.order_id, bidClientId, quote.ticker,
      "yes", "buy", "limit", quote.yes_bid_price, quote.contracts_per_side,
      bidResponse.order.status, "market_maker",
      new Date(expirationTs * 1000).toISOString(),
    );
  } catch (err: any) {
    console.error(`Market maker bid order failed for ${quote.ticker}: ${err.message}`);
  }

  try {
    // 2. Sell YES at our ask price (equivalently: buy NO at 100 - ask)
    // Using buy NO approach for cleaner execution
    const askClientId = `mm-ask-${quote.ticker}-${Date.now()}`;
    const noPrice = 100 - quote.yes_ask_price;
    const askOrder: KalshiOrderRequest = {
      ticker: quote.ticker,
      side: "no",
      action: "buy",
      type: "limit",
      count: quote.contracts_per_side,
      no_price: noPrice,
      expiration_ts: expirationTs,
      client_order_id: askClientId,
      post_only: true,
    };

    const askResponse = await kalshi.placeOrder(askOrder);
    result.no_order_id = askResponse.order.order_id;

    // Store in limit_orders table
    db.prepare(`
      INSERT INTO limit_orders (order_id, client_order_id, ticker, side, action, order_type, price_cents, count, status, strategy, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      askResponse.order.order_id, askClientId, quote.ticker,
      "no", "buy", "limit", noPrice, quote.contracts_per_side,
      askResponse.order.status, "market_maker",
      new Date(expirationTs * 1000).toISOString(),
    );
  } catch (err: any) {
    console.error(`Market maker ask order failed for ${quote.ticker}: ${err.message}`);
  }

  return result;
}

// ── Inventory management: rebalance if we're one-sided ──
export async function manageInventory(
  kalshi: KalshiClient,
  bankroll: number,
): Promise<void> {
  try {
    const { positions } = await kalshi.getPositions({ status: "open" });

    for (const pos of positions) {
      const absPosition = Math.abs(pos.position);

      // If inventory exceeds max, reduce by half with a market order
      if (absPosition > config.MARKET_MAKER_MAX_INVENTORY) {
        const reduceCount = Math.ceil(absPosition / 2);
        const isLong = pos.position > 0;

        console.log(
          `[Market Maker] Rebalancing ${pos.ticker}: ${isLong ? "long" : "short"} ${absPosition} contracts → reducing by ${reduceCount}`,
        );

        try {
          const rebalanceOrder: KalshiOrderRequest = {
            ticker: pos.ticker,
            side: isLong ? "yes" : "no",
            action: "sell",
            type: "market",
            count: reduceCount,
            client_order_id: `mm-rebal-${pos.ticker}-${Date.now()}`,
          };

          await kalshi.placeOrder(rebalanceOrder);

          // Log the rebalance trade
          const db = getDb();
          db.prepare(`
            INSERT INTO trades (timestamp, market_question, condition_id, strategy, side, price, size, cost, dry_run, order_response)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            new Date().toISOString(),
            `MM rebalance: ${pos.ticker}`,
            pos.ticker,
            "market_maker",
            isLong ? "SELL_YES" : "SELL_NO",
            0, // Market order — price unknown until filled
            reduceCount,
            0,
            0,
            "inventory_rebalance",
          );
        } catch (err: any) {
          console.error(`Market maker rebalance failed for ${pos.ticker}: ${err.message}`);
        }
      }
    }

    // Cancel expired limit orders in our tracking table
    const db = getDb();
    const now = new Date().toISOString();
    const expiredOrders = db.prepare(`
      SELECT order_id FROM limit_orders
      WHERE strategy = 'market_maker' AND status IN ('pending', 'resting') AND expires_at < ?
    `).all(now) as Array<{ order_id: string }>;

    for (const order of expiredOrders) {
      try {
        await kalshi.cancelOrder(order.order_id);
      } catch {
        // Order may already be filled/cancelled
      }
      db.prepare(`UPDATE limit_orders SET status = 'expired', updated_at = ? WHERE order_id = ?`)
        .run(now, order.order_id);
    }
  } catch (err: any) {
    console.error(`Market maker inventory management error: ${err.message}`);
  }
}

// ── Stats: round trips, PnL, average spread ──
export function getMarketMakerStats(): {
  total_round_trips: number;
  total_pnl: number;
  avg_spread_captured: number;
} {
  try {
    const db = getDb();

    // Count trades for market_maker strategy
    const tradeStats = db.prepare(`
      SELECT COUNT(*) as total_trades, SUM(pnl) as total_pnl
      FROM trades
      WHERE strategy = 'market_maker'
    `).get() as { total_trades: number; total_pnl: number | null } | null;

    const totalTrades = tradeStats?.total_trades ?? 0;
    const totalPnl = tradeStats?.total_pnl ?? 0;

    // A round trip = a buy + sell pair, so divide by 2
    const totalRoundTrips = Math.floor(totalTrades / 2);

    // Average spread captured per round trip
    const avgSpread = totalRoundTrips > 0 ? totalPnl / totalRoundTrips : 0;

    // Also count filled limit orders for more precise tracking
    const filledOrders = db.prepare(`
      SELECT COUNT(*) as filled
      FROM limit_orders
      WHERE strategy = 'market_maker' AND status = 'filled'
    `).get() as { filled: number } | null;

    const filledCount = filledOrders?.filled ?? 0;
    const roundTripsFromLimits = Math.floor(filledCount / 2);

    // Use whichever gives more round trips (trades table may have more history)
    const bestRoundTrips = Math.max(totalRoundTrips, roundTripsFromLimits);

    return {
      total_round_trips: bestRoundTrips,
      total_pnl: totalPnl / 100, // Convert cents to dollars
      avg_spread_captured: bestRoundTrips > 0 ? totalPnl / bestRoundTrips / 100 : 0,
    };
  } catch {
    return { total_round_trips: 0, total_pnl: 0, avg_spread_captured: 0 };
  }
}

// ── Helpers ──

// Extract the best bid or ask from an orderbook level array
// Orderbook format: [[price_cents, quantity], ...]
// Bids are sorted descending (highest first), asks ascending (lowest first)
function getBestPrice(levels: Array<[number, number]>, side: "bid" | "ask"): number {
  if (!levels || levels.length === 0) return 0;
  if (side === "bid") {
    // Bids: highest price first
    return Math.max(...levels.map(([price]) => price));
  }
  // Asks: lowest price first
  return Math.min(...levels.map(([price]) => price));
}
