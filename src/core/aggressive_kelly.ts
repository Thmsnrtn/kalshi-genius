// src/core/aggressive_kelly.ts — Aggressive Kelly criterion for small bankroll compounding
//
// Standard Kelly says bet `edge / odds`. For small bankrolls, we want MORE aggression:
// 1. Risk of ruin matters less when the bankroll is tiny (you can reload $25)
// 2. The opportunity cost of being conservative is huge (slow compounding)
// 3. High-confidence bets should get outsized allocation

import { config, getPhaseParams } from "./config.js";
import { getDb, getCalibrationData, getCouncilAttribution } from "./db.js";

export interface KellyRecommendation {
  raw_kelly: number;
  adjusted_kelly: number;
  bet_size_usd: number;
  bet_size_pct: number;
  contracts: number;
  confidence_boost: number;
  reasoning: string;
}

// ── Bankroll-based aggression multiplier ──
// Smaller bankroll = more aggression (you can always reload $25)
export function getBankrollMultiplier(bankroll: number): number {
  if (bankroll <= 50) return 1.5;   // Beast mode — swinging for the fences
  if (bankroll <= 100) return 1.3;
  if (bankroll <= 500) return 1.1;
  if (bankroll <= 2000) return 1.0; // Standard Kelly
  return 0.8;                       // Protect gains
}

// ── Strategy-specific aggression multiplier ──
function getStrategyMultiplier(strategy: string): number {
  const multipliers: Record<string, number> = {
    monotonicity_arb: 2.0,   // Risk-free!
    hourly_sniper: 1.3,      // High confidence, fast resolution
    mispricing: 1.0,
    cross_platform: 1.2,
    economic_release: 1.1,
    weather_edge: 0.9,       // Less certain
    market_maker: 0.5,       // Inventory risk
  };
  return multipliers[strategy] ?? 1.0;
}

