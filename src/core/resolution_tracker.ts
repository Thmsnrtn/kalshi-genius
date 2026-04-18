// src/core/resolution_tracker.ts — Polls Kalshi for settled markets, closes the feedback loop

import { config, getPhaseParams } from "./config.js";
import {
  getDb,
  getOpenPositions,
  closePosition,
  logResolution,
  logMilestone,
  logPriceSnapshot,
  getPriceVelocity,
} from "./db.js";
import { KalshiClient, type KalshiMarket } from "../exchanges/kalshi/kalshi_client.js";

const RESOLUTION_CHECK_INTERVAL_MS: number = config.RESOLUTION_CHECK_INTERVAL_MS;

// Track which milestones have already been checked this session
const reachedMilestones: Set<number> = new Set();

let resolutionTimer: ReturnType<typeof setInterval> | null = null;

// ── Start the resolution polling loop ──
export function startResolutionTracker(
  kalshi: KalshiClient,
  getBankroll: () => number,
  getTotalTrades: () => number,
  getStartTime: () => number,
  onResolution: (pnl: number, ticker?: string) => void,
): void {
  console.log(`[ResolutionTracker] Starting — checking every ${RESOLUTION_CHECK_INTERVAL_MS / 1000}s`);

  // Run immediately, then on interval
  checkResolutions(kalshi, getBankroll, getTotalTrades, getStartTime, onResolution).catch((err) =>
    console.error("[ResolutionTracker] Initial check error:", err),
  );

  resolutionTimer = setInterval(() => {
    checkResolutions(kalshi, getBankroll, getTotalTrades, getStartTime, onResolution).catch((err) =>
      console.error("[ResolutionTracker] Check error:", err),
    );
  }, RESOLUTION_CHECK_INTERVAL_MS);
}

// ── Single resolution check pass ──
export async function checkResolutions(
  kalshi: KalshiClient,
  getBankroll: () => number,
  getTotalTrades: () => number,
  getStartTime: () => number,
  onResolution: (pnl: number, ticker?: string) => void,
): Promise<void> {
  const positions = getOpenPositions();
  if (positions.length === 0) return;

  for (const pos of positions) {
    try {
      const { market } = await kalshi.getMarket(pos.ticker);

      if (market.status !== "settled") continue;

      const pnlCents = calculatePnl(pos.side, pos.entry_price, pos.contracts, market.result);
      const pnlUsd = pnlCents / 100;
      const actualResult: 0 | 1 = market.result === "yes" ? 1 : 0;
      const exitReason = pnlCents >= 0 ? "settled_win" : "settled_loss";

      // Close the position
      const exitPrice = actualResult === 1 ? 100 : 0;
      closePosition(pos.id, exitPrice, exitReason, pnlUsd);

      // Log resolution for calibration
      logResolution({
        ticker: pos.ticker,
        market_question: pos.market_question ?? market.title,
        strategy: pos.strategy ?? "",
        predicted_prob: pos.predicted_prob ?? pos.entry_price / 100,
        predicted_direction: pos.side === "YES" ? "YES" : "NO",
        entry_price: pos.entry_price,
        actual_result: actualResult,
        pnl_cents: pnlCents,
        council_votes: undefined,
      });

      console.log(
        `[ResolutionTracker] Settled: ${pos.ticker} | Side: ${pos.side} | Result: ${market.result} | PnL: ${pnlCents >= 0 ? "+" : ""}${pnlCents}c ($${pnlUsd.toFixed(2)})`,
      );

      onResolution(pnlUsd, pos.ticker);
    } catch (err) {
      console.error(`[ResolutionTracker] Error checking ${pos.ticker}:`, err);
    }
  }

  // Check milestones
  checkMilestones(getBankroll(), getTotalTrades(), getStartTime());

  // Update counterfactual analysis on rejected signals
  await updateCounterfactuals(kalshi);
}

// ── PnL calculation (in cents) ──
function calculatePnl(side: string, entryPriceCents: number, contracts: number, result: string): number {
  const won = (side === "YES" && result === "yes") || (side === "NO" && result === "no");
  if (won) {
    // Win: each contract pays out 100 cents, minus what we paid
    if (side === "YES") {
      return contracts * (100 - entryPriceCents);
    } else {
      // NO side: entry_price is the NO price (100 - yes_price in some cases)
      return contracts * (100 - entryPriceCents);
    }
  } else {
    // Loss: we lose what we paid
    return -(contracts * entryPriceCents);
  }
}

// ── Check bankroll milestones ──
function checkMilestones(bankroll: number, totalTrades: number, startTime: number): void {
  const daysFromStart = (Date.now() - startTime) / (1000 * 60 * 60 * 24);

  for (const milestone of config.MILESTONES) {
    if (bankroll >= milestone && !reachedMilestones.has(milestone)) {
      reachedMilestones.add(milestone);

      // Build strategy breakdown from resolution data
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT strategy, SUM(pnl_cents) as total_pnl FROM resolutions WHERE actual_result IS NOT NULL GROUP BY strategy`,
        )
        .all() as Array<{ strategy: string; total_pnl: number }>;

      const strategyBreakdown: Record<string, number> = {};
      for (const row of rows) {
        strategyBreakdown[row.strategy || "unknown"] = row.total_pnl / 100;
      }

      logMilestone(milestone, bankroll, totalTrades, daysFromStart, strategyBreakdown);
    }
  }
}

// ── Update counterfactual PnL on rejected signals whose markets have settled ──
async function updateCounterfactuals(kalshi: KalshiClient): Promise<void> {
  const db = getDb();
  const pendingSignals = db
    .prepare(
      `SELECT id, ticker, direction, price_at_rejection FROM rejected_signals WHERE resolution_result IS NULL AND ticker IS NOT NULL`,
    )
    .all() as Array<{
    id: number;
    ticker: string;
    direction: string;
    price_at_rejection: number;
  }>;

  if (pendingSignals.length === 0) return;

  // Batch: check unique tickers only
  const tickerMap = new Map<string, Array<{ id: number; direction: string; price_at_rejection: number }>>();
  for (const sig of pendingSignals) {
    if (!tickerMap.has(sig.ticker)) tickerMap.set(sig.ticker, []);
    tickerMap.get(sig.ticker)!.push(sig);
  }

  for (const [ticker, signals] of tickerMap) {
    try {
      const { market } = await kalshi.getMarket(ticker);
      if (market.status !== "settled") continue;

      const actualResult: 0 | 1 = market.result === "yes" ? 1 : 0;

      for (const sig of signals) {
        // Simulate: if we had bought 1 contract at rejection price
        const hypotheticalContracts = 1;
        const counterfactualPnl = calculatePnl(
          sig.direction,
          sig.price_at_rejection,
          hypotheticalContracts,
          market.result,
        );

        db.prepare(
          `UPDATE rejected_signals SET resolution_result = ?, counterfactual_pnl = ? WHERE id = ?`,
        ).run(actualResult, counterfactualPnl, sig.id);
      }
    } catch {
      // Market might not exist anymore or API error — skip silently
    }
  }
}

// ── Snapshot current prices for tracked tickers ──
export async function snapshotPrices(kalshi: KalshiClient, tickers: string[]): Promise<void> {
  for (const ticker of tickers) {
    try {
      const { market } = await kalshi.getMarket(ticker);
      const yesPrice = (market.yes_bid + market.yes_ask) / 2;
      const noPrice = (market.no_bid + market.no_ask) / 2;
      logPriceSnapshot(ticker, yesPrice, noPrice, market.volume, market.volume_24h);
    } catch {
      // Skip tickers that fail (market may have been delisted)
    }
  }
}
