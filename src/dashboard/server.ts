// src/dashboard/server.ts — V3 with full agent controls + withdrawal API
//
// MOBILE DASHBOARD SERVER
// Serves phone-first dashboard with agent controls, strategy toggles,
// parameter tuning, withdrawal requests, and real-time monitoring.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getDb, getCalibrationData, getCouncilAttribution, getMilestones, getOpenPositions as getDbOpenPositions, logBankrollSnapshot, getBankrollHistory, getFinancialStats, getPositionPriceHistory } from "../core/db.js";
import { getAllWeights } from "../evolution/strategy_weights.js";
import { getCurrentRegime } from "../evolution/regime_detector.js";
import { getEvolutionState } from "../evolution/evolution_loop.js";
import { getPerformance, getTopPerformers } from "../evolution/performance_tracker.js";
import { getLabReport } from "../genius/hypothesis_lab.js";
import { getGeneticsReport } from "../genius/strategy_genetics.js";
import { getCalibrationReport } from "../genius/calibration_engine.js";
import { getGeniusState } from "../genius/genius_orchestrator.js";
import { config, getPhaseParams } from "../core/config.js";
// ARCHIVED: import { getLiquidityState } from "../liquidity/liquidity_orchestrator.js";
// ARCHIVED: import { confirmWithdrawal, getWithdrawalState } from "../compound/compound_engine.js";
// ARCHIVED: import { getCompoundState } from "../compound/compound_engine.js";
// ARCHIVED: import { getVelocityState } from "../velocity/velocity_orchestrator.js";
const getLiquidityState = () => ({});
const getCompoundState = () => ({});
const getVelocityState = () => ({});
const getWithdrawalState = () => ({});
const confirmWithdrawal = (_a: number) => ({ success: false, reason: "archived" });
import { getStrategyTelemetry, getCouncilTelemetry } from "../core/telemetry.js";
import { snoozeDailyLoss, unsnoozeDailyLoss, isDailyLossSnoozed } from "../core/risk.js";
import { getTurboStats, getRecentTurboContext } from "../strategies/kalshi/turbo_tracker.js";
import { getGrowthTargetState } from "../strategies/kalshi/turbo_brain.js";
import { getAllPrices, detectCryptoSignal, detectCrossAssetCascade, predictSettlement, getPriceHistoryRaw } from "../feeds/binance.js";
import { getOrderBookImbalance, getFundingBias, detectLiquidationCascade, getVWAP, getVPIN } from "../feeds/binance_advanced.js";
import { classifyRegime as geniusClassifyRegime, scoreConfluence, getTimeAdvice, getAllTimeProfiles, canTradeCircuitBreaker, getCircuitBreakerState, getOptimalParameters, correlationDiscount } from "../core/genius_signals.js";
// ARCHIVED: import { getTaxSummary, getOpenLots, getRecentLots } from "../core/tax_tracker.js";
// ARCHIVED: import { getFillStats } from "../core/smart_execution.js";
const getTaxSummary = () => ({});
const getOpenLots = () => [];
const getRecentLots = () => [];
const getFillStats = () => ({});
import Anthropic from "@anthropic-ai/sdk";

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
  // V3 controls
  setConfig?: (key: string, value: any) => void;
  getKalshiClient?: () => any;
  triggerScan?: (strategy: string) => void;
  getLastSyncAt?: () => number | null;
  // V4 chat controls
  closePosition?: (ticker: string) => Promise<string>;
  emergencyStop?: () => Promise<string>;
  getLogs?: (lines: number) => string[];
  setDryRun?: (dry: boolean) => void;
  // V5 full agency controls
  placeTrade?: (ticker: string, direction: "YES" | "NO", size: number) => Promise<string>;
  setBankroll?: (amount: number) => void;
  getCachedMarkets?: () => any[];
  // Auto-pause controls
  getAutoPauseState?: () => any;
  clearAutoPause?: () => void;
  resetHWM?: () => void;
}

let botState: BotState | null = null;

// Activity feed buffer
interface ActivityItem {
  time: number;
  icon: string;
  text: string;
}
const activityBuffer: ActivityItem[] = [];
const MAX_ACTIVITY = 50;

export function pushActivity(icon: string, text: string) {
  activityBuffer.push({ time: Date.now(), icon, text });
  if (activityBuffer.length > MAX_ACTIVITY) activityBuffer.shift();
}

export function setBotState(s: BotState) { botState = s; }

function buildSnapshot() {
  const db = getDb();
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  const recentTrades = db.prepare(`SELECT * FROM trades ORDER BY timestamp DESC LIMIT 20`).all() as any[];
  const todayPerf = getPerformance({ since_ms: todayStart.getTime() });
  const weights = getAllWeights().map((w) => ({
    strategy: w.strategy, weight: w.weight, status: w.status,
    win_rate: w.expected_win_rate, trades: Math.round((w.alpha ?? 1) + (w.beta ?? 1) - 2),
  }));
  const regime = getCurrentRegime();
  const evoState = getEvolutionState();
  const lab = getLabReport();
  const genetics = getGeneticsReport();
  const cal = getCalibrationReport();
  const bankroll = botState?.getBankroll() ?? config.STARTING_BANKROLL;
  const starting = botState?.getStartingBankroll() ?? config.STARTING_BANKROLL;
  const totalReturn = ((bankroll - starting) / starting) * 100;

  // V3: Calibration data, council attribution, milestones, positions
  const calibration = getCalibrationData();
  const councilAttribution = getCouncilAttribution();
  const milestones = getMilestones();
  const openPositions = getDbOpenPositions();

  // Rejected signals count
  const rejectedCount = (db.prepare(`SELECT COUNT(*) as c FROM rejected_signals WHERE timestamp > ?`).get(todayStart.toISOString()) as any)?.c ?? 0;

  // Cost estimation (Claude API)
  const councilCalls = (db.prepare(`SELECT COUNT(*) as c FROM analyses WHERE timestamp > ?`).get(todayStart.toISOString()) as any)?.c ?? 0;
  const estimatedApiCost = councilCalls * 0.06; // ~$0.06 per deliberation

  return {
    mode: config.DRY_RUN ? "PAPER" : "LIVE",
    phase: getPhaseParams(bankroll).label,
    bankroll,
    starting_bankroll: starting,
    today_pnl: todayPerf.total_pnl,
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
      timestamp: t.timestamp, strategy: t.strategy, direction: t.side,
      price: t.price, size: t.size, question: t.market_question,
      won: null, pnl: t.pnl ?? 0,
    })),
    latest_verdict: botState?.getLatestVerdict() ?? null,
    lab: { total: lab.total_hypotheses, validated: lab.validated, rejected: lab.rejected, top_edges: lab.top_edges },
    genetics: { active: genetics.active, testing: genetics.testing, archived: genetics.archived, generations: genetics.generations },
    calibration: { brier: cal.overall_brier, error: cal.overall_calibration_error, overconfident: cal.is_overconfident, underconfident: cal.is_underconfident },
    evolution: { cycles: evoState.cycle_count, patterns: evoState.patterns_discovered, prompt_evolutions: evoState.prompt_evolutions },
    genius: getGeniusState(),
    paused: botState?.isPaused() ?? false,

    // V3 extras
    calibration_buckets: calibration,
    council_attribution: councilAttribution,
    milestones,
    open_position_details: openPositions,
    rejected_today: rejectedCount,
    estimated_api_cost: estimatedApiCost,
    council_calls_today: councilCalls,

    // Auto-pause state (Operator Rule #1)
    auto_pause: botState?.getAutoPauseState?.() ?? null,

    // V4: Engine state for dashboard
    liquidity: getLiquidityState(),
    compound: getCompoundState(),
    velocity: getVelocityState(),
    turbo: getTurboStats(),
    growth_target: getGrowthTargetState(),
    financial: getFinancialStats(),

    // Current config for controls
    config: {
      dry_run: config.DRY_RUN,
      kelly: getPhaseParams(bankroll).kelly,
      max_pos_pct: getPhaseParams(bankroll).maxPosPct,
      max_positions: getPhaseParams(bankroll).maxPositions,
      min_edge: getPhaseParams(bankroll).minEdge,
      absolute_max_trade: config.ABSOLUTE_MAX_SINGLE_TRADE,
      daily_loss_limit: config.DAILY_LOSS_LIMIT_PCT,
      daily_loss_snoozed: isDailyLossSnoozed(),
      turbo_only: config.TURBO_ONLY_MODE,
      sniper_interval: config.SNIPER_SCAN_INTERVAL_MS,
      council_interval: config.CLAUDE_SCAN_INTERVAL_MS,
      strategies: {
        cycle_sniper: config.STRATEGY_CYCLE_SNIPER,
        negrisk_arb: config.STRATEGY_NEGRISK_ARB,
        mispricing: config.STRATEGY_MISPRICING,
        cross_correlation: config.STRATEGY_CROSS_CORRELATION,
        whale_consensus: config.STRATEGY_WHALE_CONSENSUS,
        market_maker: config.STRATEGY_MARKET_MAKER,
        weather: config.STRATEGY_WEATHER,
        economic: config.STRATEGY_ECONOMIC,
      },
    },

    // Bankroll sync metadata
    bankroll_source: config.DRY_RUN ? "paper_accumulator" : "kalshi_sync",
    last_sync_at: botState?.getLastSyncAt?.() ?? null,

    // Strategy execution telemetry
    strategy_telemetry: getStrategyTelemetry(),
    council_telemetry: getCouncilTelemetry(),
  };
}

