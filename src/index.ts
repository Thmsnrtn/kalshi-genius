// src/index.ts — KALSHI GENIUS V3: BEAST MODE
//
// COMPLETE ARCHITECTURE:
//
// Layer 1: STRATEGIES       (hourly sniper, monotonicity arb, economic, weather, cross-platform, market maker)
// Layer 2: EVOLUTION        (learn what works — 5-scale feedback loops)
// Layer 3: GENIUS           (think deeply — cognitive council with calibration)
// Layer 4: META             (self-critique — prompt evolution, strategy genetics)
// Layer 5: ALPHA SOURCES    (information edge — news, whales, orderbook, FRED, NWS, odds movement)
// Layer 6: DASHBOARD        (phone-first monitoring with calibration view)
// Layer 7: POSITION MGMT    (exits — take profit, stop loss, trailing stop, time exit)
// Layer 8: RESOLUTION       (feedback loop — track outcomes, calibrate, milestones)

import { config, getPhaseParams } from "./core/config.js";
import { calculatePosition, canTrade, meetsEdgeThreshold, getExposure } from "./core/risk.js";
import { getDb, logTrade, logRejectedSignal, openPosition, getOpenPositions, closePosition as dbClosePosition, logMilestone, getCalibrationData, getCouncilAttribution, getMilestones, getCachedVerdict, setCachedVerdict, cleanExpiredCache, getBotState, setBotState as dbSetBotState } from "./core/db.js";
import { notifyStartup, notifyTrade, notifyExit, notifyMilestone, notifyError } from "./core/notify.js";
import { startPriceFeed, getPrice } from "./feeds/binance.js";
import { aggressiveKelly, getCalibrationFactor } from "./core/aggressive_kelly.js";
import { logScanStart, logScanComplete, telemetryEvaluated, telemetryNoEdge, telemetryBelowThreshold, telemetrySizeMin, telemetryBlocked, telemetryTraded, telemetryCouncilDeliberation, telemetryCouncilSkip, getStrategyTelemetry, getCouncilTelemetry } from "./core/telemetry.js";

// KALSHI EXCHANGE
import { KalshiClient, kalshiMarketToUnified } from "./exchanges/kalshi/kalshi_client.js";
import { KalshiWebSocket } from "./exchanges/kalshi/kalshi_websocket.js";

// KALSHI STRATEGIES
import {
  scanHourlySniper,
  scanMonotonicityArb,
  scanEconomicMarkets,
  scanWeatherMarkets,
  scanCrossPlatformDivergences,
  scanHighConfidence,
  getOddsMovementSignals,
} from "./strategies/kalshi/kalshi_strategies.js";
// ARCHIVED: import { scanWithEnsemble } from "./strategies/multi_model_ensemble.js";

// MARKET MAKER
import { findMarketMakingOpportunities, placeMarketMakerOrders, manageInventory } from "./strategies/kalshi/market_maker.js";
import { initTurboTracker, recordTurboEntry, recordTurboOutcome, getTurboStats, getTurboSizeMultiplier, shouldSkipAsset, getRecentTurboContext } from "./strategies/kalshi/turbo_tracker.js";
import { recordCycleResult, recordBrainOutcome, getBrainStats, recordEntryMinute, clearActivePosition, setBrainBankroll, initGrowthTargets, setGrowthBaseline, updateGrowthProgress, evaluateAndRatchetTarget, getGrowthTargetState } from "./strategies/kalshi/turbo_brain.js";
import { logBankrollSnapshot } from "./core/db.js";

// DATA FEEDS
import { recordPriceSnapshots } from "./feeds/odds_movement.js";

// POSITION MANAGEMENT
import { startPositionManager, getPositionSummary } from "./core/position_manager.js";
import { startResolutionTracker, snapshotPrices } from "./core/resolution_tracker.js";

// EVOLUTION
import { initPerformanceTracker, recordSignal } from "./evolution/performance_tracker.js";
import { initStrategyWeights, applyWeightToSize, shouldFire, getWeight } from "./evolution/strategy_weights.js";
import { initMemory } from "./evolution/memory.js";
import { initPromptEvolution } from "./evolution/prompt_evolver.js";
import { startEvolutionLoops, reflexLoop } from "./evolution/evolution_loop.js";
import { getCurrentRegime } from "./evolution/regime_detector.js";

// GENIUS
import { initGenius, deliberate, retrospect, registerDecision, startGeniusLoops, registerBaseHypotheses } from "./genius/genius_orchestrator.js";

// ALPHA SOURCES
import { initAlphaSources, startAlphaSources, getFusedAlpha, getTriggeredAlphaMarkets, markActedOn } from "./alpha_sources/alpha_orchestrator.js";

// COMPOUND ENGINE
// ARCHIVED: import { initCompoundTracking, updateCompoundState, isStrategyUnlocked, allocateCapital, recordStrategyYield, checkAutoWithdrawal } from "./compound/compound_engine.js";
// Stubs for archived modules
const updateCompoundState = (_b: number) => {};
const recordStrategyYield = (_s: string, _p: number) => {};
const velocityAllocateTrade = (_p: any) => ({ approved: true, allocated_size: _p.size, tranche_id: `t-${Date.now()}` });
const velocityReleaseTranche = (_t: string, _p: number) => {};

// ADVANCED FEEDS (Order Book, Funding Rate, Liquidation, VWAP, VPIN)
import { startAdvancedFeeds, getOrderBookImbalance, getFundingBias, detectLiquidationCascade, getVWAP, getVPIN, classifyTrade } from "./feeds/binance_advanced.js";

// GENIUS SIGNALS (Regime, Stale Price, Confluence, Time Profiling, Circuit Breaker, Backtester, Adaptive, Correlation)
import { classifyRegime, detectStalePrice, scoreConfluence, recordTimeProfile, getTimeAdvice, canTradeCircuitBreaker, recordTradeResult, correlationDiscount, recordSignalOutcome, getOptimalParameters } from "./core/genius_signals.js";

// TURBO PROBABILITY MODEL (Phase 4: proper Black-Scholes + mispricing scanner)
import { updateCycleOpens } from "./core/turbo_probability.js";

// SMART EXECUTION (Order Routing, Partial Scaling)
// ARCHIVED: import { getOrderStrategy, createScaledEntry, checkScaleOut, recordFillStats } from "./core/smart_execution.js";

// TAX TRACKING
// ARCHIVED: import { initTaxTracker, recordTaxLot, closeTaxLot, getTaxSummary } from "./core/tax_tracker.js";

// LIQUIDITY ENGINE
// ARCHIVED: import { initLiquidityEngine, wireLiquidityEngine, startLiquidityEngine } from "./liquidity/liquidity_orchestrator.js";

// VELOCITY ENGINE
// ARCHIVED: import { initVelocityOrchestrator, wireVelocityOrchestrator, startVelocityOrchestrator, velocityAllocateTrade, velocityReleaseTranche } from "./velocity/velocity_orchestrator.js";

// AUTO-PAUSE (Operator Rule #1)
import { initAutoPause, checkAutoPause, setAutoPauseCallback, clearAutoPause, getAutoPauseState, resetHighWaterMark } from "./core/auto_pause.js";

// KILL-SWITCH (Operator Rule #2)
import { initKillSwitch, isKillSwitchActive, killSwitchPath } from "./core/kill_switch.js";

// STARTUP RECONCILIATION (Operator Rule #3)
import { reconcileStartupPositions } from "./core/startup_reconciler.js";

// DASHBOARD
import { startDashboard, setBotState, pushActivity } from "./dashboard/server.js";

// Global state
let bankroll = config.STARTING_BANKROLL;
let STARTING_BANKROLL = bankroll;
let lastBankrollSyncAt: number | null = null;
let openPositionCount = 0;
let totalTrades = 0;
let signalCounter = 0;
let paused = false; // Overwritten from DB in main()
let consecutiveWins = 0;
const startTime = Date.now();
let latestVerdict: any = null;
let cachedMarkets: any[] = [];
let nextMilestone = config.MILESTONES.find(m => m > bankroll) ?? config.MILESTONES[0];

