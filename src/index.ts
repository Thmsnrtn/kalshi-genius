// src/index.ts — KALSHI EDITION
//
// COMPLETE ARCHITECTURE:
//
// Layer 1: STRATEGIES       (what to trade — Kalshi-native)
// Layer 2: EVOLUTION        (learn what works)
// Layer 3: GENIUS           (think deeply)
// Layer 4: META             (self-critique)
// Layer 5: ALPHA SOURCES    (information edge from news/whales/orderbook)
// Layer 6: DASHBOARD        (phone-first monitoring)

import { config, getPhaseParams } from "./core/config.js";
import { calculatePosition, canTrade, meetsEdgeThreshold } from "./core/risk.js";
import { getDb, logTrade } from "./core/db.js";
import { notifyStartup, notifyTrade } from "./core/notify.js";
import { startPriceFeed, getPrice } from "./feeds/binance.js";

// KALSHI EXCHANGE
import { KalshiClient, kalshiMarketToUnified } from "./exchanges/kalshi/kalshi_client.js";
import { KalshiWebSocket } from "./exchanges/kalshi/kalshi_websocket.js";

// KALSHI STRATEGIES
import {
  scanHourlySniper,
  scanMonotonicityArb,
  findEconomicEvents,
  scanCrossPlatformDivergences,
} from "./strategies/kalshi/kalshi_strategies.js";

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

// DASHBOARD
import { startDashboard, setBotState } from "./dashboard/server.js";

// Global state
let bankroll = config.STARTING_BANKROLL;
const STARTING_BANKROLL = bankroll;
let openPositions = 0;
let totalTrades = 0;
let signalCounter = 0;
let paused = false;
const startTime = Date.now();
let latestVerdict: any = null;
let cachedMarkets: any[] = [];

