// src/index.ts — ULTIMATE EDITION
//
// COMPLETE ARCHITECTURE:
//
// Layer 1: STRATEGIES       (what to trade)
// Layer 2: EVOLUTION        (learn what works)
// Layer 3: GENIUS           (think deeply)
// Layer 4: META             (self-critique)
// Layer 5: ALPHA SOURCES    (information edge from news/whales/orderbook)
// Layer 6: DASHBOARD        (phone-first monitoring)

import { config, getPhaseParams } from "./core/config.js";
import { fetchActiveMarkets, getMarketPrices, placeLimitOrder } from "./core/polymarket.js";
import { calculatePosition, canTrade, meetsEdgeThreshold } from "./core/risk.js";
import { getDb, logTrade } from "./core/db.js";
import { notifyStartup, notifyTrade } from "./core/notify.js";
import { startPriceFeed } from "./feeds/binance.js";
import { scanForSniperSignals, sniperPositionSize } from "./strategies/cycle_sniper.js";
import { scanNegRiskArbitrage } from "./strategies/negrisk_scanner.js";

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
║  🧠 POLYMARKET ULTIMATE — 6-Layer Cognitive Architecture   ║
╠════════════════════════════════════════════════════════════╣
║  Strategies × Evolution × Genius × Meta × Alpha × Monitor  ║
╚════════════════════════════════════════════════════════════╝`);

  console.log(`  Mode:      ${config.DRY_RUN ? "🧪 PAPER" : "🔴 LIVE"}`);
  console.log(`  Bankroll:  $${bankroll.toFixed(2)}`);
  console.log(`  Phase:     ${getPhaseParams(bankroll).label}`);

  console.log("\n  ARCHITECTURE:");
  console.log("  1️⃣  STRATEGIES    → ⚡ sniper, 🛡️  negrisk, 🧠 council-mispricing");
  console.log("  2️⃣  EVOLUTION     → 5 loops (reflex → omega)");
  console.log("  3️⃣  GENIUS        → council, counterfactuals, hypotheses, genetics, calibration");
  console.log("  4️⃣  META          → strategy breeding, prompt evolution");
  console.log("  5️⃣  ALPHA SOURCES → 📰 news, 🐋 whales, 📊 orderbook");
  console.log("  6️⃣  DASHBOARD     → phone-first monitoring\n");

  if (!config.ANTHROPIC_API_KEY) { console.error("❌ ANTHROPIC_API_KEY required"); process.exit(1); }

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

  // Start price feed
  if (config.STRATEGY_CYCLE_SNIPER) {
    startPriceFeed();
    await sleep(5000);
  }

  // Cache active markets for alpha sources
  const refreshMarkets = async () => {
    try { cachedMarkets = await fetchActiveMarkets(100); }
    catch {}
  };
  await refreshMarkets();
  setInterval(refreshMarkets, 60 * 1000);

  // Engage all learning loops
  startEvolutionLoops(() => bankroll, STARTING_BANKROLL);
  startGeniusLoops();
  startAlphaSources(() => cachedMarkets.map((m) => m.question).slice(0, 30));

  await notifyStartup();

  // ═══ Strategy 1: Cycle Sniper ═══
  if (config.STRATEGY_CYCLE_SNIPER) {
    setInterval(async () => {
      try {
        if (paused || !shouldFire("cycle_sniper")) return;
        const regime = getCurrentRegime();
        if (regime && (regime.regime === "DEAD" || regime.regime === "VOLATILE")) return;
        const { ok } = canTrade(bankroll, openPositions);
        if (!ok) return;

        const cryptoMarkets = cachedMarkets.filter((m) => m.category?.toLowerCase().includes("crypto"));
        const signals = scanForSniperSignals(cryptoMarkets as any);
        for (const sig of signals.slice(0, 1)) {
          const baseSize = sniperPositionSize(sig, bankroll);
          let size = applyWeightToSize("cycle_sniper", baseSize);
          if (regime) size *= regime.recommended_aggression;
          if (size < 0.5) continue;

          // Check order book quality before executing
          const alpha = await getFusedAlpha(sig.market_id, sig.market_question, sig.token_id, size);
          if (alpha.execution && !alpha.execution.should_execute) {
            console.log(`  ⛔ Sniper rejected by orderbook: ${alpha.execution.warnings.join(", ")}`);
            continue;
          }
          if (alpha.execution) size = Math.min(size, alpha.execution.max_size_usd);

          await executeTrade({
            strategy: "cycle_sniper",
            asset: sig.symbol.toLowerCase() + "usdt",
            category: "crypto",
            question: sig.market_question,
            conditionId: sig.market_id,
            tokenId: sig.token_id,
            direction: sig.direction,
            price: sig.contract_price,
            size,
            reasoning: sig.reasoning,
            edge: sig.potential_return_pct,
            confidence: sig.confidence,
            hypothesisName: "late_cycle_sniper_wins",
          });
        }
      } catch {}
    }, config.SNIPER_SCAN_INTERVAL_MS);
    console.log("⚡ Cycle sniper armed (regime + orderbook gated)");
  }

  // ═══ Strategy 2: NegRisk ═══
  if (config.STRATEGY_NEGRISK_ARB) {
    const runNegRisk = async () => {
      try {
        if (paused || !shouldFire("negrisk_arb")) return;
        const opps = await scanNegRiskArbitrage();
        for (const opp of opps.slice(0, 3)) {
          const baseSize = calculatePosition(opp.net_spread, opp.total_cost, bankroll, "negrisk_arb");
          const size = applyWeightToSize("negrisk_arb", baseSize);
          if (size < 1) continue;
          for (const m of opp.markets) {
            const tokenId = opp.direction === "BUY_ALL_YES" ? m.yes_token_id : m.no_token_id;
            const price = opp.direction === "BUY_ALL_YES" ? m.yes_price : m.no_price;
            await executeTrade({
              strategy: "negrisk_arb",
              asset: null, category: "negrisk",
              question: `[NegRisk] ${m.question}`,
              conditionId: m.condition_id, tokenId,
              direction: opp.direction === "BUY_ALL_YES" ? "YES" : "NO",
              price, size: size / opp.markets.length,
              reasoning: `Risk-free arb, ${opp.roi_pct.toFixed(1)}% ROI`,
              edge: opp.net_spread, confidence: 0.99,
              hypothesisName: "negrisk_always_profitable",
            });
          }
        }
      } catch (err: any) { console.error(`NegRisk: ${err.message}`); }
    };
    setTimeout(runNegRisk, 8000);
    setInterval(runNegRisk, config.NEGRISK_SCAN_INTERVAL_MS);
    console.log("🛡️  NegRisk scanner armed");
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

        // PRIORITIZE: markets with alpha signals get analyzed first
        const triggered = getTriggeredAlphaMarkets();
        if (triggered.length > 0) {
          console.log(`  🎯 ${triggered.length} markets with alpha signals`);
        }

        // Get markets to analyze — prioritize triggered, fall back to liquid
        const liquid = cachedMarkets.filter((m) => m.volume >= config.MIN_MARKET_LIQUIDITY);
        const toAnalyze = [
          ...liquid.filter((m) => triggered.some((t) => m.condition_id === t.market_id || m.question.slice(0, 30) === t.market_id.slice(0, 30))),
          ...liquid.filter((m) => !triggered.some((t) => m.condition_id === t.market_id)),
        ].slice(0, 3);

        for (const market of toAnalyze) {
          await sleep(3000);
          try {
            const { yesPrice, noPrice, yesTokenId, noTokenId } = getMarketPrices(market);

            // Fuse alpha sources for this specific market
            const alpha = await getFusedAlpha(market.condition_id, market.question, yesTokenId, 5);

            // Show alpha context in logs
            if (alpha.news_signals.length > 0) {
              console.log(`  📰 ${alpha.news_signals.length} news signals: ${alpha.news_signals[0].reasoning.slice(0, 80)}`);
            }
            if (alpha.whale_convergence) {
              console.log(`  🐋 ${alpha.whale_convergence.whale_count} whales on ${alpha.whale_convergence.direction}`);
            }
            if (alpha.microstructure_signal) {
              console.log(`  📊 ${alpha.microstructure_signal.signal_type}: ${alpha.microstructure_signal.reasoning}`);
            }

            // Execution gate
            if (alpha.execution && !alpha.execution.should_execute) {
              console.log(`  ⛔ Orderbook rejected: ${alpha.execution.warnings.join(", ")}`);
              continue;
            }

            // Convene council
            console.log(`  ⚖️  Council on: ${market.question.slice(0, 60)}...`);
            const verdict = await deliberate(market.question, market.description, yesPrice, noPrice, market.category, bankroll);

            // Store as latest for dashboard
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

            // Boost size if alpha signals agree with council
            if (alpha.combined_direction_hint === verdict.direction) {
              size *= 1.2;
              console.log(`     💪 Alpha confirms council → +20% size`);
            }

            if (alpha.execution) size = Math.min(size, alpha.execution.max_size_usd);
            if (size < 0.5) continue;

            // Mark news signals as acted on
            for (const ns of alpha.news_signals) markActedOn(ns.news_id);

            await executeTrade({
              strategy: "mispricing",
              asset: null, category: market.category,
              question: market.question, conditionId: market.condition_id,
              tokenId: verdict.direction === "YES" ? yesTokenId : noTokenId,
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

  console.log(`\n✅ ALL SYSTEMS LIVE\n`);
  console.log(`📱 Dashboard: http://localhost:${dashboardPort}`);
  console.log(`📱 Pin to iOS home screen for native-like experience\n`);
}