const genSignalId = (s: string) => `${s}-${Date.now()}-${++signalCounter}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let councilConsecutivePasses = 0;
let councilIntervalMs = config.CLAUDE_SCAN_INTERVAL_MS;
let councilTimer: ReturnType<typeof setInterval> | null = null;

// Log buffer for chat assistant
const logBuffer: string[] = [];
const MAX_LOG_LINES = 200;
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
const captureLog = (...args: any[]) => {
  const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  logBuffer.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
  origLog(...args);
};
const captureError = (...args: any[]) => {
  const line = args.map(a => typeof a === "string" ? a : (a?.message ?? JSON.stringify(a))).join(" ");
  logBuffer.push(`[${new Date().toLocaleTimeString()}] ❌ ${line}`);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
  origError(...args);
};
console.log = captureLog;
console.error = captureError;
console.warn = (...args: any[]) => { captureLog("⚠️", ...args); origWarn(...args); };

async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🧠 KALSHI GENIUS V3 — BEAST MODE                         ║
╠════════════════════════════════════════════════════════════╣
║  8 Layers × Aggressive Kelly × Data-Driven Edge            ║
╚════════════════════════════════════════════════════════════╝`);

  const phase = getPhaseParams(bankroll);
  console.log(`  Mode:      ${config.DRY_RUN ? "🧪 PAPER" : "🔴 LIVE"}`);
  console.log(`  Exchange:  Kalshi (${config.KALSHI_ENV})`);
  console.log(`  Bankroll:  $${bankroll.toFixed(2)}`);
  console.log(`  Phase:     ${phase.label}`);
  console.log(`  Kelly:     ${(phase.kelly * 100).toFixed(0)}% | Max Pos: ${(phase.maxPosPct * 100).toFixed(0)}% | Positions: ${phase.maxPositions}`);
  console.log(`  Target:    $${nextMilestone} (${(nextMilestone / bankroll).toFixed(0)}x)`);

  console.log("\n  ARCHITECTURE:");
  console.log("  1️⃣  STRATEGIES    → ⚡ sniper, 📐 arb, 📊 economic, 🌤️ weather+GFS, 🌐 cross-plat, 💹 MM, 🎯 high-conf, 🤖 ensemble");
  console.log("  2️⃣  EVOLUTION     → 5 loops (reflex → omega)");
  console.log("  3️⃣  GENIUS        → council + calibration + counterfactuals");
  console.log("  4️⃣  META          → strategy breeding, prompt evolution");
  console.log("  5️⃣  ALPHA         → 📰 news, 🐋 whales, 📊 orderbook, 📈 FRED, 🌤️ NWS, 📉 odds velocity");
  console.log("  6️⃣  DASHBOARD     → phone-first monitoring + calibration");
  console.log("  7️⃣  POSITIONS     → take-profit, stop-loss, trailing-stop, time-exit");
  console.log("  8️⃣  RESOLUTION    → feedback loop, milestones, calibration");
  console.log("  9️⃣  COMPOUND      → 6-phase growth engine, strategy unlocks");
  console.log("  🔟  LIQUIDITY     → spread capture, adverse selection, inventory mgmt");
  console.log("  1️⃣1️⃣  VELOCITY     → parallel tranches, laddered exits, capital cycling");
  console.log("  1️⃣2️⃣  GENIUS SIG   → confluence, regime, circuit breaker, time profiling");
  console.log("  1️⃣3️⃣  ADVANCED     → OBI, VPIN, VWAP, funding rate, liquidation cascade");
  console.log("  1️⃣4️⃣  EXECUTION    → smart routing, partial scaling, tax tracking\n");

  if (!config.ANTHROPIC_API_KEY) { console.error("❌ ANTHROPIC_API_KEY required"); process.exit(1); }
  if (!config.KALSHI_API_KEY_ID) { console.error("❌ KALSHI_API_KEY_ID required"); process.exit(1); }

  // ── Restore paused state from DB ──
  const savedPaused = getBotState("paused", "false");
  paused = savedPaused === "true";
  console.log(`  🔄 Restored paused state: ${paused}`);

  // ── Write PEM from env var if needed (Fly.io) ──
  if (process.env.KALSHI_PRIVATE_KEY && config.KALSHI_PRIVATE_KEY_PATH) {
    const { writeFileSync, mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    mkdirSync(dirname(config.KALSHI_PRIVATE_KEY_PATH), { recursive: true });
    writeFileSync(config.KALSHI_PRIVATE_KEY_PATH, process.env.KALSHI_PRIVATE_KEY, { mode: 0o600 });
    console.log(`  📝 Wrote PEM to ${config.KALSHI_PRIVATE_KEY_PATH}`);
  }

  // V6: Init growth target tables early (before Kalshi connect calls setGrowthBaseline)
  getDb();
  initGrowthTargets();

  // ── Initialize Kalshi client ──
  const kalshi = new KalshiClient({
    environment: config.KALSHI_ENV,
    apiKeyId: config.KALSHI_API_KEY_ID,
    privateKeyPath: config.KALSHI_PRIVATE_KEY_PATH,
  });

  try {
    const balance = await kalshi.getBalance();
    const balanceUsd = balance.balance / 100;
    const payoutUsd = (balance.payout ?? 0) / 100;
    const portfolioUsd = balanceUsd + payoutUsd;
    console.log(`✅ Kalshi connected (${config.KALSHI_ENV}) — Cash: $${balanceUsd.toFixed(2)} | Positions: $${payoutUsd.toFixed(2)} | Portfolio: $${portfolioUsd.toFixed(2)}`);

    // Sync bankroll from Kalshi if connected to production — use total portfolio value
    if (config.KALSHI_ENV === "production" && portfolioUsd > 0) {
      bankroll = portfolioUsd;
      setBrainBankroll(portfolioUsd); // V5: Brain needs bankroll for sizing
      setGrowthBaseline(portfolioUsd); // V6: Set today's growth baseline
      STARTING_BANKROLL = portfolioUsd;
      lastBankrollSyncAt = Date.now();
      console.log(`💰 Initial bankroll synced from Kalshi: $${bankroll.toFixed(2)} (portfolio total)`);
    } else {
      console.log(`⚠️  Using config bankroll: $${bankroll.toFixed(2)} (env=${config.KALSHI_ENV})`);
    }
  } catch (err: any) {
    console.error(`❌ Kalshi connection failed: ${err.message}`);
    process.exit(1);
  }

  // ── Initialize kill-switch file watcher (Operator Rule #2) ──
  initKillSwitch();

  // ── Initialize auto-pause-to-paper (Operator Rule #1) ──
  initAutoPause(bankroll);
  setAutoPauseCallback((reason) => {
    (config as any).DRY_RUN = true;
    console.log(`🚨 AUTO-PAUSE: Switched to PAPER mode — ${reason}`);
    pushActivity("🚨", `AUTO-PAUSE: ${reason} — switched to paper mode`);
    notifyError(`AUTO-PAUSE TRIGGERED: ${reason}\nBot switched to paper mode. Use chat to re-enable live trading.`);
  });

  console.log(`🔒 Mode: ${config.DRY_RUN ? "PAPER (DRY_RUN=true)" : "LIVE (DRY_RUN=false)"} | Paused: ${paused} | Bankroll: $${bankroll.toFixed(2)}`);

  // ── Startup reconciliation: diff local open positions against Kalshi live portfolio (Operator Rule #3) ──
  try {
    const report = await reconcileStartupPositions({ kalshi, isDryRun: config.DRY_RUN });
    if (report.ran && (report.closed_as_missing.length > 0 || report.unknown_on_kalshi.length > 0 || report.errors.length > 0)) {
      pushActivity("🔁", `Reconcile: closed ${report.closed_as_missing.length} stale, ${report.unknown_on_kalshi.length} untracked on Kalshi`);
    }
  } catch (err: any) {
    console.warn(`⚠️  Startup reconcile crashed (non-fatal): ${err?.message ?? err}`);
  }

  // ── Initialize Kalshi WebSocket ──
  let kalshiWs: KalshiWebSocket | null = null;
  try {
    kalshiWs = new KalshiWebSocket({
      environment: config.KALSHI_ENV,
      apiKeyId: config.KALSHI_API_KEY_ID,
      privateKeyPath: config.KALSHI_PRIVATE_KEY_PATH,
    });
    await kalshiWs.connect();
  } catch (err: any) {
    console.warn(`⚠️  Kalshi WebSocket failed (non-fatal): ${err.message}`);
    kalshiWs = null;
  }

  // Initialize all layers (getDb already called above for growth targets)
  initPerformanceTracker();
  initStrategyWeights();
  initMemory();
  initPromptEvolution();
  initGenius();
  registerBaseHypotheses();
  initAlphaSources();
  // ARCHIVED: initCompoundTracking, initLiquidityEngine, initVelocityOrchestrator, initTaxTracker
  console.log("✅ All layers initialized\n");

  // Expose state to dashboard (V4: with full chat controls)
  setBotState({
    getBankroll: () => bankroll,
    getStartingBankroll: () => STARTING_BANKROLL,
    getOpenPositions: () => openPositionCount,
    getStartTime: () => startTime,
    isPaused: () => paused,
    setPaused: (p) => { paused = p; dbSetBotState("paused", String(p)); console.log(p ? "⏸  Bot paused" : "▶  Bot resumed"); },
    getLatestVerdict: () => latestVerdict,
    getKalshiClient: () => kalshi,
    getLastSyncAt: () => lastBankrollSyncAt,
    triggerScan: (strategy: string) => {
      console.log(`🔍 Manual scan triggered: ${strategy}`);
    },
    // V4: Chat-driven controls
    closePosition: async (ticker: string) => {
      const positions = getOpenPositions();
      const pos = positions.find((p: any) => p.ticker === ticker);
      if (!pos) return `No open position found for ticker '${ticker}'. Open positions: ${positions.map((p: any) => p.ticker).join(", ") || "none"}`;
      try {
        if (!config.DRY_RUN) {
          const side = pos.side.toLowerCase() as "yes" | "no";
          await kalshi.placeOrder({
            ticker: pos.ticker,
            side,
            action: "sell",
            type: "limit",
            count: pos.contracts,
            yes_price: side === "yes" ? 1 : undefined,
            no_price: side === "no" ? 1 : undefined,
          });
        }
        const pnl = pos.unrealized_pnl ?? 0;
        dbClosePosition(pos.id, pos.current_price ?? pos.entry_price, "chat_manual_close", pnl);
        openPositionCount = Math.max(0, openPositionCount - 1);
        return `Closed position ${ticker}: ${pos.side} ${pos.contracts} contracts, PnL ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}${config.DRY_RUN ? " (paper mode)" : ""}`;
      } catch (err: any) {
        return `Failed to close ${ticker}: ${err.message}`;
      }
    },
    emergencyStop: async () => {
      paused = true;
      dbSetBotState("paused", "true");
      const lines: string[] = ["Bot paused."];
      try {
        const ordersResp = await kalshi.getOrders({ status: "resting", limit: 50 });
        const orders = ordersResp.orders ?? [];
        let cancelled = 0;
        for (const order of orders) {
          try { await kalshi.cancelOrder(order.order_id); cancelled++; } catch {}
        }
        lines.push(`Cancelled ${cancelled}/${orders.length} resting orders.`);
      } catch (err: any) {
        lines.push(`Could not fetch/cancel orders: ${err.message}`);
      }
      return lines.join(" ");
    },
    getLogs: (n: number) => logBuffer.slice(-n),
    setDryRun: (dry: boolean) => {
      (config as any).DRY_RUN = dry;
      console.log(`🔄 Mode changed via chat: ${dry ? "PAPER" : "🔴 LIVE"}`);
    },
    // V5: Full agency controls
    placeTrade: async (ticker: string, direction: "YES" | "NO", size: number) => {
      try {
        const { market } = await kalshi.getMarket(ticker);
        const side = direction.toLowerCase() as "yes" | "no";
        const priceField = side === "yes" ? market.yes_ask : market.no_ask;
        const priceDollars = priceField / 100;
        const count = Math.max(1, Math.floor(size / priceDollars));

        if (config.DRY_RUN) {
          openPosition({
            ticker, order_id: `chat-manual-${Date.now()}`, side: direction,
            entry_price: priceField, contracts: count, size_usd: size,
            strategy: "chat_manual", market_question: market.title,
          });
          openPositionCount++;
          return `[PAPER] Placed ${direction} ${count}x ${ticker} @ ${priceField}¢, size $${size.toFixed(2)}. "${market.title}"`;
        }

        const result = await kalshi.placeOrder({
          ticker, side, action: "buy", type: "limit", count,
          yes_price: side === "yes" ? priceField : undefined,
          no_price: side === "no" ? priceField : undefined,
        });
        openPosition({
          ticker, order_id: result?.order?.order_id ?? `chat-${Date.now()}`,
          side: direction, entry_price: priceField, contracts: count,
          size_usd: size, strategy: "chat_manual", market_question: market.title,
        });
        openPositionCount++;
        return `Placed ${direction} ${count}x ${ticker} @ ${priceField}¢, size $${size.toFixed(2)}. Order: ${result?.order?.order_id ?? "submitted"}. "${market.title}"`;
      } catch (err: any) {
        return `Trade failed: ${err.message}`;
      }
    },
    setBankroll: (amount: number) => {
      bankroll = amount;
      console.log(`💰 Bankroll manually set to $${amount.toFixed(2)} via chat`);
    },
    getCachedMarkets: () => cachedMarkets,
    // Auto-pause controls (Operator Rule #1)
    getAutoPauseState,
    clearAutoPause: () => {
      clearAutoPause(bankroll);
      (config as any).DRY_RUN = false;
      console.log(`✅ Auto-pause cleared — switched back to LIVE mode`);
      pushActivity("✅", `Auto-pause cleared — LIVE mode re-enabled at $${bankroll.toFixed(2)}`);
    },
    resetHWM: () => {
      resetHighWaterMark(bankroll);
      console.log(`🔄 HWM reset to current bankroll $${bankroll.toFixed(2)}`);
    },
  });

  // Start dashboard
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT ?? "3000");
  startDashboard(dashboardPort);

  // Initialize turbo performance tracker
  initTurboTracker();

  // Start Binance price feed + advanced feeds
  startPriceFeed();
  startAdvancedFeeds();
  await sleep(3000);

  // Track cycle open prices every 10s for the probability model
  setInterval(updateCycleOpens, 10_000);
  updateCycleOpens(); // immediate first capture

  // Cache active Kalshi markets (events + turbo crypto series)
  const refreshMarkets = async () => {
    try {
      const markets = await kalshi.getAllNonSportsMarkets();

      // Also fetch turbo crypto markets (not in events endpoint)
      const turboSeries = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M"];
      let turboCount = 0;
      for (const series of turboSeries) {
        try {
          const { markets: turboMarkets } = await kalshi.getMarkets({ series_ticker: series, limit: 20 });
          for (const tm of turboMarkets) {
            if (tm.status && !["active", "open", "trading", "initialized"].includes(tm.status)) continue;
            if (!markets.some(m => m.ticker === tm.ticker)) {
              markets.push(tm);
              turboCount++;
            }
          }
        } catch (e: any) {
          console.log(`  ⚠️ Turbo fetch ${series}: ${e.message?.slice(0, 100)}`);
        }
      }

      cachedMarkets = markets.map(kalshiMarketToUnified);
      const within24h = cachedMarkets.filter(m => m.end_date && (new Date(m.end_date).getTime() - Date.now()) / 3600000 <= 24).length;
      console.log(`📊 Market refresh: ${cachedMarkets.length} cached (${turboCount} turbo), ${within24h} closing within 24h`);
      pushActivity("📊", `Market refresh: ${cachedMarkets.length} markets (${turboCount} turbo)`);

      // Record price snapshots for odds movement detection
      if (cachedMarkets.length > 0) {
        recordPriceSnapshots(cachedMarkets.map(m => ({
          condition_id: m.condition_id,
          yes_price: m.yes_price,
          no_price: m.no_price,
          volume: 0,
          volume_24h: m.volume,
        })));
      }
    } catch (err: any) {
      console.error(`⚠️ Market refresh failed: ${err.message}`);
    }
  };
  await refreshMarkets();
  setInterval(refreshMarkets, 5 * 60 * 1000); // 5 min — full refresh including events

  // Fast turbo-only refresh every 60s — turbo markets cycle every 15 min
  let _turboRefreshCount = 0;
  const refreshTurboOnly = async () => {
    try {
      const turboSeries = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M"];
      let added = 0;
      let fetched = 0;
      let skippedStatus = new Map<string, number>();
      for (const series of turboSeries) {
        try {
          const { markets: turboMarkets } = await kalshi.getMarkets({ series_ticker: series, limit: 20 });
          fetched += turboMarkets.length;
          for (const tm of turboMarkets) {
            // Log status distribution for first 3 refreshes
            if (_turboRefreshCount < 3) {
              skippedStatus.set(tm.status, (skippedStatus.get(tm.status) ?? 0) + 1);
            }
            // Accept "active" or any open-like status (API may return different values)
            if (tm.status && !["active", "open", "trading", "initialized"].includes(tm.status)) continue;
            const unified = kalshiMarketToUnified(tm);
            const idx = cachedMarkets.findIndex(m => m.condition_id === unified.condition_id);
            if (idx >= 0) {
              cachedMarkets[idx] = unified;
            } else {
              cachedMarkets.push(unified);
              added++;
            }
          }
        } catch (e: any) {
          console.log(`  ⚠️ Turbo fast refresh ${series}: ${e.message?.slice(0, 100)}`);
        }
      }
      _turboRefreshCount++;
      const turboInCache = cachedMarkets.filter(m => m.condition_id.includes("15M")).length;
      // Always log first 3 refreshes for debugging
      if (_turboRefreshCount <= 3 || added > 0) {
        const statusStr = [...skippedStatus.entries()].map(([k,v]) => `${k}=${v}`).join(", ");
        console.log(`⚡ Turbo refresh #${_turboRefreshCount}: fetched=${fetched}, added=${added}, ${turboInCache} in cache. Statuses: ${statusStr}`);
      }
    } catch (e: any) {
      console.error(`⚠️ Turbo refresh error: ${e.message}`);
    }
  };
  setInterval(refreshTurboOnly, 60 * 1000); // Every 60s

  // Subscribe to ticker updates
  if (kalshiWs) {
    const topTickers = cachedMarkets.slice(0, 20).map((m) => m.condition_id);
    if (topTickers.length > 0) {
      kalshiWs.subscribe("ticker", topTickers);
      kalshiWs.subscribe("orderbook_delta", topTickers);
    }
  }

  // ARCHIVED: liquidity engine, velocity engine

  // Start evolution and genius loops
  startEvolutionLoops(() => bankroll, STARTING_BANKROLL);
  startGeniusLoops(() => bankroll);
  startAlphaSources(() => cachedMarkets.map((m) => m.question).slice(0, 30), () => bankroll);

  // ── Start Position Manager (exits) ──
  startPositionManager(kalshi, (ticker, pnl, reason) => {
    if (config.DRY_RUN) {
      bankroll += pnl; // paper trading accumulator
    }
    // Note: in live mode, the next sync loop cycle will update bankroll from Kalshi
    openPositionCount = Math.max(0, openPositionCount - 1);
    updateCompoundState(bankroll);
    velocityReleaseTranche(ticker, pnl);

    // Genius layer feedback on real exits
    const won = pnl > 0;
    recordTradeResult(won);
    recordTimeProfile(new Date().getUTCHours(), won, pnl);

    // Track turbo outcomes for learning + feed multi-cycle memory + signal analysis
    const isTurboExit = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M"].some(p => ticker.startsWith(p));
    if (isTurboExit) {
      recordTurboOutcome(ticker, pnl > 0, pnl, 0);
      const turboAsset = ticker.includes("BTC") ? "BTC" : ticker.includes("ETH") ? "ETH" : ticker.includes("SOL") ? "SOL" : "XRP";
      const lastContext = getRecentTurboContext(1);
      const lastSignals = lastContext.length > 0 && lastContext[0].asset === turboAsset
        ? (lastContext[0].momentum_signal?.split(",") ?? []) : [];
      recordBrainOutcome(pnl > 0, pnl, turboAsset, "YES", 0, lastSignals);
      updateGrowthProgress(pnl, pnl > 0); // V6: Feed growth target tracker
      recordCycleResult(turboAsset, "YES", pnl > 0, lastSignals);
      recordEntryMinute(0, pnl > 0, pnl); // V4 #11: micro-timing (approx)
      clearActivePosition(turboAsset); // V4 #9: free correlation slot
    }

    console.log(`  📤 EXIT ${ticker}: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} [${reason}] | Bankroll: $${bankroll.toFixed(2)}`);
    pushActivity("📤", `Exit ${ticker}: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} [${reason}]`);
    notifyExit(ticker, pnl, reason, bankroll);
    checkAutoPause(bankroll, config.DRY_RUN);
    checkMilestoneInline();
  });

  // ── Start Resolution Tracker (feedback loop) ──
  startResolutionTracker(kalshi, () => bankroll, () => totalTrades, () => startTime, (pnl, ticker) => {
    if (config.DRY_RUN) {
      bankroll += pnl; // paper trading accumulator
    }
    // Track turbo outcomes for learning + feed multi-cycle memory
    if (ticker) {
      const isTurboResolution = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M"].some(p => ticker.startsWith(p));
      if (isTurboResolution) {
        recordTurboOutcome(ticker, pnl > 0, pnl, 0);
        const turboAsset = ticker.includes("BTC") ? "BTC" : ticker.includes("ETH") ? "ETH" : ticker.includes("SOL") ? "SOL" : "XRP";
        const lastCtx = getRecentTurboContext(1);
        const sigs = lastCtx.length > 0 && lastCtx[0].asset === turboAsset
          ? (lastCtx[0].momentum_signal?.split(",") ?? []) : [];
        recordBrainOutcome(pnl > 0, pnl, turboAsset, "YES", 0, sigs);
        updateGrowthProgress(pnl, pnl > 0); // V6: Feed growth target tracker
        recordCycleResult(turboAsset, "YES", pnl > 0, sigs);
        recordEntryMinute(0, pnl > 0, pnl);
        clearActivePosition(turboAsset);
      }
    }
    // Genius layer feedback on resolution
    const won = pnl > 0;
    recordTradeResult(won);
    recordTimeProfile(new Date().getUTCHours(), won, pnl);
    // Note: in live mode, the next sync loop cycle will update bankroll from Kalshi
    if (pnl > 0) {
      consecutiveWins++;
    } else {
      consecutiveWins = 0;
    }
    openPositionCount = Math.max(0, openPositionCount - 1);
    updateCompoundState(bankroll);
    if (ticker) velocityReleaseTranche(ticker, pnl);
    checkAutoPause(bankroll, config.DRY_RUN);
    checkMilestoneInline();
  });

  // ── Periodic bankroll sync from Kalshi (live mode only) ──
  if (config.KALSHI_ENV === "production") {
    setInterval(async () => {
      // Only sync when trading live — paper mode uses the accumulator
      if (config.DRY_RUN) return;
      try {
        const balance = await kalshi.getBalance();
        const cashUsd = balance.balance / 100;
        const payoutUsd = (balance.payout ?? 0) / 100;
        const newBankroll = cashUsd + payoutUsd;
        if (Math.abs(newBankroll - bankroll) > 0.01) {
          console.log(`💰 Bankroll sync: $${bankroll.toFixed(2)} → $${newBankroll.toFixed(2)} (cash: $${cashUsd.toFixed(2)} + positions: $${payoutUsd.toFixed(2)})`);
          bankroll = newBankroll;
          updateCompoundState(bankroll);
          setBrainBankroll(bankroll); // V5: Brain needs bankroll for sizing
          checkAutoPause(bankroll, config.DRY_RUN); // Auto-pause check on sync
        }
        lastBankrollSyncAt = Date.now();
        // V6: Log bankroll snapshot for equity curve
        logBankrollSnapshot(bankroll, 0, openPositionCount);
      } catch (err: any) {
        console.error(`⚠️  Bankroll sync failed: ${err.message}`);
      }
    }, 60 * 1000);
    console.log(`💰 Bankroll sync loop armed (60s, ${config.DRY_RUN ? "paused in DRY_RUN" : "active"})`);
  }

  // V6: Daily growth target ratchet — check once per hour if a new day has started
  let lastGrowthDay = new Date().toISOString().slice(0, 10);
  setInterval(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastGrowthDay) {
      console.log(`📈 New day detected — evaluating growth target ratchet...`);
      evaluateAndRatchetTarget();
      lastGrowthDay = today;
      const gs = getGrowthTargetState();
      console.log(`📈 Growth target: ${gs.daily_target_pct.toFixed(0)}% daily | Hit rate: ${(gs.hit_rate * 100).toFixed(0)}% | Best day: ${((gs.best_day_mult - 1) * 100).toFixed(0)}%`);
      pushActivity("📈", `Daily target: +${gs.daily_target_pct.toFixed(0)}% | Progress: ${gs.progress_pct.toFixed(0)}%`);
    }
  }, 5 * 60 * 1000); // Check every 5 minutes

  await notifyStartup();
  const gs = getGrowthTargetState();
  pushActivity("🚀", `Bot started in ${config.DRY_RUN ? "PAPER" : "LIVE"} mode — $${bankroll.toFixed(2)} | Target: +${gs.daily_target_pct.toFixed(0)}%/day`);

  // ═══════════════════════════════════════════════════
  // STRATEGY 1: Hourly Close Sniper
  // ═══════════════════════════════════════════════════
  if (config.STRATEGY_CYCLE_SNIPER) {
    const runSniper = async () => {
      try {
        if (paused || !shouldFire("hourly_sniper")) return;
        // No regime gate — sniper should ALWAYS scan crypto markets regardless of regime
        const { ok, reason } = canTrade(bankroll, openPositionCount);
        if (!ok) return;

        const signals = await scanHourlySniper(kalshi, () => ({
          btc: getPrice("btcusdt")?.price,
          eth: getPrice("ethusdt")?.price,
          sol: getPrice("solusdt")?.price,
          xrp: getPrice("xrpusdt")?.price,
        }));

        logScanStart("hourly_sniper", signals.length);
        let _sniperTraded = 0;

        // Log turbo stats every scan if we have data
        const turboStats = getTurboStats();
        if (turboStats.total_trades > 0) {
          const sizeMultStr = getTurboSizeMultiplier().toFixed(2);
          const brain = getBrainStats();
          const brainStr = brain.trades > 0
            ? ` | 🧠 Brain: ${brain.trades}t ${(brain.winRate*100).toFixed(0)}%WR ${brain.pnl >= 0 ? '+' : ''}$${brain.pnl.toFixed(2)} peak:${(brain.peakWR*100).toFixed(0)}%`
            : "";
          console.log(`  📈 [Turbo] ${turboStats.total_trades} trades | WR: ${(turboStats.win_rate*100).toFixed(0)}% (recent: ${(turboStats.recent_win_rate*100).toFixed(0)}%) | PnL: $${turboStats.total_pnl.toFixed(2)} | streak: ${turboStats.streak > 0 ? '+' : ''}${turboStats.streak} | size: ${sizeMultStr}x${brainStr}`);
        }

        // V4 #8: Sort signals by EV (expected value) — take the best opportunities first
        const rankedSignals = [...signals].sort((a, b) => (b.ev_cents ?? 0) - (a.ev_cents ?? 0));

        for (const sig of rankedSignals.slice(0, 4)) {  // V4 #3: Take top 4 (multi-asset)
          telemetryEvaluated("hourly_sniper");

          // ── TURBO LEARNING: Skip assets that consistently lose ──
          // BUT: if TurboBrain approved this trade, trust the brain over legacy stats
          // The brain has its own loss pattern blocking that's smarter than blanket asset bans
          const sigAsset = sig.ticker.includes("BTC") ? "BTC" : sig.ticker.includes("ETH") ? "ETH" : sig.ticker.includes("SOL") ? "SOL" : sig.ticker.includes("XRP") ? "XRP" : "OTHER";
          const isBrainApproved = sig.reasoning.includes("[TurboBrain]");
          if (!isBrainApproved && shouldSkipAsset(sigAsset)) {
            console.log(`  🧊 [Turbo] Skipping ${sigAsset} — win rate too low (${(turboStats.by_asset[sigAsset]?.win_rate ?? 0 * 100).toFixed(0)}%)`);
            continue;
          }

          // ══════════════════════════════════════════════════
          // INTELLIGENCE LAYER 1: Regime-adaptive confidence gate
          // Require higher confidence in volatile markets, lower in trending
          // ══════════════════════════════════════════════════
          const { getCurrentRegime } = await import("./evolution/regime_detector.js");
          const regime = getCurrentRegime();
          let regimeConfidenceGate = 0.30; // Default
          let regimeLabel = "default";
          if (regime) {
            if (regime.regime === "VOLATILE") { regimeConfidenceGate = 0.50; regimeLabel = "VOLATILE"; }
            else if (regime.regime === "TRENDING_UP" || regime.regime === "TRENDING_DOWN") { regimeConfidenceGate = 0.22; regimeLabel = regime.regime; }
            else if (regime.regime === "QUIET") { regimeConfidenceGate = 0.30; regimeLabel = "QUIET"; }
            else if (regime.regime === "NEWS_DRIVEN") { regimeConfidenceGate = 0.45; regimeLabel = "NEWS"; }
          }
          if (sig.confidence < regimeConfidenceGate) {
            logRejectedSignal({ ticker: sig.ticker, strategy: "hourly_sniper", direction: sig.direction, edge: sig.potential_return_pct, confidence: sig.confidence, reject_reason: `regime_gate_${regimeLabel}`, market_question: sig.market_question, price: sig.contract_price });
            continue;
          }

          // ARCHIVED: Adverse selection filter (computeAdverseScore)
          let adverseMultiplier = 1.0;

          // ── Confluence scoring: boost confidence with multi-signal agreement ──
          const symbol = sig.ticker.toLowerCase().includes("btc") ? "btcusdt"
            : sig.ticker.toLowerCase().includes("eth") ? "ethusdt"
            : sig.ticker.toLowerCase().includes("sol") ? "solusdt"
            : sig.ticker.toLowerCase().includes("xrp") ? "xrpusdt"
            : null;
          let confluenceBoost = 1.0;
          if (symbol) {
            const confluence = scoreConfluence(symbol, sig.direction as "YES" | "NO", symbol.replace("usdt", "").toUpperCase());
            const normalizedScore = confluence.total_score / 10;
            if (normalizedScore > 0.6) {
              confluenceBoost = 1 + (normalizedScore - 0.6) * 0.5;
              console.log(`     🎯 Confluence: ${confluence.total_score.toFixed(1)}/10 (${confluence.signals_agreeing}/${confluence.signals_total} signals) → +${((confluenceBoost - 1) * 100).toFixed(0)}% size`);
            }
          }

          // ══════════════════════════════════════════════════
          // INTELLIGENCE LAYER 3: Bayesian strategy weight scaling
          // Hot strategies get 1.5x, cold get 0.3x, frozen = skip
          // ══════════════════════════════════════════════════
          const { applyWeightToSize } = await import("./evolution/strategy_weights.js");
          const turboMult = getTurboSizeMultiplier();
          const brainMult = sig.turbo_brain_size_multiplier ?? 1.0;  // TurboBrain asymmetric Kelly
          const rawSize = calculatePosition(sig.potential_return_pct, sig.contract_price, bankroll, "hourly_sniper", {
            confidence: sig.confidence,
            consecutive_wins: consecutiveWins,
          }) * confluenceBoost * adverseMultiplier * turboMult * brainMult;
          // V5: Hard max risk cap — no single trade should risk more than 10% of bankroll
          // The -$4.90 and -$6.39 losses were balance-killers
          const maxTradeSize = Math.max(1.0, bankroll * 0.10);
          const cappedSize = Math.min(rawSize, maxTradeSize);
          const size = applyWeightToSize("hourly_sniper", cappedSize);
          if (size < 0.50) {
            telemetrySizeMin("hourly_sniper");
            logRejectedSignal({ ticker: sig.ticker, strategy: "hourly_sniper", direction: sig.direction, edge: sig.potential_return_pct, confidence: sig.confidence, reject_reason: "size_too_small", market_question: sig.market_question, price: sig.contract_price });
            continue;
          }

          await executeTrade(kalshi, {
            strategy: "hourly_sniper",
            category: "crypto",
            question: sig.market_question,
            ticker: sig.ticker,
            direction: sig.direction,
            price: sig.contract_price,
            size,
            reasoning: sig.reasoning,
            edge: sig.potential_return_pct,
            confidence: sig.confidence,
            hypothesisName: "hourly_sniper_final_minutes",
          });
          telemetryTraded("hourly_sniper");

          // Record turbo entry for learning
          const isTurboTrade = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M"].some(p => sig.ticker.startsWith(p));
          if (isTurboTrade) {
            const { getCurrentRegime } = await import("./evolution/regime_detector.js");
            // V2: Store signal sources for post-trade analysis
            const brainSources = sig.reasoning.includes("[TurboBrain]")
              ? sig.reasoning.replace(/.*signals: /, "").slice(0, 100)
              : sig.reasoning.slice(0, 50);
            recordTurboEntry({
              ticker: sig.ticker,
              asset: sigAsset,
              direction: sig.direction,
              entry_price: sig.contract_price,
              momentum_signal: brainSources,
              regime: getCurrentRegime()?.regime ?? "UNKNOWN",
              confidence: sig.confidence,
            });
          }
          pushActivity("⚡", `Sniper trade: ${sig.ticker} ${sig.direction}`);
          _sniperTraded++;
        }
        // Count signals not taken as no_edge (filtered by strategy internally)
        if (signals.length === 0) telemetryNoEdge("hourly_sniper");
        logScanComplete("hourly_sniper");
      } catch {}
    };
    setInterval(runSniper, config.SNIPER_SCAN_INTERVAL_MS);
    console.log("⚡ Hourly close sniper armed (30s scan)");
  }

  // ═══════════════════════════════════════════════════
  // STRATEGY 2: Monotonicity Arb (risk-free!)
  // ═══════════════════════════════════════════════════
  if (config.STRATEGY_NEGRISK_ARB) {
    const runMonotonicity = async () => {
      try {
        if (paused || !shouldFire("monotonicity_arb")) return;
        const violations = await scanMonotonicityArb(kalshi);
        logScanStart("monotonicity_arb", violations.length);
        if (violations.length === 0) telemetryNoEdge("monotonicity_arb");
        for (const v of violations.slice(0, 3)) {
          telemetryEvaluated("monotonicity_arb");
          const edgePct = v.edge_cents / 100;
          const size = calculatePosition(edgePct, v.market_a.yes_ask / 100, bankroll, "monotonicity_arb", {
            confidence: 0.98, is_arb: true, consecutive_wins: consecutiveWins,
          });
          if (size < 0.50) { telemetrySizeMin("monotonicity_arb"); continue; }

          await executeTrade(kalshi, {
            strategy: "monotonicity_arb",
            category: "arb",
            question: `[Arb] ${v.market_a.question} vs ${v.market_b.question}`,
            ticker: v.market_a.ticker,
            direction: "YES",
            price: v.market_a.yes_ask / 100,
            size,
            reasoning: v.reasoning,
            edge: edgePct,
            confidence: 0.98,
            hypothesisName: "monotonicity_always_profitable",
          });
          telemetryTraded("monotonicity_arb");
          pushActivity("📐", `Arb found: ${v.market_a.ticker}`);
        }
        logScanComplete("monotonicity_arb");
      } catch (err: any) { console.error(`Monotonicity: ${err.message}`); }
    };
    setTimeout(runMonotonicity, 8000);
    setInterval(runMonotonicity, config.MONOTONICITY_SCAN_INTERVAL_MS);
    console.log("📐 Monotonicity arb scanner armed (45s scan)");
  }

  // ═══════════════════════════════════════════════════
  // STRATEGY 3: Council-Deliberated Mispricing
  //   V3.1: Bankroll-gated + cached + pre-filtered
  //   Below $100: skip council entirely (API cost > expected profit)
  //   Above $100: pre-filter → cache check → deliberate only high-value
  // ═══════════════════════════════════════════════════
  if (config.STRATEGY_MISPRICING) {
    // Clean expired cache entries every 15 min
    setInterval(() => cleanExpiredCache(), 15 * 60 * 1000);

    const runCouncil = async () => {
      try {
        if (paused || !shouldFire("mispricing")) return;
        const regime = getCurrentRegime();
        if (regime && regime.regime === "VOLATILE") { telemetryCouncilSkip("volatile_regime"); return; }
        const { ok, reason } = canTrade(bankroll, openPositionCount);
        if (!ok) { if (reason) console.log(`  🧠 Council skipped: ${reason}`); telemetryCouncilSkip(reason || "gate"); return; }

        // BANKROLL GATE: Council costs ~$0.07/deliberation (Haiku).
        // Even at $50 bankroll, a single winning trade can recoup dozens of deliberations.
        if (bankroll < 25) {
          telemetryCouncilSkip("bankroll_below_25");
          return; // Too small to justify any API costs
        }

        console.log("\n── 🧠 Cognitive Council ──");

        // Get odds movement + alpha signals
        const oddsMovements = getOddsMovementSignals(cachedMarkets);
        const hotMarkets = oddsMovements.filter(om => om.signal_strength === "strong" || om.signal_strength === "moderate");
        const triggered = getTriggeredAlphaMarkets();

        const now = Date.now();

        const MAX_HOURS_TO_EXPIRY = 24; // 24h max — maximize capital velocity for compounding
        const liquid = cachedMarkets.filter((m) => {
          if (m.yes_price <= 0.01 || m.yes_price >= 0.99) return false;
          if (m.end_date) {
            const expiryMs = new Date(m.end_date).getTime();
            if (expiryMs < now) return false;  // Already expired
            if ((expiryMs - now) / (1000 * 60 * 60) > MAX_HOURS_TO_EXPIRY) return false; // Too far out
          } else {
            return false; // No end_date = unknown duration, skip
          }
          return true;
        });

        // ── PRE-FILTER: Score markets by edge potential BEFORE spending on Claude ──
        // STRATEGY: Favor markets that resolve SOON (hours, not weeks).
        // Short-term markets = faster capital turnover = more compounding cycles.
        const alphaIds = new Set(triggered.map(t => t.market_id));
        const hotIds = new Set(hotMarkets.map(h => h.ticker));

        const scored = liquid.map(m => {
          let score = 0;

          // ── TIME-TO-EXPIRY BONUS: shorter = better ──
          if (m.end_date) {
            const hoursLeft = (new Date(m.end_date).getTime() - now) / (1000 * 60 * 60);
            if (hoursLeft <= 4) score += 30;        // Resolves in hours — huge bonus
            else if (hoursLeft <= 12) score += 25;   // Same day
            else if (hoursLeft <= 24) score += 20;   // Tomorrow
            else if (hoursLeft <= 48) score += 10;   // 2 days
            // 48-72h gets no bonus but is still allowed
          }

          // Alpha signal boost (+40 points)
          if (alphaIds.has(m.condition_id)) score += 40;

          // Odds movement boost (+25 points for strong, +15 moderate)
          const oddsHit = hotMarkets.find(h => h.ticker === m.condition_id);
          if (oddsHit) score += oddsHit.signal_strength === "strong" ? 25 : 15;

          // Price dislocation from 50% midpoint = higher potential edge
          const dislocation = Math.abs(m.yes_price - 0.5);
          if (dislocation > 0.10 && dislocation < 0.45) score += dislocation * 50;

          // Volume/liquidity bonus — liquid markets are tradeable
          if (m.volume > 10000) score += 15;
          else if (m.volume > 1000) score += 10;
          else if (m.volume > 100) score += 5;

          // Baseline score for any liquid market in tradeable range
          if (m.yes_price > 0.10 && m.yes_price < 0.90) score += 8;

          // Penalize extreme prices (near 0 or 1 = already resolved)
          if (m.yes_price < 0.05 || m.yes_price > 0.95) score -= 50;

          return { market: m, score };
        })
        .filter(s => s.score > 5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

        if (scored.length === 0) {
          console.log("  No markets passed pre-filter threshold");
          telemetryCouncilSkip("no_markets_passed_prefilter");
          return;
        }
        console.log(`  Pre-filter: ${scored.length}/${liquid.length} short-term markets qualify (scores: ${scored.map(s => s.score.toFixed(0)).join(", ")})`);

        for (const { market, score: preFilterScore } of scored) {
          await sleep(500); // Reduced from 2s — Haiku is fast and cheap
          try {
            // Log time to expiry for visibility
            const hoursLeft = market.end_date ? Math.max(0, (new Date(market.end_date).getTime() - Date.now()) / (1000 * 60 * 60)) : -1;
            const timeLabel = hoursLeft < 0 ? "unknown" : hoursLeft < 1 ? `${Math.round(hoursLeft * 60)}min` : hoursLeft < 24 ? `${hoursLeft.toFixed(1)}h` : `${(hoursLeft / 24).toFixed(1)}d`;

            const yesPrice = market.yes_price;
            const noPrice = market.no_price;

            const alpha = await getFusedAlpha(market.condition_id, market.question, market.yes_token_id, 5);

            if (alpha.execution && !alpha.execution.should_execute) {
              logRejectedSignal({ ticker: market.condition_id, strategy: "mispricing", direction: "SKIP", edge: 0, confidence: 0, reject_reason: `orderbook_rejected: ${alpha.execution.warnings.join(", ")}`, market_question: market.question, price: yesPrice });
              continue;
            }

            // ── CACHE CHECK: Don't re-analyze the same market at similar price ──
            const priceKey = `${Math.round(yesPrice * 20)}`; // Bucket by 5-cent increments
            const cached = getCachedVerdict(market.condition_id, priceKey);
            let verdict: any;

            if (cached) {
              verdict = cached;
              console.log(`  ⚡ Cache hit: ${market.question.slice(0, 50)}... (saved ~$0.30)`);
            } else {
              console.log(`  ⚖️  Council on: ${market.question.slice(0, 55)}... [${timeLabel}]`);
              verdict = await deliberate(market.question, market.description, yesPrice, noPrice, market.category, bankroll);
              // Cache for 30 min (longer for low-score markets, shorter for hot ones)
              const cacheTtl = preFilterScore > 30 ? 20 : 40;
              setCachedVerdict(market.condition_id, priceKey, verdict, cacheTtl);
            }

            latestVerdict = {
              question: market.question,
              verdict: verdict.verdict,
              direction: verdict.direction,
              agreement: verdict.council_agreement,
              edge: verdict.edge,
              crux: verdict.crux,
            };

            console.log(`     ${verdict.verdict} ${verdict.direction} | Agreement: ${(verdict.council_agreement * 100).toFixed(0)}% | Edge: ${(verdict.edge * 100).toFixed(1)}%`);

            if (!verdict.should_trade) {
              telemetryCouncilDeliberation(false);
              logRejectedSignal({ ticker: market.condition_id, strategy: "mispricing", direction: verdict.direction, edge: verdict.edge, confidence: verdict.confidence, reject_reason: "council_no_trade", market_question: market.question, price: yesPrice });
              councilConsecutivePasses++;
              if (councilConsecutivePasses >= 10 && councilIntervalMs < 10 * 60 * 1000) {
                councilIntervalMs = 10 * 60 * 1000;
                startCouncilTimer();
                console.log("  📉 Council slowed to 10m (10 consecutive passes)");
              }
              continue;
            }

            const price = verdict.direction === "YES" ? yesPrice : noPrice;

            const calibFactor = getCalibrationFactor("mispricing");
            let size = calculatePosition(Math.abs(verdict.edge), price, bankroll, "mispricing", {
              confidence: verdict.confidence,
              calibration_factor: calibFactor,
              consecutive_wins: consecutiveWins,
            });
            size *= verdict.size_multiplier;

            // Confirmation boosts
            if (alpha.combined_direction_hint === verdict.direction) {
              size *= 1.25;
              console.log(`     💪 Alpha confirms → +25% size`);
            }
            const oddsSignal = hotMarkets.find(h => h.ticker === market.condition_id);
            if (oddsSignal && oddsSignal.direction === verdict.direction) {
              size *= 1.15;
              console.log(`     📈 Smart money confirms → +15% size`);
            }

            if (alpha.execution) size = Math.min(size, alpha.execution.max_size_usd);
            if (size < 0.50) continue;

            for (const ns of alpha.news_signals) markActedOn(ns.news_id);

            telemetryCouncilDeliberation(true);
            councilConsecutivePasses = 0;
            if (councilIntervalMs > config.CLAUDE_SCAN_INTERVAL_MS) {
              councilIntervalMs = config.CLAUDE_SCAN_INTERVAL_MS;
              startCouncilTimer();
              console.log("  📈 Council reset to 5m (trade executed)");
            }
            await executeTrade(kalshi, {
              strategy: "mispricing",
              category: market.category,
              question: market.question,
              ticker: market.condition_id,
              direction: verdict.direction as "YES" | "NO",
              price, size,
              reasoning: verdict.judge_reasoning,
              edge: Math.abs(verdict.edge),
              confidence: verdict.confidence,
              councilVerdict: verdict,
              hypothesisName: verdict.council_agreement > 0.8 ? "council_unanimous_wins" : "mispricing_high_edge_wins",
              predicted_prob: verdict.direction === "YES" ? verdict.edge + yesPrice : 1 - noPrice - verdict.edge,
            });
          } catch (err: any) {
            console.error(`     Council error: ${err.message}`);
          }
        }
      } catch (err: any) { console.error(`Mispricing: ${err.message}`); }
    };
    const startCouncilTimer = () => {
      if (councilTimer) clearInterval(councilTimer);
      councilTimer = setInterval(runCouncil, councilIntervalMs);
    };
    setTimeout(runCouncil, 15000);
    startCouncilTimer();
    console.log("🧠 Council armed (bankroll-gated, cached, pre-filtered)");
  }

  // ═══════════════════════════════════════════════════
  // STRATEGY 4: Economic Release (FRED-powered)
  // ═══════════════════════════════════════════════════
  if (config.STRATEGY_ECONOMIC) {
    const runEconomic = async () => {
      try {
        if (paused) return;
        const { ok } = canTrade(bankroll, openPositionCount);
        if (!ok) return;

        const signals = await scanEconomicMarkets(kalshi);
        logScanStart("economic_release", signals.length);
        if (signals.length === 0) telemetryNoEdge("economic_release");

        if (signals.length > 0) {
          console.log(`\n📊 Economic: ${signals.length} FRED-powered signals`);
        }

        for (const sig of signals.slice(0, 2)) {
          telemetryEvaluated("economic_release");
          if (!meetsEdgeThreshold(sig.edge, bankroll, "economic_release")) {
            telemetryBelowThreshold("economic_release");
            logRejectedSignal({ ticker: sig.ticker, strategy: "economic_release", direction: sig.fred_implied_direction, edge: sig.edge, confidence: sig.confidence, reject_reason: "edge_below_threshold", market_question: sig.release_name, price: sig.market_implied_prob });
            continue;
          }

          const price = sig.fred_implied_direction === "YES" ? sig.market_implied_prob : 1 - sig.market_implied_prob;
          const size = calculatePosition(sig.edge, price, bankroll, "economic_release", {
            confidence: sig.confidence,
            consecutive_wins: consecutiveWins,
          });
          if (size < 0.50) { telemetrySizeMin("economic_release"); continue; }

          await executeTrade(kalshi, {
            strategy: "economic_release",
            category: sig.category,
            question: sig.release_name,
            ticker: sig.ticker,
            direction: sig.fred_implied_direction,
            price, size,
            reasoning: sig.reasoning,
            edge: sig.edge,
            confidence: sig.confidence,
            hypothesisName: "fred_data_edge",
          });
          telemetryTraded("economic_release");
        }
        logScanComplete("economic_release");
      } catch {}
    };
    setTimeout(runEconomic, 25000);
    setInterval(runEconomic, 300000); // Every 5 min
    console.log("📊 Economic release scanner armed (FRED-powered, 5m scan)");
  }

  // ═══════════════════════════════════════════════════
  // STRATEGY 5: Weather Edge (NWS-powered)
  // ═══════════════════════════════════════════════════
  if (config.STRATEGY_WEATHER) {
    const runWeather = async () => {
      try {
        if (paused) return;
        const { ok } = canTrade(bankroll, openPositionCount);
        if (!ok) return;

        const signals = await scanWeatherMarkets(kalshi);
        logScanStart("weather_edge", signals.length);
        if (signals.length === 0) telemetryNoEdge("weather_edge");

        if (signals.length > 0) {
          console.log(`\n🌤️ Weather: ${signals.length} NWS-powered signals`);
        }

        for (const sig of signals.slice(0, 2)) {
          telemetryEvaluated("weather_edge");
          if (Math.abs(sig.edge) < 0.08) { telemetryBelowThreshold("weather_edge"); continue; }

          const price = sig.direction === "YES" ? sig.market_implied_prob : 1 - sig.market_implied_prob;
          const size = calculatePosition(Math.abs(sig.edge), price, bankroll, "weather_edge", {
            confidence: sig.confidence,
            consecutive_wins: consecutiveWins,
          });
          if (size < 0.50) { telemetrySizeMin("weather_edge"); continue; }

          await executeTrade(kalshi, {
            strategy: "weather_edge",
            category: "weather",
            question: sig.question,
            ticker: sig.ticker,
            direction: sig.direction,
            price, size,
            reasoning: sig.reasoning,
            edge: Math.abs(sig.edge),
            confidence: sig.confidence,
            hypothesisName: "nws_forecast_edge",
          });
          telemetryTraded("weather_edge");
        }
        logScanComplete("weather_edge");
      } catch {}
    };
    setTimeout(runWeather, 30000);
    setInterval(runWeather, 600000); // Every 10 min
    console.log("🌤️ Weather edge scanner armed (NWS-powered, 10m scan)");
  }

  // ═══════════════════════════════════════════════════
  // STRATEGY 6: Cross-Platform Divergence
  // ═══════════════════════════════════════════════════
  {
    const runCrossPlatform = async () => {
      try {
        if (paused) return;
        const divergences = await scanCrossPlatformDivergences(kalshi);
        logScanStart("cross_platform", divergences.length);
        if (divergences.length === 0) telemetryNoEdge("cross_platform");
        for (const d of divergences.slice(0, 2)) {
          telemetryEvaluated("cross_platform");
          const { ok } = canTrade(bankroll, openPositionCount);
          if (!ok) { telemetryBlocked("cross_platform"); break; }

          const price = d.trade_direction === "YES" ? d.kalshi_yes_price : (1 - d.kalshi_yes_price);
          const size = calculatePosition(Math.abs(d.divergence), price, bankroll, "cross_platform", {
            confidence: d.confidence,
            consecutive_wins: consecutiveWins,
          });
          if (size < 0.50) { telemetrySizeMin("cross_platform"); continue; }

          await executeTrade(kalshi, {
            strategy: "cross_platform",
            category: "arb",
            question: `[XPlat] ${d.polymarket_question}`,
            ticker: d.kalshi_ticker,
            direction: d.trade_direction,
            price, size,
            reasoning: d.reasoning,
            edge: Math.abs(d.divergence),
            confidence: d.confidence,
            hypothesisName: "cross_platform_convergence",
          });
          telemetryTraded("cross_platform");
        }
        logScanComplete("cross_platform");
      } catch {}
    };
    setTimeout(runCrossPlatform, 20000);
    setInterval(runCrossPlatform, config.CROSS_PLATFORM_SCAN_INTERVAL_MS);
    console.log("🌐 Cross-platform divergence scanner armed (3m scan)");
  }

  // ═══════════════════════════════════════════════════
  // STRATEGY 7: Market Maker (spread capture)
  // ═══════════════════════════════════════════════════
  if (config.STRATEGY_MARKET_MAKER && !getPhaseParams(bankroll).aggressive) {
    // Only market-make when bankroll > $100 (not in beast mode)
    const runMarketMaker = async () => {
      try {
        if (paused) return;
        if (bankroll < 100) return; // Need enough capital to post both sides

        const opportunities = await findMarketMakingOpportunities(kalshi, bankroll);
        if (opportunities.length > 0) {
          console.log(`\n💹 Market Maker: ${opportunities.length} wide-spread markets`);
        }

        for (const opp of opportunities.slice(0, 2)) {
          if (!config.DRY_RUN) {
            await placeMarketMakerOrders(kalshi, opp, bankroll);
          }
          console.log(`  💹 Posted ${opp.ticker}: bid ${opp.yes_bid_price}¢ / ask ${opp.yes_ask_price}¢ (spread: ${opp.spread_cents}¢)`);
        }

        // Manage existing inventory
        await manageInventory(kalshi, bankroll);
      } catch {}
    };
    setTimeout(runMarketMaker, 35000);
    setInterval(runMarketMaker, config.MARKET_MAKER_REFRESH_MS);
    console.log("💹 Market maker armed (wide spreads, 2m refresh)");
  }

  // ═══════════════════════════════════════════════════
  // STRATEGY 8: High-Confidence Near-Close (85-94¢)
  // ═══════════════════════════════════════════════════
  // Research-backed: buy near-certain outcomes closing soon.
  // Zero API cost, high win rate, rapid turnover.
  if (config.STRATEGY_HIGH_CONFIDENCE) {
    let hcTradesToday = 0;
    let hcLastResetDay = new Date().getUTCDate();

    const runHighConfidence = async () => {
      try {
        if (paused) return;
        const { ok } = canTrade(bankroll, openPositionCount);
        if (!ok) return;

        // Reset daily counter
        const today = new Date().getUTCDate();
        if (today !== hcLastResetDay) { hcTradesToday = 0; hcLastResetDay = today; }
        if (hcTradesToday >= config.HIGH_CONFIDENCE_MAX_TRADES) return;

        const signals = await scanHighConfidence(kalshi, cachedMarkets);
        logScanStart("high_confidence", signals.length);
        if (signals.length === 0) { telemetryNoEdge("high_confidence"); return; }

        for (const sig of signals.slice(0, 2)) {
          if (hcTradesToday >= config.HIGH_CONFIDENCE_MAX_TRADES) break;
          telemetryEvaluated("high_confidence");

          // Fixed small position size — these are low-edge high-probability trades
          const size = Math.min(bankroll * 0.08, 5); // $5 max or 8% of bankroll
          if (size < 0.50) { telemetrySizeMin("high_confidence"); continue; }

          await executeTrade(kalshi, {
            strategy: "high_confidence",
            category: "high_confidence",
            question: sig.question,
            ticker: sig.ticker,
            direction: sig.direction,
            price: sig.price,
            size,
            reasoning: sig.reasoning,
            edge: sig.expected_profit_pct,
            confidence: sig.confidence,
            hypothesisName: "high_confidence_near_close",
          });
          telemetryTraded("high_confidence");
          pushActivity("🎯", `High-conf: ${sig.ticker} ${sig.direction} @ ${(sig.price * 100).toFixed(0)}¢`);
          hcTradesToday++;
        }
        logScanComplete("high_confidence");
      } catch {}
    };
    setTimeout(runHighConfidence, 5000);
    setInterval(runHighConfidence, config.HIGH_CONFIDENCE_SCAN_INTERVAL_MS);
    console.log("🎯 High-confidence near-close scanner armed (1m scan, 85-94¢)");
  }

  // ARCHIVED: Strategy 9 Multi-Model Ensemble — restore when bankroll > $500

  // ═══════════════════════════════════════════════════
  // ODDS MOVEMENT SCANNER (background signal)
  // ═══════════════════════════════════════════════════
  {
    const runOddsCheck = async () => {
      try {
        const movements = getOddsMovementSignals(cachedMarkets);
        const strong = movements.filter(m => m.signal_strength === "strong");
        if (strong.length > 0) {
          console.log(`\n📈 ODDS ALERT: ${strong.length} markets with strong price movement`);
          for (const s of strong.slice(0, 3)) {
            console.log(`  📈 ${s.ticker}: ${s.velocity_1h > 0 ? "+" : ""}${s.velocity_1h.toFixed(1)}¢/hr → ${s.direction} (${s.reasoning})`);
          }
        }
      } catch {}
    };
    setInterval(runOddsCheck, 120000);  // Check every 2 min
    console.log("📈 Odds movement detector armed (2m check)");
  }

  // ═══════════════════════════════════════════════════
  // ADAPTIVE OPTIMIZATION (every 30 min)
  // Analyzes trade history and adjusts parameters
  // ═══════════════════════════════════════════════════
  setInterval(() => {
    try {
      const optimal = getOptimalParameters();
      if (optimal.sample_size > 0) {
        console.log(`  🧬 Adaptive optimizer: confidence=${optimal.optimal_confidence_threshold.toFixed(2)}, confluence=${optimal.optimal_min_confluence}, max_pos=${optimal.optimal_max_positions}, sample=${optimal.sample_size}`);
      }
    } catch {}
  }, 30 * 60 * 1000);
  console.log("🧬 Adaptive optimizer armed (30m analysis cycle)");

  // ═══════════════════════════════════════════════════
  // STALE PRICE SNIPING (piggybacks on sniper interval)
  // Detects when Kalshi prices lag behind Binance moves
  // ═══════════════════════════════════════════════════
  {
    const runStaleSniper = async () => {
      try {
        if (paused) return;
        const { ok } = canTrade(bankroll, openPositionCount);
        if (!ok) return;

        for (const sym of ["btcusdt", "ethusdt", "solusdt", "xrpusdt"]) {
          const asset = sym.replace("usdt", "").toUpperCase();
          const turboPrefix = `KX${asset}15M`;
          const nearbyMarkets = cachedMarkets.filter(m =>
            m.condition_id.startsWith(turboPrefix) &&
            m.yes_price > 0.10 && m.yes_price < 0.90
          );

          for (const m of nearbyMarkets.slice(0, 3)) {
            // Estimate minutes remaining from end_date
            const minutesLeft = m.end_date
              ? Math.max(0, (new Date(m.end_date).getTime() - Date.now()) / 60000)
              : 15;
            if (minutesLeft <= 0 || minutesLeft > 60) continue;

            // Extract strike price from ticker (e.g., KXBTC15M-25APR11-100000-T1234)
            const strikeMatch = m.condition_id.match(/(\d{4,})-T/);
            const strikePrice = strikeMatch ? parseFloat(strikeMatch[1]) : 0;
            if (strikePrice <= 0) continue;

            const stale = detectStalePrice(m.yes_price, 1 - m.yes_price, strikePrice, asset, minutesLeft);
            if (stale && stale.confidence > 0.55) {
              const price = stale.direction === "YES" ? m.yes_price : (1 - m.yes_price);
              const size = calculatePosition(stale.divergence_pct / 100, price, bankroll, "hourly_sniper", {
                confidence: stale.confidence,
                consecutive_wins: consecutiveWins,
              });
              if (size < 0.50) continue;

              await executeTrade(kalshi, {
                strategy: "hourly_sniper",
                category: "crypto",
                question: m.question ?? m.condition_id,
                ticker: m.condition_id,
                direction: stale.direction,
                price,
                size,
                reasoning: `Stale price: Binance=${stale.binance_price}, Kalshi implied=${stale.kalshi_implied_price}, divergence=${stale.divergence_pct.toFixed(1)}%`,
                edge: stale.divergence_pct / 100,
                confidence: stale.confidence,
                hypothesisName: "stale_price_snipe",
              });
              pushActivity("🎯", `Stale price snipe: ${m.condition_id} ${stale.direction}`);
            }
          }
        }
      } catch {}
    };
    setInterval(runStaleSniper, 20000); // Every 20s
    console.log("🎯 Stale price sniper armed (20s scan)");
  }

  console.log(`\n✅ ALL 14 SYSTEMS LIVE`);
  console.log(`📱 Dashboard: http://localhost:${dashboardPort}`);
  console.log(`🎯 Goal: $${bankroll.toFixed(2)} → $10,000+ via aggressive compounding\n`);

  // Print compound growth projections
  const { getCompoundingProjection } = await import("./core/aggressive_kelly.js");
  const projections = getCompoundingProjection(bankroll, 0.08, 10, 30); // 8% edge, 10 trades/day, 30 days
  console.log("  📊 Growth projections (8% avg edge, 10 trades/day):");
  console.log(`     Day 7:  $${projections[7]?.toFixed(2) ?? "N/A"}`);
  console.log(`     Day 14: $${projections[14]?.toFixed(2) ?? "N/A"}`);
  console.log(`     Day 30: $${projections[30]?.toFixed(2) ?? "N/A"}\n`);
}

