// src/evolution/performance_tracker.ts
//
// REAL-TIME PERFORMANCE ATTRIBUTION
// Every signal gets scored the moment it resolves. The bot maintains
// a running tally of WHAT IS WORKING right now, broken down by:
// - Strategy
// - Asset (BTC/ETH/SOL/etc)
// - Time of day
// - Market category
// - Signal type
// - Confidence level
//
// This is the data layer that feeds every other evolution loop.

import { getDb } from "../core/db.js";

export interface SignalScore {
  signal_id: string;
  strategy: string;
  asset: string | null;
  category: string;
  hour_of_day: number;
  day_of_week: number;
  confidence: number;
  predicted_edge: number;
  position_size: number;
  // Outcome
  resolved: boolean;
  win: boolean | null;
  actual_pnl: number | null;
  hold_duration_ms: number | null;
  // Context
  market_volatility: number;
  bankroll_at_entry: number;
}

// ── Initialize tracker tables ──
export function initPerformanceTracker() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT UNIQUE NOT NULL,
      timestamp_entry INTEGER NOT NULL,
      timestamp_resolved INTEGER,
      strategy TEXT NOT NULL,
      asset TEXT,
      category TEXT,
      hour_of_day INTEGER,
      day_of_week INTEGER,
      confidence REAL,
      predicted_edge REAL,
      position_size REAL,
      resolved INTEGER DEFAULT 0,
      win INTEGER,
      actual_pnl REAL,
      hold_duration_ms INTEGER,
      market_volatility REAL,
      bankroll_at_entry REAL,
      regime TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals(strategy);
    CREATE INDEX IF NOT EXISTS idx_signals_resolved ON signals(resolved);
    CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp_entry);
  `);
}

// ── Record a signal at entry time ──
export function recordSignal(s: Omit<SignalScore, "resolved" | "win" | "actual_pnl" | "hold_duration_ms">) {
  const db = getDb();
  const now = Date.now();
  const date = new Date(now);

  db.prepare(`
    INSERT OR REPLACE INTO signals (
      signal_id, timestamp_entry, strategy, asset, category,
      hour_of_day, day_of_week, confidence, predicted_edge,
      position_size, market_volatility, bankroll_at_entry
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.signal_id, now, s.strategy, s.asset, s.category,
    date.getUTCHours(), date.getUTCDay(),
    s.confidence, s.predicted_edge, s.position_size,
    s.market_volatility, s.bankroll_at_entry
  );
}

// ── Record resolution of a signal ──
export function recordResolution(signalId: string, win: boolean, pnl: number) {
  const db = getDb();
  const now = Date.now();
  const row = db.prepare(`SELECT timestamp_entry FROM signals WHERE signal_id = ?`).get(signalId) as any;
  const holdMs = row ? now - row.timestamp_entry : 0;

  db.prepare(`
    UPDATE signals SET resolved = 1, timestamp_resolved = ?, win = ?, actual_pnl = ?, hold_duration_ms = ?
    WHERE signal_id = ?
  `).run(now, win ? 1 : 0, pnl, holdMs, signalId);
}

// ── Get rolling performance for a dimension ──
export interface PerformanceSnapshot {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl: number;
  expectancy: number; // Avg P&L per trade including losses
  sharpe: number;     // Risk-adjusted return
  recent_trend: "improving" | "stable" | "degrading";
}

export function getPerformance(filter: {
  strategy?: string;
  asset?: string;
  hour_of_day?: number;
  category?: string;
  since_ms?: number;
}): PerformanceSnapshot {
  const db = getDb();
  const conditions: string[] = ["resolved = 1"];
  const params: any[] = [];

  if (filter.strategy) { conditions.push("strategy = ?"); params.push(filter.strategy); }
  if (filter.asset) { conditions.push("asset = ?"); params.push(filter.asset); }
  if (filter.hour_of_day !== undefined) { conditions.push("hour_of_day = ?"); params.push(filter.hour_of_day); }
  if (filter.category) { conditions.push("category = ?"); params.push(filter.category); }
  if (filter.since_ms) { conditions.push("timestamp_entry >= ?"); params.push(filter.since_ms); }

  const where = conditions.join(" AND ");
  const trades = db.prepare(`SELECT * FROM signals WHERE ${where} ORDER BY timestamp_entry DESC`).all(...params) as any[];

  if (trades.length === 0) {
    return { trades: 0, wins: 0, losses: 0, win_rate: 0, total_pnl: 0, avg_pnl: 0, expectancy: 0, sharpe: 0, recent_trend: "stable" };
  }

  const wins = trades.filter((t) => t.win === 1).length;
  const losses = trades.filter((t) => t.win === 0).length;
  const totalPnl = trades.reduce((s, t) => s + (t.actual_pnl ?? 0), 0);
  const pnls = trades.map((t) => t.actual_pnl ?? 0);
  const avgPnl = totalPnl / trades.length;

  // Sharpe-like: avg / stdev
  const variance = pnls.reduce((s, p) => s + Math.pow(p - avgPnl, 2), 0) / trades.length;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? avgPnl / stdev : 0;

  // Trend: compare last 25% to previous 25%
  let trend: "improving" | "stable" | "degrading" = "stable";
  if (trades.length >= 8) {
    const quarter = Math.floor(trades.length / 4);
    const recent = trades.slice(0, quarter).reduce((s, t) => s + (t.actual_pnl ?? 0), 0) / quarter;
    const previous = trades.slice(quarter, quarter * 2).reduce((s, t) => s + (t.actual_pnl ?? 0), 0) / quarter;
    if (recent > previous * 1.2) trend = "improving";
    else if (recent < previous * 0.8) trend = "degrading";
  }

  return {
    trades: trades.length,
    wins,
    losses,
    win_rate: wins / (wins + losses || 1),
    total_pnl: totalPnl,
    avg_pnl: avgPnl,
    expectancy: avgPnl,
    sharpe,
    recent_trend: trend,
  };
}

// ── Get top performing dimensions ──
export function getTopPerformers(dimension: "strategy" | "asset" | "hour_of_day" | "category", lookbackMs = 24 * 60 * 60 * 1000) {
  const db = getDb();
  const since = Date.now() - lookbackMs;

  const results = db.prepare(`
    SELECT 
      ${dimension} as dim,
      COUNT(*) as trades,
      SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) as wins,
      SUM(actual_pnl) as total_pnl,
      AVG(actual_pnl) as avg_pnl
    FROM signals
    WHERE resolved = 1 AND timestamp_entry >= ?
    GROUP BY ${dimension}
    HAVING trades >= 3
    ORDER BY total_pnl DESC
  `).all(since) as any[];

  return results.map((r) => ({
    dimension: r.dim,
    trades: r.trades,
    win_rate: r.wins / r.trades,
    total_pnl: r.total_pnl,
    avg_pnl: r.avg_pnl,
  }));
}