async function executeTrade(params: {
  strategy: string; asset: string | null; category: string;
  question: string; conditionId: string; tokenId: string;
  direction: "YES" | "NO"; price: number; size: number;
  reasoning: string; edge: number; confidence: number;
  councilVerdict?: any;
  hypothesisName?: string;
}) {
  const signalId = genSignalId(params.strategy);
  const tag = ({ cycle_sniper: "⚡", negrisk_arb: "🛡️", mispricing: "🧠" } as any)[params.strategy] ?? "📊";
  const w = getWeight(params.strategy);

  console.log(`  ${config.DRY_RUN ? "🧪" : "🔴"}${tag} ${params.direction} $${params.size.toFixed(2)} @ $${params.price.toFixed(2)} [${params.strategy} w:${w?.weight.toFixed(2) ?? "1.00"}]`);

  recordSignal({
    signal_id: signalId, strategy: params.strategy,
    asset: params.asset, category: params.category,
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

  const result = await placeLimitOrder({
    tokenID: params.tokenId, price: params.price,
    size: Math.floor(params.size / params.price),
    side: "BUY", feeRateBps: 0,
  });

  logTrade({
    market_question: params.question, condition_id: params.conditionId,
    token_id: params.tokenId, strategy: params.strategy,
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
    cycle_sniper: 0.88, negrisk_arb: 0.99, mispricing: 0.68,
    cross_correlation: 0.75, whale_consensus: 0.65,
  };
  const winProb = winProbs[params.strategy] ?? 0.60;
  const won = Math.random() < winProb;
  const pnl = won
    ? params.size * (params.edge || 0.10) * (0.8 + Math.random() * 0.4)
    : -params.size * (0.5 + Math.random() * 0.5);

  bankroll += pnl;
  openPositions--;

  reflexLoop({
    signalId, strategy: params.strategy, asset: params.asset, category: params.category,
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
