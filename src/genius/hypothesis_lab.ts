// src/genius/hypothesis_lab.ts
//
// THE HYPOTHESIS LABORATORY
//
// Every pattern the bot discovers is treated as a scientific hypothesis
// with a null hypothesis, alternative hypothesis, and proper statistical
// test. Patterns must achieve statistical significance before they get
// promoted to playbooks.
//
// This prevents the classic ML trap of pattern-matching to noise.
// A pattern that "works" 7/10 times in a small sample is NOT the same
// as a pattern that works 70% of the time in expectation.
//
// Statistical tests used:
// - Wilson score interval for proportion confidence
// - Binomial significance test vs null (random = 0.50)
// - Minimum sample size calculation
// - Effect size (not just p-value)

import { getDb } from "../core/db.js";

export interface Hypothesis {
  id: number;
  name: string;
  description: string;
  null_hypothesis: string;     // "This pattern is random (win rate = 0.50)"
  alternative: string;          // "This pattern wins > 0.50"
  expected_effect_size: number; // How much better than random
  // Evidence
  trials: number;
  wins: number;
  observed_rate: number;
  // Statistics
  p_value: number;
  confidence_interval_low: number;
  confidence_interval_high: number;
  effect_size: number;
  // Status
  status: "untested" | "insufficient_data" | "rejected" | "weak_support" | "strong_support" | "validated";
  created_at: number;
  last_tested: number;
  minimum_sample_size: number;
}

export function initHypothesisLab() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS hypotheses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL,
      null_hypothesis TEXT NOT NULL,
      alternative TEXT NOT NULL,
      expected_effect_size REAL NOT NULL,
      trials INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      observed_rate REAL DEFAULT 0,
      p_value REAL DEFAULT 1,
      confidence_interval_low REAL DEFAULT 0,
      confidence_interval_high REAL DEFAULT 1,
      effect_size REAL DEFAULT 0,
      status TEXT DEFAULT 'untested',
      created_at INTEGER NOT NULL,
      last_tested INTEGER NOT NULL,
      minimum_sample_size INTEGER DEFAULT 30
    );
  `);
}

// ── Register a new hypothesis to test ──
export function registerHypothesis(name: string, description: string, expectedEffect: number) {
  const db = getDb();
  const minSample = calculateMinimumSample(expectedEffect);
  db.prepare(`
    INSERT OR IGNORE INTO hypotheses 
    (name, description, null_hypothesis, alternative, expected_effect_size, 
     created_at, last_tested, minimum_sample_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, description,
    "Pattern wins at random baseline (0.50)",
    `Pattern wins > 0.50 with effect size ${expectedEffect}`,
    expectedEffect,
    Date.now(), Date.now(), minSample
  );
}

// ── Record a trial for a hypothesis ──
export function recordTrial(name: string, won: boolean) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM hypotheses WHERE name = ?`).get(name) as any;
  if (!row) return;

  const newTrials = row.trials + 1;
  const newWins = row.wins + (won ? 1 : 0);
  const newRate = newWins / newTrials;

  // Compute Wilson score interval (better than normal approximation for small samples)
  const z = 1.96; // 95% confidence
  const wilsonCenter = (newWins + z * z / 2) / (newTrials + z * z);
  const wilsonSpread = z * Math.sqrt((newWins * (newTrials - newWins) / newTrials + z * z / 4) / (newTrials + z * z)) / (newTrials + z * z);
  const ciLow = Math.max(0, wilsonCenter - wilsonSpread);
  const ciHigh = Math.min(1, wilsonCenter + wilsonSpread);

  // Binomial significance test vs null (0.5)
  const pValue = binomialTwoTailedPValue(newWins, newTrials, 0.5);

  // Effect size
  const effectSize = newRate - 0.5;

  // Status determination
  let status: string;
  if (newTrials < 5) status = "insufficient_data";
  else if (newTrials < row.minimum_sample_size && pValue > 0.05) status = "insufficient_data";
  else if (pValue < 0.01 && effectSize > 0.15) status = "validated";
  else if (pValue < 0.05 && effectSize > 0.10) status = "strong_support";
  else if (pValue < 0.10 && effectSize > 0.05) status = "weak_support";
  else if (pValue > 0.10 && newTrials >= row.minimum_sample_size) status = "rejected";
  else status = "untested";

  db.prepare(`
    UPDATE hypotheses 
    SET trials = ?, wins = ?, observed_rate = ?, p_value = ?,
        confidence_interval_low = ?, confidence_interval_high = ?, 
        effect_size = ?, status = ?, last_tested = ?
    WHERE name = ?
  `).run(newTrials, newWins, newRate, pValue, ciLow, ciHigh, effectSize, status, Date.now(), name);
}

// ── Get all validated hypotheses (these are the bot's confirmed edges) ──
export function getValidatedHypotheses(): Hypothesis[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM hypotheses 
    WHERE status IN ('strong_support', 'validated')
    ORDER BY effect_size DESC
  `).all() as Hypothesis[];
}

