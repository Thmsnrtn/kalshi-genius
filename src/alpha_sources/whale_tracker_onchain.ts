// src/alpha_sources/whale_tracker_onchain.ts
//
// ON-CHAIN WHALE TRACKER
//
// The most profitable Polymarket traders leave a trail on-chain. By
// tracking their wallets, we can see their positions in real-time and
// use their convergent signals as a high-confidence input.
//
// Data sources:
// 1. Polygon RPC for reading wallet balances and transaction history
// 2. The Graph subgraph for Polymarket events (free)
// 3. Polymarket's data API for position snapshots
//
// A whale is defined as: wallet with >$50K realized PnL in last 30 days
// OR wallet that consistently appears in top 100 weekly PnL rankings.
//
// When 3+ whales converge on the same side of a market, that's a
// strong signal that the Cognitive Council should deliberate on.

import { getDb } from "../core/db.js";

// Known profitable wallets from public Polymarket leaderboards
// (These are examples — real implementation would scrape the leaderboard)
const KNOWN_WHALES: { address: string; nickname: string; tier: string }[] = [
  // Format: { address: "0x...", nickname: "...", tier: "S/A/B" }
  // Populate this from https://polymarket.com/leaderboard
];

export interface WhalePosition {
  wallet: string;
  market_id: string;
  market_question: string;
  direction: "YES" | "NO";
  size_usd: number;
  entry_price: number;
  timestamp: number;
}

export interface WhaleConvergence {
  market_id: string;
  market_question: string;
  direction: "YES" | "NO";
  whale_count: number;
  total_size_usd: number;
  avg_entry_price: number;
  confidence: number;
  wallets: string[];
  first_detected: number;
}

export function initWhaleTracker() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS whale_wallets (
      address TEXT PRIMARY KEY,
      nickname TEXT,
      tier TEXT DEFAULT 'B',
      total_pnl_usd REAL DEFAULT 0,
      trades_30d INTEGER DEFAULT 0,
      win_rate REAL DEFAULT 0,
      last_active INTEGER,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whale_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      market_id TEXT NOT NULL,
      market_question TEXT NOT NULL,
      direction TEXT NOT NULL,
      size_usd REAL NOT NULL,
      entry_price REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      still_open INTEGER DEFAULT 1,
      FOREIGN KEY (wallet) REFERENCES whale_wallets(address)
    );
    CREATE INDEX IF NOT EXISTS idx_wp_market ON whale_positions(market_id);
    CREATE INDEX IF NOT EXISTS idx_wp_wallet ON whale_positions(wallet);
    CREATE INDEX IF NOT EXISTS idx_wp_timestamp ON whale_positions(timestamp);

    CREATE TABLE IF NOT EXISTS whale_convergences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      whale_count INTEGER NOT NULL,
      total_size_usd REAL NOT NULL,
      avg_entry_price REAL NOT NULL,
      first_detected INTEGER NOT NULL,
      acted_on INTEGER DEFAULT 0
    );
  `);

  // Seed with known whales
  for (const w of KNOWN_WHALES) {
    db.prepare(`
      INSERT OR IGNORE INTO whale_wallets (address, nickname, tier, added_at)
      VALUES (?, ?, ?, ?)
    `).run((w as any).address, (w as any).nickname, (w as any).tier, Date.now());
  }
}

// ── Fetch top wallets from Polymarket leaderboard ──
export async function discoverTopWallets(): Promise<number> {
  try {
    // Polymarket's public leaderboard API
    const res = await fetch("https://data-api.polymarket.com/leaderboard?window=weekly&limit=100", {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return 0;
    const data = await res.json() as any;

    const db = getDb();
    let added = 0;

    for (const entry of (data.data ?? data ?? []).slice(0, 100)) {
      const address = entry.proxyWallet || entry.wallet || entry.address;
      if (!address) continue;
      const pnl = parseFloat(entry.pnl ?? entry.weeklyPnl ?? "0");
      const volume = parseFloat(entry.volume ?? "0");
      if (pnl < 5000) continue; // Only track meaningful winners

      const tier = pnl > 100000 ? "S" : pnl > 50000 ? "A" : "B";
      const result = db.prepare(`
        INSERT OR IGNORE INTO whale_wallets (address, nickname, tier, total_pnl_usd, added_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(address.toLowerCase(), entry.name ?? address.slice(0, 8), tier, pnl, Date.now());
      if (result.changes > 0) added++;
    }

    return added;
  } catch (err: any) {
    console.error(`  Whale discovery error: ${err.message}`);
    return 0;
  }
}

