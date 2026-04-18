// src/core/db.ts — V3 SQLite with full tracking for aggressive compounding

import { Database } from "bun:sqlite";
import { join } from "path";

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  const dbPath = process.env.DB_PATH ?? join(process.cwd(), "polybot.db");
  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  initSchema();
  return db;
}

function initSchema() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      market_question TEXT NOT NULL,
      condition_id TEXT,
      category TEXT,
      strategy TEXT DEFAULT 'mispricing',
      yes_price REAL, no_price REAL,
      initial_probability REAL,
      adversarial_probability REAL,
      final_probability REAL,
      confidence TEXT, confidence_score INTEGER,
      edge REAL, direction TEXT,
      reasoning TEXT, key_uncertainties TEXT,
      traded INTEGER DEFAULT 0, skip_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      market_question TEXT NOT NULL,
      condition_id TEXT, token_id TEXT,
      strategy TEXT DEFAULT 'mispricing',
      side TEXT NOT NULL,
      price REAL NOT NULL, size REAL NOT NULL, cost REAL NOT NULL,
      status TEXT DEFAULT 'open', pnl REAL DEFAULT 0,
      dry_run INTEGER DEFAULT 0, order_response TEXT
    );
    CREATE TABLE IF NOT EXISTS strategy_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS whale_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      market_slug TEXT, consensus_side TEXT,
      whale_count INTEGER, strength REAL,
      acted_on INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cycle_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      cycle_number INTEGER,
      markets_scanned INTEGER, markets_analyzed INTEGER,
      trades_placed INTEGER, strategies_fired TEXT,
      duration_ms INTEGER
    );

    -- V3: Resolution tracking (closes the feedback loop)
    CREATE TABLE IF NOT EXISTS resolutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      market_question TEXT,
      strategy TEXT,
      predicted_prob REAL,
      predicted_direction TEXT,
      entry_price REAL,
      actual_result INTEGER,  -- 1 = YES won, 0 = NO won, NULL = unresolved
      resolution_time TEXT,
      pnl_cents REAL DEFAULT 0,
      brier_score REAL,
      council_votes TEXT,     -- JSON: {"bull": "YES", "bear": "NO", ...}
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_resolutions_ticker ON resolutions(ticker);
    CREATE INDEX IF NOT EXISTS idx_resolutions_strategy ON resolutions(strategy);

    -- V3: Open positions (live position tracking with exit management)
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      order_id TEXT,
      side TEXT NOT NULL,       -- YES or NO
      entry_price REAL NOT NULL,
      entry_time TEXT NOT NULL,
      contracts INTEGER NOT NULL,
      size_usd REAL NOT NULL,
      strategy TEXT,
      status TEXT DEFAULT 'open',  -- open, partially_closed, closed, stopped_out, take_profit, time_exit
      current_price REAL,
      peak_price REAL,             -- Highest favorable price seen (for trailing stop)
      exit_price REAL,
      exit_time TEXT,
      exit_reason TEXT,
      realized_pnl REAL DEFAULT 0,
      unrealized_pnl REAL DEFAULT 0,
      predicted_prob REAL,
      market_question TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_ticker ON positions(ticker);

    -- V6: Bankroll snapshots for equity curve persistence
    CREATE TABLE IF NOT EXISTS bankroll_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      bankroll REAL NOT NULL,
      today_pnl REAL DEFAULT 0,
      open_positions INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_bankroll_snap_ts ON bankroll_snapshots(timestamp);

    -- V3: Calibration tracking
    CREATE TABLE IF NOT EXISTS calibration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket TEXT NOT NULL,        -- "0.0-0.1", "0.1-0.2", etc.
      total_predictions INTEGER DEFAULT 0,
      actual_yes_count INTEGER DEFAULT 0,
      total_brier REAL DEFAULT 0,
      last_updated TEXT
    );

    -- V3: Council member attribution
    CREATE TABLE IF NOT EXISTS council_attribution (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_name TEXT NOT NULL UNIQUE,
      total_votes INTEGER DEFAULT 0,
      correct_votes INTEGER DEFAULT 0,
      total_brier REAL DEFAULT 0,
      total_pnl REAL DEFAULT 0,
      last_updated TEXT
    );

    -- V3: Price history for odds movement detection
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      yes_price REAL,
      no_price REAL,
      volume REAL DEFAULT 0,
      volume_24h REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_ticker_ts ON price_history(ticker, timestamp);

    -- V3: Bankroll milestones
    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      milestone_value REAL NOT NULL,
      reached_at TEXT NOT NULL,
      bankroll_at_time REAL,
      total_trades_at_time INTEGER,
      days_from_start REAL,
      strategy_breakdown TEXT  -- JSON
    );

    -- V3: Rejected signals (what we DIDN'T trade and why)
    CREATE TABLE IF NOT EXISTS rejected_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      ticker TEXT,
      strategy TEXT,
      direction TEXT,
      edge REAL,
      confidence REAL,
      reject_reason TEXT,
      market_question TEXT,
      price_at_rejection REAL,
      -- Later we check: would this have been profitable?
      resolution_result INTEGER,
      counterfactual_pnl REAL
    );
    CREATE INDEX IF NOT EXISTS idx_rejected_ticker ON rejected_signals(ticker);

    -- V3: Limit order management
    CREATE TABLE IF NOT EXISTS limit_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT,
      client_order_id TEXT UNIQUE,
      ticker TEXT NOT NULL,
      side TEXT NOT NULL,
      action TEXT NOT NULL,
      order_type TEXT DEFAULT 'limit',
      price_cents INTEGER,
      count INTEGER,
      status TEXT DEFAULT 'pending',  -- pending, resting, partial, filled, cancelled, expired
      filled_count INTEGER DEFAULT 0,
      strategy TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT,
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_limit_orders_status ON limit_orders(status);

    -- V3.1: Council response cache (slash API costs 60-80%)
    CREATE TABLE IF NOT EXISTS council_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      cache_key TEXT NOT NULL UNIQUE,
      verdict_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_council_cache_key ON council_cache(cache_key);

    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Clean up phantom PnL from excluded sports market positions (2026-04-09)
    UPDATE positions SET realized_pnl = 0 WHERE ticker LIKE '%KXMVE%' OR ticker LIKE '%SPORTS%' OR ticker LIKE '%NBA%' OR ticker LIKE '%NFL%';

    -- Initialize calibration buckets if empty
    INSERT OR IGNORE INTO calibration (bucket, total_predictions, actual_yes_count, total_brier) VALUES
      ('0.0-0.1', 0, 0, 0), ('0.1-0.2', 0, 0, 0), ('0.2-0.3', 0, 0, 0),
      ('0.3-0.4', 0, 0, 0), ('0.4-0.5', 0, 0, 0), ('0.5-0.6', 0, 0, 0),
      ('0.6-0.7', 0, 0, 0), ('0.7-0.8', 0, 0, 0), ('0.8-0.9', 0, 0, 0),
      ('0.9-1.0', 0, 0, 0);

    -- Initialize council members if empty
    INSERT OR IGNORE INTO council_attribution (member_name, total_votes, correct_votes) VALUES
      ('bull', 0, 0), ('bear', 0, 0), ('quant', 0, 0), ('sage', 0, 0), ('judge', 0, 0);
  `);
}

export function logAnalysis(a: Record<string, any>) {
  const d = getDb();
  d.prepare(`
    INSERT INTO analyses (timestamp, market_question, condition_id, category, strategy,
      yes_price, no_price, initial_probability, adversarial_probability, final_probability,
      confidence, confidence_score, edge, direction, reasoning, key_uncertainties, traded, skip_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    a.timestamp, a.market_question, a.condition_id ?? "", a.category ?? "", a.strategy ?? "mispricing",
    a.yes_price ?? 0, a.no_price ?? 0, a.initial_probability ?? 0, a.adversarial_probability ?? 0,
    a.final_probability ?? 0, a.confidence ?? "low", a.confidence_score ?? 0,
    a.edge ?? 0, a.direction ?? "SKIP", a.reasoning ?? "", a.key_uncertainties ?? "",
    a.traded ? 1 : 0, a.skip_reason ?? ""
  );
}

