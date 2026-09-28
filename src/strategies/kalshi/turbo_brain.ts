// src/strategies/kalshi/turbo_brain.ts — Turbo Trading Intelligence Engine V2
//
// 18-signal composite scoring system:
// V1: 1. Mean reversion  2. BTC lead-lag  3. Volume confirmation
//     4. Kalshi divergence  5. Entry timing  6. Multi-cycle memory
//     7. Asymmetric Kelly  8. Smart exits
// V2: 9. Strike price awareness  10. Settlement probability model
//     11. Time-of-day filtering  12. Adaptive trade threshold
//     13. Kalshi spread/liquidity  14. Multi-asset correlation
//     15. Volatility-adjusted strike distance  16. Post-trade signal analysis
//     17. Opponent modeling (Kalshi price patterns)  18. Cross-cycle momentum

import { getPrice, detectCryptoSignal, detectCrossAssetCascade, predictSettlement, type PriceSnapshot } from "../../feeds/binance.js";
import { getOrderBookImbalance, getFundingBias, detectLiquidationCascade, getVPIN, getVWAP } from "../../feeds/binance_advanced.js";
import { getCurrentRegime } from "../../evolution/regime_detector.js";
import { getRecentTurboContext, getTurboStats } from "./turbo_tracker.js";
import { analyzeTurboMarket, updateCycleOpens, computeRealizedVol, type VolRegime } from "../../core/turbo_probability.js";

// ── Types ──

export interface TurboBrainSignal {
  ticker: string;
  asset: string;
  direction: "YES" | "NO";
  price: number;
  model_prob_win: number;     // Forecast for the purchased side, before any empirical blend
  confidence: number;
  size_multiplier: number;    // Asymmetric sizing based on price + edge
  reasoning: string;
  signal_sources: string[];   // Which signals contributed
  score: number;              // Raw composite score before threshold
}

export interface TurboBrainDecision {
  trade: boolean;
  explore?: boolean;            // V3: exploration probe — trade at reduced size to gather data
  signal?: TurboBrainSignal;
  skip_reason?: string;
}

// ═══════════════════════════════════════════════════════════
// GROWTH ENGINE — The bot's core DNA: compound balance upward
//
// Philosophy:
// - Every dollar won is fuel for the next trade
// - Winning signals get reinforced, losing ones get permanently weakened
// - The win rate MUST ratchet upward over time — never regress
// - Size aggressively when hot, protect capital when cold
// - Never repeat the same type of loss twice
// ═══════════════════════════════════════════════════════════

// ── Brain-specific performance tracking ──
let brainTradeCount = 0;
let brainWinCount = 0;
let brainPnL = 0;
let lastBrainTradeTime = 0;
let cyclesSinceLastTrade = 0;
let peakWinRate = 0;         // Ratchet: never let WR drop below this - 10%
let consecutiveBrainWins = 0;
let consecutiveBrainLosses = 0;

// V5: Per-cycle dedup — prevent multiple entries on the same ticker in one cycle
const cycleEntries: Map<string, number> = new Map(); // ticker → timestamp
const CYCLE_DEDUP_WINDOW = 16 * 60 * 1000; // 16 minutes (one full cycle)

// Loss pattern memory: never repeat the same mistake
interface LossPattern {
  asset: string;
  direction: "YES" | "NO";
  priceRange: string;        // "cheap" (<30¢), "mid" (30-50¢), "expensive" (>50¢)
  signals: string[];
  count: number;
  lastSeen: number;
}
const lossPatterns: LossPattern[] = [];
const MAX_LOSS_PATTERNS = 50;

function getPriceRange(price: number): string {
  return price < 0.30 ? "cheap" : price < 0.50 ? "mid" : "expensive";
}

function recordLossPattern(asset: string, direction: "YES" | "NO", price: number, signals: string[]): void {
  const range = getPriceRange(price);
  const existing = lossPatterns.find(p =>
    p.asset === asset && p.direction === direction && p.priceRange === range
  );
  if (existing) {
    existing.count++;
    existing.lastSeen = Date.now();
    existing.signals = signals; // Update with latest signals
  } else {
    lossPatterns.push({ asset, direction, priceRange: range, signals, count: 1, lastSeen: Date.now() });
    if (lossPatterns.length > MAX_LOSS_PATTERNS) lossPatterns.shift();
  }
}

function isRepeatedLossPattern(asset: string, direction: "YES" | "NO", price: number): {
  isRepeat: boolean;
  lossCount: number;
} {
  const range = getPriceRange(price);
  const pattern = lossPatterns.find(p =>
    p.asset === asset && p.direction === direction && p.priceRange === range &&
    Date.now() - p.lastSeen < 3600000 // Within last hour
  );
  if (!pattern) return { isRepeat: false, lossCount: 0 };
  return { isRepeat: pattern.count >= 2, lossCount: pattern.count };
}

export function recordBrainOutcome(won: boolean, pnl: number = 0, asset: string = "", direction: string = "", price: number = 0, signals: string[] = []): void {
  brainTradeCount++;
  brainPnL += pnl;
  if (won) {
    brainWinCount++;
    consecutiveBrainWins++;
    consecutiveBrainLosses = 0;
  } else {
    consecutiveBrainWins = 0;
    consecutiveBrainLosses++;
    // Record loss pattern so we don't repeat it
    if (asset && direction) {
      recordLossPattern(asset, direction as "YES" | "NO", price, signals);
    }
  }

  // Ratchet: track peak win rate (only after enough data)
  if (brainTradeCount >= 5) {
    const currentWR = brainWinCount / brainTradeCount;
    if (currentWR > peakWinRate) peakWinRate = currentWR;
  }
}

export function notifyBrainCycleScanned(): void {
  cyclesSinceLastTrade++;
}

function getBrainWinRate(): number {
  if (brainTradeCount < 3) return 0.50;
  return brainWinCount / brainTradeCount;
}

function getMinutesSinceLastBrainTrade(): number {
  if (lastBrainTradeTime === 0) return 999;
  return (Date.now() - lastBrainTradeTime) / 60000;
}

// V5: NOW ACTUALLY USED — bankroll-aware compounding multiplier
// Protects small bankrolls, pushes larger ones
let lastKnownBankroll = 40; // Default estimate

export function setBrainBankroll(bankroll: number): void {
  lastKnownBankroll = bankroll;
}

function getCompoundingMultiplier(): number {
  const wr = getBrainWinRate();
  const streak = consecutiveBrainWins;
  const bankroll = lastKnownBankroll;

  // Hot streak: compound harder
  let mult = 1.0;
  if (streak >= 4) mult = 1.5;
  else if (streak >= 3) mult = 1.3;
  else if (streak >= 2) mult = 1.15;

  // Cold streak: protect capital but don't stop trading
  if (consecutiveBrainLosses >= 4) mult = 0.5;
  else if (consecutiveBrainLosses >= 3) mult = 0.65;
  else if (consecutiveBrainLosses >= 2) mult = 0.8;

  // Win rate momentum: if WR is climbing, lean in
  if (brainTradeCount >= 8 && wr > 0.55) mult *= 1.15;

  // Bankroll-based scaling — THE KEY to compounding
  if (bankroll < 15) mult *= 0.5;       // Emergency mode: tiny bets only
  else if (bankroll < 25) mult *= 0.7;  // Protect last dollars
  else if (bankroll < 50) mult *= 0.9;  // Moderate caution
  else if (bankroll > 150) mult *= 1.2; // Growing — push it
  else if (bankroll > 100) mult *= 1.1; // Healthy bankroll

  return Math.max(0.3, Math.min(2.0, mult));
}

// Export brain stats for dashboard/logging
export function getBrainStats(): {
  trades: number; wins: number; winRate: number; pnl: number;
  peakWR: number; streak: number; lossPatterns: number;
} {
  return {
    trades: brainTradeCount,
    wins: brainWinCount,
    winRate: brainTradeCount > 0 ? brainWinCount / brainTradeCount : 0,
    pnl: brainPnL,
    peakWR: peakWinRate,
    streak: consecutiveBrainWins > 0 ? consecutiveBrainWins : -consecutiveBrainLosses,
    lossPatterns: lossPatterns.length,
  };
}

// ═════════════════════════════════════════════════���═════════
// ADAPTIVE DAILY GROWTH TARGET — V6
//
// Starts conservative (1.5x), ratchets toward 10x as the brain proves itself.
// The target isn't a promise — it's a north star that shapes sizing aggression.
//
// How it learns:
// - Track daily PnL % achieved over rolling 7/30 day windows
// - If the brain consistently exceeds its target → raise the target
// - If it misses → hold steady (never lower, the floor only rises)
// - Win rate, streak quality, and bankroll growth all feed the target calc
// ══════════════════════════════���════════════════════════════

import { getDb as getGrowthDb } from "../../core/db.js";

interface GrowthState {
  currentTarget: number;         // Current daily multiplier target (e.g. 1.5 = 50% daily growth)
  peakTarget: number;            // Highest target ever achieved
  daysTracked: number;           // Total days of data
  daysExceeded: number;          // Days where actual > target
  bestDailyMult: number;         // Best single-day multiplier
  avgDailyMult: number;          // Rolling average daily multiplier
  consecutiveHits: number;       // Consecutive days hitting target
  lastTargetRaise: string;       // ISO timestamp of last raise
}

let growthState: GrowthState = {
  currentTarget: 1.5,
  peakTarget: 1.5,
  daysTracked: 0,
  daysExceeded: 0,
  bestDailyMult: 1.0,
  avgDailyMult: 1.0,
  consecutiveHits: 0,
  lastTargetRaise: new Date().toISOString(),
};

// Today's running state (resets at midnight UTC)
let todayStartBankroll = 0;
let todayPnl = 0;
let todayTradeCount = 0;

