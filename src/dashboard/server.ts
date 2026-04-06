// src/dashboard/server.ts
//
// MOBILE DASHBOARD SERVER
//
// Serves the phone-first dashboard and a JSON snapshot API.
// Polls all system state and returns it as a single snapshot.
//
// Runs on DASHBOARD_PORT (default 3000).
// If deployed to Fly.io, this becomes your bot.fly.dev URL.
// Pin to your iOS home screen for a native-feeling app.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getDb } from "../core/db.js";
import { getAllWeights } from "../evolution/strategy_weights.js";
import { getCurrentRegime } from "../evolution/regime_detector.js";
import { getEvolutionState } from "../evolution/evolution_loop.js";
import { getPerformance, getTopPerformers } from "../evolution/performance_tracker.js";
import { getLabReport } from "../genius/hypothesis_lab.js";
import { getGeneticsReport } from "../genius/strategy_genetics.js";
import { getCalibrationReport } from "../genius/calibration_engine.js";
import { getGeniusState } from "../genius/genius_orchestrator.js";
import { config, getPhaseParams } from "../core/config.js";

// Load HTML once at startup
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HTML = readFileSync(join(__dirname, "page.html"), "utf-8");

// State shared with main bot
export interface BotState {
  getBankroll: () => number;
  getStartingBankroll: () => number;
  getOpenPositions: () => number;
  getStartTime: () => number;
  isPaused: () => boolean;
  setPaused: (p: boolean) => void;
  getLatestVerdict: () => any;
}

let botState: BotState | null = null;

export function setBotState(s: BotState) { botState = s; }

// ── Build snapshot from all subsystems ──
function buildSnapshot() {
  const db = getDb();
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  // Trades
  const recentTrades = db.prepare(`
    SELECT * FROM trades ORDER BY timestamp DESC LIMIT 15
  `).all() as any[];

  // Today's performance
  const todayPerf = getPerformance({ since_ms: todayStart.getTime() });

  // Weights
  const weights = getAllWeights().map((w) => ({
    strategy: w.strategy,
    weight: w.weight,
    status: w.status,
    win_rate: w.expected_win_rate,
    trades: Math.round((w.alpha ?? 1) + (w.beta ?? 1) - 2),
  }));

  // Regime
  const regime = getCurrentRegime();

  // Evolution state
  const evoState = getEvolutionState();

  // Hypothesis lab
  const lab = getLabReport();

  // Genetics
  const genetics = getGeneticsReport();

  // Calibration
  const cal = getCalibrationReport();

  // Bankroll info
  const bankroll = botState?.getBankroll() ?? config.STARTING_BANKROLL;
  const starting = botState?.getStartingBankroll() ?? config.STARTING_BANKROLL;
  const totalReturn = ((bankroll - starting) / starting) * 100;

  // Today P&L (rough: use last 24h trades' P&L)
  const todayPnl = todayPerf.total_pnl;

  return {
    mode: config.DRY_RUN ? "PAPER" : "LIVE",
    phase: getPhaseParams(bankroll).label,
    bankroll,
    starting_bankroll: starting,
    today_pnl: todayPnl,
    total_return_pct: totalReturn,
    trades_today: todayPerf.trades,
    win_rate: todayPerf.trades > 0 ? todayPerf.win_rate : null,
    open_positions: botState?.getOpenPositions() ?? 0,
    uptime_seconds: Math.floor((now - (botState?.getStartTime() ?? now)) / 1000),

    regime: {
      name: regime?.regime ?? "UNKNOWN",
      confidence: regime?.confidence ?? 0,
      aggression: regime?.recommended_aggression ?? 1,
      recommended: regime?.recommended_strategies ?? [],
    },

    weights,

    trades: recentTrades.map((t) => ({
      timestamp: t.timestamp,
      strategy: t.strategy,
      direction: t.side,
      price: t.price,
      size: t.size,
      question: t.market_question,
      won: null, // Will be enriched if resolution data available
      pnl: 0, // Will be enriched
    })),

    latest_verdict: botState?.getLatestVerdict() ?? null,

    lab: {
      total: lab.total_hypotheses,
      validated: lab.validated,
      rejected: lab.rejected,
      top_edges: lab.top_edges,
    },

    genetics: {
      active: genetics.active,
      testing: genetics.testing,
      archived: genetics.archived,
      generations: genetics.generations,
    },

    calibration: {
      brier: cal.overall_brier,
      error: cal.overall_calibration_error,
      overconfident: cal.is_overconfident,
      underconfident: cal.is_underconfident,
    },

    evolution: {
      cycles: evoState.cycle_count,
      patterns: evoState.patterns_discovered,
      prompt_evolutions: evoState.prompt_evolutions,
    },

    genius: getGeniusState(),

    paused: botState?.isPaused() ?? false,
  };
}

// ── Start the server ──
export function startDashboard(port = 3000) {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Main page
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Snapshot API
      if (url.pathname === "/api/snapshot") {
        try {
          const snap = buildSnapshot();
          return Response.json(snap);
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // Toggle pause
      if (url.pathname === "/api/toggle" && req.method === "POST") {
        if (botState) {
          botState.setPaused(!botState.isPaused());
          return Response.json({ paused: botState.isPaused() });
        }
        return Response.json({ paused: false });
      }

      // Health check
      if (url.pathname === "/health") {
        return new Response("ok");
      }

      return new Response("not found", { status: 404 });
    },
  });

  console.log(`📱 Dashboard live at http://localhost:${port}`);
}