// ── Fetch recent positions for a specific wallet ──
export async function fetchWalletPositions(wallet: string): Promise<WhalePosition[]> {
  try {
    const res = await fetch(`https://data-api.polymarket.com/positions?user=${wallet}&sizeThreshold=100`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;

    return (data ?? []).map((p: any) => ({
      wallet: wallet.toLowerCase(),
      market_id: p.conditionId ?? p.market ?? "",
      market_question: p.title ?? p.question ?? "Unknown",
      direction: p.outcome === "Yes" ? "YES" as const : "NO" as const,
      size_usd: parseFloat(p.currentValue ?? p.initialValue ?? "0"),
      entry_price: parseFloat(p.avgPrice ?? "0"),
      timestamp: Date.now(),
    })).filter((p: WhalePosition) => p.size_usd > 100 && p.market_id);
  } catch {
    return [];
  }
}

// ── Update positions for all tracked whales ──
export async function updateWhalePositions(): Promise<{ wallets_checked: number; new_positions: number }> {
  const db = getDb();
  const whales = db.prepare(`SELECT address FROM whale_wallets WHERE tier IN ('S', 'A')`).all() as any[];

  let newPositions = 0;
  for (const whale of whales.slice(0, 20)) { // Rate limit: 20 wallets per cycle
    const positions = await fetchWalletPositions(whale.address);
    for (const pos of positions) {
      try {
        db.prepare(`
          INSERT INTO whale_positions 
          (wallet, market_id, market_question, direction, size_usd, entry_price, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(pos.wallet, pos.market_id, pos.market_question, pos.direction, pos.size_usd, pos.entry_price, pos.timestamp);
        newPositions++;
      } catch {} // Duplicate or constraint
    }
    await new Promise((r) => setTimeout(r, 500)); // Polite rate limiting
  }

  return { wallets_checked: whales.length, new_positions: newPositions };
}

// ── Detect whale convergence (3+ whales on same side) ──
export function detectConvergences(): WhaleConvergence[] {
  const db = getDb();
  const since = Date.now() - 2 * 60 * 60 * 1000; // Last 2 hours

  const rows = db.prepare(`
    SELECT 
      market_id, 
      market_question,
      direction,
      COUNT(DISTINCT wallet) as whale_count,
      SUM(size_usd) as total_size,
      AVG(entry_price) as avg_price,
      GROUP_CONCAT(DISTINCT wallet) as wallets,
      MIN(timestamp) as first_detected
    FROM whale_positions
    WHERE timestamp >= ? AND still_open = 1
    GROUP BY market_id, direction
    HAVING whale_count >= 3 AND total_size >= 10000
    ORDER BY whale_count DESC, total_size DESC
    LIMIT 10
  `).all(since) as any[];

  return rows.map((r) => ({
    market_id: r.market_id,
    market_question: r.market_question,
    direction: r.direction as "YES" | "NO",
    whale_count: r.whale_count,
    total_size_usd: r.total_size,
    avg_entry_price: r.avg_price,
    confidence: Math.min(0.95, 0.5 + (r.whale_count - 3) * 0.1 + Math.log10(r.total_size / 10000) * 0.1),
    wallets: r.wallets.split(","),
    first_detected: r.first_detected,
  }));
}

// ── Persist new convergences ──
export function recordConvergences(convergences: WhaleConvergence[]): number {
  const db = getDb();
  let newCount = 0;
  for (const c of convergences) {
    const existing = db.prepare(`
      SELECT id FROM whale_convergences 
      WHERE market_id = ? AND direction = ? AND first_detected = ?
    `).get(c.market_id, c.direction, c.first_detected);
    if (!existing) {
      db.prepare(`
        INSERT INTO whale_convergences 
        (market_id, direction, whale_count, total_size_usd, avg_entry_price, first_detected)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(c.market_id, c.direction, c.whale_count, c.total_size_usd, c.avg_entry_price, c.first_detected);
      newCount++;
    }
  }
  return newCount;
}

// ── Full cycle ──
export async function runWhaleTrackerCycle(): Promise<{ new_whales: number; new_positions: number; convergences: number }> {
  const newWhales = await discoverTopWallets();
  const { new_positions } = await updateWhalePositions();
  const convergences = detectConvergences();
  const newConvergences = recordConvergences(convergences);
  return { new_whales: newWhales, new_positions, convergences: newConvergences };
}