export function initGrowthTargets(): void {
  const db = getGrowthDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS growth_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      start_bankroll REAL NOT NULL,
      end_bankroll REAL,
      pnl REAL DEFAULT 0,
      trades INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      win_rate REAL DEFAULT 0,
      daily_mult REAL DEFAULT 1.0,
      target_mult REAL NOT NULL,
      hit_target INTEGER DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS growth_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Load persisted state
  const saved = db.prepare(`SELECT value FROM growth_state WHERE key = 'adaptive_target'`).get() as any;
  if (saved) {
    try {
      const parsed = JSON.parse(saved.value);
      growthState = { ...growthState, ...parsed };
    } catch {}
  }

  // Bootstrap from historical daily data
  const dailyStats = db.prepare(`
    SELECT date, daily_mult, target_mult, hit_target FROM growth_targets ORDER BY date ASC
  `).all() as any[];

  if (dailyStats.length > 0) {
    growthState.daysTracked = dailyStats.length;
    growthState.daysExceeded = dailyStats.filter((d: any) => d.hit_target).length;
    const mults = dailyStats.map((d: any) => d.daily_mult).filter((m: number) => m > 0);
    if (mults.length > 0) {
      growthState.bestDailyMult = Math.max(...mults);
      growthState.avgDailyMult = mults.reduce((a: number, b: number) => a + b, 0) / mults.length;
    }
    // Count consecutive recent hits
    let streak = 0;
    for (let i = dailyStats.length - 1; i >= 0; i--) {
      if (dailyStats[i].hit_target) streak++;
      else break;
    }
    growthState.consecutiveHits = streak;
  }

  console.log(`📈 Growth target initialized: ${((growthState.currentTarget - 1) * 100).toFixed(0)}% daily (${growthState.daysTracked} days tracked, ${growthState.daysExceeded} exceeded)`);
}

// Call on startup and bankroll sync to set today's baseline
export function setGrowthBaseline(bankroll: number): void {
  if (todayStartBankroll === 0) {
    todayStartBankroll = bankroll;
    // Check if we have a record for today already
    const today = new Date().toISOString().slice(0, 10);
    const db = getGrowthDb();
    const existing = db.prepare(`SELECT start_bankroll FROM growth_targets WHERE date = ?`).get(today) as any;
    if (existing) {
      todayStartBankroll = existing.start_bankroll;
    } else {
      db.prepare(`INSERT OR IGNORE INTO growth_targets (date, start_bankroll, target_mult) VALUES (?, ?, ?)`).run(
        today, bankroll, growthState.currentTarget
      );
    }
  }
}

// Called after each trade outcome to update today's progress
export function updateGrowthProgress(pnl: number, won: boolean): void {
  todayPnl += pnl;
  todayTradeCount++;

  const today = new Date().toISOString().slice(0, 10);
  const db = getGrowthDb();
  const currentBankroll = lastKnownBankroll;
  const dailyMult = todayStartBankroll > 0 ? currentBankroll / todayStartBankroll : 1.0;
  const hitTarget = dailyMult >= growthState.currentTarget;

  db.prepare(`
    UPDATE growth_targets SET
      end_bankroll = ?, pnl = ?, trades = trades + 1,
      wins = wins + ?, daily_mult = ?, hit_target = ?
    WHERE date = ?
  `).run(currentBankroll, todayPnl, won ? 1 : 0, dailyMult, hitTarget ? 1 : 0, today);
}