export function startDashboard(port = 3000) {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache" } });
      }

      if (url.pathname === "/api/snapshot") {
        try { return Response.json(buildSnapshot()); }
        catch (err: any) { return Response.json({ error: err.message }, { status: 500 }); }
      }

      // V6: Equity curve history
      if (url.pathname === "/api/equity-history") {
        const range = url.searchParams.get("range") ?? "1d";
        return Response.json(getBankrollHistory(range));
      }

      // V6: Crypto price feed for position charts
      if (url.pathname === "/api/price-feed") {
        const symbol = url.searchParams.get("symbol") ?? "btcusdt";
        return Response.json(getPriceHistoryRaw(symbol));
      }

      // V6: Position detail with price history
      if (url.pathname === "/api/position-detail") {
        const ticker = url.searchParams.get("ticker") ?? "";
        const priceHist = getPositionPriceHistory(ticker);
        const db = getDb();
        const pos = db.prepare(`SELECT * FROM positions WHERE ticker = ? ORDER BY id DESC LIMIT 1`).get(ticker);
        return Response.json({ position: pos, price_history: priceHist });
      }

      // V6: SSE events stream
      if (url.pathname === "/api/events") {
        const stream = new ReadableStream({
          start(controller) {
            const send = () => {
              try {
                const snap = buildSnapshot();
                controller.enqueue(`data: ${JSON.stringify(snap)}\n\n`);
              } catch {}
            };
            send();
            const interval = setInterval(send, 5000);
            // Log bankroll snapshot every 60s for equity curve persistence
            let snapCount = 0;
            const bankrollInterval = setInterval(() => {
              snapCount++;
              if (snapCount % 12 === 0) { // every 60s (12 × 5s)
                try {
                  const s = buildSnapshot();
                  logBankrollSnapshot(s.bankroll, s.today_pnl, s.open_positions);
                } catch {}
              }
            }, 5000);
            req.signal.addEventListener("abort", () => {
              clearInterval(interval);
              clearInterval(bankrollInterval);
            });
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
        });
      }

      // Toggle pause/resume
      if (url.pathname === "/api/toggle" && req.method === "POST") {
        if (botState) {
          botState.setPaused(!botState.isPaused());
          return Response.json({ paused: botState.isPaused() });
        }
        return Response.json({ paused: false });
      }

      // V3: Update config parameter
      if (url.pathname === "/api/config" && req.method === "POST") {
        try {
          const body = await req.json() as any;
          const { key, value } = body;
          const allowedKeys = [
            "ABSOLUTE_MAX_SINGLE_TRADE", "DAILY_LOSS_LIMIT_PCT",
            "SNIPER_SCAN_INTERVAL_MS", "CLAUDE_SCAN_INTERVAL_MS", "CLAUDE_MARKETS_PER_SCAN",
            "STRATEGY_CYCLE_SNIPER", "STRATEGY_NEGRISK_ARB", "STRATEGY_MISPRICING",
            "STRATEGY_CROSS_CORRELATION", "STRATEGY_WHALE_CONSENSUS",
            "STRATEGY_MARKET_MAKER", "STRATEGY_WEATHER", "STRATEGY_ECONOMIC",
            "TAKE_PROFIT_PCT", "STOP_LOSS_PCT", "TRAILING_STOP_PCT", "TURBO_ONLY_MODE",
          ];
          if (!allowedKeys.includes(key)) {
            return Response.json({ error: `Config key '${key}' not allowed` }, { status: 400 });
          }
          (config as any)[key] = value;
          console.log(`⚙️  Config updated: ${key} = ${value}`);
          return Response.json({ ok: true, key, value });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 400 });
        }
      }

      // V3: Toggle DRY_RUN mode
      if (url.pathname === "/api/mode" && req.method === "POST") {
        try {
          const body = await req.json() as any;
          (config as any).DRY_RUN = body.dry_run;
          console.log(`🔄 Mode changed: ${body.dry_run ? "PAPER" : "🔴 LIVE"}`);
          return Response.json({ dry_run: config.DRY_RUN });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 400 });
        }
      }

      // V3: Snooze/unsnooze daily loss limit
      if (url.pathname === "/api/daily-loss-snooze" && req.method === "POST") {
        try {
          const body = await req.json() as any;
          if (body.snooze) {
            snoozeDailyLoss(body.hours ?? 24);
            return Response.json({ snoozed: true, hours: body.hours ?? 24 });
          } else {
            unsnoozeDailyLoss();
            return Response.json({ snoozed: false });
          }
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 400 });
        }
      }

      // V3: Trigger withdrawal via Kalshi API
      if (url.pathname === "/api/withdraw" && req.method === "POST") {
        try {
          const body = await req.json() as any;
          const amountCents = Math.floor(body.amount * 100);
          if (amountCents < 100) {
            return Response.json({ error: "Minimum withdrawal is $1.00" }, { status: 400 });
          }
          const kalshi = botState?.getKalshiClient?.();
          if (!kalshi) {
            return Response.json({ error: "Kalshi client not available" }, { status: 500 });
          }
          if (config.DRY_RUN) {
            return Response.json({ status: "simulated", amount: body.amount, message: "Withdrawal simulated (paper mode)" });
          }
          // Kalshi withdrawal API
          const result = await kalshi.request("POST", "/portfolio/withdrawals", {
            amount: amountCents,
          });
          console.log(`💸 Withdrawal requested: $${body.amount}`);
          return Response.json({ status: "requested", amount: body.amount, result });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // V3: Get Kalshi balance
      if (url.pathname === "/api/balance") {
        try {
          const kalshi = botState?.getKalshiClient?.();
          if (!kalshi) return Response.json({ error: "No client" }, { status: 500 });
          const balance = await kalshi.getBalance();
          return Response.json({ balance_cents: balance.balance, balance_usd: balance.balance / 100, payout: (balance.payout ?? 0) / 100 });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // Debug: Check market status and attempt to sell a position
      if (url.pathname === "/api/market-check" && req.method === "POST") {
        try {
          const kalshi = botState?.getKalshiClient?.();
          if (!kalshi) return Response.json({ error: "No client" }, { status: 500 });
          const body = await req.json() as any;
          const { market } = await kalshi.getMarket(body.ticker);
          return Response.json({ ticker: body.ticker, status: market.status, close_time: market.close_time, result: market.result, yes_bid: market.yes_bid, yes_ask: market.yes_ask, no_bid: market.no_bid, no_ask: market.no_ask });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      if (url.pathname === "/api/sell-position" && req.method === "POST") {
        try {
          const kalshi = botState?.getKalshiClient?.();
          if (!kalshi) return Response.json({ error: "No client" }, { status: 500 });
          const body = await req.json() as any;
          const { ticker, side, count } = body;
          const result = await kalshi.placeOrder({
            ticker,
            side: side.toLowerCase(),
            action: "sell",
            type: "limit",
            count: parseInt(count),
            yes_price: side.toLowerCase() === "yes" ? 1 : undefined,
            no_price: side.toLowerCase() === "no" ? 1 : undefined,
          });
          return Response.json({ ok: true, order: result });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // Debug: Get Kalshi-side positions (what Kalshi actually sees)
      if (url.pathname === "/api/kalshi-positions") {
        try {
          const kalshi = botState?.getKalshiClient?.();
          if (!kalshi) return Response.json({ error: "No client" }, { status: 500 });
          const raw = await kalshi.getPositions({ limit: 100 });
          return Response.json(raw);
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // V3: Force strategy scan
      if (url.pathname === "/api/scan" && req.method === "POST") {
        try {
          const body = await req.json() as any;
          botState?.triggerScan?.(body.strategy);
          return Response.json({ ok: true, strategy: body.strategy });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 400 });
        }
      }

      // V3: Get positions detail
      if (url.pathname === "/api/positions") {
        const positions = getDbOpenPositions();
        return Response.json({ positions });
      }

      // Chat endpoint — AI assistant with tool use
      if (url.pathname === "/api/chat" && req.method === "POST") {
        try {
          const body = await req.json() as any;
          const { message, history } = body;

          // Build deep context — make the chat as aware as a human operator
          const snap = buildSnapshot();
          const recentTradesList = (snap.trades || []).slice(0, 5).map((t: any) =>
            `  - ${t.strategy} ${t.direction} "${(t.question || "").slice(0, 60)}" @ ${((t.price || 0) * 100).toFixed(0)}¢, size $${(t.size || 0).toFixed(2)}`
          ).join("\n") || "  (none today)";

          const openPosList = (snap.open_position_details || []).map((p: any) =>
            `  - ${p.ticker} ${p.side} @ ${(p.entry_price || 0).toFixed(0)}¢, ${p.contracts} contracts, PnL ${(p.unrealized_pnl || 0) >= 0 ? "+" : ""}$${(p.unrealized_pnl || 0).toFixed(2)} [${p.strategy}]`
          ).join("\n") || "  (none)";

          const stratWeights = (snap.weights || []).map((w: any) =>
            `  - ${w.strategy}: weight=${w.weight.toFixed(2)}, win_rate=${(w.win_rate * 100).toFixed(0)}%, ${w.trades} trades, status=${w.status}`
          ).join("\n");

          const enabledStrats = snap.config?.strategies
            ? Object.entries(snap.config.strategies).filter(([, v]) => v).map(([k]) => k).join(", ")
            : "unknown";
          const disabledStrats = snap.config?.strategies
            ? Object.entries(snap.config.strategies).filter(([, v]) => !v).map(([k]) => k).join(", ") || "none"
            : "unknown";

          const councilInfo = (snap.council_attribution || []).map((m: any) =>
            `  - ${m.member_name}: ${m.total_votes} votes, ${((m.accuracy || 0) * 100).toFixed(0)}% accuracy`
          ).join("\n") || "  (no data yet)";

          const activityLog = activityBuffer.slice(-8).map(a =>
            `  - [${new Date(a.time).toLocaleTimeString()}] ${a.icon} ${a.text}`
          ).join("\n") || "  (no recent activity)";

          const context = `You are the AI assistant for Kalshi Genius, a prediction market trading bot running on Kalshi. The user is the bot's operator and owner. You have deep knowledge of the entire system and should answer as if you built it and are monitoring it live.

CURRENT STATE:
- Mode: ${snap.mode} (${snap.mode === "PAPER" ? "simulated trades, no real money" : "REAL MONEY, live orders on Kalshi"})
- Paused: ${snap.paused}${snap.paused ? " (not scanning for new trades, but existing positions still managed)" : ""}
- Bankroll: $${snap.bankroll.toFixed(2)} (started at $${snap.starting_bankroll.toFixed(2)}, ${snap.total_return_pct >= 0 ? "+" : ""}${snap.total_return_pct.toFixed(1)}% all-time)
- Today's PnL: $${(snap.today_pnl || 0).toFixed(2)} across ${snap.trades_today} trades${snap.win_rate !== null ? `, ${(snap.win_rate * 100).toFixed(0)}% win rate` : ""}
- Growth Phase: ${snap.phase}
- Daily Growth Target: +${(snap.growth_target?.daily_target_pct || 50).toFixed(0)}% (progress: ${(snap.growth_target?.progress_pct || 0).toFixed(0)}%, today ${(snap.growth_target?.today_mult || 1).toFixed(2)}x)
- Open Positions: ${snap.open_positions}
- Market Regime: ${snap.regime?.name} (confidence ${((snap.regime?.confidence || 0) * 100).toFixed(0)}%, aggression ${snap.regime?.aggression}x)
- API Cost Today: ~$${(snap.estimated_api_cost || 0).toFixed(2)} (${snap.council_calls_today} council calls)
- Uptime: ${Math.floor((snap.uptime_seconds || 0) / 3600)}h ${Math.floor(((snap.uptime_seconds || 0) % 3600) / 60)}m

OPEN POSITIONS:
${openPosList}

RECENT TRADES:
${recentTradesList}

STRATEGY PERFORMANCE:
${stratWeights}

COUNCIL (AI TEAM) ACCURACY:
${councilInfo}

CALIBRATION: Brier score ${(snap.calibration?.brier || 0).toFixed(3)}, ${snap.calibration?.overconfident ? "overconfident" : snap.calibration?.underconfident ? "underconfident" : "well calibrated"}

ENABLED STRATEGIES: ${enabledStrats}
DISABLED STRATEGIES: ${disabledStrats}

CONFIG:
- Kelly fraction: ${((snap.config?.kelly || 0) * 100).toFixed(0)}%
- Max position size: ${((snap.config?.max_pos_pct || 0) * 100).toFixed(0)}% of bankroll
- Max concurrent positions: ${snap.config?.max_positions}
- Min edge threshold: ${((snap.config?.min_edge || 0) * 100).toFixed(0)}%
- Daily loss limit: ${((snap.config?.daily_loss_limit || 0) * 100).toFixed(0)}%
- Take profit: ${((snap.config?.absolute_max_trade || 0) * 100).toFixed(0)}% max single trade

RECENT ACTIVITY LOG:
${activityLog}

ARCHITECTURE:
10 strategies unlock by bankroll phase:
- Seedling ($0-100): high_confidence (85-94¢ near-close), hourly_sniper (crypto close), monotonicity_arb (risk-free), weather_edge (NWS + GFS 31-member ensemble), economic_release (FRED data) — all zero API cost
- Sprout ($100-500): + market_maker (spread capture), + mispricing (AI cognitive council, ~$0.07/deliberation)
- Sapling ($500-2k): + multi_model_ensemble (Claude + GPT-4o consensus), + cross_platform (Polymarket divergence), + liquidity engine
- Tree ($2k-10k): + whale_consensus (whale wallet tracking) — all strategies active
- Grove ($10k-50k) / Forest ($50k+): same strategies, lower concentration risk

AI Council: 5 members — Bull, Bear, Quant (haiku), Sage, Judge (sonnet). Unanimous SKIP from first 3 saves API cost.
Genius Layer: counterfactual engine, hypothesis lab, strategy genetics, calibration engine — runs 30-min cycles above $150 bankroll.
Infrastructure: Fly.io (shared-cpu-1x, 512MB, EWR), SQLite on persistent volume, TypeScript/Bun runtime.

CONSTRAINTS:
- Massachusetts operator — NO sports trading (3-layer filter active)
- API costs gated by bankroll phase ($150+ for council, $500+ for ensemble)
- Phase-based compounding with automatic strategy unlocks and capital caps

YOU HAVE FULL AGENCY. Your tools let you:
- CONTROL: pause, resume, restart the entire bot, emergency stop, switch paper/live mode
- CONFIGURE: change ANY config parameter, toggle ANY strategy, set bankroll amount
- TRADE: place manual trades, close positions, cancel orders (individual or all)
- SCAN: trigger any strategy scan immediately
- RESEARCH: search available markets, get market details, view rejected signals
- DEBUG: get logs, view trade history, check balance, view open orders, open positions
- MARKET INTEL: live crypto prices + momentum, crypto signals, cross-asset cascades, settlement predictions
- ORDER FLOW: order book imbalance (OBI), VPIN (informed trading detection), VWAP with bands, funding rates, liquidation cascades
- CONFLUENCE: multi-signal scoring (7 signals combined), market regime classification
- SYSTEM STATE: compound phase, circuit breaker, time-of-day profiling, adaptive optimization parameters
- ANALYTICS: strategy telemetry, evolution state, genius layer state, velocity engine state
- FINANCIALS: tax lot summary, fill rate stats, withdrawal/nest egg management

BEHAVIOR:
- Talk naturally, like a knowledgeable friend. Use markdown formatting — bold, lists, code blocks — the chat renders it properly.
- Be thorough but not verbose. Give the user what they need to make decisions.
- When asked to make changes, USE YOUR TOOLS and confirm what you did.
- For place_trade and switch_mode to live: ALWAYS confirm with the user first.
- For emergency_stop: execute immediately, explain after.
- If you spot problems (losses, miscalibration, stuck positions), proactively flag them.
- You can chain multiple tools in one turn — e.g., pause + cancel all orders + update config.
- If the user asks you to do something that requires a restart, use restart_bot after making the change.
- When analyzing markets or strategies, show your reasoning. The user wants to learn and make informed decisions, not just get yes/no answers.`;

          const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

          const tools: Anthropic.Tool[] = [
            // ── Bot Control ──
            { name: "pause_bot", description: "Pause the trading bot — stops scanning for new trades but existing positions continue to be managed", input_schema: { type: "object" as const, properties: {} } },
            { name: "resume_bot", description: "Resume the trading bot — starts scanning for new opportunities again", input_schema: { type: "object" as const, properties: {} } },
            { name: "emergency_stop", description: "EMERGENCY: Pause the bot AND cancel all open/resting orders on Kalshi. Use only when the user explicitly asks for an emergency stop.", input_schema: { type: "object" as const, properties: {} } },
            { name: "restart_bot", description: "Restart the bot process. Fly.io will auto-restart it. Use when config changes need a fresh start, or something seems stuck. All positions are preserved in the database.", input_schema: { type: "object" as const, properties: {} } },
            { name: "switch_mode", description: "Switch between paper (simulated) and live (real money) trading mode. ALWAYS confirm with the user before switching to live.", input_schema: { type: "object" as const, properties: { mode: { type: "string", enum: ["paper", "live"], description: "'paper' for simulated or 'live' for real money" } }, required: ["mode"] } },

            // ── Configuration ──
            { name: "update_config", description: "Update ANY bot config parameter at runtime. Common keys: ABSOLUTE_MAX_SINGLE_TRADE, DAILY_LOSS_LIMIT_PCT, TAKE_PROFIT_PCT, STOP_LOSS_PCT, TRAILING_STOP_PCT, MAX_HOLD_HOURS, SNIPER_SCAN_INTERVAL_MS, CLAUDE_SCAN_INTERVAL_MS, CLAUDE_MARKETS_PER_SCAN, MARKET_MAKER_MIN_SPREAD_CENTS, HIGH_CONFIDENCE_SCAN_INTERVAL_MS, HIGH_CONFIDENCE_MAX_TRADES, MULTI_MODEL_SCAN_INTERVAL_MS, MULTI_MODEL_MIN_EDGE, CORRELATION_LIMIT, SCALE_OUT_AT_PCT, CHECK_POSITIONS_INTERVAL_MS, SNIPER_MIN_CONTRACT_PRICE, SNIPER_MAX_CONTRACT_PRICE, MONOTONICITY_MIN_EDGE_CENTS. Also phase arrays: PHASE_KELLY, PHASE_MAX_POS_PCT, PHASE_MAX_POSITIONS, PHASE_MIN_EDGE.", input_schema: { type: "object" as const, properties: { key: { type: "string", description: "Config key name" }, value: { type: "number", description: "New value" } }, required: ["key", "value"] } },
            { name: "toggle_strategy", description: "Enable or disable a trading strategy. Names: cycle_sniper, negrisk_arb, mispricing, cross_correlation, whale_consensus, market_maker, weather, economic, high_confidence, multi_model", input_schema: { type: "object" as const, properties: { strategy: { type: "string" }, enabled: { type: "boolean" } }, required: ["strategy", "enabled"] } },
            { name: "set_bankroll", description: "Manually set the tracked bankroll amount. Use to correct sync issues or reset after deposits/withdrawals.", input_schema: { type: "object" as const, properties: { amount: { type: "number", description: "New bankroll amount in USD" } }, required: ["amount"] } },

            // ── Trading ──
            { name: "place_trade", description: "Place a manual trade on Kalshi. The bot will handle order placement, position tracking, and exit management. ALWAYS confirm with the user before executing.", input_schema: { type: "object" as const, properties: { ticker: { type: "string", description: "Kalshi market ticker" }, direction: { type: "string", enum: ["YES", "NO"], description: "Trade direction" }, size: { type: "number", description: "Trade size in USD" } }, required: ["ticker", "direction", "size"] } },
            { name: "close_position", description: "Force-close an open position by selling at market price.", input_schema: { type: "object" as const, properties: { ticker: { type: "string", description: "Ticker to close" } }, required: ["ticker"] } },
            { name: "cancel_order", description: "Cancel a specific resting order on Kalshi by order ID.", input_schema: { type: "object" as const, properties: { order_id: { type: "string", description: "The Kalshi order ID to cancel" } }, required: ["order_id"] } },
            { name: "cancel_all_orders", description: "Cancel ALL resting orders on Kalshi. Use with caution.", input_schema: { type: "object" as const, properties: {} } },
            { name: "trigger_scan", description: "Force immediate scan for a strategy: sniper, monotonicity, economic, weather, cross, council, high_confidence, multi_model", input_schema: { type: "object" as const, properties: { strategy: { type: "string" } }, required: ["strategy"] } },

            // ── Information ──
            { name: "get_logs", description: "Get recent bot log entries for debugging.", input_schema: { type: "object" as const, properties: { lines: { type: "number", description: "Lines to return (default 20, max 50)" } } } },
            { name: "get_balance", description: "Fetch current Kalshi account balance.", input_schema: { type: "object" as const, properties: {} } },
            { name: "get_open_orders", description: "Fetch all resting orders on Kalshi.", input_schema: { type: "object" as const, properties: {} } },
            { name: "search_markets", description: "Search available Kalshi markets by keyword. Returns matching markets with prices, volume, and close times.", input_schema: { type: "object" as const, properties: { query: { type: "string", description: "Search keyword (e.g. 'bitcoin', 'temperature NYC', 'CPI')" }, limit: { type: "number", description: "Max results (default 10)" } }, required: ["query"] } },
            { name: "get_market_detail", description: "Get detailed info about a specific Kalshi market by ticker.", input_schema: { type: "object" as const, properties: { ticker: { type: "string" } }, required: ["ticker"] } },
            { name: "get_trade_history", description: "Get the bot's recent trade history with PnL.", input_schema: { type: "object" as const, properties: { limit: { type: "number", description: "Number of trades (default 20)" } } } },
            { name: "get_rejected_signals", description: "See signals the bot rejected and why — useful for understanding why it's not trading.", input_schema: { type: "object" as const, properties: { limit: { type: "number", description: "Number of rejections (default 15)" } } } },
            { name: "confirm_withdrawal", description: "Confirm a pending auto-withdrawal to the user's nest egg. The bot suggests withdrawals at milestones — this locks them in and reduces the active bankroll.", input_schema: { type: "object" as const, properties: { amount: { type: "number", description: "Withdrawal amount in USD" } }, required: ["amount"] } },
            { name: "get_withdrawal_status", description: "Get current withdrawal/nest egg status — total withdrawn, pending withdrawals, nest egg balance.", input_schema: { type: "object" as const, properties: {} } },

            // ── Advanced Intelligence ──
            { name: "get_prices", description: "Get live Binance crypto prices with momentum data for BTC, ETH, SOL, XRP. Shows 5s/30s/60s price changes and momentum classification.", input_schema: { type: "object" as const, properties: {} } },
            { name: "get_crypto_signal", description: "Get the current crypto trading signal for a symbol — multi-timeframe momentum scoring with volatility-adaptive thresholds.", input_schema: { type: "object" as const, properties: { symbol: { type: "string", description: "Symbol like btcusdt, ethusdt, solusdt, xrpusdt" } }, required: ["symbol"] } },
            { name: "get_cross_asset_cascade", description: "Detect cross-asset lead-lag cascades — when BTC moves but ETH/SOL/XRP haven't caught up yet. These are short-lived trading opportunities.", input_schema: { type: "object" as const, properties: {} } },
            { name: "get_settlement_prediction", description: "Predict the settlement price for a crypto asset using the CF Benchmarks trimmed mean model (60 readings, trim top/bottom 20%).", input_schema: { type: "object" as const, properties: { symbol: { type: "string", description: "Symbol like btcusdt, ethusdt" } }, required: ["symbol"] } },
            { name: "get_order_book", description: "Get real-time order book imbalance (OBI) for a crypto symbol — shows bid/ask pressure, spread, and distance-weighted imbalance.", input_schema: { type: "object" as const, properties: { symbol: { type: "string", description: "Symbol like btcusdt, ethusdt" } }, required: ["symbol"] } },
            { name: "get_funding_rate", description: "Get current funding rate and leverage bias for a crypto symbol — detects overleveraged positions.", input_schema: { type: "object" as const, properties: { symbol: { type: "string", description: "Symbol like btcusdt, ethusdt" } }, required: ["symbol"] } },
            { name: "get_liquidation_cascade", description: "Detect if a liquidation cascade is happening for a crypto symbol — large forced liquidations that can move price.", input_schema: { type: "object" as const, properties: { symbol: { type: "string", description: "Symbol like btcusdt, ethusdt" } }, required: ["symbol"] } },
            { name: "get_vwap", description: "Get VWAP (Volume-Weighted Average Price) with 2-sigma bands, trend direction, and overbought/oversold status.", input_schema: { type: "object" as const, properties: { symbol: { type: "string", description: "Symbol like btcusdt, ethusdt" } }, required: ["symbol"] } },
            { name: "get_vpin", description: "Get VPIN (Volume-Synchronized Probability of Informed Trading) — Renaissance Technologies signal for detecting informed trading flow.", input_schema: { type: "object" as const, properties: { symbol: { type: "string", description: "Symbol like btcusdt, ethusdt" } }, required: ["symbol"] } },
            { name: "get_confluence", description: "Get the multi-signal confluence score for a symbol and direction — combines 7 signals (momentum, OBI, VPIN, funding, VWAP, liquidation, cross-asset) into a single 0-10 score.", input_schema: { type: "object" as const, properties: { symbol: { type: "string", description: "Symbol like btcusdt" }, direction: { type: "string", enum: ["YES", "NO"] }, asset: { type: "string", description: "Asset name like BTC, ETH" } }, required: ["symbol", "direction", "asset"] } },
            { name: "get_regime", description: "Get the current market regime classification — momentum, mean_reversion, volatile, or dead. Affects strategy selection.", input_schema: { type: "object" as const, properties: { symbol: { type: "string", description: "Symbol like btcusdt" } }, required: ["symbol"] } },

            // ── System Intelligence ──
            { name: "get_compound_state", description: "Get full compound growth engine state — current phase, strategies unlocked, phase transitions, yield by strategy, next phase target, withdrawal info.", input_schema: { type: "object" as const, properties: {} } },
            { name: "get_open_positions", description: "Get all currently open positions with entry prices, sides, strategies, and P&L.", input_schema: { type: "object" as const, properties: {} } },
            { name: "get_circuit_breaker", description: "Get circuit breaker state — consecutive losses, whether trading is restricted, size multiplier.", input_schema: { type: "object" as const, properties: {} } },
            { name: "get_time_profile", description: "Get time-of-day trading performance — win rates and P&L by hour UTC. Shows which hours are most/least profitable.", input_schema: { type: "object" as const, properties: {} } },
            { name: "get_optimal_params", description: "Get the adaptive optimizer's recommended parameters — optimal confidence threshold, confluence minimum, max positions, based on last 200 trades.", input_schema: { type: "object" as const, properties: {} } },
            { name: "get_strategy_telemetry", description: "Get detailed strategy performance telemetry — scans, evaluations, trades, rejections, and efficiency metrics per strategy.", input_schema: { type: "object" as const, properties: {} } },
            { name: "get_tax_summary", description: "Get tax lot tracking summary — total P&L, short-term/long-term gains and losses, estimated tax liability.", input_schema: { type: "object" as const, properties: { year: { type: "number", description: "Tax year (default: current year)" } } } },
            { name: "get_fill_stats", description: "Get maker vs taker order fill rate statistics.", input_schema: { type: "object" as const, properties: {} } },
            { name: "get_velocity_state", description: "Get velocity engine state — active tranches, capital cycling rate, ladder positions.", input_schema: { type: "object" as const, properties: {} } },
            { name: "get_evolution_state", description: "Get evolution engine state — strategy weights, regime detection, performance tracking, prompt evolution status.", input_schema: { type: "object" as const, properties: {} } },
            { name: "get_genius_state", description: "Get genius layer state — hypothesis lab, strategy genetics, calibration engine, counterfactual tracking.", input_schema: { type: "object" as const, properties: {} } },
            // Auto-pause (Operator Rule #1)
            { name: "get_auto_pause_state", description: "Get auto-pause state — high water mark, drawdown %, whether auto-pause is active, and reason.", input_schema: { type: "object" as const, properties: {} } },
            { name: "clear_auto_pause", description: "Clear auto-pause and switch back to LIVE trading mode. Use when operator confirms they want to resume live.", input_schema: { type: "object" as const, properties: {} } },
            { name: "reset_hwm", description: "Reset the high water mark to the current bankroll. Use after operator deposits or withdraws funds.", input_schema: { type: "object" as const, properties: {} } },
          ];

          const messages = [
            ...(history || []).slice(-10),
            { role: "user" as const, content: message },
          ];

          // 3-tier model selection: Haiku (simple) → Sonnet (moderate) → Opus (complex)
          function selectModel(msg: string): { model: string; maxTokens: number } {
            const lower = msg.toLowerCase();
            // Opus: only for genuinely complex multi-step reasoning
            // Must match 2+ signals or a very specific complex pattern
            const opusStrong = /\b(refactor|rewrite|architect|redesign|root cause|deep dive|code review|fix .* bug and|build .* (strategy|system|engine)|create .* (strategy|module)|plan .* (migration|upgrade)|think through .* (approach|design))\b/;
            if (opusStrong.test(lower) && lower.length > 60) {
              return { model: "claude-opus-4-6", maxTokens: 4096 };
            }
            // Sonnet: analysis, trading decisions, explanations, multi-step actions
            const sonnetPatterns = /\b(should|compare|analyze|evaluate|recommend|explain|why|debug|investigate|what do you think|how (can|should|does)|which|optimize|improve|review|diagnose|help me|walk me through|find .* (edge|opportunity))\b/;
            if (sonnetPatterns.test(lower)) {
              return { model: "claude-sonnet-4-20250514", maxTokens: 2048 };
            }
            // Haiku: simple commands, status checks, toggles, quick lookups
            return { model: "claude-haiku-4-5-20251001", maxTokens: 1024 };
          }

          const { model: selectedModel, maxTokens } = selectModel(message);

          // Non-streaming approach with tool use loop
          let finalText = "";
          let currentMessages = [...messages];

          for (let i = 0; i < 5; i++) { // max 5 tool-use rounds for complex multi-step actions
            const response = await anthropic.messages.create({
              model: selectedModel,
              max_tokens: maxTokens,
              system: context,
              tools,
              messages: currentMessages,
            });

            // Collect text
            let text = "";
            let toolUses: any[] = [];
            for (const block of response.content) {
              if (block.type === "text") text += block.text;
              if (block.type === "tool_use") toolUses.push(block);
            }
            finalText += text;

            if (toolUses.length === 0 || response.stop_reason !== "tool_use") break;

            // Execute tools
            currentMessages.push({ role: "assistant" as const, content: response.content as any });
            const toolResults: any[] = [];
            for (const tu of toolUses) {
              let result = "";
              try {
                const inp = tu.input as any;
                switch (tu.name) {
                  // ── Bot Control ──
                  case "pause_bot":
                    botState?.setPaused(true);
                    pushActivity("⏸️", "Bot paused via chat");
                    result = "Bot paused. Existing positions still managed.";
                    break;
                  case "resume_bot":
                    botState?.setPaused(false);
                    pushActivity("▶️", "Bot resumed via chat");
                    result = "Bot resumed — scanning for opportunities.";
                    break;
                  case "emergency_stop": {
                    botState?.setPaused(true);
                    if (botState?.emergencyStop) {
                      result = await botState.emergencyStop();
                    } else {
                      result = "Bot paused. (Cancel orders not wired.)";
                    }
                    pushActivity("🚨", "EMERGENCY STOP via chat");
                    break;
                  }
                  case "restart_bot": {
                    pushActivity("🔄", "Bot restart requested via chat");
                    result = "Restarting bot in 2 seconds. Fly.io will auto-restart the process. All positions are preserved in the database.";
                    // Delayed exit so the response reaches the client
                    setTimeout(() => process.exit(0), 2000);
                    break;
                  }
                  case "switch_mode": {
                    const goLive = inp.mode === "live";
                    (config as any).DRY_RUN = !goLive;
                    botState?.setDryRun?.(!goLive);
                    pushActivity(goLive ? "🔴" : "🧪", `Switched to ${goLive ? "LIVE" : "PAPER"} mode via chat`);
                    result = goLive ? "Switched to LIVE mode. Real money at risk." : "Switched to PAPER mode. Trades simulated.";
                    break;
                  }

                  // ── Configuration ──
                  case "update_config": {
                    if (inp.key in config) {
                      const old = (config as any)[inp.key];
                      (config as any)[inp.key] = inp.value;
                      pushActivity("⚙️", `Config ${inp.key}: ${old} → ${inp.value}`);
                      result = `${inp.key}: ${old} → ${inp.value}`;
                    } else {
                      result = `Error: '${inp.key}' not found in config. Available: ${Object.keys(config).filter(k => typeof (config as any)[k] === "number" || typeof (config as any)[k] === "boolean").join(", ")}`;
                    }
                    break;
                  }
                  case "toggle_strategy": {
                    const stratKey = `STRATEGY_${inp.strategy.toUpperCase()}`;
                    if (stratKey in config) {
                      (config as any)[stratKey] = inp.enabled;
                      pushActivity("🔀", `${inp.strategy} ${inp.enabled ? "enabled" : "disabled"}`);
                      result = `${inp.strategy} ${inp.enabled ? "enabled" : "disabled"}.`;
                    } else {
                      result = `Unknown strategy '${inp.strategy}'.`;
                    }
                    break;
                  }
                  case "set_bankroll": {
                    if (botState?.setBankroll) {
                      botState.setBankroll(inp.amount);
                      pushActivity("💰", `Bankroll set to $${inp.amount.toFixed(2)} via chat`);
                      result = `Bankroll set to $${inp.amount.toFixed(2)}.`;
                    } else {
                      result = "Set bankroll not available.";
                    }
                    break;
                  }

                  // ── Trading ──
                  case "place_trade": {
                    if (!botState?.placeTrade) { result = "Place trade not wired."; break; }
                    pushActivity("📊", `Manual trade: ${inp.direction} ${inp.ticker} $${inp.size}`);
                    result = await botState.placeTrade(inp.ticker, inp.direction, inp.size);
                    break;
                  }
                  case "close_position": {
                    if (!botState?.closePosition) { result = "Close position not available."; break; }
                    result = await botState.closePosition(inp.ticker);
                    pushActivity("📤", `Closed ${inp.ticker} via chat`);
                    break;
                  }
                  case "cancel_order": {
                    const kalshi = botState?.getKalshiClient?.();
                    if (!kalshi) { result = "Kalshi client not available."; break; }
                    await kalshi.cancelOrder(inp.order_id);
                    pushActivity("❌", `Cancelled order ${inp.order_id}`);
                    result = `Order ${inp.order_id} cancelled.`;
                    break;
                  }
                  case "cancel_all_orders": {
                    const kalshi = botState?.getKalshiClient?.();
                    if (!kalshi) { result = "Kalshi client not available."; break; }
                    const ordersResp = await kalshi.getOrders({ status: "resting", limit: 100 });
                    const orders = ordersResp.orders ?? [];
                    let cancelled = 0;
                    for (const o of orders) {
                      try { await kalshi.cancelOrder(o.order_id); cancelled++; } catch {}
                    }
                    pushActivity("❌", `Cancelled ${cancelled} orders via chat`);
                    result = `Cancelled ${cancelled} of ${orders.length} resting orders.`;
                    break;
                  }
                  case "trigger_scan":
                    botState?.triggerScan?.(inp.strategy);
                    pushActivity("🔍", `Scan: ${inp.strategy}`);
                    result = `Scan triggered for ${inp.strategy}.`;
                    break;

                  // ── Information ──
                  case "get_logs": {
                    const n = Math.min(inp.lines || 20, 50);
                    const logs = botState?.getLogs?.(n) ?? [];
                    result = logs.length > 0 ? logs.join("\n") : "No recent logs.";
                    break;
                  }
                  case "get_balance": {
                    const kalshi = botState?.getKalshiClient?.();
                    if (!kalshi) { result = "Kalshi client not available."; break; }
                    const bal = await kalshi.getBalance();
                    result = `Balance: $${(bal.balance / 100).toFixed(2)} available, $${((bal.payout ?? 0) / 100).toFixed(2)} in payouts.`;
                    break;
                  }
                  case "get_open_orders": {
                    const kalshi = botState?.getKalshiClient?.();
                    if (!kalshi) { result = "Kalshi client not available."; break; }
                    const ordersResp = await kalshi.getOrders({ status: "resting", limit: 20 });
                    const orders = ordersResp.orders ?? [];
                    if (orders.length === 0) { result = "No resting orders."; break; }
                    result = orders.map((o: any) =>
                      `${o.order_id.slice(0,8)}… ${o.ticker} ${o.side} ${o.action} ${o.remaining_count}x @ ${o.yes_price ?? o.no_price}¢ [${o.status}]`
                    ).join("\n");
                    break;
                  }
                  case "search_markets": {
                    const markets = botState?.getCachedMarkets?.() ?? [];
                    const q = (inp.query || "").toLowerCase();
                    const limit = Math.min(inp.limit || 10, 25);
                    const matches = markets
                      .filter((m: any) => (m.question || "").toLowerCase().includes(q) || (m.condition_id || "").toLowerCase().includes(q))
                      .slice(0, limit);
                    if (matches.length === 0) { result = `No markets matching "${inp.query}".`; break; }
                    result = matches.map((m: any) => {
                      const hoursLeft = m.end_date ? ((new Date(m.end_date).getTime() - Date.now()) / 3600000).toFixed(1) : "?";
                      return `${m.condition_id}: YES ${(m.yes_price * 100).toFixed(0)}¢ / NO ${(m.no_price * 100).toFixed(0)}¢ | vol ${m.volume} | closes ${hoursLeft}h\n  "${(m.question || "").slice(0, 80)}"`;
                    }).join("\n\n");
                    break;
                  }
                  case "get_market_detail": {
                    const kalshi = botState?.getKalshiClient?.();
                    if (!kalshi) { result = "Kalshi client not available."; break; }
                    const { market: mkt } = await kalshi.getMarket(inp.ticker);
                    result = `${mkt.ticker}: "${mkt.title}"\nStatus: ${mkt.status} | YES bid/ask: ${mkt.yes_bid}/${mkt.yes_ask}¢ | NO bid/ask: ${mkt.no_bid}/${mkt.no_ask}¢\nClose: ${mkt.close_time} | Volume: ${mkt.volume_24h}\nResult: ${mkt.result || "pending"}`;
                    break;
                  }
                  case "get_trade_history": {
                    const db = getDb();
                    const limit = Math.min(inp.limit || 20, 50);
                    const trades = db.prepare(`SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?`).all(limit) as any[];
                    if (trades.length === 0) { result = "No trade history."; break; }
                    result = trades.map((t: any) =>
                      `[${new Date(t.timestamp).toLocaleString()}] ${t.strategy} ${t.side} "${(t.market_question || "").slice(0, 50)}" @ ${((t.price || 0) * 100).toFixed(0)}¢, $${(t.size || 0).toFixed(2)}${t.dry_run ? " [PAPER]" : ""}`
                    ).join("\n");
                    break;
                  }
                  case "get_rejected_signals": {
                    const db = getDb();
                    const limit = Math.min(inp.limit || 15, 30);
                    const rejects = db.prepare(`SELECT * FROM rejected_signals ORDER BY timestamp DESC LIMIT ?`).all(limit) as any[];
                    if (rejects.length === 0) { result = "No rejected signals recorded."; break; }
                    result = rejects.map((r: any) =>
                      `[${new Date(r.timestamp).toLocaleTimeString()}] ${r.strategy} ${r.direction} "${(r.market_question || "").slice(0, 40)}": ${r.reject_reason} (edge ${((r.edge || 0) * 100).toFixed(1)}%, conf ${((r.confidence || 0) * 100).toFixed(0)}%)`
                    ).join("\n");
                    break;
                  }
                  case "confirm_withdrawal": {
                    const amount = inp.amount;
                    confirmWithdrawal(amount);
                    if (botState?.setBankroll) {
                      const snap = buildSnapshot();
                      botState.setBankroll(snap.bankroll - amount);
                    }
                    pushActivity("💰", `Withdrawal confirmed: $${amount.toFixed(2)} → nest egg`);
                    result = `Withdrawal of $${amount.toFixed(2)} confirmed. This amount has been moved to your nest egg. The bot's active bankroll has been reduced accordingly.`;
                    break;
                  }
                  case "get_withdrawal_status": {
                    result = "Withdrawal system is archived — not applicable to turbo-only mode.";
                    break;
                  }

                  // ── Advanced Intelligence ──
                  case "get_prices": {
                    const prices = getAllPrices();
                    if (prices.length === 0) { result = "No price data yet — Binance feed may still be connecting."; break; }
                    result = prices.map(p =>
                      `${p.symbol.toUpperCase()}: $${p.price.toLocaleString()} | 5s: ${p.change5s > 0 ? "+" : ""}${p.change5s.toFixed(3)}% | 30s: ${p.change30s > 0 ? "+" : ""}${p.change30s.toFixed(3)}% | 60s: ${p.change60s > 0 ? "+" : ""}${p.change60s.toFixed(3)}% | ${p.momentum}`
                    ).join("\n");
                    break;
                  }
                  case "get_crypto_signal": {
                    const sig = detectCryptoSignal(inp.symbol);
                    if (!sig) { result = `No data for ${inp.symbol}.`; break; }
                    result = `Signal: ${sig.signal} | Confidence: ${(sig.confidence * 100).toFixed(1)}%\n${sig.details}`;
                    break;
                  }
                  case "get_cross_asset_cascade": {
                    const cascades = detectCrossAssetCascade();
                    if (cascades.length === 0) { result = "No cross-asset cascades detected right now."; break; }
                    result = cascades.map(c =>
                      `${c.leader} → ${c.follower}: ${c.direction} | Leader moved ${c.leader_change > 0 ? "+" : ""}${c.leader_change.toFixed(3)}%, follower only ${c.follower_change > 0 ? "+" : ""}${c.follower_change.toFixed(3)}% | Gap: ${c.gap_pct.toFixed(3)}% | Confidence: ${(c.confidence * 100).toFixed(0)}%`
                    ).join("\n");
                    break;
                  }
                  case "get_settlement_prediction": {
                    const pred = predictSettlement(inp.symbol);
                    if (!pred) { result = `Not enough data for ${inp.symbol} settlement prediction (need 30+ readings).`; break; }
                    result = `Predicted settlement: $${pred.predicted_price.toLocaleString()}\nCurrent price: $${pred.current_price.toLocaleString()}\nTrend: ${pred.trend_direction}\nConfidence: ${(pred.confidence * 100).toFixed(1)}%`;
                    break;
                  }
                  case "get_order_book": {
                    const obi = getOrderBookImbalance(inp.symbol);
                    if (!obi) { result = `No order book data for ${inp.symbol}.`; break; }
                    result = `Imbalance: ${obi.imbalance > 0 ? "+" : ""}${obi.imbalance.toFixed(3)} (${obi.imbalance > 0.3 ? "BUY pressure" : obi.imbalance < -0.3 ? "SELL pressure" : "balanced"})\nWeighted imbalance: ${obi.weighted_imbalance > 0 ? "+" : ""}${obi.weighted_imbalance.toFixed(3)}\nSpread: ${obi.spread_pct.toFixed(4)}%\nSignal: ${obi.signal} | Confidence: ${(obi.confidence * 100).toFixed(0)}%`;
                    break;
                  }
                  case "get_funding_rate": {
                    const funding = getFundingBias(inp.symbol);
                    if (!funding) { result = `No funding rate data for ${inp.symbol}.`; break; }
                    result = `Funding rate: ${(funding.rate * 100).toFixed(4)}%\nBias: ${funding.bias}\nZ-score: ${funding.z_score.toFixed(2)}\n30d mean: ${(funding.mean_30d * 100).toFixed(4)}% | 30d std: ${(funding.std_30d * 100).toFixed(4)}%`;
                    break;
                  }
                  case "get_liquidation_cascade": {
                    const liq = detectLiquidationCascade(inp.symbol);
                    result = `Cascade active: ${liq.active ? "YES ⚠️" : "no"}\nDirection: ${liq.direction}\nIntensity: ${(liq.intensity * 100).toFixed(0)}%\nVolume: $${liq.volume_usd.toLocaleString()}\nLiquidation count: ${liq.count}`;
                    break;
                  }
                  case "get_vwap": {
                    const vwap = getVWAP(inp.symbol);
                    if (!vwap) { result = `No VWAP data for ${inp.symbol}.`; break; }
                    result = `VWAP: $${vwap.vwap.toLocaleString()}\nUpper band (2σ): $${vwap.upper_band.toLocaleString()}\nLower band (2σ): $${vwap.lower_band.toLocaleString()}\nDeviation: ${vwap.deviation > 0 ? "+" : ""}${vwap.deviation.toFixed(2)}σ\nSlope: ${vwap.slope > 0 ? "+" : ""}${vwap.slope.toFixed(4)}\nSignal: ${vwap.signal}`;
                    break;
                  }
                  case "get_vpin": {
                    const vpin = getVPIN(inp.symbol);
                    result = `VPIN: ${(vpin.vpin * 100).toFixed(1)}% (${vpin.signal})\nBucket imbalance: ${(vpin.bucket_imbalance * 100).toFixed(1)}%\n${vpin.vpin > 0.7 ? "⚠️ High informed trading detected — price move likely imminent" : vpin.vpin > 0.4 ? "Moderate informed flow — watch for breakout" : "Low informed activity — normal market"}`;
                    break;
                  }
                  case "get_confluence": {
                    const conf = scoreConfluence(inp.symbol, inp.direction as "YES" | "NO", inp.asset);
                    const breakdown = Object.entries(conf.breakdown).map(([k, v]) =>
                      `  ${v.agrees ? "✅" : "❌"} ${k} (weight ${v.weight.toFixed(1)}): ${v.detail}`
                    ).join("\n");
                    result = `Confluence score: ${conf.total_score.toFixed(1)}/10 | ${conf.signals_agreeing}/${conf.signals_total} signals agree\nRecommendation: ${conf.recommendation}\n\nBreakdown:\n${breakdown}`;
                    break;
                  }
                  case "get_regime": {
                    const regime = geniusClassifyRegime(inp.symbol);
                    result = `Regime: ${regime.regime}\nConfidence: ${(regime.confidence * 100).toFixed(0)}%\nAutocorrelation: ${regime.autocorrelation.toFixed(3)}\nVWAP slope: ${regime.vwap_slope.toFixed(4)}\nRecommended strategy: ${regime.recommended_strategy}`;
                    break;
                  }

                  // ── System Intelligence ──
                  case "get_compound_state": {
                    result = "Compound engine is archived — bot is in turbo-only mode.";
                    break;
                  }
                  case "get_open_positions": {
                    const positions = getDbOpenPositions();
                    if (positions.length === 0) { result = "No open positions."; break; }
                    result = positions.map((p: any) =>
                      `${p.ticker}: ${p.side} ${p.contracts}x @ ${p.entry_price}¢ | $${(p.size_usd || 0).toFixed(2)} | ${p.strategy}\n  "${(p.market_question || "").slice(0, 60)}"`
                    ).join("\n\n");
                    break;
                  }
                  case "get_circuit_breaker": {
                    const cbState = getCircuitBreakerState();
                    const canTrade = canTradeCircuitBreaker();
                    result = `Status: ${cbState.status}\nConsecutive losses: ${cbState.consecutive_losses}\nCan trade: ${canTrade.ok ? "YES" : "NO"}\nSize multiplier: ${(canTrade.size_multiplier * 100).toFixed(0)}%${canTrade.reason ? `\nReason: ${canTrade.reason}` : ""}\nCooldown until: ${cbState.cooldown_until > 0 ? new Date(cbState.cooldown_until).toLocaleTimeString() : "none"}`;
                    break;
                  }
                  case "get_time_profile": {
                    const profiles = getAllTimeProfiles();
                    if (profiles.length === 0) { result = "No time profiling data yet."; break; }
                    const advice = getTimeAdvice();
                    const rows = profiles.filter(p => p.trades > 0).map(p =>
                      `  ${String(p.hour_utc).padStart(2, "0")}:00 UTC: ${p.trades} trades, ${(p.win_rate * 100).toFixed(0)}% win rate, avg PnL: ${p.avg_pnl >= 0 ? "+" : ""}$${p.avg_pnl.toFixed(2)}${!p.should_trade ? " ⛔" : ""}`
                    ).join("\n") || "  (no trades recorded yet)";
                    result = `Current advice: ${advice.should_trade ? "✅ Trade" : "⛔ Skip"} (${advice.reason})\nConfidence multiplier: ${advice.confidence_multiplier.toFixed(2)}x\n\nHourly breakdown:\n${rows}`;
                    break;
                  }
                  case "get_optimal_params": {
                    const opt = getOptimalParameters();
                    result = `Optimal confidence threshold: ${opt.optimal_confidence_threshold.toFixed(2)}\nOptimal min confluence: ${opt.optimal_min_confluence}\nOptimal max positions: ${opt.optimal_max_positions}\nSample size: ${opt.sample_size} trades`;
                    break;
                  }
                  case "get_strategy_telemetry": {
                    const tel = getStrategyTelemetry();
                    if (Object.keys(tel).length === 0) { result = "No telemetry data yet."; break; }
                    result = Object.entries(tel).map(([strategy, data]: [string, any]) =>
                      `${strategy}:\n  Scans: ${data.scans} | Evaluated: ${data.evaluated} | Traded: ${data.traded}\n  No edge: ${data.no_edge} | Below threshold: ${data.below_threshold} | Size min: ${data.size_min} | Blocked: ${data.blocked}`
                    ).join("\n\n");
                    break;
                  }
                  case "get_tax_summary": {
                    result = "Tax tracker is archived — not applicable to turbo-only mode.";
                    break;
                  }
                  case "get_fill_stats": {
                    result = "Smart execution fill stats are archived — not applicable to turbo-only mode.";
                    break;
                  }
                  case "get_velocity_state": {
                    const vs = getVelocityState();
                    result = JSON.stringify(vs, null, 2);
                    break;
                  }
                  case "get_auto_pause_state": {
                    if (!botState?.getAutoPauseState) { result = "Auto-pause not initialized."; break; }
                    const ap = botState.getAutoPauseState();
                    result = `Auto-pause: ${ap.is_auto_paused ? "🚨 ACTIVE" : "✅ Armed"}\nHigh water mark: $${ap.high_water_mark.toFixed(2)}\nSession start: $${ap.session_start_bankroll.toFixed(2)}\nDrawdown from HWM: ${(ap.drawdown_pct * 100).toFixed(1)}%\nSession drawdown: ${(ap.session_drawdown_pct * 100).toFixed(1)}%${ap.is_auto_paused ? `\nPause reason: ${ap.pause_reason}\nPaused at: ${ap.pause_timestamp ? new Date(ap.pause_timestamp).toLocaleString() : "unknown"}` : ""}`;
                    break;
                  }
                  case "clear_auto_pause": {
                    if (!botState?.clearAutoPause) { result = "Auto-pause not initialized."; break; }
                    botState.clearAutoPause();
                    result = "Auto-pause cleared. Bot switched back to LIVE mode. HWM and session start reset to current bankroll.";
                    break;
                  }
                  case "reset_hwm": {
                    if (!botState?.resetHWM) { result = "Auto-pause not initialized."; break; }
                    botState.resetHWM();
                    result = "High water mark reset to current bankroll.";
                    break;
                  }
                  case "get_evolution_state": {
                    const es = getEvolutionState();
                    const weights = getAllWeights();
                    const regime = getCurrentRegime();
                    result = `Regime: ${regime?.regime ?? "unknown"} (confidence: ${(regime as any)?.confidence?.toFixed(2) ?? "?"})\n\nStrategy weights:\n${weights.map((w: any) => `  ${w.strategy}: ${w.weight.toFixed(2)} (${w.trend})`).join("\n")}\n\nEvolution state: ${JSON.stringify(es, null, 2).slice(0, 500)}`;
                    break;
                  }
                  case "get_genius_state": {
                    const gs = getGeniusState();
                    result = JSON.stringify(gs, null, 2).slice(0, 1500);
                    break;
                  }
                  default:
                    result = `Unknown tool: ${tu.name}`;
                }
              } catch (toolErr: any) {
                result = `Tool error: ${toolErr.message}`;
              }
              toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
            }
            currentMessages.push({ role: "user" as const, content: toolResults });
          }

          const modelLabel = selectedModel.includes("opus") ? "opus" : selectedModel.includes("sonnet") ? "sonnet" : "haiku";
          return Response.json({ response: finalText, model: modelLabel });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      if (url.pathname === "/api/activity") {
        return Response.json({ items: activityBuffer.slice(-30) });
      }

      if (url.pathname === "/health") {
        return new Response("ok");
      }

      return new Response("not found", { status: 404 });
    },
  });

  console.log(`📱 Dashboard live at http://localhost:${port}`);
}