// ── Get rejected hypotheses (patterns we thought worked but didn't) ──
export function getRejectedHypotheses(): Hypothesis[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM hypotheses WHERE status = 'rejected'
    ORDER BY last_tested DESC LIMIT 10
  `).all() as Hypothesis[];
}

// ── Calculate minimum sample size for desired effect detection ──
function calculateMinimumSample(expectedEffect: number): number {
  // For binomial test: n ≈ (z_α + z_β)² / effect² ≈ 10.5 / effect²
  // Using α=0.05, power=0.80
  if (expectedEffect <= 0) return 100;
  const n = Math.ceil(10.5 / (expectedEffect * expectedEffect));
  return Math.min(500, Math.max(30, n));
}

// ── Binomial p-value (two-tailed) ──
function binomialTwoTailedPValue(wins: number, trials: number, nullProb: number): number {
  if (trials === 0) return 1;
  // Normal approximation (valid for n >= 30)
  const mean = trials * nullProb;
  const stdev = Math.sqrt(trials * nullProb * (1 - nullProb));
  if (stdev === 0) return wins === mean ? 1 : 0;
  const z = Math.abs((wins - mean) / stdev);
  // Two-tailed p-value from z score (using erfc approximation)
  return 2 * (1 - normalCDF(z));
}

function normalCDF(z: number): number {
  // Approximation of standard normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}

// ── Should we trade on this hypothesis? ──
export function shouldTradeHypothesis(name: string): { trade: boolean; reason: string; sizing: number } {
  const db = getDb();
  const h = db.prepare(`SELECT * FROM hypotheses WHERE name = ?`).get(name) as any;
  if (!h) return { trade: true, reason: "No hypothesis registered, default to allow", sizing: 1.0 };

  switch (h.status) {
    case "validated": return { trade: true, reason: "Statistically validated edge", sizing: 1.3 };
    case "strong_support": return { trade: true, reason: "Strong statistical support", sizing: 1.0 };
    case "weak_support": return { trade: true, reason: "Weak support, reduced size", sizing: 0.6 };
    case "insufficient_data": return { trade: true, reason: "Still gathering data", sizing: 0.8 };
    case "untested": return { trade: true, reason: "Untested, exploring", sizing: 0.5 };
    case "rejected": return { trade: false, reason: "Statistically rejected — no real edge", sizing: 0 };
    default: return { trade: true, reason: "Default", sizing: 1.0 };
  }
}

// ── Lab report ──
export interface LabReport {
  total_hypotheses: number;
  validated: number;
  strong_support: number;
  weak_support: number;
  rejected: number;
  insufficient_data: number;
  top_edges: Array<{ name: string; rate: number; trials: number; p: number; effect: number }>;
}

export function getLabReport(): LabReport {
  const db = getDb();
  const all = db.prepare(`SELECT * FROM hypotheses`).all() as any[];
  const validated = all.filter((h) => h.status === "validated").length;
  const strong = all.filter((h) => h.status === "strong_support").length;
  const weak = all.filter((h) => h.status === "weak_support").length;
  const rejected = all.filter((h) => h.status === "rejected").length;
  const insufficient = all.filter((h) => h.status === "insufficient_data").length;

  const topEdges = all
    .filter((h) => h.status === "validated" || h.status === "strong_support")
    .sort((a, b) => b.effect_size - a.effect_size)
    .slice(0, 5)
    .map((h) => ({ name: h.name, rate: h.observed_rate, trials: h.trials, p: h.p_value, effect: h.effect_size }));

  return {
    total_hypotheses: all.length,
    validated, strong_support: strong, weak_support: weak, rejected, insufficient_data: insufficient,
    top_edges: topEdges,
  };
}