// ═══════════════════════════════════════════════════
// EXECUTION ENGINE
// ═══════════════════════════════════════════════════

async function executeTrade(kalshi: KalshiClient, params: {
  strategy: string; category: string;
  question: string; ticker: string;
  direction: "YES" | "NO"; price: number; size: number;
  reasoning: string; edge: number; confidence: number;
  councilVerdict?: any;
  hypothesisName?: string;
  predicted_prob?: number;
}) {
  // ── Turbo-only mode: block all non-turbo trades ──
  const TURBO_PREFIXES = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M"];
  if (config.TURBO_ONLY_MODE) {
    const isTurbo = TURBO_PREFIXES.some(p => params.ticker.startsWith(p));
    if (!isTurbo) {
      console.log(`  🚫 Turbo-only mode: blocked ${params.strategy} on ${params.ticker.slice(0, 30)}`);
      return;
    }
  }

  const signalId = genSignalId(params.strategy);
  const tag = ({
    hourly_sniper: "⚡", monotonicity_arb: "📐", mispricing: "🧠",
    cross_platform: "🌐", economic_release: "📊", weather_edge: "🌤️",
    market_maker: "💹",
  } as any)[params.strategy] ?? "📊";
  const w = getWeight(params.strategy);
  const phase = getPhaseParams(bankroll);

  // ── Circuit Breaker: stop trading after consecutive losses ──
  const cb = canTradeCircuitBreaker();
  if (!cb.ok) {
    console.log(`  🛑 Circuit breaker: ${cb.reason}`);
    return;
  }
  if (cb.size_multiplier < 1) {
    params.size *= cb.size_multiplier;
    console.log(`  ⚠️ Circuit breaker: size reduced to ${(cb.size_multiplier * 100).toFixed(0)}%`);
  }

  // ── Time-of-Day profiling: adjust confidence based on historical win rate by hour ──
  const timeAdvice = getTimeAdvice();
  if (!timeAdvice.should_trade) {
    console.log(`  🕐 Time filter: ${timeAdvice.reason}`);
    return;
  }
  if (timeAdvice.confidence_multiplier !== 1.0) {
    params.size *= timeAdvice.confidence_multiplier;
  }

  // ── Correlation discount: reduce size for correlated positions ──
  const positions = getOpenPositions();
  const openPosForCorr = positions.map((p: any) => ({
    asset: p.ticker,
    direction: p.side,
    size_usd: p.size_usd ?? 1,
  }));
  const corrDiscount = correlationDiscount(params.ticker, params.direction, openPosForCorr);
  if (corrDiscount < 1) {
    params.size *= corrDiscount;
    console.log(`  🔗 Correlation discount: ${(corrDiscount * 100).toFixed(0)}% (correlated with open positions)`);
  }

  console.log(`  ${config.DRY_RUN ? "🧪" : "🔴"}${tag} ${params.direction} $${params.size.toFixed(2)} @ $${params.price.toFixed(2)} [${params.strategy} w:${w?.weight.toFixed(2) ?? "1.00"} | ${phase.label}]`);

  recordSignal({
    signal_id: signalId, strategy: params.strategy,
    asset: null, category: params.category,
    hour_of_day: new Date().getUTCHours(), day_of_week: new Date().getUTCDay(),
    confidence: params.confidence, predicted_edge: params.edge,
    position_size: params.size, market_volatility: 0, bankroll_at_entry: bankroll,
  });

  registerDecision({
    signalId, marketQuestion: params.question,
    yesPrice: params.price, noPrice: 1 - params.price,
    direction: params.direction, size: params.size,
    strategy: params.strategy, bankroll,
    confidence: params.confidence, verdict: params.councilVerdict,
  });

  // ARCHIVED: compound engine unlock/cap and velocity engine tranche allocation

  let result: any;
  const count = Math.max(1, Math.floor(params.size / params.price));

  // Kill-switch: abort live order placement if operator has touched the STOP file.
  // Open positions are still managed by position_manager; this only blocks new entries.
  if (!config.DRY_RUN && isKillSwitchActive()) {
    console.log(`  🛑 KILL-SWITCH ACTIVE — refusing live order on ${params.ticker}. Remove ${killSwitchPath()} to resume.`);
    pushActivity("🛑", `Kill-switch blocked ${params.direction} ${params.ticker} ($${params.size.toFixed(2)})`);
    return;
  }

  if (config.DRY_RUN) {
    result = { status: "dry_run", ticker: params.ticker, direction: params.direction, size: params.size };
  } else {
    // Use limit orders at current price — fills immediately if liquidity exists
    // post_only removed: it caused "post only cross" rejections on every trade
    // because our limit price equals the current ask (we WANT to cross the spread)
    result = await kalshi.placeOrder({
      ticker: params.ticker,
      side: params.direction === "YES" ? "yes" : "no",
      action: "buy",
      type: "limit",
      count,
      yes_price: params.direction === "YES" ? Math.floor(params.price * 100) : undefined,
      no_price: params.direction === "NO" ? Math.floor(params.price * 100) : undefined,
      client_order_id: signalId,
    });
  }

  logTrade({
    market_question: params.question, condition_id: params.ticker,
    token_id: `${params.ticker}-${params.direction.toLowerCase()}`,
    strategy: params.strategy,
    side: params.direction, price: params.price, size: params.size, cost: params.size,
    dry_run: config.DRY_RUN, order_response: JSON.stringify(result),
  });

  // Track open position for exit management
  openPosition({
    ticker: params.ticker,
    order_id: result?.order?.order_id ?? signalId,
    side: params.direction,
    entry_price: Math.round(params.price * 100),  // Store in cents to match position_manager
    contracts: count,
    size_usd: params.size,
    strategy: params.strategy,
    predicted_prob: params.predicted_prob,
    market_question: params.question,
  });

  totalTrades++;
  openPositionCount++;

  // DRY_RUN simulation — for turbo markets, wait actual 15 min, then check real price
  if (config.DRY_RUN) {
    const isTurbo = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M"].some(p => (params.ticker || "").startsWith(p));
    // Capture Binance entry price for real-data resolution
    const turboAsset = (params.ticker || "").includes("BTC") ? "btcusdt"
      : (params.ticker || "").includes("ETH") ? "ethusdt"
      : (params.ticker || "").includes("SOL") ? "solusdt"
      : "xrpusdt";
    const enrichedParams = { ...params, _entryBinancePrice: getPrice(turboAsset) };
    const holdMs = isTurbo
      ? 15 * 60 * 1000 + 10 * 1000 // 15 min + 10s buffer (wait for actual settlement)
      : 60 * 1000 + Math.random() * 120 * 1000; // Non-turbo: 1-3 min
    setTimeout(() => simulateResolution(signalId, enrichedParams), holdMs);
  }

  await notifyTrade({
    market_question: params.question, direction: params.direction,
    edge: params.edge, confidence: params.confidence > 0.5 ? "high" : "medium",
    final_reasoning: params.reasoning, yes_price: params.price,
  } as any, params.size, config.DRY_RUN);
}