export function logTrade(t: Record<string, any>) {
  const d = getDb();
  d.prepare(`
    INSERT INTO trades (timestamp, market_question, condition_id, token_id, strategy,
      side, price, size, cost, dry_run, order_response)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(), t.market_question ?? "", t.condition_id ?? "",
    t.token_id ?? "", t.strategy ?? "mispricing",
    t.side ?? "", t.price ?? 0, t.size ?? 0, t.cost ?? 0,
    t.dry_run ? 1 : 0, t.order_response ?? ""
  );
}

// V3: Log rejected signal for counterfactual analysis
export function logRejectedSignal(r: {
  ticker: string; strategy: string; direction: string;
  edge: number; confidence: number; reject_reason: string;
  market_question: string; price: number;
}) {
  const d = getDb();
  d.prepare(`
    INSERT INTO rejected_signals (timestamp, ticker, strategy, direction, edge, confidence, reject_reason, market_question, price_at_rejection)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(new Date().toISOString(), r.ticker, r.strategy, r.direction, r.edge, r.confidence, r.reject_reason, r.market_question, r.price);
}

// V3: Open position tracking
export function openPosition(p: {
  ticker: string; order_id?: string; side: string; entry_price: number;
  contracts: number; size_usd: number; strategy: string;
  predicted_prob?: number; market_question?: string;
}) {
  const d = getDb();
  d.prepare(`
    INSERT INTO positions (ticker, order_id, side, entry_price, entry_time, contracts, size_usd, strategy, status, peak_price, predicted_prob, market_question)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
  `).run(p.ticker, p.order_id ?? null, p.side, p.entry_price, new Date().toISOString(), p.contracts, p.size_usd, p.strategy, p.entry_price, p.predicted_prob ?? null, p.market_question ?? null);
}

export function getOpenPositions() {
  const d = getDb();
  // V5: Include all non-terminal positions — not just 'open'
  // Positions with status like 'partially_closed', 'turbo_brain_exit:...' were getting stuck
  return d.prepare(`SELECT * FROM positions WHERE status NOT IN ('settled','take_profit','trailing_stop','stop_loss','time_exit','turbo_cut','turbo_early_cut','stopped_out','chat_manual_close','market_closed','market_finalized','market_expired_exit_failed') ORDER BY entry_time ASC`).all() as any[];
}

export function updatePositionPrice(id: number, currentPrice: number, peakPrice: number, unrealizedPnl: number) {
  const d = getDb();
  d.prepare(`UPDATE positions SET current_price = ?, peak_price = MAX(COALESCE(peak_price, 0), ?), unrealized_pnl = ? WHERE id = ?`).run(currentPrice, peakPrice, unrealizedPnl, id);
}

export function closePosition(id: number, exitPrice: number, exitReason: string, realizedPnl: number) {
  const d = getDb();
  d.prepare(`UPDATE positions SET status = ?, exit_price = ?, exit_time = ?, exit_reason = ?, realized_pnl = ? WHERE id = ?`).run(exitReason, exitPrice, new Date().toISOString(), exitReason, realizedPnl, id);
}

// V3: Record resolution for calibration
export function logResolution(r: {
  ticker: string; market_question?: string; strategy?: string;
  predicted_prob: number; predicted_direction: string; entry_price: number;
  actual_result: number; pnl_cents: number;
  council_votes?: Record<string, string>;
}) {
  const d = getDb();
  const brierScore = Math.pow(r.predicted_prob - r.actual_result, 2);
  d.prepare(`
    INSERT INTO resolutions (ticker, market_question, strategy, predicted_prob, predicted_direction, entry_price, actual_result, resolution_time, pnl_cents, brier_score, council_votes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.ticker, r.market_question ?? "", r.strategy ?? "", r.predicted_prob, r.predicted_direction, r.entry_price, r.actual_result, new Date().toISOString(), r.pnl_cents, brierScore, r.council_votes ? JSON.stringify(r.council_votes) : null);

  // Update calibration bucket
  const bucket = getBucket(r.predicted_prob);
  d.prepare(`UPDATE calibration SET total_predictions = total_predictions + 1, actual_yes_count = actual_yes_count + ?, total_brier = total_brier + ?, last_updated = ? WHERE bucket = ?`)
    .run(r.actual_result, brierScore, new Date().toISOString(), bucket);

  // Update council attribution if votes provided
  if (r.council_votes) {
    for (const [member, vote] of Object.entries(r.council_votes)) {
      const correct = (vote === "YES" && r.actual_result === 1) || (vote === "NO" && r.actual_result === 0) ? 1 : 0;
      d.prepare(`UPDATE council_attribution SET total_votes = total_votes + 1, correct_votes = correct_votes + ?, total_pnl = total_pnl + ?, last_updated = ? WHERE member_name = ?`)
        .run(correct, r.pnl_cents, new Date().toISOString(), member);
    }
  }
}

// V3: Log price snapshot
export function logPriceSnapshot(ticker: string, yesPrice: number, noPrice: number, volume: number, volume24h: number) {
  const d = getDb();
  d.prepare(`INSERT INTO price_history (ticker, timestamp, yes_price, no_price, volume, volume_24h) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(ticker, new Date().toISOString(), yesPrice, noPrice, volume, volume24h);
}

// V3: Record milestone
export function logMilestone(milestone: number, bankroll: number, totalTrades: number, daysFromStart: number, strategyBreakdown: Record<string, number>) {
  const d = getDb();
  const existing = d.prepare(`SELECT id FROM milestones WHERE milestone_value = ?`).get(milestone);
  if (existing) return; // Already logged
  d.prepare(`INSERT INTO milestones (milestone_value, reached_at, bankroll_at_time, total_trades_at_time, days_from_start, strategy_breakdown) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(milestone, new Date().toISOString(), bankroll, totalTrades, daysFromStart, JSON.stringify(strategyBreakdown));
  console.log(`\n🏆 MILESTONE: $${milestone} reached! Bankroll: $${bankroll.toFixed(2)} after ${totalTrades} trades in ${daysFromStart.toFixed(1)} days\n`);
}

// V3: Get price velocity for a ticker
export function getPriceVelocity(ticker: string, lookbackMinutes: number = 60): { velocity: number; volume_change: number; data_points: number } {
  const d = getDb();
  const since = new Date(Date.now() - lookbackMinutes * 60000).toISOString();
  const rows = d.prepare(`SELECT yes_price, volume, timestamp FROM price_history WHERE ticker = ? AND timestamp > ? ORDER BY timestamp ASC`).all(ticker, since) as any[];
  if (rows.length < 2) return { velocity: 0, volume_change: 0, data_points: rows.length };
  const first = rows[0];
  const last = rows[rows.length - 1];
  const velocity = (last.yes_price - first.yes_price) * 100; // cents per period
  const volumeChange = last.volume - first.volume;
  return { velocity, volume_change: volumeChange, data_points: rows.length };
}

// V3: Get calibration data
export function getCalibrationData() {
  const d = getDb();
  return d.prepare(`SELECT * FROM calibration ORDER BY bucket`).all() as any[];
}

// V3: Get council attribution
export function getCouncilAttribution() {
  const d = getDb();
  return d.prepare(`SELECT *, CASE WHEN total_votes > 0 THEN CAST(correct_votes AS REAL) / total_votes ELSE 0 END as accuracy FROM council_attribution ORDER BY accuracy DESC`).all() as any[];
}

// V3: Get all milestones
export function getMilestones() {
  const d = getDb();
  return d.prepare(`SELECT * FROM milestones ORDER BY milestone_value ASC`).all() as any[];
}

export function getStats() {
  const d = getDb();
  const total = d.prepare(`SELECT COUNT(*) as c FROM trades`).get() as any;
  const analyses = d.prepare(`SELECT COUNT(*) as c FROM analyses`).get() as any;
  const traded = d.prepare(`SELECT COUNT(*) as c FROM analyses WHERE traded = 1`).get() as any;
  const byStrategy = d.prepare(`
    SELECT strategy, COUNT(*) as count, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins
    FROM trades GROUP BY strategy
  `).all() as any[];
  const resolutionStats = d.prepare(`
    SELECT strategy, COUNT(*) as total, SUM(CASE WHEN actual_result = 1 AND predicted_direction = 'YES' OR actual_result = 0 AND predicted_direction = 'NO' THEN 1 ELSE 0 END) as correct,
    AVG(brier_score) as avg_brier, SUM(pnl_cents) as total_pnl
    FROM resolutions WHERE actual_result IS NOT NULL GROUP BY strategy
  `).all() as any[];
  return {
    total_trades: total?.c ?? 0,
    total_analyses: analyses?.c ?? 0,
    total_traded: traded?.c ?? 0,
    by_strategy: byStrategy,
    resolution_stats: resolutionStats,
  };
}

// ── Bot state persistence (survives deploys) ──

export function getBotState(key: string, defaultValue: string = ""): string {
  const d = getDb();
  const row = d.prepare(`SELECT value FROM bot_state WHERE key = ?`).get(key) as any;
  return row?.value ?? defaultValue;
}

export function setBotState(key: string, value: string): void {
  const d = getDb();
  d.prepare(`INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`)
    .run(key, value, Date.now(), value, Date.now());
}

// V3.1: Get today's realized PnL for daily loss limit
export function getTodayPnl(): number {
  const d = getDb();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const row = d.prepare(`SELECT COALESCE(SUM(realized_pnl), 0) as total FROM positions WHERE exit_time > ? AND status != 'open'`).get(todayStart.toISOString()) as any;
  return row?.total ?? 0;
}

// V3.1: Council cache — get cached verdict if still valid
export function getCachedVerdict(marketId: string, priceKey: string): any | null {
  const d = getDb();
  const cacheKey = `${marketId}:${priceKey}`;
  const row = d.prepare(`SELECT verdict_json FROM council_cache WHERE cache_key = ? AND expires_at > datetime('now')`).get(cacheKey) as any;
  if (!row) return null;
  try { return JSON.parse(row.verdict_json); } catch { return null; }
}

// V3.1: Council cache — store verdict
export function setCachedVerdict(marketId: string, priceKey: string, verdict: any, ttlMinutes: number = 30) {
  const d = getDb();
  const cacheKey = `${marketId}:${priceKey}`;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  d.prepare(`INSERT OR REPLACE INTO council_cache (market_id, cache_key, verdict_json, expires_at) VALUES (?, ?, ?, ?)`)
    .run(marketId, cacheKey, JSON.stringify(verdict), expiresAt);
}

// V3.1: Clean expired cache entries
export function cleanExpiredCache() {
  const d = getDb();
  d.prepare(`DELETE FROM council_cache WHERE expires_at < datetime('now')`).run();
}

function getBucket(prob: number): string {
  const lower = Math.floor(prob * 10) / 10;
  const upper = lower + 0.1;
  if (lower >= 1) return "0.9-1.0";
  if (lower < 0) return "0.0-0.1";
  return `${lower.toFixed(1)}-${upper.toFixed(1)}`;
}

// ── V6: Bankroll snapshot persistence for equity curve ──

export function logBankrollSnapshot(bankroll: number, todayPnl: number, openPositions: number): void {
  const d = getDb();
  d.prepare(`INSERT INTO bankroll_snapshots (timestamp, bankroll, today_pnl, open_positions) VALUES (?, ?, ?, ?)`)
    .run(new Date().toISOString(), bankroll, todayPnl, openPositions);

  // Thin old data: keep every 5th point for data older than 24h
  const cutoff24h = new Date(Date.now() - 86400000).toISOString();
  d.prepare(`DELETE FROM bankroll_snapshots WHERE timestamp < ? AND id % 5 != 0`).run(cutoff24h);
}

export function getBankrollHistory(range: string): Array<{ timestamp: string; bankroll: number; today_pnl: number }> {
  const d = getDb();
  const rangeMs: Record<string, number> = {
    "1h": 3600000, "4h": 14400000, "1d": 86400000, "7d": 604800000, "30d": 2592000000
  };
  const ms = rangeMs[range] ?? 604800000;
  const since = new Date(Date.now() - ms).toISOString();
  return d.prepare(`SELECT timestamp, bankroll, today_pnl FROM bankroll_snapshots WHERE timestamp > ? ORDER BY timestamp ASC`).all(since) as any[];
}

// V6: Financial stats for dashboard
export function getFinancialStats(): {
  lifetime: { wins: number; losses: number; win_amount: number; loss_amount: number; pnl: number };
  today: { wins: number; losses: number; win_amount: number; loss_amount: number; pnl: number };
  by_asset: Array<{ asset: string; trades: number; wins: number; pnl: number }>;
  by_exit: Array<{ status: string; count: number; pnl: number }>;
  peak_balance: number;
} {
  const d = getDb();
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const lifetime = d.prepare(`SELECT
    COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END), 0) as wins,
    COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END), 0) as losses,
    COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END), 0) as win_amount,
    COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN realized_pnl ELSE 0 END), 0) as loss_amount,
    COALESCE(SUM(realized_pnl), 0) as pnl
  FROM positions`).get() as any;

  const today = d.prepare(`SELECT
    COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END), 0) as wins,
    COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END), 0) as losses,
    COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END), 0) as win_amount,
    COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN realized_pnl ELSE 0 END), 0) as loss_amount,
    COALESCE(SUM(realized_pnl), 0) as pnl
  FROM positions WHERE entry_time > ?`).get(todayISO) as any;

  const byAsset = d.prepare(`SELECT
    CASE WHEN ticker LIKE '%BTC%' THEN 'BTC' WHEN ticker LIKE '%ETH%' THEN 'ETH' WHEN ticker LIKE '%SOL%' THEN 'SOL' ELSE 'XRP' END as asset,
    COUNT(*) as trades,
    SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
    SUM(realized_pnl) as pnl
  FROM positions GROUP BY asset ORDER BY pnl DESC`).all() as any[];

  const byExit = d.prepare(`SELECT status, COUNT(*) as count, SUM(realized_pnl) as pnl FROM positions GROUP BY status ORDER BY pnl ASC`).all() as any[];

  // Peak balance from bankroll snapshots
  const peak = d.prepare(`SELECT MAX(bankroll) as peak FROM bankroll_snapshots`).get() as any;

  return {
    lifetime: { wins: lifetime.wins, losses: lifetime.losses, win_amount: lifetime.win_amount, loss_amount: lifetime.loss_amount, pnl: lifetime.pnl },
    today: { wins: today.wins, losses: today.losses, win_amount: today.win_amount, loss_amount: today.loss_amount, pnl: today.pnl },
    by_asset: byAsset,
    by_exit: byExit,
    peak_balance: peak?.peak ?? 0,
  };
}

// V6: Get position price history for charting
export function getPositionPriceHistory(ticker: string): Array<{ timestamp: string; yes_price: number; no_price: number }> {
  const d = getDb();
  return d.prepare(`SELECT timestamp, yes_price, no_price FROM price_history WHERE ticker = ? ORDER BY timestamp ASC`).all(ticker) as any[];
}
