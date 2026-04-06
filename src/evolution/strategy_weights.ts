// src/evolution/strategy_weights.ts
//
// BAYESIAN STRATEGY WEIGHTING
// Each strategy starts with a prior belief about its effectiveness.
// Every trade updates that belief in real-time.
// Position sizing scales with current weight.
//
// This is the mechanism by which the bot allocates more capital to
// what's working RIGHT NOW and less to what's not, automatically.

import { getDb } from "../core/db.js";
import { getPerformance } from "./performance_tracker.js";

export interface StrategyWeight {
  strategy: string;
  weight: number;          // 0.0-1.0, multiplier on position size
  confidence: number;      // 0.0-1.0, how sure we are about this weight
  alpha: number;          // Beta distribution alpha (wins + 1)
  beta: number;           // Beta distribution beta (losses + 1)
  expected_win_rate: number;
  recent_pnl: number;
  status: "hot" | "warm" | "cold" | "frozen"; // Live vs paused
  last_updated: number;
}

const STRATEGIES = [
  "cycle_sniper",
  "negrisk_arb",
  "mispricing",
  "cross_correlation",
  "whale_consensus",
  "market_making",
];

export function initStrategyWeights() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategy_weights (
      strategy TEXT PRIMARY KEY,
      weight REAL DEFAULT 0.5,
      confidence REAL DEFAULT 0.1,
      alpha REAL DEFAULT 1.0,
      beta REAL DEFAULT 1.0,
      expected_win_rate REAL DEFAULT 0.5,
      recent_pnl REAL DEFAULT 0,
      status TEXT DEFAULT 'warm',
      last_updated INTEGER DEFAULT 0
    );
  `);
  // Initialize all strategies if not present
  for (const s of STRATEGIES) {
    db.prepare(`INSERT OR IGNORE INTO strategy_weights (strategy, last_updated) VALUES (?, ?)`).run(s, Date.now());
  }
}

// ── Update weight after a trade resolves ──
export function updateWeight(strategy: string, won: boolean, pnl: number) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM strategy_weights WHERE strategy = ?`).get(strategy) as any;
  if (!row) return;

  // Bayesian update: alpha increments on win, beta on loss
  const newAlpha = row.alpha + (won ? 1 : 0);
  const newBeta = row.beta + (won ? 0 : 1);

  // Expected win rate from beta distribution: alpha / (alpha + beta)
  const expectedWinRate = newAlpha / (newAlpha + newBeta);

  // Confidence grows with sample size, capped at 0.95
  const totalTrades = newAlpha + newBeta - 2; // Subtract priors
  const confidence = Math.min(0.95, totalTrades / (totalTrades + 20));

  // Weight is expected_win_rate scaled non-linearly
  // Strategies with >55% win rate get boosted, <45% get suppressed
  let weight: number;
  if (expectedWinRate >= 0.55) weight = Math.min(1.5, 0.5 + (expectedWinRate - 0.5) * 2);
  else if (expectedWinRate >= 0.45) weight = 0.5 + (expectedWinRate - 0.5);
  else weight = Math.max(0.0, expectedWinRate - 0.1);

  // Recent PnL exponential moving average
  const recentPnl = row.recent_pnl * 0.9 + pnl * 0.1;

  // Status determination
  let status: string;
  if (totalTrades < 5) status = "warm";
  else if (expectedWinRate >= 0.65 && confidence >= 0.5) status = "hot";
  else if (expectedWinRate < 0.40 && confidence >= 0.5) status = "frozen";
  else if (recentPnl < 0 && totalTrades >= 10) status = "cold";
  else status = "warm";

  db.prepare(`
    UPDATE strategy_weights 
    SET weight = ?, confidence = ?, alpha = ?, beta = ?, 
        expected_win_rate = ?, recent_pnl = ?, status = ?, last_updated = ?
    WHERE strategy = ?
  `).run(weight, confidence, newAlpha, newBeta, expectedWinRate, recentPnl, status, Date.now(), strategy);
}

// ── Get current weights ──
export function getAllWeights(): StrategyWeight[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM strategy_weights ORDER BY weight DESC`).all() as StrategyWeight[];
}

export function getWeight(strategy: string): StrategyWeight | null {
  const db = getDb();
  return db.prepare(`SELECT * FROM strategy_weights WHERE strategy = ?`).get(strategy) as any;
}

// ── Apply weight to position sizing ──
export function applyWeightToSize(strategy: string, baseSize: number): number {
  const w = getWeight(strategy);
  if (!w) return baseSize;
  if (w.status === "frozen") return 0; // Don't trade frozen strategies
  if (w.status === "cold") return baseSize * 0.3; // Reduced sizing
  return baseSize * w.weight;
}

// ── Should this strategy fire at all? ──
export function shouldFire(strategy: string): boolean {
  const w = getWeight(strategy);
  if (!w) return true; // No data yet, allow
  return w.status !== "frozen";
}

// ── Get strategies sorted by weight (for prioritization) ──
export function getStrategyPriority(): string[] {
  return getAllWeights()
    .filter((w) => w.status !== "frozen")
    .sort((a, b) => b.weight - a.weight)
    .map((w) => w.strategy);
}
