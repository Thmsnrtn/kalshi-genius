// src/core/position_manager.ts — Exit management: stop loss, take profit, trailing stop, time exit, scale-out

import { config } from "./config.js";
import { getDb, getOpenPositions, updatePositionPrice, closePosition } from "./db.js";
import { KalshiClient } from "../exchanges/kalshi/kalshi_client.js";
// ARCHIVED: import { getExitPlan, markTierExecuted } from "../velocity/velocity_engine.js";
const getExitPlan = (_id: string): any => null;
const markTierExecuted = (_id: string, _tier: number, _price?: number) => {};

const CHECK_POSITIONS_INTERVAL_MS: number = config.CHECK_POSITIONS_INTERVAL_MS;
const STOP_LOSS_PCT: number = config.STOP_LOSS_PCT;
const TAKE_PROFIT_PCT: number = config.TAKE_PROFIT_PCT;
const TRAILING_STOP_PCT: number = config.TRAILING_STOP_PCT;
const MAX_HOLD_HOURS: number = config.MAX_HOLD_HOURS;
const SCALE_OUT_AT_PCT: number = config.SCALE_OUT_AT_PCT;

let positionTimer: ReturnType<typeof setInterval> | null = null;

// ── Start the position management loop ──
export function startPositionManager(
  kalshi: KalshiClient,
  onExit: (ticker: string, pnl: number, reason: string) => void,
): void {
  console.log(`[PositionManager] Starting — checking every ${CHECK_POSITIONS_INTERVAL_MS / 1000}s`);

  // Run immediately, then on interval
  checkExits(kalshi, onExit).catch((err) =>
    console.error("[PositionManager] Initial check error:", err),
  );

  positionTimer = setInterval(() => {
    checkExits(kalshi, onExit).catch((err) =>
      console.error("[PositionManager] Check error:", err),
    );
  }, CHECK_POSITIONS_INTERVAL_MS);
}

