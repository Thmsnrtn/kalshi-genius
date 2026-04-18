// src/core/tax_tracker.ts — Tax lot tracking with FIFO matching (#18)

import type { Database } from "bun:sqlite";

const SHORT_TERM_RATE = 0.35;
const LONG_TERM_RATE = 0.15;
const ONE_YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

let db: Database | null = null;

export interface TaxLot {
  id: number;
  market_ticker: string;
  side: string;
  entry_price: number;
  quantity: number;
  entry_date: string;
  exit_price: number | null;
  exit_date: string | null;
  pnl: number | null;
  holding_period: string;
  tax_year: number;
}

export interface TaxSummary {
  totalPnl: number;
  shortTermGains: number;
  shortTermLosses: number;
  longTermGains: number;
  longTermLosses: number;
  netTaxable: number;
  estimatedTax: number;
  lotCount: number;
}

// ── Initialize tax tracker: create table + store db ref ──

export function initTaxTracker(database: any): void {
  db = database;
  db!.exec(`
    CREATE TABLE IF NOT EXISTS tax_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_ticker TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('yes', 'no')),
      entry_price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      entry_date TEXT NOT NULL,
      exit_price REAL,
      exit_date TEXT,
      pnl REAL,
      holding_period TEXT NOT NULL DEFAULT 'short' CHECK(holding_period IN ('short', 'long')),
      tax_year INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tax_lots_ticker_side ON tax_lots(market_ticker, side);
    CREATE INDEX IF NOT EXISTS idx_tax_lots_year ON tax_lots(tax_year);
    CREATE INDEX IF NOT EXISTS idx_tax_lots_open ON tax_lots(exit_date);
  `);
}

function getDb(): Database {
  if (!db) throw new Error("[TaxTracker] Not initialized — call initTaxTracker(db) first");
  return db;
}

// ── Record a new tax lot on entry ──

export function recordTaxLot(
  ticker: string,
  side: string,
  price: number,
  quantity: number,
): void {
  const d = getDb();
  const now = new Date().toISOString();
  const year = new Date().getFullYear();

  d.prepare(`
    INSERT INTO tax_lots (market_ticker, side, entry_price, quantity, entry_date, holding_period, tax_year)
    VALUES (?, ?, ?, ?, ?, 'short', ?)
  `).run(ticker, side.toLowerCase(), price, quantity, now, year);
}

// ── Close lots using FIFO matching ──

export function closeTaxLot(
  ticker: string,
  side: string,
  exitPrice: number,
  quantity: number,
): void {
  const d = getDb();
  const normalizedSide = side.toLowerCase();

  // Get open lots for this ticker+side, oldest first (FIFO)
  const openLots = d.prepare(`
    SELECT * FROM tax_lots
    WHERE market_ticker = ? AND side = ? AND exit_date IS NULL
    ORDER BY entry_date ASC
  `).all(ticker, normalizedSide) as TaxLot[];

  let remaining = quantity;

  for (const lot of openLots) {
    if (remaining <= 0) break;

    const closeQty = Math.min(lot.quantity, remaining);
    const now = new Date();
    const exitDate = now.toISOString();
    const entryDate = new Date(lot.entry_date);
    const heldMs = now.getTime() - entryDate.getTime();
    const holdingPeriod = heldMs >= ONE_YEAR_MS ? "long" : "short";
    const pnl = (exitPrice - lot.entry_price) * closeQty;
    const exitYear = now.getFullYear();

    if (closeQty === lot.quantity) {
      // Close the entire lot
      d.prepare(`
        UPDATE tax_lots
        SET exit_price = ?, exit_date = ?, pnl = ?, holding_period = ?, tax_year = ?
        WHERE id = ?
      `).run(exitPrice, exitDate, pnl, holdingPeriod, exitYear, lot.id);
    } else {
      // Partial close: reduce the open lot and create a new closed lot for the sold portion
      d.prepare(`
        UPDATE tax_lots SET quantity = ? WHERE id = ?
      `).run(lot.quantity - closeQty, lot.id);

      d.prepare(`
        INSERT INTO tax_lots (market_ticker, side, entry_price, quantity, entry_date, exit_price, exit_date, pnl, holding_period, tax_year)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lot.market_ticker, lot.side, lot.entry_price, closeQty,
        lot.entry_date, exitPrice, exitDate, pnl, holdingPeriod, exitYear,
      );
    }

    remaining -= closeQty;
  }

  if (remaining > 0) {
    console.warn(`[TaxTracker] Warning: ${remaining} contracts for ${ticker}/${normalizedSide} could not be matched to open lots`);
  }
}

// ── Tax summary for a given year (or all time) ──

export function getTaxSummary(year?: number): TaxSummary {
  const d = getDb();

  const whereClause = year != null
    ? "WHERE exit_date IS NOT NULL AND tax_year = ?"
    : "WHERE exit_date IS NOT NULL";
  const params = year != null ? [year] : [];

  const rows = d.prepare(`
    SELECT pnl, holding_period FROM tax_lots ${whereClause}
  `).all(...params) as { pnl: number; holding_period: string }[];

  let shortTermGains = 0;
  let shortTermLosses = 0;
  let longTermGains = 0;
  let longTermLosses = 0;

  for (const row of rows) {
    if (row.holding_period === "short") {
      if (row.pnl >= 0) shortTermGains += row.pnl;
      else shortTermLosses += row.pnl;
    } else {
      if (row.pnl >= 0) longTermGains += row.pnl;
      else longTermLosses += row.pnl;
    }
  }

  const totalPnl = shortTermGains + shortTermLosses + longTermGains + longTermLosses;
  const netShort = shortTermGains + shortTermLosses;
  const netLong = longTermGains + longTermLosses;
  const netTaxable = totalPnl;

  const estimatedTax =
    Math.max(0, netShort) * SHORT_TERM_RATE +
    Math.max(0, netLong) * LONG_TERM_RATE;

  return {
    totalPnl,
    shortTermGains,
    shortTermLosses,
    longTermGains,
    longTermLosses,
    netTaxable,
    estimatedTax,
    lotCount: rows.length,
  };
}

// ── Get all unclosed lots ──

export function getOpenLots(): TaxLot[] {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM tax_lots WHERE exit_date IS NULL ORDER BY entry_date ASC
  `).all() as TaxLot[];
}

// ── Get last N closed lots ──

export function getRecentLots(limit: number): TaxLot[] {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM tax_lots WHERE exit_date IS NOT NULL ORDER BY exit_date DESC LIMIT ?
  `).all(limit) as TaxLot[];
}