const genSignalId = (s: string) => `${s}-${Date.now()}-${++signalCounter}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🧠 KALSHI GENIUS — 6-Layer Cognitive Architecture         ║
╠════════════════════════════════════════════════════════════╣
║  Strategies × Evolution × Genius × Meta × Alpha × Monitor  ║
╚════════════════════════════════════════════════════════════╝`);

  console.log(`  Mode:      ${config.DRY_RUN ? "🧪 PAPER" : "🔴 LIVE"}`);
  console.log(`  Exchange:  Kalshi (${config.KALSHI_ENV})`);
  console.log(`  Bankroll:  $${bankroll.toFixed(2)}`);
  console.log(`  Phase:     ${getPhaseParams(bankroll).label}`);

  console.log("\n  ARCHITECTURE:");
  console.log("  1️⃣  STRATEGIES    → ⚡ hourly sniper, 📐 monotonicity arb, 🧠 council, 📊 economic, 🌐 cross-platform");
  console.log("  2️⃣  EVOLUTION     → 5 loops (reflex → omega)");
  console.log("  3️⃣  GENIUS        → council, counterfactuals, hypotheses, genetics, calibration");
  console.log("  4️⃣  META          → strategy breeding, prompt evolution");
  console.log("  5️⃣  ALPHA SOURCES → 📰 news, 🐋 whales, 📊 orderbook");
  console.log("  6️⃣  DASHBOARD     → phone-first monitoring\n");

  if (!config.ANTHROPIC_API_KEY) { console.error("❌ ANTHROPIC_API_KEY required"); process.exit(1); }
  if (!config.KALSHI_API_KEY_ID) { console.error("❌ KALSHI_API_KEY_ID required"); process.exit(1); }

  // ── Initialize Kalshi client ──
  const kalshi = new KalshiClient({
    environment: config.KALSHI_ENV,
    apiKeyId: config.KALSHI_API_KEY_ID,
    privateKeyPath: config.KALSHI_PRIVATE_KEY_PATH,
  });

  // Validate connection
  try {
    const balance = await kalshi.getBalance();
    console.log(`✅ Kalshi connected (${config.KALSHI_ENV}) — Balance: $${(balance.balance / 100).toFixed(2)}`);
  } catch (err: any) {
    console.error(`❌ Kalshi connection failed: ${err.message}`);
    process.exit(1);
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

  // Initialize all layers
  getDb();
  initPerformanceTracker();
  initStrategyWeights();
  initMemory();
  initPromptEvolution();
  initGenius();
  registerBaseHypotheses();
  initAlphaSources();
  console.log("✅ All layers initialized\n");

  // Expose state to dashboard
  setBotState({
    getBankroll: () => bankroll,
    getStartingBankroll: () => STARTING_BANKROLL,
    getOpenPositions: () => openPositions,
    getStartTime: () => startTime,
    isPaused: () => paused,
    setPaused: (p) => { paused = p; console.log(p ? "⏸  Bot paused" : "▶  Bot resumed"); },
    getLatestVerdict: () => latestVerdict,
  });

  // Start dashboard server
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT ?? "3000");
  startDashboard(dashboardPort);

  // Start Binance price feed (used by hourly sniper for live BTC/ETH prices)
  startPriceFeed();
  await sleep(3000);

  // Cache active Kalshi markets
  const refreshMarkets = async () => {
    try {
      const { markets } = await kalshi.getMarkets({ limit: 200 });
      cachedMarkets = markets.map(kalshiMarketToUnified);
    } catch {}
  };
  await refreshMarkets();
  setInterval(refreshMarkets, 60 * 1000);

  // Subscribe to ticker updates for top markets
  if (kalshiWs) {
    const topTickers = cachedMarkets.slice(0, 20).map((m) => m.condition_id);
    if (topTickers.length > 0) {
      kalshiWs.subscribe("ticker", topTickers);
      kalshiWs.subscribe("orderbook_delta", topTickers);
    }
  }

  // Engage all learning loops
  startEvolutionLoops(() => bankroll, STARTING_BANKROLL);
  startGeniusLoops();
  startAlphaSources(() => cachedMarkets.map((m) => m.question).slice(0, 30));

  await notifyStartup();

  // ═══ Strategy 1: Hourly Close Sniper ═══
  if (config.STRATEGY_CYCLE_SNIPER) {
    const runSniper = async () => {
      try {
        if (paused || !shouldFire("hourly_sniper")) return;
        const regime = getCurrentRegime();
        if (regime && (regime.regime === "DEAD" || regime.regime === "VOLATILE")) return;
        const { ok } = canTrade(bankroll, openPositions);
        if (!ok) return;

        const signals = await scanHourlySniper(kalshi, () => ({
          btc: getPrice("btcusdt")?.price,
          eth: getPrice("ethusdt")?.price,
          sol: getPrice("solusdt")?.price,
        }));

        for (const sig of signals.slice(0, 1)) {
          const phase = getPhaseParams(bankroll);
          let size = bankroll * phase.kelly * sig.confidence * 0.5;
          size = applyWeightToSize("hourly_sniper", size);
          if (regime) size *= regime.recommended_aggression;
          if (size < 0.5) continue;

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
        }
      } catch {}
    };
    setInterval(runSniper, config.SNIPER_SCAN_INTERVAL_MS);
    console.log("⚡ Hourly close sniper armed");
  }

  // ═══ Strategy 2: Monotonicity Arb ═══
  if (config.STRATEGY_NEGRISK_ARB) {
    const runMonotonicity = async () => {
      try {
        if (paused || !shouldFire("monotonicity_arb")) return;
        const violations = await scanMonotonicityArb(kalshi);
        for (const v of violations.slice(0, 3)) {
          const edgePct = v.edge_cents / 100;
          const baseSize = calculatePosition(edgePct, v.market_a.yes_ask / 100, bankroll, "monotonicity_arb");
          const size = applyWeightToSize("monotonicity_arb", baseSize);
          if (size < 1) continue;

          // Buy the cheaper higher-strike YES
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
            confidence: 0.95,
            hypothesisName: "monotonicity_always_profitable",
          });
        }
      } catch (err: any) { console.error(`Monotonicity: ${err.message}`); }
    };
    setTimeout(runMonotonicity, 8000);
    setInterval(runMonotonicity, config.MONOTONICITY_SCAN_INTERVAL_MS);
    console.log("📐 Monotonicity arb scanner armed");
  }

  // ═══ Strategy 3: Council-Deliberated Mispricing (alpha-aware) ═══
  if (config.STRATEGY_MISPRICING) {
    const runCouncil = async () => {
      try {
        if (paused || !shouldFire("mispricing")) return;
        const regime = getCurrentRegime();
        if (regime && regime.regime === "VOLATILE") return;
        const { ok } = canTrade(bankroll, openPositions);
        if (!ok) return;

        console.log("\n── 🧠 Cognitive Council (alpha-aware) ──");

        const triggered = getTriggeredAlphaMarkets();
        if (triggered.length > 0) {
          console.log(`  🎯 ${triggered.length} markets with alpha signals`);
        }

        const liquid = cachedMarkets.filter((m) => m.yes_price > 0.01 && m.yes_price < 0.99);
        const toAnalyze = [
          ...liquid.filter((m) => triggered.some((t) => m.condition_id === t.market_id || m.question.slice(0, 30) === t.market_id.slice(0, 30))),
          ...liquid.filter((m) => !triggered.some((t) => m.condition_id === t.market_id)),
        ].slice(0, 3);

        for (const market of toAnalyze) {
          await sleep(3000);
          try {
            const yesPrice = market.yes_price;
            const noPrice = market.no_price;
            const yesTokenId = market.yes_token_id;
            const noTokenId = market.no_token_id;

            // Fuse alpha sources
            const alpha = await getFusedAlpha(market.condition_id, market.question, yesTokenId, 5);

            if (alpha.news_signals.length > 0) {
              console.log(`  📰 ${alpha.news_signals.length} news signals: ${alpha.news_signals[0].reasoning.slice(0, 80)}`);
            }
            if (alpha.whale_convergence) {
              console.log(`  🐋 ${alpha.whale_convergence.whale_count} whales on ${alpha.whale_convergence.direction}`);
            }
            if (alpha.microstructure_signal) {
              console.log(`  📊 ${alpha.microstructure_signal.signal_type}: ${alpha.microstructure_signal.reasoning}`);
            }
            if (alpha.execution && !alpha.execution.should_execute) {
              console.log(`  ⛔ Orderbook rejected: ${alpha.execution.warnings.join(", ")}`);
              continue;
            }

            console.log(`  ⚖️  Council on: ${market.question.slice(0, 60)}...`);
            const verdict = await deliberate(market.question, market.description, yesPrice, noPrice, market.category, bankroll);

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
              console.log(`     ⏭️  PASS`);
              continue;
            }

            const price = verdict.direction === "YES" ? yesPrice : noPrice;
            const baseSize = calculatePosition(Math.abs(verdict.edge), price, bankroll, "mispricing");
            let size = applyWeightToSize("mispricing", baseSize) * verdict.size_multiplier;

            if (alpha.combined_direction_hint === verdict.direction) {
              size *= 1.2;
              console.log(`     💪 Alpha confirms council → +20% size`);
            }
            if (alpha.execution) size = Math.min(size, alpha.execution.max_size_usd);
            if (size < 0.5) continue;

            for (const ns of alpha.news_signals) markActedOn(ns.news_id);

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
            });
          } catch (err: any) {
            console.error(`     Council error: ${err.message}`);
          }
        }
      } catch (err: any) { console.error(`Mispricing: ${err.message}`); }
    };
    setTimeout(runCouncil, 15000);
    setInterval(runCouncil, config.CLAUDE_SCAN_INTERVAL_MS);
    console.log("🧠 Alpha-aware Council armed");
  }

  // ═══ Strategy 4: Cross-Platform Divergence ═══
  {
    const runCrossPlatform = async () => {
      try {
        if (paused) return;
        const divergences = await scanCrossPlatformDivergences(kalshi);
        for (const d of divergences.slice(0, 2)) {
          const { ok } = canTrade(bankroll, openPositions);
          if (!ok) break;

          const price = d.trade_direction === "YES" ? d.kalshi_yes_price : (1 - d.kalshi_yes_price);
          const baseSize = calculatePosition(Math.abs(d.divergence), price, bankroll, "cross_platform");
          const size = applyWeightToSize("cross_platform", baseSize);
          if (size < 0.5) continue;

          await executeTrade(kalshi, {
            strategy: "cross_platform",
            category: "arb",
            question: `[XPlat] ${d.polymarket_question}`,
            ticker: d.kalshi_ticker,
            direction: d.trade_direction,
            price, size,
            reasoning: d.reasoning,
            edge: Math.abs(d.divergence),
            confidence: 0.7,
            hypothesisName: "cross_platform_convergence",
          });
        }
      } catch {}
    };
    setTimeout(runCrossPlatform, 20000);
    setInterval(runCrossPlatform, config.CROSS_PLATFORM_SCAN_INTERVAL_MS);
    console.log("🌐 Cross-platform divergence scanner armed");
  }

  console.log(`\n✅ ALL SYSTEMS LIVE\n`);
  console.log(`📱 Dashboard: http://localhost:${dashboardPort}`);
  console.log(`📱 Pin to iOS home screen for native-like experience\n`);
}