// ── Single pass: check all open positions for exit conditions ──
export async function checkExits(
  kalshi: KalshiClient,
  onExit: (ticker: string, pnl: number, reason: string) => void,
): Promise<void> {
  const positions = getOpenPositions();
  if (positions.length === 0) return;

  for (const pos of positions) {
    try {
      const { market } = await kalshi.getMarket(pos.ticker);

      // Skip settled markets (resolution_tracker handles those)
      if (market.status === "settled") continue;

      // Auto-close positions in markets that are finalized/closed/expired
      // V6: Calculate actual PnL from settlement result instead of recording $0
      if (["closed", "finalized", "expired", "ceased_trading"].includes(market.status ?? "")) {
        let pnl = 0;
        const result = (market.result ?? "").toLowerCase();
        if (result === "yes" || result === "no") {
          const won = (pos.side.toLowerCase() === result);
          // Binary option: win pays $1/contract (100¢), lose pays $0
          pnl = won
            ? pos.contracts * (100 - pos.entry_price) / 100  // Won: payout - cost
            : pos.contracts * (-pos.entry_price) / 100;       // Lost: lost the cost
        }
        console.log(
          `[PositionManager] Market ${pos.ticker} status="${market.status}" result="${result}" — closing #${pos.id}: ${pos.side} ${pos.contracts}x @ ${pos.entry_price}¢, PnL: $${pnl.toFixed(2)}`,
        );
        closePosition(pos.id, result === pos.side.toLowerCase() ? 100 : 0, `market_${market.status}`, pnl);
        onExit(pos.ticker, pnl, `market_${market.status}`);
        continue;
      }

      // ── TURBO SMART EXIT: multi-signal early exit + underwater time cut ──
      const TURBO_PREFIXES = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M"];
      const isTurboPos = TURBO_PREFIXES.some(p => pos.ticker.startsWith(p));
      if (isTurboPos && market.close_time) {
        const minutesLeft = (new Date(market.close_time).getTime() - Date.now()) / 60000;
        const midPrice = pos.side === "YES"
          ? (market.yes_bid + market.yes_ask) / 2
          : (market.no_bid + market.no_ask) / 2;

        // TurboBrain smart exit: momentum reversal, spike detection, liquidation cascade
        if (midPrice > 0 && minutesLeft > 1) {
          try {
            const { shouldExitTurboEarly } = await import("../strategies/kalshi/turbo_brain.js");
            const exitSignal = shouldExitTurboEarly(
              pos.ticker,
              pos.side as "YES" | "NO",
              pos.entry_price,
              midPrice,
              minutesLeft,
            );
            if (exitSignal.exit) {
              const pnlCents = pos.side === "YES"
                ? pos.contracts * (midPrice - pos.entry_price)
                : pos.contracts * (pos.entry_price - midPrice);
              const pnlUsd = pnlCents / 100;
              console.log(
                `[PositionManager] 🧠 TURBO BRAIN EXIT: ${pos.ticker} — ${exitSignal.reason} | ${minutesLeft.toFixed(1)}m left, PnL: $${pnlUsd.toFixed(2)}`,
              );
              await executeExit(kalshi, pos, midPrice, pnlUsd, `turbo_brain_exit: ${exitSignal.reason}`, onExit);
              continue;
            }
          } catch (brainErr) {
            // Don't let brain errors block the fallback exit logic
            console.error("[PositionManager] TurboBrain exit check error:", brainErr);
          }
        }

        // V4 #2: Within-cycle reevaluation — add to winners, trim losers
        if (midPrice > 0 && minutesLeft > 3 && pos.contracts > 0) {
          try {
            const { reevaluatePosition } = await import("../strategies/kalshi/turbo_brain.js");
            const reeval = reevaluatePosition(
              pos.ticker,
              pos.side as "YES" | "NO",
              pos.entry_price,
              midPrice,
              minutesLeft,
              pos.contracts,
            );
            if (reeval.action === "exit") {
              const pnlCents = pos.side === "YES"
                ? pos.contracts * (midPrice - pos.entry_price)
                : pos.contracts * (pos.entry_price - midPrice);
              const pnlUsd = pnlCents / 100;
              console.log(`[PositionManager] 🧠 REEVAL EXIT: ${pos.ticker} — ${reeval.reason} | PnL: $${pnlUsd.toFixed(2)}`);
              await executeExit(kalshi, pos, midPrice, pnlUsd, `turbo_reeval_exit: ${reeval.reason}`, onExit);
              continue;
            } else if (reeval.action === "trim" && pos.contracts > 1) {
              const trimCount = Math.max(1, Math.floor(pos.contracts * 0.5));
              console.log(`[PositionManager] 🧠 REEVAL TRIM: ${pos.ticker} — selling ${trimCount}/${pos.contracts} — ${reeval.reason}`);
              // Use the existing scale-out mechanism
              try {
                const side = pos.side.toLowerCase() as "yes" | "no";
                await kalshi.placeOrder({
                  ticker: pos.ticker, side, action: "sell", type: "limit", count: trimCount,
                  yes_price: side === "yes" ? 1 : undefined,
                  no_price: side === "no" ? 1 : undefined,
                });
                const db = getDb();
                const remaining = pos.contracts - trimCount;
                const remainingSize = (remaining / pos.contracts) * pos.size_usd;
                const trimPnl = pos.side === "YES"
                  ? trimCount * (midPrice - pos.entry_price) / 100
                  : trimCount * (pos.entry_price - midPrice) / 100;
                db.prepare(`UPDATE positions SET contracts = ?, size_usd = ?, status = 'partially_closed', realized_pnl = realized_pnl + ? WHERE id = ?`)
                  .run(remaining, remainingSize, trimPnl, pos.id);
                pos.contracts = remaining;
                onExit(pos.ticker, trimPnl, "turbo_reeval_trim");
              } catch {}
            }
            // "add" action: logged but not auto-executed (would need new order placement logic)
            if (reeval.action === "add") {
              console.log(`[PositionManager] 🧠 REEVAL: ${pos.ticker} — signals strengthening, would add (${reeval.reason})`);
            }
          } catch {}
        }

        // Fallback: if <5 min left and underwater, cut immediately
        const isUnderwater = pos.side === "YES"
          ? midPrice < pos.entry_price
          : midPrice > pos.entry_price;

        if (minutesLeft < 5 && isUnderwater && midPrice > 0) {
          const pnlCents = pos.side === "YES"
            ? pos.contracts * (midPrice - pos.entry_price)
            : pos.contracts * (pos.entry_price - midPrice);
          const pnlUsd = pnlCents / 100;
          console.log(
            `[PositionManager] TURBO CUT: ${pos.ticker} underwater with ${minutesLeft.toFixed(1)}m left — exiting at ${midPrice}¢ (PnL: $${pnlUsd.toFixed(2)})`,
          );
          await executeExit(kalshi, pos, midPrice, pnlUsd, "turbo_early_cut", onExit);
          continue;
        }
      }

      // Current mid-price in cents for the side we hold
      const currentPriceCents: number =
        pos.side === "YES"
          ? (market.yes_bid + market.yes_ask) / 2
          : (market.no_bid + market.no_ask) / 2;

      // Calculate unrealized PnL in cents
      const unrealizedPnlCents: number = pos.side === "YES"
        ? pos.contracts * (currentPriceCents - pos.entry_price)
        : pos.contracts * (pos.entry_price - currentPriceCents);

      const unrealizedPnlUsd: number = unrealizedPnlCents / 100;

      // Track peak price (for trailing stop) — YES wants high, NO wants low
      const peakPrice: number = pos.side === "YES"
        ? Math.max(pos.peak_price ?? pos.entry_price, currentPriceCents)
        : Math.min(pos.peak_price ?? pos.entry_price, currentPriceCents);

      // Update position record with latest price data
      updatePositionPrice(pos.id, currentPriceCents, peakPrice, unrealizedPnlUsd);

      // ── Exit condition checks (in priority order) ──

      const sizeUsd: number = pos.size_usd;
      const holdHours: number =
        (Date.now() - new Date(pos.entry_time).getTime()) / (1000 * 60 * 60);

      // 1. STOP LOSS — always fires, regardless of velocity plan (capital preservation)
      // V6: Turbos get wider stop (65%) — they're volatile early but settle at 0 or 100,
      // so a mid-cycle drawdown often reverses. Cutting too early locks in losses.
      const TURBO_PREFIXES_SL = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M"];
      const isTurboSL = TURBO_PREFIXES_SL.some(p => pos.ticker.startsWith(p));
      const effectiveStopLoss = isTurboSL ? 0.65 : STOP_LOSS_PCT;
      if (unrealizedPnlUsd < -(sizeUsd * effectiveStopLoss)) {
        await executeExit(kalshi, pos, currentPriceCents, unrealizedPnlUsd, "stopped_out", onExit);
        continue;
      }

      // Check if this position has a velocity exit plan
      const velocityPlan = getExitPlan(pos.order_id ?? "");

      if (velocityPlan) {
        // ── VELOCITY-MANAGED POSITION ──
        // Tier exits replace take-profit and scale-out.
        // Trailing stop is disabled (conflicts with laddered exits).
        // Stop-loss already checked above. Time exit checked below.

        let tiersExecutedThisPass = 0;
        for (const tier of velocityPlan.tiers) {
          if (tier.executed) continue;
          if (tier.contracts <= 0) continue;

          // Check if current price has reached this tier's target
          const tierReached = velocityPlan.side === "YES"
            ? currentPriceCents / 100 >= tier.target_price
            : currentPriceCents / 100 <= tier.target_price;

          if (!tierReached) continue;

          // Execute tier exit — sell this tier's contracts
          const tierContracts = Math.min(tier.contracts, pos.contracts);
          if (tierContracts <= 0) continue;

          const tierPnlCents: number = velocityPlan.side === "YES"
            ? tierContracts * (currentPriceCents - pos.entry_price)
            : tierContracts * (pos.entry_price - currentPriceCents);
          const tierPnlUsd: number = tierPnlCents / 100;

          if (config.DRY_RUN) {
            console.log(
              `[PositionManager] [DRY_RUN] Velocity tier ${tier.tier} exit ${pos.ticker}: selling ${tierContracts}/${pos.contracts} contracts @ ${currentPriceCents}¢ | PnL: $${tierPnlUsd.toFixed(2)}`,
            );
          } else {
            try {
              const side = pos.side.toLowerCase() as "yes" | "no";
              await kalshi.placeOrder({
                ticker: pos.ticker,
                side,
                action: "sell",
                type: "limit",
                count: tierContracts,
                yes_price: side === "yes" ? 1 : undefined,
                no_price: side === "no" ? 1 : undefined,
              });
            } catch (orderErr: any) {
              const errMsg = String(orderErr?.message ?? orderErr ?? "");
              const isGone = errMsg.includes("invalid_order") || errMsg.includes("not_found") || errMsg.includes("insufficient_balance") || (orderErr?.status ?? 0) === 404;
              if (isGone) {
                console.log(`[PositionManager] Velocity tier exit failed — market ${pos.ticker} gone — auto-closing position #${pos.id}`);
                closePosition(pos.id, currentPriceCents, "market_expired_velocity", 0);
                onExit(pos.ticker, 0, "market_expired_velocity");
                break;
              }
              console.error(`[PositionManager] Velocity tier exit order failed for ${pos.ticker}:`, orderErr);
              continue;
            }
          }

          // Mark tier as executed
          markTierExecuted(velocityPlan.position_id, tier.tier, currentPriceCents / 100);

          // Update position: reduce contracts and size_usd proportionally
          const db = getDb();
          const remainingContracts: number = pos.contracts - tierContracts;
          const remainingSizeUsd: number = (remainingContracts / pos.contracts) * pos.size_usd;

          if (remainingContracts <= 0) {
            // All contracts sold — fully close position
            closePosition(pos.id, currentPriceCents, `velocity_tier_${tier.tier}_final`, tierPnlUsd);
            console.log(
              `[PositionManager] Velocity final tier ${tier.tier}: ${pos.ticker} fully closed | PnL: $${tierPnlUsd.toFixed(2)}`,
            );
            onExit(pos.ticker, tierPnlUsd, `velocity_tier_${tier.tier}_final`);
          } else {
            // Partial exit — update position with reduced contracts
            db.prepare(
              `UPDATE positions SET contracts = ?, size_usd = ?, status = 'partially_closed', realized_pnl = realized_pnl + ? WHERE id = ?`,
            ).run(remainingContracts, remainingSizeUsd, tierPnlUsd, pos.id);

            // Update local pos object for subsequent tier checks this pass
            pos.contracts = remainingContracts;
            pos.size_usd = remainingSizeUsd;

            console.log(
              `[PositionManager] Velocity tier ${tier.tier}: ${pos.ticker} sold ${tierContracts}, keeping ${remainingContracts} | PnL: $${tierPnlUsd.toFixed(2)}`,
            );
            onExit(pos.ticker, tierPnlUsd, `velocity_tier_${tier.tier}`);
          }

          tiersExecutedThisPass++;
        }

        // If position was fully closed by tiers, skip to next position
        if (pos.contracts <= 0) continue;

        // TIME EXIT still applies to velocity positions (liquidity protection)
        if (holdHours >= MAX_HOLD_HOURS) {
          await executeExit(kalshi, pos, currentPriceCents, unrealizedPnlUsd, "time_exit", onExit);
          continue;
        }

        // No take-profit, trailing stop, or scale-out for velocity positions
      } else {
        // ── NON-VELOCITY POSITION — existing logic unchanged ──

        // 2. TAKE PROFIT — check if price moved TAKE_PROFIT_PCT toward predicted_prob
        const predictedPriceCents: number = (pos.predicted_prob ?? 0.5) * 100;
        const entryToTarget: number = Math.abs(predictedPriceCents - pos.entry_price);
        const entryToCurrent: number = pos.side === "YES"
          ? currentPriceCents - pos.entry_price
          : pos.entry_price - currentPriceCents;

        if (entryToTarget > 0 && entryToCurrent / entryToTarget >= TAKE_PROFIT_PCT) {
          await executeExit(kalshi, pos, currentPriceCents, unrealizedPnlUsd, "take_profit", onExit);
          continue;
        }

        // 3. TRAILING STOP — profit retreated TRAILING_STOP_PCT from peak
        const hadGain = pos.side === "YES" ? peakPrice > pos.entry_price : peakPrice < pos.entry_price;
        if (hadGain) {
          const peakGain: number = Math.abs(peakPrice - pos.entry_price);
          const currentGain: number = pos.side === "YES"
            ? currentPriceCents - pos.entry_price
            : pos.entry_price - currentPriceCents;
          const retreatFromPeak: number = peakGain - Math.max(0, currentGain);
          if (peakGain > 0 && retreatFromPeak / peakGain >= TRAILING_STOP_PCT) {
            await executeExit(kalshi, pos, currentPriceCents, unrealizedPnlUsd, "trailing_stop", onExit);
            continue;
          }
        }

        // 4. TIME EXIT — held too long
        if (holdHours >= MAX_HOLD_HOURS) {
          await executeExit(kalshi, pos, currentPriceCents, unrealizedPnlUsd, "time_exit", onExit);
          continue;
        }

        // 5. SCALE OUT — sell half when unrealized >= SCALE_OUT_AT_PCT of target
        if (
          entryToTarget > 0 &&
          entryToCurrent / entryToTarget >= SCALE_OUT_AT_PCT &&
          pos.status === "open" &&
          pos.contracts > 1
        ) {
          const scaleContracts: number = Math.floor(pos.contracts / 2);
          const scalePnlCents: number = pos.side === "YES"
            ? scaleContracts * (currentPriceCents - pos.entry_price)
            : scaleContracts * (pos.entry_price - currentPriceCents);
          const scalePnlUsd: number = scalePnlCents / 100;

          if (config.DRY_RUN) {
            console.log(
              `[PositionManager] [DRY_RUN] Scale-out ${pos.ticker}: selling ${scaleContracts}/${pos.contracts} contracts | PnL: $${scalePnlUsd.toFixed(2)}`,
            );
          } else {
            try {
              const side = pos.side.toLowerCase() as "yes" | "no";
              await kalshi.placeOrder({
                ticker: pos.ticker,
                side,
                action: "sell",
                type: "limit",
                count: scaleContracts,
                yes_price: side === "yes" ? 1 : undefined,
                no_price: side === "no" ? 1 : undefined,
              });
            } catch (orderErr: any) {
              const errMsg = String(orderErr?.message ?? orderErr ?? "");
              const isGone = errMsg.includes("invalid_order") || errMsg.includes("not_found") || errMsg.includes("does not exist") || errMsg.includes("insufficient_balance") || (orderErr?.status ?? 0) === 404;
              if (isGone) {
                console.log(`[PositionManager] Scale-out failed — market ${pos.ticker} gone — auto-closing position #${pos.id}`);
                closePosition(pos.id, currentPriceCents, "market_expired_scaleout", 0);
                onExit(pos.ticker, 0, "market_expired_scaleout");
                break;
              }
              console.error(`[PositionManager] Scale-out order failed for ${pos.ticker}:`, orderErr);
              continue;
            }
          }

          // Update position: reduce contracts, mark as partially closed
          const db = getDb();
          const remainingContracts: number = pos.contracts - scaleContracts;
          const remainingSizeUsd: number = (remainingContracts / pos.contracts) * pos.size_usd;
          db.prepare(
            `UPDATE positions SET contracts = ?, size_usd = ?, status = 'partially_closed', realized_pnl = realized_pnl + ? WHERE id = ?`,
          ).run(remainingContracts, remainingSizeUsd, scalePnlUsd, pos.id);

          console.log(
            `[PositionManager] Scaled out ${pos.ticker}: sold ${scaleContracts}, keeping ${remainingContracts} | Realized: $${scalePnlUsd.toFixed(2)}`,
          );
          onExit(pos.ticker, scalePnlUsd, "scale_out");
        }
      }
    } catch (err: any) {
      // Auto-cleanup: if the market no longer exists (404) or is invalid,
      // close the position in DB so we stop retrying every 30s
      const errMsg = String(err?.message ?? err ?? "");
      const errStatus = err?.status ?? err?.response?.status ?? 0;
      const isGone =
        errStatus === 404 ||
        errMsg.includes("not_found") ||
        errMsg.includes("market not found") ||
        errMsg.includes("invalid_params") ||
        errMsg.includes("invalid_order") ||
        errMsg.includes("insufficient_balance") ||
        errMsg.includes("does not exist");

      if (isGone) {
        console.log(
          `[PositionManager] Market ${pos.ticker} no longer exists (${errStatus || errMsg.slice(0, 60)}) — auto-closing stale position #${pos.id}`,
        );
        closePosition(pos.id, pos.current_price ?? pos.entry_price, "market_expired_auto", 0);
        onExit(pos.ticker, 0, "market_expired_auto");
        continue;
      }

      console.error(`[PositionManager] Error checking ${pos.ticker}:`, err);
    }
  }
}