// ── Calibration factor from historical Brier scores ──
// Returns >1 if strategy is well-calibrated (boost sizing), <1 if overconfident (reduce)
export function getCalibrationFactor(strategy: string): number {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT AVG(brier_score) as avg_brier, COUNT(*) as total
      FROM resolutions
      WHERE strategy = ? AND actual_result IS NOT NULL
    `).get(strategy) as { avg_brier: number | null; total: number } | null;

    if (!row || row.total < 5 || row.avg_brier === null) {
      // Not enough data — use neutral factor
      return 1.0;
    }

    if (row.avg_brier < 0.15) return 1.1;  // Well calibrated — slightly boost
    if (row.avg_brier > 0.30) return 0.7;  // Poorly calibrated — reduce sizing
    return 1.0;
  } catch {
    return 1.0;
  }
}

// ── Main aggressive Kelly sizing ──
export function aggressiveKelly(params: {
  edge: number;
  price: number;
  bankroll: number;
  strategy: string;
  confidence: number;
  calibration_factor?: number;
  is_arb?: boolean;
  consecutive_wins?: number;
}): KellyRecommendation {
  const {
    edge,
    price,
    bankroll,
    strategy,
    confidence,
    calibration_factor,
    is_arb = false,
    consecutive_wins = 0,
  } = params;

  // Guard: no bet if no edge or invalid price
  if (edge <= 0 || price <= 0 || price >= 1 || bankroll <= 0) {
    return {
      raw_kelly: 0,
      adjusted_kelly: 0,
      bet_size_usd: 0,
      bet_size_pct: 0,
      contracts: 0,
      confidence_boost: 0,
      reasoning: "No edge or invalid parameters",
    };
  }

  // Raw Kelly for binary markets: edge / (1 - price)
  const raw_kelly = edge / (1 - price);

  // Apply multipliers
  const bankrollMult = getBankrollMultiplier(bankroll);
  const strategyMult = getStrategyMultiplier(strategy);
  const calFactor = calibration_factor ?? getCalibrationFactor(strategy);

  // Confidence boost: outsized allocation for high-confidence bets
  let confidence_boost = 0;
  if (confidence > 0.95 && is_arb) {
    confidence_boost = 0.50; // 50% boost for near-certain arb
  } else if (confidence > 0.85) {
    confidence_boost = 0.20; // 20% boost for high confidence
  }

  // Consecutive win streak bonus: ride hot streaks (5% per win, max 25%)
  const streakBonus = Math.min(consecutive_wins * 0.05, 0.25);

  // Combine all multipliers
  const totalMultiplier = bankrollMult * strategyMult * calFactor * (1 + confidence_boost) * (1 + streakBonus);
  let adjusted_kelly = raw_kelly * totalMultiplier;

  // Cap at absolute max single trade
  const maxKelly = config.ABSOLUTE_MAX_SINGLE_TRADE;
  adjusted_kelly = Math.min(adjusted_kelly, maxKelly);

  // Compute dollar bet size
  let bet_size_usd = bankroll * adjusted_kelly;

  // Floor at $0.50 minimum bet (Kalshi minimum)
  if (bet_size_usd > 0 && bet_size_usd < 0.50) {
    bet_size_usd = 0.50;
    adjusted_kelly = bet_size_usd / bankroll;
  }

  // If bankroll is too small even for the minimum bet, skip
  if (bankroll < 0.50) {
    return {
      raw_kelly,
      adjusted_kelly: 0,
      bet_size_usd: 0,
      bet_size_pct: 0,
      contracts: 0,
      confidence_boost,
      reasoning: "Bankroll below minimum bet ($0.50)",
    };
  }

  const bet_size_pct = bet_size_usd / bankroll;
  const contracts = Math.floor(bet_size_usd / price);

  // Build reasoning string
  const parts: string[] = [];
  parts.push(`Raw Kelly: ${(raw_kelly * 100).toFixed(1)}%`);
  parts.push(`Bankroll mult: ${bankrollMult}x ($${bankroll.toFixed(0)})`);
  parts.push(`Strategy mult: ${strategyMult}x (${strategy})`);
  if (calFactor !== 1.0) parts.push(`Calibration: ${calFactor}x`);
  if (confidence_boost > 0) parts.push(`Confidence boost: +${(confidence_boost * 100).toFixed(0)}%`);
  if (streakBonus > 0) parts.push(`Streak bonus: +${(streakBonus * 100).toFixed(0)}% (${consecutive_wins} wins)`);
  parts.push(`Final: $${bet_size_usd.toFixed(2)} (${(bet_size_pct * 100).toFixed(1)}%) = ${contracts} contracts @ ${(price * 100).toFixed(0)}¢`);

  return {
    raw_kelly,
    adjusted_kelly,
    bet_size_usd,
    bet_size_pct,
    contracts,
    confidence_boost,
    reasoning: parts.join(" | "),
  };
}

// ── Monte Carlo risk of ruin estimate ──
// Simulates 10,000 paths of 100 trades to estimate probability of hitting $0
export function calculateRiskOfRuin(
  bankroll: number,
  avgBetSize: number,
  winRate: number,
  avgWinPct: number,
  avgLossPct: number,
): number {
  const NUM_SIMULATIONS = 10_000;
  const TRADES_PER_SIM = 100;
  let ruinCount = 0;

  for (let sim = 0; sim < NUM_SIMULATIONS; sim++) {
    let balance = bankroll;

    for (let t = 0; t < TRADES_PER_SIM; t++) {
      const betSize = Math.min(avgBetSize, balance);
      if (betSize <= 0) {
        ruinCount++;
        break;
      }

      const isWin = Math.random() < winRate;
      if (isWin) {
        balance += betSize * avgWinPct;
      } else {
        balance -= betSize * avgLossPct;
      }

      if (balance <= 0) {
        ruinCount++;
        break;
      }
    }
  }

  return ruinCount / NUM_SIMULATIONS;
}

// ── Compounding projection ──
// Projects bankroll growth assuming consistent edge and Kelly sizing
export function getCompoundingProjection(
  bankroll: number,
  edgePerTrade: number,
  tradesPerDay: number,
  days: number,
): number[] {
  const projection: number[] = [bankroll];
  let current = bankroll;

  // Kelly fraction for the edge (simplified: edge / (1 - 0.5) = 2 * edge)
  // Use a conservative Kelly fraction for projection
  const kellyFraction = Math.min(edgePerTrade * 2, config.ABSOLUTE_MAX_SINGLE_TRADE);

  // Expected growth per trade: win_rate * win_amount - loss_rate * loss_amount
  // For binary markets at ~50c: win_rate ~= 0.5 + edge/2, win/loss ~= bet_size
  // Simplified: E[growth] = edge * kelly * bankroll
  const winRate = 0.5 + edgePerTrade / 2;
  const expectedGrowthRate = winRate * kellyFraction - (1 - winRate) * kellyFraction;

  for (let day = 1; day <= days; day++) {
    for (let trade = 0; trade < tradesPerDay; trade++) {
      current = current * (1 + expectedGrowthRate);
    }
    projection.push(current);
  }

  return projection;
}
