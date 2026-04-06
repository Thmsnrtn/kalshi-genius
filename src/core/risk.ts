// src/core/risk.ts — Phase-based risk engine for explosive compounding

import { config, getPhaseParams } from "./config.js";

export function calculatePosition(edge: number, price: number, bankroll: number, strategy: string): number {
  if (edge <= 0 || price <= 0 || price >= 1) return 0;

  const phase = getPhaseParams(bankroll);
  const kellyFraction = edge / (1 - price);

  // Strategy-specific multipliers
  const stratMultiplier = {
    cycle_sniper: 0.6,      // More conservative — high frequency compensates
    negrisk_arb: 1.5,       // More aggressive — these are RISK FREE
    mispricing: 1.0,        // Standard
    cross_correlation: 1.2, // Slightly more — these are logical, not probabilistic
    whale_consensus: 0.8,   // Moderate — following, not leading
  }[strategy] ?? 1.0;

  const raw = bankroll * Math.max(0, Math.min(kellyFraction * phase.kelly * stratMultiplier, 0.20));
  const maxAbs = bankroll * config.ABSOLUTE_MAX_SINGLE_TRADE;
  const maxPhase = bankroll * phase.maxPosPct;

  // NegRisk can go bigger since it's guaranteed profit
  if (strategy === "negrisk_arb") {
    return Math.min(raw * 2, bankroll * 0.25, maxAbs * 2);
  }

  return Math.min(raw, maxAbs, maxPhase);
}

export function canTrade(bankroll: number, openPositions: number): { ok: boolean; reason?: string } {
  const phase = getPhaseParams(bankroll);
  if (openPositions >= phase.maxPositions) return { ok: false, reason: `Max positions (${phase.maxPositions})` };
  if (bankroll < 1) return { ok: false, reason: "Bankroll < $1" };
  return { ok: true };
}

export function meetsEdgeThreshold(edge: number, bankroll: number, strategy: string): boolean {
  // NegRisk and cross-correlation have fixed thresholds (structural, not probabilistic)
  if (strategy === "negrisk_arb") return edge >= 0.02;
  if (strategy === "cross_correlation") return edge >= 0.05;
  if (strategy === "cycle_sniper") return edge >= 0.04;
  // Standard mispricing uses phase-based threshold
  return edge >= getPhaseParams(bankroll).minEdge;
}