// End-of-day evaluation — call this when a new day starts
export function evaluateAndRatchetTarget(): void {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const db = getGrowthDb();
  const dayData = db.prepare(`SELECT * FROM growth_targets WHERE date = ?`).get(yesterday) as any;
  if (!dayData) return;

  growthState.daysTracked++;

  if (dayData.hit_target) {
    growthState.daysExceeded++;
    growthState.consecutiveHits++;
  } else {
    growthState.consecutiveHits = 0;
  }

  if (dayData.daily_mult > growthState.bestDailyMult) {
    growthState.bestDailyMult = dayData.daily_mult;
  }

  // Recalculate rolling average from last 7 days
  const recent = db.prepare(`
    SELECT daily_mult FROM growth_targets WHERE daily_mult > 0 ORDER BY date DESC LIMIT 7
  `).all() as any[];
  if (recent.length > 0) {
    growthState.avgDailyMult = recent.reduce((s: number, r: any) => s + r.daily_mult, 0) / recent.length;
  }

  // ── RATCHET LOGIC ──
  // Raise target if: 3+ consecutive days exceeding target, OR avg daily mult > current target
  const oldTarget = growthState.currentTarget;

  if (growthState.consecutiveHits >= 3 && growthState.avgDailyMult > growthState.currentTarget * 0.9) {
    // Raise by 20% of the gap between current and 10x, capped at 10x
    const gap = 10.0 - growthState.currentTarget;
    const raise = Math.max(0.1, gap * 0.20);
    growthState.currentTarget = Math.min(10.0, growthState.currentTarget + raise);
  } else if (growthState.avgDailyMult > growthState.currentTarget * 1.2) {
    // Avg performance is 20%+ above target — the brain is sandbagging, raise it
    growthState.currentTarget = Math.min(10.0, growthState.avgDailyMult * 0.9);
  }

  if (growthState.currentTarget > oldTarget) {
    growthState.lastTargetRaise = new Date().toISOString();
    console.log(`📈 GROWTH TARGET RAISED: ${((oldTarget - 1) * 100).toFixed(0)}% → ${((growthState.currentTarget - 1) * 100).toFixed(0)}% daily`);
  }

  if (growthState.currentTarget > growthState.peakTarget) {
    growthState.peakTarget = growthState.currentTarget;
  }

  // Persist
  persistGrowthState();

  // Reset today's counters
  todayPnl = 0;
  todayTradeCount = 0;
  todayStartBankroll = lastKnownBankroll;

  // Record new day
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT OR IGNORE INTO growth_targets (date, start_bankroll, target_mult) VALUES (?, ?, ?)`).run(
    today, lastKnownBankroll, growthState.currentTarget
  );
}

function persistGrowthState(): void {
  const db = getGrowthDb();
  db.prepare(`INSERT OR REPLACE INTO growth_state (key, value) VALUES ('adaptive_target', ?)`).run(
    JSON.stringify(growthState)
  );
}

// ── Growth-aware sizing multiplier ──
// Returns a multiplier that adjusts sizing based on progress toward daily target
export function getGrowthSizingMultiplier(): number {
  if (todayStartBankroll <= 0) return 1.0;

  const currentBankroll = lastKnownBankroll;
  const dailyMult = currentBankroll / todayStartBankroll;
  const targetMult = growthState.currentTarget;
  const progress = (dailyMult - 1.0) / (targetMult - 1.0); // 0 = no progress, 1 = hit target

  const brainWR = getBrainWinRate();
  const stats = getTurboStats();
  const recentWR = stats.recent_win_rate;

  // How many cycles are left today? (rough estimate)
  const hour = new Date().getUTCHours();
  const cyclesLeft = Math.max(4, (24 - hour) * 4);
  const cyclesElapsed = Math.max(1, hour * 4);
  const urgency = cyclesElapsed / (cyclesElapsed + cyclesLeft); // 0 = start of day, 1 = end

  let mult = 1.0;

  if (progress >= 1.0) {
    // Already hit daily target — shift to capital preservation
    // Still trade but reduce size to lock in the day's gains
    mult = 0.6;
  } else if (progress >= 0.7) {
    // Close to target — normal sizing, slight push
    mult = 1.1;
  } else if (progress >= 0.3) {
    // Middling — need to push but not panic
    // Scale up if win rate supports it
    if (recentWR > 0.55) mult = 1.3;
    else mult = 1.0;
  } else if (progress < 0.1 && urgency > 0.5) {
    // Behind target in second half of day — be more aggressive IF the brain is winning
    if (recentWR > 0.55 && brainWR > 0.50) {
      mult = 1.5; // Lean in — the brain has edge
    } else {
      mult = 0.8; // Behind but no edge — don't chase losses
    }
  }

  // Never let growth pressure override cold-streak protection
  if (consecutiveBrainLosses >= 3) mult = Math.min(mult, 0.5);

  return Math.max(0.4, Math.min(2.0, mult));
}

// Get current growth state for dashboard/logging
export function getGrowthTargetState(): {
  daily_target_pct: number;
  progress_pct: number;
  today_mult: number;
  days_tracked: number;
  days_exceeded: number;
  hit_rate: number;
  consecutive_hits: number;
  best_day_mult: number;
  avg_daily_mult: number;
  peak_target_pct: number;
} {
  const dailyMult = todayStartBankroll > 0 ? lastKnownBankroll / todayStartBankroll : 1.0;
  const targetMult = growthState.currentTarget;
  const progress = targetMult > 1 ? Math.max(0, (dailyMult - 1.0) / (targetMult - 1.0)) * 100 : 0;

  return {
    daily_target_pct: (targetMult - 1) * 100,
    progress_pct: Math.min(999, progress),
    today_mult: dailyMult,
    days_tracked: growthState.daysTracked,
    days_exceeded: growthState.daysExceeded,
    hit_rate: growthState.daysTracked > 0 ? growthState.daysExceeded / growthState.daysTracked : 0,
    consecutive_hits: growthState.consecutiveHits,
    best_day_mult: growthState.bestDailyMult,
    avg_daily_mult: growthState.avgDailyMult,
    peak_target_pct: (growthState.peakTarget - 1) * 100,
  };
}

// ── Multi-cycle memory ──

interface CycleResult {
  asset: string;
  direction: "YES" | "NO";
  won: boolean;
  timestamp: number;
  signals_fired?: string[];   // V2: which signals contributed
  score?: number;             // V2: composite score at entry
}

const cycleMemory: CycleResult[] = [];
const MAX_CYCLE_MEMORY = 64; // V2: doubled for better pattern detection

// ── V2: Signal accuracy tracking (#16) ──
interface SignalAccuracy {
  signal: string;
  fired: number;
  correct: number;
}
const signalAccuracyMap = new Map<string, SignalAccuracy>();

function updateSignalAccuracy(signal: string, correct: boolean): void {
  const existing = signalAccuracyMap.get(signal) ?? { signal, fired: 0, correct: 0 };
  existing.fired++;
  if (correct) existing.correct++;
  signalAccuracyMap.set(signal, existing);
}

function getSignalWeight(signal: string): number {
  const acc = signalAccuracyMap.get(signal);
  if (!acc || acc.fired < 4) return 1.0; // Not enough data, use default weight
  const accuracy = acc.correct / acc.fired;

  // Aggressive reinforcement: winning signals get boosted hard, losers get crushed
  // 70%+ accuracy = 1.8x (this signal is gold, lean into it)
  // 55-70% = 1.2x (solid, keep using)
  // 45-55% = 1.0x (neutral)
  // 30-45% = 0.5x (weak, almost ignore)
  // <30% = 0.2x (this signal is anti-correlated, nearly kill it)
  if (accuracy >= 0.70) return 1.8;
  if (accuracy >= 0.55) return 1.0 + (accuracy - 0.55) * 5.3; // 1.0 → 1.8
  if (accuracy >= 0.45) return 1.0;
  if (accuracy >= 0.30) return 0.5;
  return 0.2; // Signal is garbage, but keep a sliver in case it flips
}

// ── V2: Time-of-day performance (#11) ──
interface HourPerformance {
  hour: number;
  trades: number;
  wins: number;
}
const hourlyPerformance = new Map<number, HourPerformance>();

export function recordHourlyResult(won: boolean): void {
  const hour = new Date().getUTCHours();
  const existing = hourlyPerformance.get(hour) ?? { hour, trades: 0, wins: 0 };
  existing.trades++;
  if (won) existing.wins++;
  hourlyPerformance.set(hour, existing);
}

function getHourWinRate(): { rate: number; trades: number; shouldSkip: boolean } {
  const hour = new Date().getUTCHours();
  const perf = hourlyPerformance.get(hour);
  if (!perf || perf.trades < 5) return { rate: 0.5, trades: perf?.trades ?? 0, shouldSkip: false };
  const rate = perf.wins / perf.trades;
  return { rate, trades: perf.trades, shouldSkip: rate < 0.30 && perf.trades >= 8 };
}

// ── V2: Opponent modeling (#17) — track Kalshi price behavior ──
interface CyclePriceSnapshot {
  asset: string;
  minutesIn: number;     // minutes since cycle opened
  yesPrice: number;
  timestamp: number;
}
const kalshiPricePatterns: CyclePriceSnapshot[] = [];
const MAX_PRICE_PATTERNS = 500;

export function recordKalshiPrice(asset: string, minutesIn: number, yesPrice: number): void {
  kalshiPricePatterns.push({ asset, minutesIn: Math.round(minutesIn), yesPrice, timestamp: Date.now() });
  if (kalshiPricePatterns.length > MAX_PRICE_PATTERNS) kalshiPricePatterns.splice(0, 100);
}

function getOpponentPattern(asset: string): {
  early_overshoot: boolean;  // prices tend to overshoot in first 3 min then revert
  efficient: boolean;        // prices move smoothly to settlement
  mean_early_yes: number;    // average YES price in first 3 min
} {
  const recent = kalshiPricePatterns.filter(p => p.asset === asset && Date.now() - p.timestamp < 3600000);
  if (recent.length < 20) return { early_overshoot: false, efficient: true, mean_early_yes: 0.50 };

  const earlyPrices = recent.filter(p => p.minutesIn <= 3);
  const latePrices = recent.filter(p => p.minutesIn >= 8);

  if (earlyPrices.length < 5 || latePrices.length < 5) {
    return { early_overshoot: false, efficient: true, mean_early_yes: 0.50 };
  }

  const meanEarly = earlyPrices.reduce((s, p) => s + p.yesPrice, 0) / earlyPrices.length;
  const meanLate = latePrices.reduce((s, p) => s + p.yesPrice, 0) / latePrices.length;

  // Overshoot: early prices deviate more from 0.50 than late prices
  const earlyDeviation = Math.abs(meanEarly - 0.50);
  const lateDeviation = Math.abs(meanLate - 0.50);
  const early_overshoot = earlyDeviation > lateDeviation * 1.3 && earlyDeviation > 0.08;

  return { early_overshoot, efficient: !early_overshoot, mean_early_yes: meanEarly };
}

// ── V2: Multi-asset correlation matrix (#14) ──
interface AssetReturn {
  asset: string;
  return15m: number;
  timestamp: number;
}
const assetReturns: AssetReturn[] = [];
const MAX_ASSET_RETURNS = 200;

export function recordAssetReturn(asset: string, return15m: number): void {
  assetReturns.push({ asset, return15m, timestamp: Date.now() });
  if (assetReturns.length > MAX_ASSET_RETURNS) assetReturns.splice(0, 50);
}

function getCorrelation(asset1: string, asset2: string): number {
  const cutoff = Date.now() - 4 * 3600000; // last 4 hours
  const r1 = assetReturns.filter(r => r.asset === asset1 && r.timestamp > cutoff);
  const r2 = assetReturns.filter(r => r.asset === asset2 && r.timestamp > cutoff);
  if (r1.length < 5 || r2.length < 5) return 0.5; // V5: neutral default — don't penalize without data

  // Simple correlation: match by time proximity
  const pairs: { a: number; b: number }[] = [];
  for (const a of r1) {
    const closest = r2.reduce((best, b) =>
      Math.abs(b.timestamp - a.timestamp) < Math.abs(best.timestamp - a.timestamp) ? b : best
    );
    if (Math.abs(closest.timestamp - a.timestamp) < 120000) { // within 2 min
      pairs.push({ a: a.return15m, b: closest.return15m });
    }
  }
  if (pairs.length < 3) return 0.5; // V5: neutral default

  const meanA = pairs.reduce((s, p) => s + p.a, 0) / pairs.length;
  const meanB = pairs.reduce((s, p) => s + p.b, 0) / pairs.length;
  let cov = 0, varA = 0, varB = 0;
  for (const p of pairs) {
    cov += (p.a - meanA) * (p.b - meanB);
    varA += (p.a - meanA) ** 2;
    varB += (p.b - meanB) ** 2;
  }
  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : 0;
}

function getCorrelationSignal(asset: string, direction: "YES" | "NO"): {
  agrees: boolean;
  strength: number;
  divergent_asset?: string;
} {
  if (asset === "BTC") return { agrees: true, strength: 0 }; // BTC is the reference

  const others = ["BTC", "ETH", "SOL", "XRP"].filter(a => a !== asset);
  let agreements = 0;
  let divergentAsset: string | undefined;

  for (const other of others) {
    const otherSymbol = other === "BTC" ? "btcusdt" : other === "ETH" ? "ethusdt" : other === "SOL" ? "solusdt" : "xrpusdt";
    const otherSnap = getPrice(otherSymbol);
    if (!otherSnap) continue;

    const otherDir = (otherSnap.change30s ?? 0) > 0 ? "YES" : "NO";
    const corr = getCorrelation(asset, other);

    if (corr > 0.6) {
      // High correlation: other asset should agree
      if (otherDir === direction) agreements++;
      else {
        divergentAsset = other;
      }
    } else if (corr < 0.2) {
      // Low correlation: divergence is expected, not penalized
      agreements++;
    }
  }

  return {
    agrees: agreements >= 2,
    strength: agreements / others.length,
    divergent_asset: divergentAsset,
  };
}

export function recordCycleResult(asset: string, direction: "YES" | "NO", won: boolean, signalsFired?: string[], score?: number): void {
  cycleMemory.push({ asset, direction, won, timestamp: Date.now(), signals_fired: signalsFired, score });
  if (cycleMemory.length > MAX_CYCLE_MEMORY) cycleMemory.shift();

  // V2 #16: Update signal accuracy tracking
  if (signalsFired) {
    for (const sig of signalsFired) {
      updateSignalAccuracy(sig, won);
    }
  }

  // V2 #11: Update hourly performance
  recordHourlyResult(won);

  // V2 #14: Record asset return for correlation tracking
  const symbol = asset === "BTC" ? "btcusdt" : asset === "ETH" ? "ethusdt" : asset === "SOL" ? "solusdt" : "xrpusdt";
  const snap = getPrice(symbol);
  if (snap) {
    const return15m = snap.change60s ?? 0; // Use 60s change as proxy
    recordAssetReturn(asset, return15m);
  }
}

function getRecentCycles(asset: string, n: number = 8): CycleResult[] {
  return cycleMemory.filter(c => c.asset === asset).slice(-n);
}

// ── Core Analysis Functions ──

// #1: Mean reversion detection — is this a spike or sustained trend?
function analyzeMoveType(snap: PriceSnapshot): {
  type: "spike" | "trend" | "flat";
  reversal_risk: number;  // 0-1, higher = more likely to revert
} {
  const c5 = snap.change5s ?? 0;
  const c30 = snap.change30s ?? 0;
  const c60 = snap.change60s ?? 0;

  const absC5 = Math.abs(c5);
  const absC30 = Math.abs(c30);
  const absC60 = Math.abs(c60);

  // Spike: 5s move is large but 60s is flat or opposite
  if (absC5 > 0.05 && absC60 < 0.02) {
    return { type: "spike", reversal_risk: 0.8 };
  }
  // Spike: 5s move much bigger than 30s (acceleration without base)
  if (absC5 > absC30 * 3 && absC5 > 0.03) {
    return { type: "spike", reversal_risk: 0.7 };
  }
  // Trend: all timeframes agree in direction and magnitude builds
  const allUp = c5 > 0 && c30 > 0 && c60 > 0;
  const allDown = c5 < 0 && c30 < 0 && c60 < 0;
  if ((allUp || allDown) && absC30 > 0.01) {
    return { type: "trend", reversal_risk: 0.2 };
  }
  // Moderate move — some agreement
  if (absC30 > 0.005) {
    const sameDir = (c5 > 0 && c30 > 0) || (c5 < 0 && c30 < 0);
    return { type: sameDir ? "trend" : "spike", reversal_risk: sameDir ? 0.35 : 0.6 };
  }

  return { type: "flat", reversal_risk: 0.5 };
}

// #2: BTC lead-lag — does BTC predict this alt's move?
function getBtcLeadSignal(asset: string): {
  signal: "YES" | "NO" | null;
  confidence: number;
  lag_pct: number;
} {
  if (asset === "BTC") return { signal: null, confidence: 0, lag_pct: 0 };

  const btcSnap = getPrice("btcusdt");
  const cascades = detectCrossAssetCascade();

  const symbol = asset === "ETH" ? "ethusdt" : asset === "SOL" ? "solusdt" : "xrpusdt";
  const altSnap = getPrice(symbol);

  if (!btcSnap || !altSnap) return { signal: null, confidence: 0, lag_pct: 0 };

  // Find cascade for this alt
  const cascade = cascades.find(c => c.follower === asset);

  if (cascade && cascade.gap_pct > 0.05) {
    // BTC moved but alt hasn't caught up yet
    const dir = cascade.direction === "up" ? "YES" : "NO";
    return {
      signal: dir as "YES" | "NO",
      confidence: Math.min(0.8, cascade.confidence + 0.1),
      lag_pct: cascade.gap_pct,
    };
  }

  // Manual check: BTC moved in 5s but alt hasn't
  const btcMove = btcSnap.change5s ?? 0;
  const altMove = altSnap.change5s ?? 0;
  const gap = Math.abs(btcMove) - Math.abs(altMove);

  if (Math.abs(btcMove) > 0.03 && gap > 0.02) {
    return {
      signal: btcMove > 0 ? "YES" : "NO",
      confidence: Math.min(0.7, 0.4 + gap * 5),
      lag_pct: gap,
    };
  }

  return { signal: null, confidence: 0, lag_pct: 0 };
}

// #3: Volume confirmation
function getVolumeConfirmation(symbol: string, direction: "YES" | "NO"): {
  confirmed: boolean;
  strength: number;  // 0-1
} {
  const obi = getOrderBookImbalance(symbol);
  const vpin = getVPIN(symbol);

  if (!obi || !vpin) return { confirmed: false, strength: 0 };

  let score = 0;

  // Order book imbalance agrees with direction
  const obiAgrees = (direction === "YES" && obi.weighted_imbalance > 0.15) ||
                    (direction === "NO" && obi.weighted_imbalance < -0.15);
  if (obiAgrees) score += 0.4;

  // Strong OBI signal
  if ((direction === "YES" && obi.signal === "strong_buy") ||
      (direction === "NO" && obi.signal === "strong_sell")) {
    score += 0.3;
  }

  // VPIN shows informed trading in our direction
  if (vpin.vpin > 0.5) {
    const vpinAgrees = (direction === "YES" && vpin.bucket_imbalance > 0.1) ||
                       (direction === "NO" && vpin.bucket_imbalance < -0.1);
    if (vpinAgrees) score += 0.3;
  }

  return { confirmed: score >= 0.4, strength: Math.min(1, score) };
}

// #4: Kalshi price divergence — only trade when Kalshi disagrees
function getKalshiDivergence(
  kalshiYesPrice: number,
  binanceDirection: "YES" | "NO",
  moveStrength: number,
): { divergent: boolean; edge: number } {
  // "Fair" price based on momentum: strong up → YES should be ~60-70¢
  // If Kalshi has YES at 40¢ and Binance says strong up, that's a 20-30¢ edge
  const impliedFairYes = binanceDirection === "YES"
    ? 0.50 + Math.min(moveStrength * 50, 0.25)   // Cap at 75¢ implied
    : 0.50 - Math.min(moveStrength * 50, 0.25);   // Floor at 25¢ implied

  const edge = binanceDirection === "YES"
    ? impliedFairYes - kalshiYesPrice    // YES: we want cheap YES contracts
    : kalshiYesPrice - impliedFairYes;   // NO: we want cheap NO (expensive YES)

  return {
    divergent: edge > 0.05,  // At least 5¢ divergence
    edge: Math.max(0, edge),
  };
}

// #6: Multi-cycle pattern analysis
function getCyclePattern(asset: string): {
  streak_direction: "YES" | "NO" | null;
  streak_length: number;
  reversion_probability: number;
  trend_day: boolean;
} {
  const recent = getRecentCycles(asset, 8);
  if (recent.length < 3) return { streak_direction: null, streak_length: 0, reversion_probability: 0.5, trend_day: false };

  // Count streak from most recent
  let streakDir = recent[recent.length - 1].direction;
  let streakLen = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].direction === streakDir) streakLen++;
    else break;
  }

  // Reversion probability increases with streak length
  // After 4+ same-direction cycles, reversion becomes likely
  const reversionProb = streakLen >= 5 ? 0.7 : streakLen >= 4 ? 0.6 : streakLen >= 3 ? 0.55 : 0.45;

  // Trend day: 6+ of last 8 cycles went the same direction
  const yesCount = recent.filter(c => c.direction === "YES").length;
  const trendDay = yesCount >= 6 || yesCount <= 2;

  return {
    streak_direction: streakLen >= 2 ? streakDir : null,
    streak_length: streakLen,
    reversion_probability: reversionProb,
    trend_day: trendDay,
  };
}

// #7: Growth-aware Kelly sizing
// Key insight: every dollar risked is a compounding opportunity
// Cheap contracts with confirmed signals = the sweet spot for growth
function getAsymmetricSizeMultiplier(price: number, confidence: number): number {
  const payoutRatio = (1 - price) / price;

  // Kelly fraction: (confidence * payoutRatio - (1-confidence)) / payoutRatio
  const kellyFraction = (confidence * payoutRatio - (1 - confidence)) / payoutRatio;
  if (kellyFraction <= 0) return 0; // No edge

  // Growth-adjusted Kelly: use third-Kelly when cold, half-Kelly when hot
  const brainWR = getBrainWinRate();
  const kellyScale = brainWR >= 0.55 ? 0.50 :  // Hot: half-Kelly (more aggressive)
                     brainWR >= 0.45 ? 0.35 :   // Warm: third-Kelly
                     0.25;                        // Cold: quarter-Kelly (protect)
  const scaledKelly = kellyFraction * kellyScale;

  // V5: Cheap contract bonus — 25-35¢ is the sweet spot (floor is now 25¢)
  // Risk $0.30 to win $0.70 = 2.3:1 payout, perfect for growth
  const cheapBonus = price < 0.30 ? 1.4 : price < 0.35 ? 1.3 : price < 0.40 ? 1.15 : 1.0;

  // Compounding multiplier: lean into hot streaks
  const compMult = consecutiveBrainWins >= 3 ? 1.3 : consecutiveBrainWins >= 2 ? 1.15 : 1.0;
  const coldMult = consecutiveBrainLosses >= 3 ? 0.6 : consecutiveBrainLosses >= 2 ? 0.8 : 1.0;

  return Math.min(3.0, Math.max(0.3, scaledKelly * 10 * cheapBonus * compMult * coldMult));
}

// ── V2 #9: Strike price awareness ──
// Turbo markets ask "will price be up/down?" — the strike is the opening price.
// We estimate the cycle open price from the 15-min VWAP baseline or price history.
function getStrikeDistance(symbol: string, isUpMarket: boolean): {
  distance_pct: number;      // how far price has already moved from estimated open
  favorable: boolean;        // price already moved in our direction
  probability_boost: number; // 0-1 boost based on distance
} {
  const snap = getPrice(symbol);
  if (!snap) return { distance_pct: 0, favorable: false, probability_boost: 0 };

  const vwap = getVWAP(symbol);
  // Estimate cycle open as VWAP (best proxy for opening price over this 15-min window)
  const estimatedOpen = vwap ? vwap.vwap : snap.price;
  const distance_pct = (snap.price - estimatedOpen) / estimatedOpen;

  // For "up" market: positive distance = already above open = favorable
  const favorable = isUpMarket ? distance_pct > 0.001 : distance_pct < -0.001;

  // Probability boost: if already 0.3% above open with 10 min left, high chance of settling up
  let probability_boost = 0;
  if (favorable) {
    const absDist = Math.abs(distance_pct);
    probability_boost = Math.min(0.4, absDist * 40); // 0.1% = 0.04 boost, 1% = 0.40 boost
  }

  return { distance_pct, favorable, probability_boost };
}

// ── V2 #10: Settlement probability model ──
// Binary option pricing: P(settle above) ≈ Φ((current - strike) / (σ * √T))
function getSettlementProbability(symbol: string, isUpMarket: boolean, minutesRemaining: number): {
  probability: number;    // estimated P(up) or P(down) depending on market type
  edge_vs_kalshi: number; // our estimate minus Kalshi's implied prob
  vol_15m: number;        // estimated 15-min volatility
} {
  const snap = getPrice(symbol);
  if (!snap) return { probability: 0.50, edge_vs_kalshi: 0, vol_15m: 0 };

  const settlement = predictSettlement(symbol);
  if (!settlement) return { probability: 0.50, edge_vs_kalshi: 0, vol_15m: 0 };

  // Use predicted settlement vs current price direction
  const priceDiff = settlement.predicted_price - snap.price;
  const movingUp = priceDiff > 0;

  // Estimate 15-min volatility from recent price changes
  const c60 = Math.abs(snap.change60s ?? 0);
  const c30 = Math.abs(snap.change30s ?? 0);
  // Annualize: 60s vol * sqrt(15) for 15-min vol estimate
  const vol_60s = Math.max(c60, c30 * 1.4);
  const vol_15m = vol_60s * Math.sqrt(15);

  // Simple normal approximation for binary option
  // P(up) = Φ(z) where z = (current - open) / (vol * sqrt(T_remaining / T_total))
  const vwap = getVWAP(symbol);
  const estimatedOpen = vwap ? vwap.vwap : snap.price;
  const dist = (snap.price - estimatedOpen) / estimatedOpen;
  const timeRatio = Math.max(0.01, minutesRemaining / 15);
  const adjustedVol = Math.max(0.001, vol_15m * Math.sqrt(timeRatio));

  // Z-score: positive means price is above open
  const z = dist / adjustedVol;
  // Approximate Φ(z) using logistic function: 1 / (1 + e^(-1.7*z))
  const probUp = 1 / (1 + Math.exp(-1.7 * z));

  const probability = isUpMarket ? probUp : 1 - probUp;

  return { probability, edge_vs_kalshi: 0, vol_15m }; // edge filled in analyzeTurboOpportunity
}

// ── GROWTH ENGINE: Adaptive threshold ──
// Core rule: The bot MUST trade to compound. Dead money loses to time.
// Threshold adjusts to maintain ~3-6 trades per hour (aggressive but selective).
function getAdaptiveThreshold(): { threshold: number; exploreThreshold: number } {
  const brainWR = getBrainWinRate();
  const hasBrainData = brainTradeCount >= 3;

  // Phase 1: Learning (first 10 brain trades) — trade aggressively to gather data
  if (brainTradeCount < 10) {
    const minutesIdle = getMinutesSinceLastBrainTrade();
    const idleDiscount = minutesIdle > 30 ? 0.06 : minutesIdle > 15 ? 0.03 : 0;
    return { threshold: Math.max(0.20, 0.30 - idleDiscount), exploreThreshold: 0.18 };
  }

  // Phase 2: Calibrated — use brain win rate to set threshold
  let base: number;
  if (brainWR >= 0.60) base = 0.22;     // Crushing it — max aggression, take every edge
  else if (brainWR >= 0.50) base = 0.28; // Profitable — stay aggressive
  else if (brainWR >= 0.40) base = 0.33; // Breakeven — slight caution, still trading
  else if (brainWR >= 0.30) base = 0.38; // Below breakeven — tighten but don't freeze
  else base = 0.42;                      // Bad streak — be selective, not dead

  // Win rate ratchet: if we've ever been above 50%, don't let threshold go above 0.38
  // This prevents one bad streak from making the bot too scared
  if (peakWinRate > 0.50 && base > 0.38) base = 0.38;

  // Hot streak bonus: when consecutive wins, the signals are clearly working, lean in
  if (consecutiveBrainWins >= 3) base -= 0.05;
  if (consecutiveBrainWins >= 5) base -= 0.05; // Extra aggressive on heater

  // Activity pressure: compound growth REQUIRES trades
  const minutesIdle = getMinutesSinceLastBrainTrade();
  const idleDiscount = minutesIdle > 45 ? 0.08 : minutesIdle > 20 ? 0.04 : 0;
  const cycleDiscount = cyclesSinceLastTrade > 6 ? 0.05 : cyclesSinceLastTrade > 3 ? 0.03 : 0;

  const threshold = Math.max(0.18, Math.min(0.45, base - idleDiscount - cycleDiscount));
  // Explore: always keep a path to trading — even marginally scored setups get small bets
  const exploreThreshold = Math.max(0.15, threshold - 0.08);

  return { threshold, exploreThreshold };
}

// ── V2 #13: Kalshi spread/liquidity check ──
function checkKalshiLiquidity(
  yesBid: number, yesAsk: number, noBid: number, noAsk: number,
  direction: "YES" | "NO",
): { liquid: boolean; spread_cents: number; exit_cost_pct: number } {
  const yesSpread = yesAsk - yesBid;
  const noSpread = noAsk - noBid;
  const spread = direction === "YES" ? yesSpread : noSpread;
  const spread_cents = spread * 100;

  // Exit cost: if we buy at ask, we'd sell at bid. The spread is our round-trip cost.
  const entryPrice = direction === "YES" ? yesAsk : noAsk;
  const exitPrice = direction === "YES" ? yesBid : noBid;
  const exit_cost_pct = entryPrice > 0 ? (entryPrice - exitPrice) / entryPrice : 1;

  return {
    liquid: spread_cents <= 12 && exitPrice > 0.02,  // Max 12¢ spread, must have a bid
    spread_cents,
    exit_cost_pct,
  };
}

// ── V2 #15: Volatility-adjusted strike distance ──
function getVolAdjustedEdge(symbol: string, isUpMarket: boolean, minutesRemaining: number): {
  vol_adjusted_prob: number;  // probability adjusted for vol
  high_vol_caution: boolean;  // vol too high for confident directional bets
} {
  const snap = getPrice(symbol);
  if (!snap) return { vol_adjusted_prob: 0.50, high_vol_caution: false };

  // Realized vol from recent changes
  const absC5 = Math.abs(snap.change5s ?? 0);
  const absC30 = Math.abs(snap.change30s ?? 0);
  const absC60 = Math.abs(snap.change60s ?? 0);
  const recentVol = Math.max(absC5, absC30, absC60);

  // In high vol, price can move a lot in remaining time — directional bets are coin flips
  const high_vol_caution = recentVol > 0.15 && minutesRemaining > 5;

  // Low vol + favorable distance = high probability
  // High vol + any distance = uncertain
  const strike = getStrikeDistance(symbol, isUpMarket);
  const volNormalized = recentVol > 0.001 ? Math.abs(strike.distance_pct) / recentVol : 0;
  // Higher ratio = price has moved more relative to vol = more likely to hold
  const vol_adjusted_prob = 0.50 + Math.min(0.35, volNormalized * 0.15) * (strike.favorable ? 1 : -1);

  return { vol_adjusted_prob, high_vol_caution };
}

// ── V2 #18: Enhanced cross-cycle momentum ──
function getCrossCycleMomentum(asset: string): {
  continuation_probability: number;  // P(same direction as last N cycles)
  cycles_same_direction: number;
  should_fade: boolean;              // market likely to reverse
  trend_strength: number;            // 0-1
} {
  const recent = getRecentCycles(asset, 12); // V2: look at more history
  if (recent.length < 4) return { continuation_probability: 0.50, cycles_same_direction: 0, should_fade: false, trend_strength: 0 };

  // Count consecutive same-direction cycles
  const lastDir = recent[recent.length - 1].direction;
  let consecutive = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].direction === lastDir) consecutive++;
    else break;
  }

  // Count wins in same direction (does the trend actually pay off?)
  const sameDirCycles = recent.filter(c => c.direction === lastDir);
  const sameDirWinRate = sameDirCycles.length > 0
    ? sameDirCycles.filter(c => c.won).length / sameDirCycles.length
    : 0.50;

  // Continuation probability based on streak length and whether it's been profitable
  let contProb = 0.50;
  if (consecutive >= 6 && sameDirWinRate > 0.60) {
    contProb = 0.65; // Strong trend day, ride it
  } else if (consecutive >= 5) {
    contProb = 0.40; // Long streak, reversion likely
  } else if (consecutive >= 3 && sameDirWinRate > 0.55) {
    contProb = 0.58; // Moderate trend, slightly favor continuation
  } else if (consecutive >= 3) {
    contProb = 0.45; // Moderate streak without profits, slight fade
  }

  return {
    continuation_probability: contProb,
    cycles_same_direction: consecutive,
    should_fade: contProb < 0.45 && consecutive >= 4,
    trend_strength: Math.min(1, consecutive / 6 * sameDirWinRate),
  };
}

// ═══════════════════════════════════════════════════════
// V4: GENIUS-LEVEL INTELLIGENCE LAYER
// ═══════════════════════════════════════════════════════

// ── #V4-1: Smart exit targets (brain-calculated per trade) ──
export interface BrainExitTargets {
  take_profit_price: number;   // Exit when price reaches this (cents)
  stop_loss_price: number;     // Cut when price drops to this (cents)
  hold_until_minutes: number;  // Minimum hold time before allowing TP
  reason: string;
}

export function calculateExitTargets(
  side: "YES" | "NO",
  entryPrice: number,         // cents
  confidence: number,
  score: number,
  asset: string,
  minutesRemaining: number,
): BrainExitTargets {
  const symbol = asset === "BTC" ? "btcusdt" : asset === "ETH" ? "ethusdt" : asset === "SOL" ? "solusdt" : "xrpusdt";
  const settlementProb = getSettlementProbability(symbol, side === "YES", minutesRemaining);

  // Target price based on settlement probability
  // If model says 70% chance YES settles at 100, fair value is ~70¢
  const fairValue = settlementProb.probability * 100; // in cents
  const currentSidePrice = entryPrice; // what we paid

  // Take profit: capture 70% of the distance to fair value
  const distanceToFair = side === "YES"
    ? Math.max(0, fairValue - currentSidePrice)
    : Math.max(0, (100 - fairValue) - currentSidePrice);
  const tpDistance = distanceToFair * 0.70;

  // Higher conviction = more aggressive targets
  const convictionMult = score > 0.60 ? 1.3 : score > 0.45 ? 1.0 : 0.7;

  const take_profit_price = side === "YES"
    ? Math.min(95, entryPrice + tpDistance * convictionMult)
    : Math.max(5, entryPrice - tpDistance * convictionMult);

  // Stop loss: tighter for low conviction, wider for high conviction
  const slPct = confidence > 0.70 ? 0.40 : confidence > 0.55 ? 0.30 : 0.20;
  const slDistance = entryPrice * slPct;
  const stop_loss_price = side === "YES"
    ? Math.max(1, entryPrice - slDistance)
    : Math.min(99, entryPrice + slDistance);

  // Hold time: high conviction = hold longer for bigger payout
  const hold_until_minutes = score > 0.60 ? 3 : score > 0.40 ? 2 : 1;

  return {
    take_profit_price,
    stop_loss_price,
    hold_until_minutes,
    reason: `TP=${take_profit_price.toFixed(0)}¢ SL=${stop_loss_price.toFixed(0)}¢ hold≥${hold_until_minutes}m (fair=${fairValue.toFixed(0)}¢)`,
  };
}

// ── #V4-2: Within-cycle re-evaluation (should we add/trim?) ──
export function reevaluatePosition(
  ticker: string,
  side: "YES" | "NO",
  entryPrice: number,
  currentPrice: number,
  minutesLeft: number,
  contracts: number,
): { action: "hold" | "add" | "trim" | "exit"; reason: string; sizeAdj: number } {
  const asset = ticker.includes("BTC") ? "BTC" : ticker.includes("ETH") ? "ETH"
    : ticker.includes("SOL") ? "SOL" : ticker.includes("XRP") ? "XRP" : null;
  if (!asset) return { action: "hold", reason: "unknown_asset", sizeAdj: 0 };

  const symbol = asset === "BTC" ? "btcusdt" : asset === "ETH" ? "ethusdt" : asset === "SOL" ? "solusdt" : "xrpusdt";
  const snap = getPrice(symbol);
  if (!snap) return { action: "hold", reason: "no_data", sizeAdj: 0 };

  const c5 = snap.change5s ?? 0;
  const c30 = snap.change30s ?? 0;
  const moveType = analyzeMoveType(snap);

  // Signals strengthening: momentum accelerating in our direction
  const momWithUs = (side === "YES" && c5 > 0.02 && c30 > 0.01) || (side === "NO" && c5 < -0.02 && c30 < -0.01);
  const momAgainstUs = (side === "YES" && c5 < -0.02 && c30 < -0.01) || (side === "NO" && c5 > 0.02 && c30 > 0.01);

  const isWinning = side === "YES" ? currentPrice > entryPrice : currentPrice < entryPrice;

  // ADD: signals strengthening + we're winning + not a spike + time left
  if (momWithUs && isWinning && moveType.type === "trend" && minutesLeft > 5) {
    const volume = getVolumeConfirmation(symbol, side);
    if (volume.confirmed) {
      return { action: "add", reason: `Momentum accelerating + volume confirms (${(volume.strength * 100).toFixed(0)}%)`, sizeAdj: 0.5 };
    }
  }

  // TRIM: signals weakening but not fully reversed
  if (momAgainstUs && isWinning && minutesLeft > 3) {
    return { action: "trim", reason: `Momentum fading, locking in ${isWinning ? "profit" : "position"}`, sizeAdj: -0.5 };
  }

  // EXIT: strong reversal signal
  if (momAgainstUs && !isWinning && moveType.type === "trend" && minutesLeft > 3) {
    return { action: "exit", reason: "Momentum reversed into sustained trend against us", sizeAdj: -1 };
  }

  return { action: "hold", reason: "signals_stable", sizeAdj: 0 };
}

// ── #V4-5: Confidence decay — weight recent scans heavier ──
interface ScanResult {
  direction: "YES" | "NO";
  score: number;
  timestamp: number;
}
const recentScans = new Map<string, ScanResult[]>(); // key: ticker

export function recordScanResult(ticker: string, direction: "YES" | "NO", score: number): void {
  const existing = recentScans.get(ticker) ?? [];
  existing.push({ direction, score, timestamp: Date.now() });
  // Keep last 10 scans per ticker
  if (existing.length > 10) existing.shift();
  recentScans.set(ticker, existing);
}

function getDecayWeightedScore(ticker: string, currentDirection: "YES" | "NO", currentScore: number): number {
  const scans = recentScans.get(ticker);
  if (!scans || scans.length === 0) return currentScore;

  // Exponential decay: recent scans worth more
  let weightedSum = currentScore * 1.0; // Current scan gets weight 1.0
  let totalWeight = 1.0;

  for (let i = scans.length - 1; i >= 0; i--) {
    const age = (Date.now() - scans[i].timestamp) / 1000; // seconds ago
    const decay = Math.exp(-age / 30); // Half-life ~21 seconds
    const directionMatch = scans[i].direction === currentDirection ? 1.0 : -0.5;
    weightedSum += scans[i].score * decay * directionMatch;
    totalWeight += decay;
  }

  return Math.max(0, weightedSum / totalWeight);
}

// ── #V4-6: Pre-market analysis (analyze before cycle opens) ──
interface PreMarketSignal {
  asset: string;
  direction: "YES" | "NO";
  strength: number;
  timestamp: number;
}
const preMarketSignals = new Map<string, PreMarketSignal>();

export function analyzePreMarket(): void {
  const assets = [
    { name: "BTC", symbol: "btcusdt" },
    { name: "ETH", symbol: "ethusdt" },
    { name: "SOL", symbol: "solusdt" },
    { name: "XRP", symbol: "xrpusdt" },
  ];

  for (const { name, symbol } of assets) {
    const snap = getPrice(symbol);
    if (!snap) continue;

    const c30 = snap.change30s ?? 0;
    const c60 = snap.change60s ?? 0;

    // If momentum is building before cycle opens, prepare to enter
    if (Math.abs(c30) > 0.005 || Math.abs(c60) > 0.01) {
      const dir = c30 > 0 ? "YES" as const : "NO" as const;
      const strength = Math.abs(c30) + Math.abs(c60) * 0.5;
      preMarketSignals.set(name, { asset: name, direction: dir, strength, timestamp: Date.now() });
    }
  }
}

function getPreMarketEdge(asset: string, direction: "YES" | "NO"): number {
  const signal = preMarketSignals.get(asset);
  if (!signal || Date.now() - signal.timestamp > 120000) return 0; // Stale after 2 min
  if (signal.direction !== direction) return -0.05; // Pre-market disagrees
  return Math.min(0.15, signal.strength * 2); // Boost for pre-market agreement
}

// ── #V4-7: Regime-specific playbook ──
function getRegimePlaybook(regime: string): {
  minScore: number;       // Minimum composite score adjustment
  sizeScale: number;      // Size multiplier
  preferDirection: "YES" | "NO" | null;
  maxPrice: number;       // Price cap for this regime
  strategy: string;       // Description
} {
  // V5: Data-driven price caps — >50¢ entries are 20% WR and -$28 PnL
  // Sweet spot is 25-48¢ across all regimes
  switch (regime) {
    case "VOLATILE":
      return { minScore: 0.05, sizeScale: 0.7, preferDirection: null, maxPrice: 0.42, strategy: "Only take high-edge cheap contracts in chaos" };
    case "TRENDING_UP":
      return { minScore: -0.03, sizeScale: 1.2, preferDirection: "YES", maxPrice: 0.48, strategy: "Ride the trend, lean YES" };
    case "TRENDING_DOWN":
      return { minScore: -0.03, sizeScale: 1.2, preferDirection: "NO", maxPrice: 0.48, strategy: "Ride the trend, lean NO" };
    case "NEWS_DRIVEN":
      return { minScore: 0.08, sizeScale: 0.5, preferDirection: null, maxPrice: 0.38, strategy: "High bar, small size — news is unpredictable" };
    default: // QUIET
      return { minScore: 0, sizeScale: 1.0, preferDirection: null, maxPrice: 0.48, strategy: "Standard play, favor mean reversion" };
  }
}

// ── #V4-8: Expected Value calculation for signal ranking ──
export function calculateEV(price: number, confidence: number, score: number): number {
  // V5: Use the calibrated confidence as P(win) — it's already anchored to brain WR
  const pWin = Math.min(0.75, confidence);
  const payout = 1 - price;
  const cost = price;
  return pWin * payout - (1 - pWin) * cost;
}

// ── #V4-9: Position correlation guard ──
const activePositions: Map<string, { side: "YES" | "NO"; entryTime: number }> = new Map();

export function registerActivePosition(asset: string, side: "YES" | "NO"): void {
  activePositions.set(asset, { side, entryTime: Date.now() });
}

export function clearActivePosition(asset: string): void {
  activePositions.delete(asset);
}

function getCorrelationPenalty(asset: string, direction: "YES" | "NO"): number {
  // If we already hold a correlated position in the same direction, penalize
  const correlated: Record<string, string[]> = {
    "BTC": ["ETH", "SOL", "XRP"],
    "ETH": ["BTC", "SOL"],
    "SOL": ["BTC", "ETH"],
    "XRP": ["BTC"],
  };

  const related = correlated[asset] ?? [];
  let penalty = 0;
  for (const other of related) {
    const pos = activePositions.get(other);
    if (pos && pos.side === direction) {
      // Same direction on correlated asset — reduce size, don't double down
      const corr = getCorrelation(asset, other);
      penalty += corr * 0.3; // 0.8 correlation = 0.24 penalty
    }
  }
  return Math.min(0.6, penalty); // Max 60% penalty
}

// ── #V4-10: Profit target escalation (streak-aware exits) ──
function getStreakExitMultiplier(): number {
  // On hot streaks, hold longer and aim for bigger payouts
  if (consecutiveBrainWins >= 5) return 1.5;  // 50% higher TP targets
  if (consecutiveBrainWins >= 3) return 1.25;  // 25% higher
  if (consecutiveBrainLosses >= 3) return 0.7; // Cut quicker after losses
  return 1.0;
}

// ── #V4-11: Micro-timing — track best entry minute within cycle ──
interface MinutePerformance {
  minute: number;
  trades: number;
  wins: number;
  totalPnl: number;
}
const minutePerformance = new Map<number, MinutePerformance>();

export function recordEntryMinute(minutesRemaining: number, won: boolean, pnl: number): void {
  const minuteIn = Math.round(15 - minutesRemaining); // 0 = cycle just opened, 15 = about to close
  const existing = minutePerformance.get(minuteIn) ?? { minute: minuteIn, trades: 0, wins: 0, totalPnl: 0 };
  existing.trades++;
  if (won) existing.wins++;
  existing.totalPnl += pnl;
  minutePerformance.set(minuteIn, existing);
}

function getMinuteEdge(minutesRemaining: number): { edge: number; shouldDelay: boolean } {
  const minuteIn = Math.round(15 - minutesRemaining);
  const perf = minutePerformance.get(minuteIn);
  if (!perf || perf.trades < 3) return { edge: 0, shouldDelay: false };

  const wr = perf.wins / perf.trades;
  const avgPnl = perf.totalPnl / perf.trades;

  // If this minute has <35% WR, suggest delaying
  if (wr < 0.35 && perf.trades >= 5) {
    // Check if the next minute is better
    const nextPerf = minutePerformance.get(minuteIn + 1);
    if (nextPerf && nextPerf.trades >= 3 && (nextPerf.wins / nextPerf.trades) > wr + 0.10) {
      return { edge: -0.05, shouldDelay: true };
    }
  }

  // Good minute: boost score
  if (wr > 0.55) return { edge: 0.05, shouldDelay: false };
  return { edge: 0, shouldDelay: false };
}

// ── #V4-12: Contrarian conviction boost ──
function getContrarianBoost(kalshiYesPrice: number, direction: "YES" | "NO", settlementProb: number): {
  boost: number;
  sizeBoost: number;
  isContrarian: boolean;
} {
  // When our model strongly disagrees with Kalshi's price, that's edge
  const kalshiImpliedProb = direction === "YES" ? kalshiYesPrice : (1 - kalshiYesPrice);
  const disagreement = settlementProb - kalshiImpliedProb;

  if (disagreement > 0.20) {
    // Massive disagreement: our model says 70%, Kalshi says 50% — size up
    return { boost: 0.15, sizeBoost: 1.8, isContrarian: true };
  }
  if (disagreement > 0.12) {
    return { boost: 0.08, sizeBoost: 1.4, isContrarian: true };
  }
  if (disagreement > 0.05) {
    return { boost: 0.03, sizeBoost: 1.1, isContrarian: false };
  }
  // Kalshi agrees with us — less edge but still valid
  return { boost: 0, sizeBoost: 1.0, isContrarian: false };
}

// ── #V4-4: Kalshi order flow tracking ──
interface KalshiFlowSnapshot {
  asset: string;
  yesBid: number;
  yesAsk: number;
  timestamp: number;
}
const kalshiFlow: KalshiFlowSnapshot[] = [];
const MAX_FLOW = 200;

export function recordKalshiFlow(asset: string, yesBid: number, yesAsk: number): void {
  kalshiFlow.push({ asset, yesBid, yesAsk, timestamp: Date.now() });
  if (kalshiFlow.length > MAX_FLOW) kalshiFlow.splice(0, 50);
}

function getKalshiFlowSignal(asset: string): {
  buying_pressure: boolean;  // ask being lifted (buyers aggressive)
  selling_pressure: boolean; // bid being hit (sellers aggressive)
  flow_direction: "YES" | "NO" | null;
  strength: number;
} {
  const recent = kalshiFlow.filter(f => f.asset === asset && Date.now() - f.timestamp < 120000);
  if (recent.length < 3) return { buying_pressure: false, selling_pressure: false, flow_direction: null, strength: 0 };

  // Track bid/ask changes: rising bid = buying pressure, falling ask = selling pressure
  let bidRises = 0, bidFalls = 0, askRises = 0, askFalls = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].yesBid > recent[i-1].yesBid) bidRises++;
    if (recent[i].yesBid < recent[i-1].yesBid) bidFalls++;
    if (recent[i].yesAsk > recent[i-1].yesAsk) askRises++;
    if (recent[i].yesAsk < recent[i-1].yesAsk) askFalls++;
  }

  const n = recent.length - 1;
  const buySignal = bidRises / n > 0.5 || askRises / n > 0.5;
  const sellSignal = bidFalls / n > 0.5 || askFalls / n > 0.5;

  return {
    buying_pressure: buySignal,
    selling_pressure: sellSignal,
    flow_direction: buySignal ? "YES" : sellSignal ? "NO" : null,
    strength: Math.max(bidRises / n, askRises / n, bidFalls / n, askFalls / n),
  };
}

// #8: Smart exit signal — should we exit early?
export function shouldExitTurboEarly(
  ticker: string,
  side: "YES" | "NO",
  entryPrice: number,
  currentPrice: number,
  minutesLeft: number,
): { exit: boolean; reason: string } {
  const asset = ticker.includes("BTC") ? "BTC" : ticker.includes("ETH") ? "ETH"
    : ticker.includes("SOL") ? "SOL" : ticker.includes("XRP") ? "XRP" : null;
  if (!asset) return { exit: false, reason: "" };

  const symbol = asset === "BTC" ? "btcusdt" : asset === "ETH" ? "ethusdt"
    : asset === "SOL" ? "solusdt" : "xrpusdt";
  const snap = getPrice(symbol);
  if (!snap) return { exit: false, reason: "" };

  // Hard reversal: momentum flipped against our position
  // V6: Raised threshold from 0.02% to 0.08% — was too trigger-happy, causing premature exits
  // Also require 30s change to confirm (not just a 5s blip)
  const moveType = analyzeMoveType(snap);
  const isGoingUp = (snap.change5s ?? 0) > 0.08 && (snap.change30s ?? 0) > 0.03;
  const isGoingDown = (snap.change5s ?? 0) < -0.08 && (snap.change30s ?? 0) < -0.03;

  if (side === "YES" && isGoingDown && minutesLeft > 3) {
    return { exit: true, reason: `Momentum reversed against YES (5s: ${((snap.change5s ?? 0) * 100).toFixed(2)}%)` };
  }
  if (side === "NO" && isGoingUp && minutesLeft > 3) {
    return { exit: true, reason: `Momentum reversed against NO (5s: ${((snap.change5s ?? 0) * 100).toFixed(2)}%)` };
  }

  // Spike detection: entered on what turned out to be a spike
  if (moveType.type === "spike" && moveType.reversal_risk > 0.6) {
    const isUnderwater = side === "YES"
      ? currentPrice < entryPrice
      : currentPrice > entryPrice;
    if (isUnderwater && minutesLeft > 5) {
      return { exit: true, reason: `Spike reversal detected (risk: ${(moveType.reversal_risk * 100).toFixed(0)}%)` };
    }
  }

  // Liquidation cascade against our position
  const liq = detectLiquidationCascade(symbol);
  if (liq && liq.active) {
    if ((side === "YES" && liq.direction === "long_squeeze") ||
        (side === "NO" && liq.direction === "short_squeeze")) {
      return { exit: true, reason: `Liquidation cascade: ${liq.direction} (intensity: ${(liq.intensity * 100).toFixed(0)}%)` };
    }
  }

  return { exit: false, reason: "" };
}

// ═══════════════════════════════════════════════════════
// MAIN ANALYSIS V7: Probability-model-first decision engine
//
// Architecture:
// 1. Pre-checks (dedup, time-of-day, timing gate)
// 2. PRIMARY: Black-Scholes probability model → fee-aware edge
// 3. SECONDARY: Momentum, volume, correlation, flow → confidence adjustment
// 4. SIZING: Quarter-Kelly from calibrated edge, adjusted by vol regime
// ═══════════════════════════════════════════════════════

export function analyzeTurboOpportunity(params: {
  ticker: string;
  asset: string;
  kalshiYesPrice: number;
  kalshiNoPrice: number;
  kalshiYesBid?: number;
  kalshiNoBid?: number;
  minutesRemaining: number;
  isFreshOpen: boolean;
  isUpMarket?: boolean;
}): TurboBrainDecision {
  const { ticker, asset, kalshiYesPrice, kalshiNoPrice, minutesRemaining, isFreshOpen } = params;
  const kalshiYesBid = params.kalshiYesBid ?? 0;
  const kalshiNoBid = params.kalshiNoBid ?? 0;
  const isUpMarket = params.isUpMarket ?? true;
  const symbol = asset === "BTC" ? "btcusdt" : asset === "ETH" ? "ethusdt"
    : asset === "SOL" ? "solusdt" : "xrpusdt";

  // ── Pre-check 1: Per-cycle dedup ──
  const now = Date.now();
  for (const [t, ts] of cycleEntries) {
    if (now - ts > CYCLE_DEDUP_WINDOW) cycleEntries.delete(t);
  }
  if (cycleEntries.has(ticker)) {
    return { trade: false, skip_reason: `already_entered_this_cycle` };
  }

  // ── Pre-check 2: Time-of-day filter ──
  const hourPerf = getHourWinRate();
  if (hourPerf.shouldSkip) {
    return { trade: false, skip_reason: `bad_hour (${(hourPerf.rate * 100).toFixed(0)}% WR over ${hourPerf.trades} trades this hour)` };
  }

  // ── Pre-check 3: Timing gate — only trade in first ~7 minutes ──
  if (isFreshOpen && minutesRemaining < 8) {
    return { trade: false, skip_reason: "past_optimal_entry_window" };
  }

  // ── Pre-check 4: Micro-timing ──
  const minuteEdge = getMinuteEdge(minutesRemaining);
  if (minuteEdge.shouldDelay) {
    return { trade: false, skip_reason: `bad_entry_minute (delaying to better window)` };
  }

  const snap = getPrice(symbol);
  if (!snap) return { trade: false, skip_reason: "no_price_data" };

  // ── Pre-check 5: Liquidity ──
  const liquidity = checkKalshiLiquidity(kalshiYesBid, kalshiYesPrice, kalshiNoBid, kalshiNoPrice, "YES");
  if (!liquidity.liquid) {
    return { trade: false, skip_reason: `illiquid (spread: ${liquidity.spread_cents.toFixed(0)}¢, exit_cost: ${(liquidity.exit_cost_pct * 100).toFixed(0)}%)` };
  }

  // ══════════════════════════════════════════════════════
  // PRIMARY SIGNAL: Black-Scholes probability model + mispricing
  // ══════════════════════════════════════════════════════
  updateCycleOpens(); // Ensure cycle open prices are tracked

  const turboAnalysis = analyzeTurboMarket({
    symbol,
    minutesRemaining,
    kalshiYesPrice,
    kalshiNoPrice,
    isUpMarket,
    bankroll: lastKnownBankroll,
  });

  const sources: string[] = [];
  const reasons: string[] = [];

  // The model gives us direction and edge
  let direction = turboAnalysis.direction;
  let netEdge = turboAnalysis.net_edge;
  let modelProb = turboAnalysis.mispricing.model_prob;

  if (turboAnalysis.prob) {
    sources.push(`model(${(modelProb * 100).toFixed(0)}%)`);
    reasons.push(`P(${direction})=${(modelProb * 100).toFixed(1)}% z=${turboAnalysis.prob.z_score.toFixed(2)} dist=${turboAnalysis.prob.distance_pct.toFixed(3)}%`);
  }

  reasons.push(`Vol: ${(turboAnalysis.vol.vol_15m * 100).toFixed(2)}% [${turboAnalysis.vol.regime}]`);
  sources.push(`vol_${turboAnalysis.vol.regime.toLowerCase()}`);

  // ══════════════════════════════════════════════════════
  // SECONDARY SIGNALS: Adjust edge estimate ±
  // These can push a borderline trade into "go" territory or pull it back
  // Max total secondary adjustment: ±5% edge
  // ══════════════════════════════════════════════════════
  let secondaryAdj = 0;

  // S1: Momentum confirmation — does Binance momentum agree with our direction?
  const c5 = snap.change5s ?? 0;
  const c30 = snap.change30s ?? 0;
  const c60 = snap.change60s ?? 0;
  const moveType = analyzeMoveType(snap);

  if (moveType.type === "spike") {
    secondaryAdj -= 0.02;
    reasons.push("Spike detected — momentum discount");
  } else if (moveType.type === "trend") {
    const trendDir = c30 > 0 ? "YES" : "NO";
    if (trendDir === direction) {
      secondaryAdj += 0.015 * getSignalWeight("sustained_trend");
      sources.push("trend_confirms");
    } else {
      secondaryAdj -= 0.015;
      reasons.push("Trend opposes model direction");
    }
  }

  // Timeframe agreement
  const allAgree = (c5 > 0 && c30 > 0 && c60 > 0) || (c5 < 0 && c30 < 0 && c60 < 0);
  const momDir = c30 > 0 ? "YES" : "NO";
  if (allAgree && momDir === direction) {
    secondaryAdj += 0.01 * getSignalWeight("tf_agreement");
    sources.push("tf_agree");
  }

  // S2: BTC lead-lag for alts
  const btcLead = getBtcLeadSignal(asset);
  if (btcLead.signal) {
    if (btcLead.signal === direction) {
      secondaryAdj += 0.015 * btcLead.confidence * getSignalWeight("btc_lead");
      sources.push(`btc_lead(${(btcLead.lag_pct * 100).toFixed(2)}%)`);
    } else {
      secondaryAdj -= 0.01;
    }
  }

  // S3: Volume confirmation (OBI + VPIN)
  const volume = getVolumeConfirmation(symbol, direction);
  if (volume.confirmed) {
    secondaryAdj += 0.01 * volume.strength * getSignalWeight("volume");
    sources.push(`volume(${(volume.strength * 100).toFixed(0)}%)`);
  }

  // S4: Funding rate bias
  const funding = getFundingBias(symbol);
  if (funding) {
    const fundingAgrees = (direction === "YES" && funding.bias === "bullish") ||
                          (direction === "NO" && funding.bias === "bearish");
    if (fundingAgrees) {
      secondaryAdj += 0.005;
      sources.push("funding");
    }
  }

  // S5: Liquidation cascade — large signal, can override
  const liq = detectLiquidationCascade(symbol);
  if (liq && liq.active && liq.intensity > 0.5) {
    const liqDir = liq.direction === "short_squeeze" ? "YES" : "NO";
    if (liqDir === direction) {
      secondaryAdj += 0.03;
      sources.push(`liq_cascade(${liq.direction})`);
      reasons.push(`Active ${liq.direction} cascade`);
    } else {
      return { trade: false, skip_reason: `liq_cascade_against (${liq.direction})` };
    }
  }

  // S6: Multi-asset correlation
  const corrSignal = getCorrelationSignal(asset, direction);
  if (corrSignal.agrees && corrSignal.strength > 0.6) {
    secondaryAdj += 0.005;
    sources.push("corr_confirms");
  } else if (!corrSignal.agrees && corrSignal.divergent_asset) {
    secondaryAdj -= 0.005;
  }

  // S7: Cross-cycle momentum
  const crossCycle = getCrossCycleMomentum(asset);
  const cyclePattern = getCyclePattern(asset);
  if (crossCycle.should_fade && direction === cyclePattern.streak_direction) {
    secondaryAdj -= 0.01;
    reasons.push(`${crossCycle.cycles_same_direction}-cycle streak — fade pressure`);
  } else if (crossCycle.trend_strength > 0.6 && direction === cyclePattern.streak_direction) {
    secondaryAdj += 0.005;
    sources.push(`trend_run(${crossCycle.cycles_same_direction})`);
  }

  // S8: Kalshi order flow
  const flow = getKalshiFlowSignal(asset);
  if (flow.flow_direction === direction && flow.strength > 0.4) {
    secondaryAdj += 0.008 * flow.strength;
    sources.push(`flow(${flow.flow_direction})`);
  } else if (flow.flow_direction && flow.flow_direction !== direction && flow.strength > 0.5) {
    secondaryAdj -= 0.005;
  }

  // S9: Pre-market edge
  const preEdge = getPreMarketEdge(asset, direction);
  if (preEdge !== 0) {
    secondaryAdj += Math.max(-0.01, Math.min(0.01, preEdge * 0.5));
  }

  // S10: Minute-level edge from historical performance
  secondaryAdj += minuteEdge.edge * 0.5;

  // Clamp secondary adjustment to ±5%
  secondaryAdj = Math.max(-0.05, Math.min(0.05, secondaryAdj));

  // ── Apply secondary adjustment to net edge ──
  const adjustedEdge = netEdge + secondaryAdj;

  // ── Confidence decay: weight against recent scans ──
  const compositeScore = adjustedEdge * 10; // Scale edge to composite score range for compatibility
  recordScanResult(ticker, direction, compositeScore);
  const decayScore = getDecayWeightedScore(ticker, direction, compositeScore);
  const signalStability = Math.abs(decayScore - compositeScore) < 0.05 ? 1.0 : 0.85;

  // ══════════════════════════════════════════════════════
  // DECISION GATE
  // ══════════════════════════════════════════════════════
  const minEdge = turboAnalysis.min_edge_required;
  const maxPrice = turboAnalysis.max_contract_price;

  // Use model's skip reason if it has one
  if (turboAnalysis.skip_reason && adjustedEdge < minEdge) {
    return { trade: false, skip_reason: turboAnalysis.skip_reason };
  }

  // Check adjusted edge against vol-regime-aware minimum
  const isExplore = adjustedEdge >= minEdge * 0.6 && adjustedEdge < minEdge;
  if (adjustedEdge < minEdge * 0.6) {
    return {
      trade: false,
      skip_reason: `edge_too_low (${(adjustedEdge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(0)}% [${turboAnalysis.vol.regime}])`,
    };
  }

  // Price checks
  const price = direction === "YES" ? kalshiYesPrice : kalshiNoPrice;
  if (price > maxPrice) {
    return { trade: false, skip_reason: `price_too_high (${(price * 100).toFixed(0)}¢ > ${(maxPrice * 100).toFixed(0)}¢ [${turboAnalysis.vol.regime}])` };
  }
  if (price < 0.20) {
    return { trade: false, skip_reason: `price_too_low (${(price * 100).toFixed(0)}¢ — correctly priced cheap)` };
  }

  // ── Loss pattern blocking ──
  const lossCheck = isRepeatedLossPattern(asset, direction, price);
  if (lossCheck.isRepeat && !isExplore) {
    return { trade: false, skip_reason: `loss_pattern_blocked (${lossCheck.lossCount}x ${asset} ${direction} at ${getPriceRange(price)})` };
  }

  // ══════════════════════════════════════════════════════
  // SIZING: Model-driven Kelly with adjustments
  // ══════════════════════════════════════════════════════

  // Confidence: model probability is the real P(win), calibrated by brain WR
  const brainBaseRate = getBrainWinRate();
  // Blend model probability with brain WR: 70% model, 30% empirical
  const blendedProb = modelProb * 0.7 + brainBaseRate * 0.3;
  const confidence = Math.min(0.75, blendedProb);

  // Kelly from the model's edge calculation
  const fullKelly = adjustedEdge > 0 ? adjustedEdge / (1 - price) : 0;
  // Scale by vol regime + brain calibration
  const volRegimeScale = turboAnalysis.vol.regime === "LOW" ? 0.35
    : turboAnalysis.vol.regime === "NORMAL" ? 0.25
    : turboAnalysis.vol.regime === "HIGH" ? 0.15
    : 0.10;
  let sizeMultiplier = fullKelly * volRegimeScale * 10; // Scale to multiplier range

  if (sizeMultiplier <= 0) {
    return { trade: false, skip_reason: "negative_kelly" };
  }

  // Adjustments
  const corrPenalty = getCorrelationPenalty(asset, direction);
  const compoundMult = getCompoundingMultiplier();
  const growthMult = getGrowthSizingMultiplier();
  const explorePenalty = isExplore ? 0.50 : 1.0;
  const lossPatternAdj = lossCheck.isRepeat ? 0.25 : 1.0;
  const corrSizeAdj = 1.0 - corrPenalty;

  const finalSizeMult = sizeMultiplier * compoundMult * growthMult * explorePenalty
    * lossPatternAdj * corrSizeAdj * signalStability;

  // Mark last brain trade time + register cycle entry
  lastBrainTradeTime = Date.now();
  cyclesSinceLastTrade = 0;
  cycleEntries.set(ticker, Date.now());

  // Calculate exit targets
  const exitTargets = calculateExitTargets(direction, price * 100, confidence, compositeScore, asset, minutesRemaining);

  const label = isExplore ? "[EXPLORE] " : "";
  reasons.push(`Net edge: ${(adjustedEdge * 100).toFixed(1)}% (model ${(netEdge * 100).toFixed(1)}% + secondary ${(secondaryAdj * 100).toFixed(1)}%)`);
  reasons.push(exitTargets.reason);

  return {
    trade: true,
    explore: isExplore,
    signal: {
      ticker,
      asset,
      direction,
      price,
      model_prob_win: modelProb,
      confidence: isExplore ? confidence * 0.85 : confidence,
      size_multiplier: Math.max(0.2, Math.min(3.0, finalSizeMult)),
      reasoning: label + reasons.join(" | "),
      signal_sources: sources,
      score: compositeScore,
    },
  };
}
