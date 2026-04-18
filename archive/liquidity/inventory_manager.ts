// src/liquidity/inventory_manager.ts — Track net position per market
//
// Keeps running tally of our market-making inventory per ticker.
// When inventory gets too one-sided, signals the quote manager to
// skew quotes or pause quoting on that side.

import { config } from "../core/config.js";

export interface InventoryState {
  ticker: string;
  yes_contracts: number;
  no_contracts: number;
  net: number;              // positive = long YES, negative = long NO
  abs_net: number;
  skew_direction: "none" | "buy_yes" | "buy_no"; // Which side to favor
  should_pause: boolean;     // True if inventory too one-sided
  pnl_cents: number;         // Running realized P&L from market making
}

// In-memory inventory state
const inventory: Map<string, InventoryState> = new Map();

function getOrCreate(ticker: string): InventoryState {
  if (!inventory.has(ticker)) {
    inventory.set(ticker, {
      ticker,
      yes_contracts: 0,
      no_contracts: 0,
      net: 0,
      abs_net: 0,
      skew_direction: "none",
      should_pause: false,
      pnl_cents: 0,
    });
  }
  return inventory.get(ticker)!;
}

// Record a fill on our quote
export function recordInventoryFill(
  ticker: string,
  side: "yes" | "no",
  contracts: number,
  priceCents: number,
) {
  const state = getOrCreate(ticker);

  if (side === "yes") {
    state.yes_contracts += contracts;
  } else {
    state.no_contracts += contracts;
  }

  state.net = state.yes_contracts - state.no_contracts;
  state.abs_net = Math.abs(state.net);

  // Determine skew
  const maxInv = config.MARKET_MAKER_MAX_INVENTORY;
  if (state.net >= maxInv) {
    state.skew_direction = "buy_no";   // Overweight YES, need to buy NO / sell YES
    state.should_pause = state.net >= maxInv * 2;
  } else if (state.net <= -maxInv) {
    state.skew_direction = "buy_yes";  // Overweight NO, need to buy YES / sell NO
    state.should_pause = state.net <= -maxInv * 2;
  } else {
    state.skew_direction = "none";
    state.should_pause = false;
  }
}

// Record realized P&L when a round-trip completes
export function recordRoundTrip(ticker: string, pnlCents: number) {
  const state = getOrCreate(ticker);
  state.pnl_cents += pnlCents;
}

// Get inventory state for a specific market
export function getInventory(ticker: string): InventoryState {
  return getOrCreate(ticker);
}

// Get all markets with active inventory
export function getAllInventory(): InventoryState[] {
  return [...inventory.values()].filter(s => s.abs_net > 0 || s.pnl_cents !== 0);
}

// Calculate skew adjustment in cents for quote pricing
// When inventory is one-sided, we widen on the heavy side and tighten on the light side
export function getSkewAdjustment(ticker: string): { yes_adjust: number; no_adjust: number } {
  const state = getOrCreate(ticker);
  const maxInv = config.MARKET_MAKER_MAX_INVENTORY;

  if (state.abs_net === 0) return { yes_adjust: 0, no_adjust: 0 };

  // Skew proportional to inventory imbalance (max 3 cents)
  const skewCents = Math.min(3, Math.floor(state.abs_net / maxInv * 3));

  if (state.net > 0) {
    // Long YES: make YES cheaper to sell (lower ask), NO more expensive (higher ask)
    return { yes_adjust: -skewCents, no_adjust: skewCents };
  } else {
    return { yes_adjust: skewCents, no_adjust: -skewCents };
  }
}

// Reset inventory for a market (e.g., after position closed or market settled)
export function resetInventory(ticker: string) {
  inventory.delete(ticker);
}

// Total inventory value across all markets (for exposure tracking)
export function getTotalInventoryExposure(): number {
  let total = 0;
  for (const state of inventory.values()) {
    total += state.abs_net;
  }
  return total;
}
