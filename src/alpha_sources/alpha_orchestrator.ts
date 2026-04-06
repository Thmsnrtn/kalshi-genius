// src/alpha_sources/alpha_orchestrator.ts
//
// ALPHA SOURCE ORCHESTRATOR
//
// Coordinates the three alpha sources (news, whales, order book) and
// fuses their signals into a unified "alpha feed" that the Cognitive
// Council consumes alongside price data.
//
// Run cadences:
// - News intelligence: every 2 minutes
// - Whale tracker: every 5 minutes  
// - Order book analysis: on-demand per market (every trade attempt)
// - Signal fusion: every 1 minute

import { 
  initNewsIntelligence, 
  runNewsIntelligenceCycle, 
  getActiveNewsSignals,
  markSignalActedOn,
  type NewsSignal 
} from "./news_intelligence.js";

import { 
  initWhaleTracker, 
  runWhaleTrackerCycle, 
  detectConvergences,
  type WhaleConvergence 
} from "./whale_tracker_onchain.js";

import { 
  initOrderBookAnalyzer, 
  fetchOrderBook, 
  analyzeOrderBook, 
  assessExecution,
  detectSignals,
  recordSnapshot,
  type MicrostructureMetrics,
  type ExecutionAssessment,
  type MicrostructureSignal,
} from "./orderbook_microstructure.js";

export interface AlphaState {
  news_items_fetched: number;
  news_signals_generated: number;
  whales_tracked: number;
  convergences_detected: number;
  orderbooks_analyzed: number;
  last_news_cycle: number;
  last_whale_cycle: number;
}

const state: AlphaState = {
  news_items_fetched: 0,
  news_signals_generated: 0,
  whales_tracked: 0,
  convergences_detected: 0,
  orderbooks_analyzed: 0,
  last_news_cycle: 0,
  last_whale_cycle: 0,
};

// ── Initialize all alpha sources ──
export function initAlphaSources() {
  initNewsIntelligence();
  initWhaleTracker();
  initOrderBookAnalyzer();
  console.log("📡 ALPHA SOURCES initialized: News, Whales, Order Book");
}

// ── Start the alpha source loops ──
export function startAlphaSources(getActiveMarkets: () => string[]) {
  // News intelligence: every 2 minutes
  const runNews = async () => {
    try {
      console.log("\n  📰 News intelligence cycle");
      const result = await runNewsIntelligenceCycle(getActiveMarkets);
      state.news_items_fetched += result.new_items;
      state.news_signals_generated += result.new_signals;
      state.last_news_cycle = Date.now();
      if (result.new_items > 0) {
        console.log(`     Fetched ${result.new_items} new items, generated ${result.new_signals} signals`);
      }
    } catch (err: any) {
      console.error(`     News error: ${err.message}`);
    }
  };
  setTimeout(runNews, 10 * 1000); // First run after 10 seconds
  setInterval(runNews, 2 * 60 * 1000);

  // Whale tracker: every 5 minutes
  const runWhales = async () => {
    try {
      console.log("\n  🐋 Whale tracker cycle");
      const result = await runWhaleTrackerCycle();
      if (result.new_whales > 0) console.log(`     Discovered ${result.new_whales} new whales`);
      if (result.new_positions > 0) console.log(`     Updated ${result.new_positions} positions`);
      if (result.convergences > 0) {
        console.log(`     🚨 ${result.convergences} new whale convergences detected`);
        state.convergences_detected += result.convergences;
      }
      state.last_whale_cycle = Date.now();
    } catch (err: any) {
      console.error(`     Whale error: ${err.message}`);
    }
  };
  setTimeout(runWhales, 20 * 1000); // First run after 20 seconds
  setInterval(runWhales, 5 * 60 * 1000);

  console.log("✅ Alpha sources engaged: News(2m), Whales(5m), OrderBook(on-demand)");
}

// ── Get fused alpha signals for a specific market ──
export interface FusedAlpha {
  market_id: string;
  news_signals: NewsSignal[];
  whale_convergence: WhaleConvergence | null;
  microstructure: MicrostructureMetrics | null;
  execution: ExecutionAssessment | null;
  microstructure_signal: MicrostructureSignal | null;
  combined_confidence: number;
  combined_direction_hint: "YES" | "NO" | null;
  should_council_deliberate: boolean;
}

