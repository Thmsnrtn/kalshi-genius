// src/db.ts — V2 SQLite with strategy adjustment tracking

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

export function getStats() {
  const d = getDb();
  const total = d.prepare(`SELECT COUNT(*) as c FROM trades`).get() as any;
  const analyses = d.prepare(`SELECT COUNT(*) as c FROM analyses`).get() as any;
  const traded = d.prepare(`SELECT COUNT(*) as c FROM analyses WHERE traded = 1`).get() as any;
  const byStrategy = d.prepare(`
    SELECT strategy, COUNT(*) as count, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins
    FROM trades GROUP BY strategy
  `).all() as any[];
  return { total_trades: total?.c ?? 0, total_analyses: analyses?.c ?? 0, total_traded: traded?.c ?? 0, by_strategy: byStrategy };
}