// ── Execute a full exit ──
async function executeExit(
  kalshi: KalshiClient,
  pos: {
    id: number;
    ticker: string;
    side: string;
    contracts: number;
    entry_price: number;
    size_usd: number;
  },
  exitPriceCents: number,
  pnlUsd: number,
  reason: string,
  onExit: (ticker: string, pnl: number, reason: string) => void,
): Promise<void> {
  if (config.DRY_RUN) {
    console.log(
      `[PositionManager] [DRY_RUN] Exit ${pos.ticker} | Reason: ${reason} | PnL: $${pnlUsd.toFixed(2)}`,
    );
  } else {
    try {
      // Kalshi V2 API requires limit orders with a price.
      // To exit immediately, sell at 1¢ (for YES side) or buy NO at 99¢ — essentially a market sell.
      const side = pos.side.toLowerCase() as "yes" | "no";
      await kalshi.placeOrder({
        ticker: pos.ticker,
        side,
        action: "sell",
        type: "limit",
        count: pos.contracts,
        // Sell at worst possible price to ensure immediate fill
        yes_price: side === "yes" ? 1 : undefined,
        no_price: side === "no" ? 1 : undefined,
      });
    } catch (orderErr: any) {
      const errMsg = String(orderErr?.message ?? orderErr ?? "");
      const errStatus = orderErr?.status ?? orderErr?.response?.status ?? 0;
      const isGone =
        errStatus === 404 ||
        errMsg.includes("not_found") ||
        errMsg.includes("market not found") ||
        errMsg.includes("invalid_order") ||
        errMsg.includes("does not exist") ||
        errMsg.includes("insufficient_balance");

      if (isGone) {
        // Market expired/settled or position doesn't exist — close the DB record so we stop retrying
        console.log(
          `[PositionManager] Exit failed — market ${pos.ticker} gone (${errStatus || errMsg.slice(0, 60)}) — force-closing position #${pos.id}`,
        );
        closePosition(pos.id, exitPriceCents, "market_expired_exit_failed", pnlUsd);
        onExit(pos.ticker, pnlUsd, "market_expired_exit_failed");
        return;
      }

      console.error(`[PositionManager] Exit order failed for ${pos.ticker}:`, orderErr);
      return;
    }
  }

  closePosition(pos.id, exitPriceCents, reason, pnlUsd);
  console.log(
    `[PositionManager] Closed ${pos.ticker} | Reason: ${reason} | PnL: ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)}`,
  );
  onExit(pos.ticker, pnlUsd, reason);
}

// ── Get a summary of all open positions ──
export function getPositionSummary(): {
  open_count: number;
  total_unrealized_pnl: number;
  positions: Array<{
    ticker: string;
    side: string;
    entry_price: number;
    current_price: number | null;
    contracts: number;
    unrealized_pnl: number;
    hold_hours: number;
    strategy: string;
  }>;
} {
  const positions = getOpenPositions();
  let totalUnrealizedPnl = 0;

  const mapped = positions.map((pos) => {
    const unrealized: number = pos.unrealized_pnl ?? 0;
    totalUnrealizedPnl += unrealized;
    const holdHours: number =
      (Date.now() - new Date(pos.entry_time).getTime()) / (1000 * 60 * 60);

    return {
      ticker: pos.ticker as string,
      side: pos.side as string,
      entry_price: pos.entry_price as number,
      current_price: (pos.current_price as number | null) ?? null,
      contracts: pos.contracts as number,
      unrealized_pnl: unrealized,
      hold_hours: Math.round(holdHours * 10) / 10,
      strategy: (pos.strategy as string) ?? "unknown",
    };
  });

  return {
    open_count: positions.length,
    total_unrealized_pnl: Math.round(totalUnrealizedPnl * 100) / 100,
    positions: mapped,
  };
}