export async function getFusedAlpha(marketId: string, marketQuestion: string, tokenId: string, intendedSizeUsd: number): Promise<FusedAlpha> {
  // Fetch all alpha sources for this market
  const newsSignals = getActiveNewsSignals().filter((s) => 
    s.market_keywords.some((k) => 
      marketQuestion.toLowerCase().includes(k.toLowerCase().slice(0, 30)) ||
      k.toLowerCase().includes(marketQuestion.toLowerCase().slice(0, 30))
    )
  );

  const convergences = detectConvergences();
  const whaleConvergence = convergences.find((c) => c.market_id === marketId) ?? null;

  // Fetch order book
  let microstructure: MicrostructureMetrics | null = null;
  let execution: ExecutionAssessment | null = null;
  let microstructureSignal: MicrostructureSignal | null = null;

  try {
    const book = await fetchOrderBook(tokenId);
    if (book) {
      microstructure = analyzeOrderBook(book);
      recordSnapshot(microstructure);
      execution = assessExecution(microstructure, intendedSizeUsd);
      microstructureSignal = detectSignals(microstructure);
      state.orderbooks_analyzed++;
    }
  } catch {}

  // Compute combined direction hint
  const directionVotes = {
    YES: 0,
    NO: 0,
  };

  for (const ns of newsSignals) {
    const weight = ns.confidence * (ns.urgency === "breaking" ? 1.5 : ns.urgency === "recent" ? 1.0 : 0.5);
    if (ns.direction_push === "increases") directionVotes.YES += weight;
    else if (ns.direction_push === "decreases") directionVotes.NO += weight;
  }

  if (whaleConvergence) {
    const weight = whaleConvergence.confidence * 2;
    directionVotes[whaleConvergence.direction] += weight;
  }

  if (microstructureSignal?.direction_hint) {
    directionVotes[microstructureSignal.direction_hint] += microstructureSignal.strength;
  }

  const totalVotes = directionVotes.YES + directionVotes.NO;
  let combinedDirection: "YES" | "NO" | null = null;
  let combinedConfidence = 0;

  if (totalVotes > 0) {
    const yesRatio = directionVotes.YES / totalVotes;
    if (yesRatio > 0.65) { combinedDirection = "YES"; combinedConfidence = yesRatio; }
    else if (yesRatio < 0.35) { combinedDirection = "NO"; combinedConfidence = 1 - yesRatio; }
  }

  // Should council deliberate? High-value signals merit deep analysis
  const shouldDeliberate = 
    (newsSignals.length > 0 && newsSignals[0].urgency === "breaking") ||
    (whaleConvergence !== null && whaleConvergence.whale_count >= 5) ||
    (microstructureSignal !== null && microstructureSignal.strength > 0.7);

  return {
    market_id: marketId,
    news_signals: newsSignals,
    whale_convergence: whaleConvergence,
    microstructure,
    execution,
    microstructure_signal: microstructureSignal,
    combined_confidence: combinedConfidence,
    combined_direction_hint: combinedDirection,
    should_council_deliberate: shouldDeliberate,
  };
}

// ── Get triggered alpha signals (high-priority markets to act on) ──
export function getTriggeredAlphaMarkets(): Array<{ market_id: string; reason: string; priority: number }> {
  const triggered: Array<{ market_id: string; reason: string; priority: number }> = [];

  // Breaking news signals
  const news = getActiveNewsSignals().filter((n) => n.urgency === "breaking" && n.confidence >= 0.7);
  for (const n of news) {
    for (const kw of n.market_keywords) {
      triggered.push({
        market_id: kw, // Keyword used as market identifier
        reason: `Breaking news: ${n.reasoning.slice(0, 80)}`,
        priority: 0.9 * n.confidence,
      });
    }
  }

  // Whale convergences
  const convergences = detectConvergences().filter((c) => c.whale_count >= 4);
  for (const c of convergences) {
    triggered.push({
      market_id: c.market_id,
      reason: `${c.whale_count} whales converged ${c.direction} ($${c.total_size_usd.toFixed(0)})`,
      priority: c.confidence,
    });
  }

  return triggered.sort((a, b) => b.priority - a.priority).slice(0, 5);
}

export function getAlphaState(): AlphaState {
  return { ...state };
}

export function markActedOn(newsId: string) {
  markSignalActedOn(newsId);
}
