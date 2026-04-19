// src/core/startup_reconciler.ts — Boot-time consistency check
// between local `positions` table and Kalshi's live portfolio.
//
// Protects against the TradeTrap-class failure mode where the bot's
// notion of "what's open" diverges from reality after a crash/restart
// and then sizes/manages positions against fabricated state.
//
// Policy (conservative — never trades on reconcile, only reconciles):
//   - Local 'open' but Kalshi flat on that ticker   → close locally
//     with exit_reason='reconcile_missing' (no PnL imputed).
//   - Kalshi holds exposure we don't track locally  → log a warning
//     with ticker + size; the operator decides whether to adopt or exit.
//     We never auto-insert: we don't know strategy/edge/predicted_prob.
//   - Both present                                  → no-op.
//
// Skipped entirely in DRY_RUN (paper positions won't match real portfolio).

import { getDb, getOpenPositions, closePosition } from "./db.js";
import type { KalshiClient, KalshiPosition } from "../exchanges/kalshi/kalshi_client.js";

export interface ReconcileReport {
  ran: boolean;
  skipped_reason?: string;
  local_open_count: number;
  kalshi_position_count: number;
  closed_as_missing: Array<{ id: number; ticker: string; side: string; contracts: number }>;
  unknown_on_kalshi: Array<{ ticker: string; position: number; market_exposure_cents: number }>;
  errors: string[];
}

export async function reconcileStartupPositions(opts: {
  kalshi: KalshiClient;
  isDryRun: boolean;
}): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    ran: false,
    local_open_count: 0,
    kalshi_position_count: 0,
    closed_as_missing: [],
    unknown_on_kalshi: [],
    errors: [],
  };

  if (opts.isDryRun) {
    report.skipped_reason = "DRY_RUN mode — local positions are paper, no reconcile needed";
    console.log(`🔁 Startup reconcile: SKIPPED (${report.skipped_reason})`);
    return report;
  }

  const localOpen = getOpenPositions() as Array<{
    id: number; ticker: string; side: string; contracts: number; entry_price: number;
  }>;
  report.local_open_count = localOpen.length;

  let kalshiPositions: KalshiPosition[] = [];
  try {
    const resp = await opts.kalshi.getPositions({ limit: 200 });
    kalshiPositions = resp.positions ?? [];
  } catch (err: any) {
    const msg = `Kalshi getPositions failed: ${err?.message ?? err}`;
    report.errors.push(msg);
    console.warn(`⚠️  Startup reconcile: ${msg} — skipping this pass`);
    return report;
  }
  report.kalshi_position_count = kalshiPositions.length;
  report.ran = true;

  // Kalshi's `position` field is signed: positive = YES, negative = NO, zero = flat.
  // Index by ticker for O(1) lookup.
  const byTicker = new Map<string, KalshiPosition>();
  for (const p of kalshiPositions) byTicker.set(p.ticker, p);

  // (1) Local-open → Kalshi: close any local position Kalshi doesn't confirm.
  for (const pos of localOpen) {
    const live = byTicker.get(pos.ticker);
    const liveSide = !live || live.position === 0 ? "flat"
      : live.position > 0 ? "YES" : "NO";
    const liveContracts = live ? Math.abs(live.position) : 0;

    if (liveSide === "flat") {
      // Kalshi confirms no exposure — was settled or never filled.
      closePosition(pos.id, pos.entry_price, "reconcile_missing", 0);
      report.closed_as_missing.push({
        id: pos.id, ticker: pos.ticker, side: pos.side, contracts: pos.contracts,
      });
      continue;
    }

    if (liveSide !== pos.side) {
      // Opposite side live — rare but serious. Leave the local row alone,
      // flag loudly. Operator must reconcile manually via chat/dashboard.
      const msg = `Side mismatch on ${pos.ticker}: local=${pos.side} live=${liveSide} (${liveContracts} contracts)`;
      report.errors.push(msg);
      console.warn(`⚠️  Startup reconcile: ${msg}`);
    }
    // Contract-count drift is expected (partial fills/exits) — we don't adjust
    // quantities here; the position_manager loop owns ongoing state.
  }

  // (2) Kalshi → local: warn on positions we don't track.
  const localTickers = new Set(localOpen.map((p) => p.ticker));
  for (const p of kalshiPositions) {
    if (p.position === 0) continue;
    if (!localTickers.has(p.ticker)) {
      report.unknown_on_kalshi.push({
        ticker: p.ticker,
        position: p.position,
        market_exposure_cents: p.market_exposure,
      });
    }
  }

  // Log a one-line summary (detail available via the returned report).
  const closedCount = report.closed_as_missing.length;
  const unknownCount = report.unknown_on_kalshi.length;
  const tag = closedCount === 0 && unknownCount === 0 && report.errors.length === 0 ? "✅" : "⚠️ ";
  console.log(
    `🔁 Startup reconcile ${tag}: local_open=${report.local_open_count} kalshi=${report.kalshi_position_count} ` +
    `closed_missing=${closedCount} untracked_on_kalshi=${unknownCount} errors=${report.errors.length}`,
  );
  if (unknownCount > 0) {
    console.log(`    Untracked on Kalshi (review manually):`);
    for (const u of report.unknown_on_kalshi) {
      const side = u.position > 0 ? "YES" : "NO";
      console.log(`      ${u.ticker}: ${side} ${Math.abs(u.position)} contracts (exposure $${(u.market_exposure_cents / 100).toFixed(2)})`);
    }
  }

  // Persist last-run summary to bot_state for the dashboard.
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO bot_state (key, value, updated_at) VALUES (?, ?, ?)`,
  ).run(
    "reconcile_last_run",
    JSON.stringify({
      ts: new Date().toISOString(),
      local_open_count: report.local_open_count,
      kalshi_position_count: report.kalshi_position_count,
      closed_as_missing: report.closed_as_missing,
      unknown_on_kalshi: report.unknown_on_kalshi,
      errors: report.errors,
    }),
    Date.now(),
  );

  return report;
}
