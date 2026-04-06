// src/evolution/regime_detector.ts
//
// MARKET REGIME DETECTION
//
// Different market conditions require different strategies. The bot
// continuously detects which "regime" the market is in and adjusts.
//
// Regimes:
// - QUIET: Low volatility, tight spreads → favor market making
// - TRENDING_UP: Sustained directional move → favor momentum sniper
// - TRENDING_DOWN: Sustained directional move → favor momentum sniper
// - VOLATILE: Whipsaw conditions → favor NegRisk arb (avoid directional)
// - NEWS_DRIVEN: Major event detected → favor Claude analysis
// - DEAD: Very low activity → conservative all around

import { getAllPrices } from "../feeds/binance.js";

export type Regime = "QUIET" | "TRENDING_UP" | "TRENDING_DOWN" | "VOLATILE" | "NEWS_DRIVEN" | "DEAD";

export interface RegimeSnapshot {
  regime: Regime;
  confidence: number;
  detected_at: number;
  metrics: {
    avg_volatility_pct: number;
    direction_consistency: number; // -1 to 1
    momentum_strength: number;
    cross_asset_correlation: number;
  };
  recommended_strategies: string[];
  recommended_aggression: number; // 0.0-1.5 multiplier
}

let currentRegime: RegimeSnapshot | null = null;
let regimeHistory: RegimeSnapshot[] = [];

export function detectRegime(): RegimeSnapshot {
  const prices = getAllPrices();
  if (prices.length === 0) {
    return defaultRegime();
  }

  // Calculate cross-asset metrics
  const volatilities = prices.map((p) => Math.abs(p.change30s));
  const avgVol = volatilities.reduce((s, v) => s + v, 0) / volatilities.length;

  const directions = prices.map((p) => Math.sign(p.change30s));
  const dirSum = directions.reduce((s, d) => s + d, 0);
  const dirConsistency = dirSum / prices.length; // -1 (all down) to 1 (all up)

  const momentum = prices.reduce((s, p) => s + Math.abs(p.change60s), 0) / prices.length;

  // Determine regime
  let regime: Regime;
  let confidence: number;
  let recommendedStrategies: string[];
  let aggression: number;

  if (avgVol < 0.05) {
    regime = "QUIET";
    confidence = 0.8;
    recommendedStrategies = ["market_making", "negrisk_arb", "mispricing"];
    aggression = 1.2; // Calm conditions = safer to be aggressive
  } else if (Math.abs(dirConsistency) >= 0.66 && momentum > 0.15) {
    regime = dirConsistency > 0 ? "TRENDING_UP" : "TRENDING_DOWN";
    confidence = 0.85;
    recommendedStrategies = ["cycle_sniper", "mispricing"];
    aggression = 1.3; // Strong trends = sniper opportunity
  } else if (avgVol > 0.25) {
    regime = "VOLATILE";
    confidence = 0.75;
    recommendedStrategies = ["negrisk_arb", "cross_correlation"]; // Risk-free / structural only
    aggression = 0.5; // Pull back hard
  } else if (avgVol > 0.40) {
    regime = "NEWS_DRIVEN";
    confidence = 0.7;
    recommendedStrategies = ["mispricing", "negrisk_arb"]; // Let Claude evaluate
    aggression = 0.7;
  } else if (avgVol < 0.02 && momentum < 0.05) {
    regime = "DEAD";
    confidence = 0.9;
    recommendedStrategies = ["negrisk_arb"]; // Only risk-free in dead markets
    aggression = 0.3;
  } else {
    regime = "QUIET";
    confidence = 0.6;
    recommendedStrategies = ["mispricing", "market_making"];
    aggression = 1.0;
  }

  const snapshot: RegimeSnapshot = {
    regime,
    confidence,
    detected_at: Date.now(),
    metrics: {
      avg_volatility_pct: avgVol,
      direction_consistency: dirConsistency,
      momentum_strength: momentum,
      cross_asset_correlation: 0, // Could compute pairwise correlations
    },
    recommended_strategies: recommendedStrategies,
    recommended_aggression: aggression,
  };

  // Track regime changes
  if (currentRegime && currentRegime.regime !== regime) {
    console.log(`  🔄 REGIME CHANGE: ${currentRegime.regime} → ${regime}`);
    regimeHistory.push(currentRegime);
    if (regimeHistory.length > 100) regimeHistory.shift();
  }

  currentRegime = snapshot;
  return snapshot;
}

export function getCurrentRegime(): RegimeSnapshot | null {
  return currentRegime;
}

export function getRegimeHistory(): RegimeSnapshot[] {
  return [...regimeHistory];
}

function defaultRegime(): RegimeSnapshot {
  return {
    regime: "QUIET",
    confidence: 0.3,
    detected_at: Date.now(),
    metrics: { avg_volatility_pct: 0, direction_consistency: 0, momentum_strength: 0, cross_asset_correlation: 0 },
    recommended_strategies: ["mispricing", "negrisk_arb"],
    recommended_aggression: 1.0,
  };
}
