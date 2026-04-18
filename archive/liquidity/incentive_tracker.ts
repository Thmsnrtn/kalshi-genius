// src/liquidity/incentive_tracker.ts — Maker economics tracking
//
// Tracks spread capture P&L, fee savings from post_only, fill rates,
// and yield per market. NOT tracking rebates — account doesn't qualify
// for Kalshi's institutional incentive program.

export interface MarketMakerMetrics {
  ticker: string;
  total_fills: number;
  yes_fills: number;
  no_fills: number;
  total_contracts: number;
  spread_capture_cents: number;   // Cumulative spread earned
  fee_savings_cents: number;      // Saved by using post_only vs market orders
  round_trips: number;            // Complete buy+sell cycles
  fill_rate: number;              // 0-1, what % of our quotes get filled
  yield_per_contract_cents: number; // Average cents earned per contract
  first_fill_at: number;
  last_fill_at: number;
}

interface QuoteRecord {
  ticker: string;
  spread_cents: number;
  contracts: number;
  posted_at: number;
}

// Per-market metrics
const metrics: Map<string, MarketMakerMetrics> = new Map();

// Quote history for fill rate calculation
const quoteHistory: QuoteRecord[] = [];
const MAX_QUOTE_HISTORY = 500;

// Taker fee on Kalshi (saved by using post_only)
const TAKER_FEE_CENTS_PER_CONTRACT = 3; // ~3 cents taker fee avoided

function getOrCreate(ticker: string): MarketMakerMetrics {
  if (!metrics.has(ticker)) {
    metrics.set(ticker, {
      ticker,
      total_fills: 0,
      yes_fills: 0,
      no_fills: 0,
      total_contracts: 0,
      spread_capture_cents: 0,
      fee_savings_cents: 0,
      round_trips: 0,
      fill_rate: 0,
      yield_per_contract_cents: 0,
      first_fill_at: 0,
      last_fill_at: 0,
    });
  }
  return metrics.get(ticker)!;
}

// Record when we post a quote (for fill rate tracking)
export function recordSpreadCapture(ticker: string, spreadCents: number, contracts: number) {
  quoteHistory.push({ ticker, spread_cents: spreadCents, contracts, posted_at: Date.now() });
  if (quoteHistory.length > MAX_QUOTE_HISTORY) quoteHistory.splice(0, quoteHistory.length - MAX_QUOTE_HISTORY);
}

// Record a fill event
export function recordFillEvent(
  ticker: string,
  side: "yes" | "no",
  priceCents: number,
  contracts: number,
) {
  const m = getOrCreate(ticker);
  const now = Date.now();

  m.total_fills++;
  m.total_contracts += contracts;
  if (side === "yes") m.yes_fills++;
  else m.no_fills++;

  if (!m.first_fill_at) m.first_fill_at = now;
  m.last_fill_at = now;

  // Fee savings: each contract would have cost TAKER_FEE_CENTS if we crossed the spread
  m.fee_savings_cents += contracts * TAKER_FEE_CENTS_PER_CONTRACT;

  // Check if this creates a round trip (both sides filled)
  if (m.yes_fills > 0 && m.no_fills > 0) {
    const roundTrips = Math.min(m.yes_fills, m.no_fills);
    if (roundTrips > m.round_trips) {
      // New round trip completed — estimate spread capture
      const avgSpread = getAverageSpread(ticker);
      const newTrips = roundTrips - m.round_trips;
      m.spread_capture_cents += newTrips * avgSpread;
      m.round_trips = roundTrips;
    }
  }

  // Update yield per contract
  if (m.total_contracts > 0) {
    m.yield_per_contract_cents = (m.spread_capture_cents + m.fee_savings_cents) / m.total_contracts;
  }

  // Update fill rate
  updateFillRate(ticker);
}

function getAverageSpread(ticker: string): number {
  const recent = quoteHistory.filter(q => q.ticker === ticker).slice(-20);
  if (recent.length === 0) return 4; // Default 4 cents
  return recent.reduce((s, q) => s + q.spread_cents, 0) / recent.length;
}

function updateFillRate(ticker: string) {
  const m = getOrCreate(ticker);
  const totalQuotes = quoteHistory.filter(q => q.ticker === ticker).length;
  if (totalQuotes > 0) {
    m.fill_rate = Math.min(1, m.total_fills / totalQuotes);
  }
}

// Get metrics for a specific market
export function getMarketMetrics(ticker: string): MarketMakerMetrics | null {
  return metrics.get(ticker) ?? null;
}

// Get aggregate metrics across all markets
export function getAggregateMetrics(): {
  total_markets: number;
  total_fills: number;
  total_contracts: number;
  total_spread_capture_cents: number;
  total_fee_savings_cents: number;
  total_round_trips: number;
  avg_fill_rate: number;
  avg_yield_per_contract: number;
  total_pnl_cents: number;
} {
  const all = [...metrics.values()];
  if (all.length === 0) {
    return {
      total_markets: 0, total_fills: 0, total_contracts: 0,
      total_spread_capture_cents: 0, total_fee_savings_cents: 0,
      total_round_trips: 0, avg_fill_rate: 0, avg_yield_per_contract: 0,
      total_pnl_cents: 0,
    };
  }

  const totalFills = all.reduce((s, m) => s + m.total_fills, 0);
  const totalContracts = all.reduce((s, m) => s + m.total_contracts, 0);
  const totalSpread = all.reduce((s, m) => s + m.spread_capture_cents, 0);
  const totalFees = all.reduce((s, m) => s + m.fee_savings_cents, 0);
  const totalRoundTrips = all.reduce((s, m) => s + m.round_trips, 0);
  const avgFillRate = all.reduce((s, m) => s + m.fill_rate, 0) / all.length;
  const avgYield = totalContracts > 0 ? (totalSpread + totalFees) / totalContracts : 0;

  return {
    total_markets: all.length,
    total_fills: totalFills,
    total_contracts: totalContracts,
    total_spread_capture_cents: totalSpread,
    total_fee_savings_cents: totalFees,
    total_round_trips: totalRoundTrips,
    avg_fill_rate: avgFillRate,
    avg_yield_per_contract: avgYield,
    total_pnl_cents: totalSpread + totalFees,
  };
}

// Get top performing markets by yield
export function getTopMarkets(n = 5): MarketMakerMetrics[] {
  return [...metrics.values()]
    .filter(m => m.total_fills > 0)
    .sort((a, b) => b.yield_per_contract_cents - a.yield_per_contract_cents)
    .slice(0, n);
}