function simulateResolution(signalId: string, params: any) {
  // For turbo markets: use actual Binance price to determine outcome
  // For others: fall back to calibrated simulation
  const isTurbo = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M"].some(p => (params.ticker || "").startsWith(p));
  let won: boolean;
  let pnl: number;

  if (isTurbo) {
    // Real-data paper resolution: check actual Binance price movement
    const turboAsset = (params.ticker || "").includes("BTC") ? "btcusdt"
      : (params.ticker || "").includes("ETH") ? "ethusdt"
      : (params.ticker || "").includes("SOL") ? "solusdt"
      : "xrpusdt";
    const currentPrice = getPrice(turboAsset) ?? 0;
    // Approximate: use entry price stored at trade time vs current price
    const entryPrice = params._entryBinancePrice ?? currentPrice;
    const priceWentUp = currentPrice > entryPrice;
    // Turbo markets settle YES if price is above strike
    // Bot bets YES if it thinks price goes up, NO if down
    const betOnUp = params.direction === "YES";
    won = (betOnUp && priceWentUp) || (!betOnUp && !priceWentUp);
    // Realistic PnL: binary contract payout
    const entryPriceCents = Math.round(params.price * 100);
    pnl = won
      ? params.size * ((100 - entryPriceCents) / entryPriceCents) // win: payout ratio
      : -params.size; // loss: full cost (binary option)
  } else {
    // Non-turbo: calibrated simulation (legacy)
    const winProbs: Record<string, number> = {
      hourly_sniper: 0.65, // Lowered from 0.82 to be realistic
      monotonicity_arb: 0.90,
      mispricing: 0.55,
      cross_platform: 0.58,
    };
    const winProb = winProbs[params.strategy] ?? 0.50;
    won = Math.random() < winProb;
    pnl = won
      ? params.size * (params.edge || 0.05) * (0.6 + Math.random() * 0.4)
      : -params.size * (0.3 + Math.random() * 0.4);
  }

  if (config.DRY_RUN) {
    bankroll += pnl; // paper trading accumulator
  }
  // Note: in live mode, the next sync loop cycle will update bankroll from Kalshi
  openPositionCount = Math.max(0, openPositionCount - 1);
  updateCompoundState(bankroll);
  recordStrategyYield(params.strategy, pnl);
  velocityReleaseTranche(signalId, pnl);

  // ── Genius layer feedback ──
  recordTradeResult(won);  // Circuit breaker tracking
  recordTimeProfile(new Date().getUTCHours(), won, pnl);  // Time-of-day profiling
  recordSignalOutcome({  // Signal backtesting
    strategy: params.strategy,
    ticker: params.ticker,
    direction: params.direction,
    confidence: params.confidence,
    confluence_score: 0,
    regime: getCurrentRegime()?.regime ?? "unknown",
    hour_utc: new Date().getUTCHours(),
    traded: true,
    won,
    pnl,
  });

  // ARCHIVED: tax lot tracking

  if (won) {
    consecutiveWins++;
  } else {
    consecutiveWins = 0;
  }

  reflexLoop({
    signalId, strategy: params.strategy, asset: null, category: params.category,
    won, pnl,
    narrative: `${params.strategy} ${params.direction} at $${params.price.toFixed(2)} $${params.size.toFixed(2)}`,
    context: { edge: params.edge, confidence: params.confidence, regime: getCurrentRegime()?.regime },
  });

  retrospect({
    signalId, strategyName: params.strategy,
    hypothesisName: params.hypothesisName,
    won, pnl,
    marketResolvedYES: (params.direction === "YES" && won) || (params.direction === "NO" && !won),
  });

  const emoji = won ? "✅" : "❌";
  const streak = consecutiveWins > 2 ? ` 🔥×${consecutiveWins}` : "";
  console.log(`     ${emoji} ${params.strategy} ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | $${bankroll.toFixed(2)}${streak}`);

  checkMilestoneInline();
}

function checkMilestoneInline() {
  if (bankroll >= nextMilestone) {
    const daysFromStart = (Date.now() - startTime) / (1000 * 60 * 60 * 24);
    logMilestone(nextMilestone, bankroll, totalTrades, daysFromStart, {});
    notifyMilestone(nextMilestone, bankroll, totalTrades);
    nextMilestone = config.MILESTONES.find(m => m > bankroll) ?? nextMilestone * 2;
  }

  // ARCHIVED: auto-withdrawal check
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
