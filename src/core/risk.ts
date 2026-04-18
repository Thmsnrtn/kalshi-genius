// src/core/risk.ts — V3 Phase-based risk engine with aggressive Kelly integration

import { config, getPhaseParams } from "./config.js";
import { aggressiveKelly, getBankrollMultiplier } from "./aggressive_kelly.js";
import { getTodayPnl } from "./db.js";

// Daily loss limit snooze — resets at midnight UTC or on bot restart
let dailyLossSnoozeUntil = 0;

export function snoozeDailyLoss(hours: number = 24): void {
  dailyLossSnoozeUntil = Date.now() + hours * 60 * 60 * 1000;
  console.log(`[Risk] Daily loss limit snoozed for ${hours}h (until ${new Date(dailyLossSnoozeUntil).toISOString()})`);
}

export function unsnoozeDailyLoss(): void {
  dailyLossSnoozeUntil = 0;
  console.log(`[Risk] Daily loss limit re-enabled`);
}

export function isDailyLossSnoozed(): boolean {
  return Date.now() < dailyLossSnoozeUntil;
}

export function calculatePosition(edge: number, price: number, bankroll: number, strategy: string, opts?: {
  confidence?: number;
  is_arb?: boolean;
  consecutive_wins?: number;
  calibration_factor?: number;
}): number {
  if (edge <= 0 || price <= 0 || price >= 1) return 0;

  // Use aggressive Kelly for precise sizing
  const rec = aggressiveKelly({
    edge,
    price,
    bankroll,
    strategy,
    confidence: opts?.confidence ?? 0.6,
    calibration_factor: opts?.calibration_factor,
    is_arb: opts?.is_arb ?? (strategy === "monotonicity_arb"),
    consecutive_wins: opts?.consecutive_wins ?? 0,
  });

  return rec.bet_size_usd;
}

export function canTrade(bankroll: number, openPositions: number): { ok: boolean; reason?: string } {
  const phase = getPhaseParams(bankroll);
  if (openPositions >= phase.maxPositions) return { ok: false, reason: `Max positions (${phase.maxPositions})` };
  if (bankroll < 0.50) return { ok: false, reason: "Bankroll < $0.50" };

  // Enforce daily loss limit (unless snoozed)
  if (!isDailyLossSnoozed()) {
    const todayPnl = getTodayPnl();
    const dailyLossLimit = -bankroll * config.DAILY_LOSS_LIMIT_PCT;
    if (todayPnl <= dailyLossLimit) {
      return { ok: false, reason: `Daily loss limit hit: $${todayPnl.toFixed(2)} (limit: $${dailyLossLimit.toFixed(2)})` };
    }
  }
  return { ok: true };
}

export function meetsEdgeThreshold(edge: number, bankroll: number, strategy: string): boolean {
  // Arb strategies have fixed thresholds
  if (strategy === "monotonicity_arb") return edge >= 0.02;
  if (strategy === "cross_platform") return edge >= 0.05;
  if (strategy === "hourly_sniper") return edge >= 0.03;  // Lower threshold — high confidence
  if (strategy === "market_maker") return edge >= 0.01;   // Spread capture, not directional
  if (strategy === "weather_edge") return edge >= 0.08;
  if (strategy === "economic_release") return edge >= 0.06;

  // Standard mispricing uses phase-based threshold
  const phase = getPhaseParams(bankroll);

  // Beast mode: lower the threshold for small bankrolls to get more trades
  if (phase.aggressive) return edge >= Math.max(0.04, phase.minEdge * 0.7);

  return edge >= phase.minEdge;
}

// How much of the bankroll is currently at risk
export function getExposure(openPositionsTotalUsd: number, bankroll: number): { pct: number; can_add: boolean; max_new_position: number } {
  const pct = bankroll > 0 ? openPositionsTotalUsd / bankroll : 1;
  const maxExposure = getPhaseParams(bankroll).aggressive ? 0.80 : 0.60;
  return {
    pct,
    can_add: pct < maxExposure,
    max_new_position: Math.max(0, (maxExposure - pct) * bankroll),
  };
}
