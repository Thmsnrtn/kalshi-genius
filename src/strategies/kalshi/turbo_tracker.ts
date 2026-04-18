// src/strategies/kalshi/turbo_tracker.ts — Turbo performance tracking & adaptive sizing
//
// Tracks every turbo trade outcome and feeds learnings back:
// 1. Live win rate → auto-reduce sizes if below breakeven
// 2. Cycle learning → recent outcomes inform next decision
// 3. Compound sizing → winning streaks scale up, losing streaks scale down
// 4. Per-asset tracking → learn which assets the bot trades best

import { getDb } from "../../core/db.js";

// ── Schema ──
export function initTurboTracker(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS turbo_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      asset TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL,
      pnl REAL DEFAULT 0,
      won INTEGER DEFAULT NULL,
      entry_time TEXT NOT NULL,
      exit_time TEXT,
      momentum_signal TEXT,
      regime TEXT,
      confidence REAL
    )
  `);
}

// ── Record a new turbo trade entry ──
export function recordTurboEntry(params: {
  ticker: string;
  asset: string;
  direction: string;
  entry_price: number;
  momentum_signal?: string;
  regime?: string;
  confidence?: number;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO turbo_outcomes (ticker, asset, direction, entry_price, entry_time, momentum_signal, regime, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(params.ticker, params.asset, params.direction, params.entry_price, new Date().toISOString(),
    params.momentum_signal ?? null, params.regime ?? null, params.confidence ?? null);
}

// ── Record turbo trade outcome ──
export function recordTurboOutcome(ticker: string, won: boolean, pnl: number, exitPrice: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE turbo_outcomes SET won = ?, pnl = ?, exit_price = ?, exit_time = ?
    WHERE ticker = ? AND won IS NULL
    ORDER BY id DESC LIMIT 1
  `).run(won ? 1 : 0, pnl, exitPrice, new Date().toISOString(), ticker);
}

// ── Get turbo performance stats ──
export interface TurboStats {
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl: number;
  streak: number;           // Positive = consecutive wins, negative = consecutive losses
  recent_win_rate: number;  // Last 20 trades
  by_asset: Record<string, { trades: number; wins: number; win_rate: number; pnl: number }>;
}

export function getTurboStats(): TurboStats {
  const db = getDb();

  const all = db.prepare(`
    SELECT asset, direction, won, pnl FROM turbo_outcomes WHERE won IS NOT NULL ORDER BY id ASC
  `).all() as Array<{ asset: string; direction: string; won: number; pnl: number }>;

  const total = all.length;
  const wins = all.filter(t => t.won === 1).length;
  const losses = total - wins;
  const totalPnl = all.reduce((s, t) => s + t.pnl, 0);

  // Streak: count from most recent
  let streak = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (i === all.length - 1) {
      streak = all[i].won ? 1 : -1;
    } else {
      if (all[i].won && streak > 0) streak++;
      else if (!all[i].won && streak < 0) streak--;
      else break;
    }
  }

  // Recent win rate (last 20)
  const recent = all.slice(-20);
  const recentWins = recent.filter(t => t.won === 1).length;

  // Per-asset breakdown
  const byAsset: Record<string, { trades: number; wins: number; win_rate: number; pnl: number }> = {};
  for (const t of all) {
    if (!byAsset[t.asset]) byAsset[t.asset] = { trades: 0, wins: 0, win_rate: 0, pnl: 0 };
    byAsset[t.asset].trades++;
    if (t.won) byAsset[t.asset].wins++;
    byAsset[t.asset].pnl += t.pnl;
  }
  for (const a of Object.values(byAsset)) {
    a.win_rate = a.trades > 0 ? a.wins / a.trades : 0;
  }

  return {
    total_trades: total,
    wins,
    losses,
    win_rate: total > 0 ? wins / total : 0,
    total_pnl: totalPnl,
    avg_pnl: total > 0 ? totalPnl / total : 0,
    streak,
    recent_win_rate: recent.length > 0 ? recentWins / recent.length : 0,
    by_asset: byAsset,
  };
}

// ── Compound sizing multiplier based on performance ──
// Winning streaks → scale up. Losing streaks → scale down. Below breakeven → shrink.
export function getTurboSizeMultiplier(): number {
  const stats = getTurboStats();

  // Not enough data yet — trade at base size
  if (stats.total_trades < 5) return 1.0;

  let multiplier = 1.0;

  // Win rate adjustment: below 54% breakeven → shrink, above 60% → grow
  if (stats.recent_win_rate < 0.45) {
    multiplier *= 0.3;  // Hemorrhaging — tiny sizes only
  } else if (stats.recent_win_rate < 0.54) {
    multiplier *= 0.6;  // Below breakeven — reduce
  } else if (stats.recent_win_rate > 0.65) {
    multiplier *= 1.5;  // Strong edge — scale up
  } else if (stats.recent_win_rate > 0.60) {
    multiplier *= 1.25; // Good edge — modest scale up
  }

  // Streak bonus/penalty
  if (stats.streak >= 3) {
    multiplier *= 1.0 + Math.min(stats.streak - 2, 3) * 0.15; // +15% per win above 2, max +45%
  } else if (stats.streak <= -3) {
    multiplier *= Math.max(0.3, 1.0 + (stats.streak + 2) * 0.15); // -15% per loss above 2
  }

  // Hard bounds: never go below 0.2x or above 2.5x
  return Math.max(0.2, Math.min(2.5, multiplier));
}

// ── Get recent turbo outcomes for learning context ──
// Returns last N outcomes so the strategy can pattern-match
export function getRecentTurboContext(n: number = 10): Array<{
  asset: string;
  direction: string;
  won: boolean;
  momentum_signal: string | null;
  regime: string | null;
}> {
  const db = getDb();
  return (db.prepare(`
    SELECT asset, direction, won, momentum_signal, regime
    FROM turbo_outcomes WHERE won IS NOT NULL
    ORDER BY id DESC LIMIT ?
  `).all(n) as any[]).map(r => ({
    asset: r.asset,
    direction: r.direction,
    won: r.won === 1,
    momentum_signal: r.momentum_signal,
    regime: r.regime,
  }));
}

// ── Should we skip a specific asset based on its recent performance? ──
export function shouldSkipAsset(asset: string): boolean {
  const stats = getTurboStats();
  const assetStats = stats.by_asset[asset];
  if (!assetStats || assetStats.trades < 5) return false; // Not enough data

  // V6: Skip asset if win rate below 40% on 8+ trades (was 35% on 5+, too lenient)
  if (assetStats.trades >= 8 && assetStats.win_rate < 0.40) return true;

  // V6: Skip asset if PnL is deeply negative (losing more than it wins even if WR is ~50%)
  if (assetStats.trades >= 10 && assetStats.pnl < -5.0) return true;

  return false;
}