async function executeTrade(kalshi: KalshiClient, params: {
  strategy: string; category: string;
  question: string; ticker: string;
  direction: "YES" | "NO"; price: number; size: number;
  reasoning: string; edge: number; confidence: number;
  councilVerdict?: any;
  hypothesisName?: string;
}) {
  const signalId = genSignalId(params.strategy);
  const tag = ({
    hourly_sniper: "⚡",
    monotonicity_arb: "📐",
    mispricing: "🧠",
    cross_platform: "🌐",
  } as any)[params.strategy] ?? "📊";
  const w = getWeight(params.strategy);

  console.log(`  ${config.DRY_RUN ? "🧪" : "🔴"}${tag} ${params.direction} $${params.size.toFixed(2)} @ $${params.price.toFixed(2)} [${params.strategy} w:${w?.weight.toFixed(2) ?? "1.00"}]`);

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

  let result: any;
  if (config.DRY_RUN) {
    result = { status: "dry_run", ticker: params.ticker, direction: params.direction, size: params.size };
  } else {
    const count = Math.max(1, Math.floor(params.size / params.price));
    result = await kalshi.placeOrder({
      ticker: params.ticker,
      side: params.direction === "YES" ? "yes" : "no",
      action: "buy",
      type: "limit",
      count,
      yes_price: params.direction === "YES" ? Math.floor(params.price * 100) : undefined,
      no_price: params.direction === "NO" ? Math.floor((1 - params.price) * 100) : undefined,
      client_order_id: signalId,
      post_only: true,
    });
  }

  logTrade({
    market_question: params.question, condition_id: params.ticker,
    token_id: `${params.ticker}-${params.direction.toLowerCase()}`,
    strategy: params.strategy,
    side: params.direction, price: params.price, size: params.size, cost: params.size,
    dry_run: config.DRY_RUN, order_response: JSON.stringify(result),
  });

  totalTrades++;
  openPositions++;

  if (config.DRY_RUN) {
    const holdMs = 2 * 60 * 1000 + Math.random() * 3 * 60 * 1000;
    setTimeout(() => simulateResolution(signalId, params), holdMs);
  }

  await notifyTrade({
    market_question: params.question, direction: params.direction,
    edge: params.edge, confidence: params.confidence > 0.5 ? "high" : "medium",
    final_reasoning: params.reasoning, yes_price: params.price,
  } as any, params.size, config.DRY_RUN);
}

function simulateResolution(signalId: string, params: any) {
  const winProbs: Record<string, number> = {
    hourly_sniper: 0.85, monotonicity_arb: 0.95, mispricing: 0.68,
    cross_platform: 0.72, economic_release: 0.60, weather_edge: 0.55,
  };
  const winProb = winProbs[params.strategy] ?? 0.60;
  const won = Math.random() < winProb;
  const pnl = won
    ? params.size * (params.edge || 0.10) * (0.8 + Math.random() * 0.4)
    : -params.size * (0.5 + Math.random() * 0.5);

  bankroll += pnl;
  openPositions--;

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

  console.log(`     ${won ? "✅" : "❌"} ${params.strategy} ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | $${bankroll.toFixed(2)}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
