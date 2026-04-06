// src/evolution/evolution_loop.ts
//
// THE EVOLUTION COORDINATOR
//
// This is the master loop that runs all the feedback systems at
// different cadences. The bot becomes an organism with:
//
// - Reflexes (every trade resolution)
// - Short-term memory (every 5 minutes)
// - Working memory (every 15 minutes)
// - Long-term consolidation (every hour)
// - Sleep / dream / rebuild (every 6 hours)
//
// Each loop feeds the next. The bot gets exponentially smarter
// because each level of learning informs and accelerates the others.

import { config } from "../core/config.js";
import { recordResolution, getTopPerformers, getPerformance } from "./performance_tracker.js";
import { updateWeight, getAllWeights, getWeight } from "./strategy_weights.js";
import { reinforcePattern, recordEpisode, discoverPatterns, getActivePlaybooks } from "./memory.js";
import { detectRegime, getCurrentRegime } from "./regime_detector.js";
import { evolveAnalystPrompt, trackPromptResult } from "./prompt_evolver.js";
import { notifyTrade } from "../core/notify.js";

export interface EvolutionState {
  cycle_count: number;
  trades_processed: number;
  patterns_discovered: number;
  prompt_evolutions: number;
  current_regime: string;
  hottest_strategy: string;
  coldest_strategy: string;
  bankroll_growth_rate: number;
  last_micro_cycle: number;
  last_meso_cycle: number;
  last_macro_cycle: number;
  last_consolidation: number;
}

const state: EvolutionState = {
  cycle_count: 0,
  trades_processed: 0,
  patterns_discovered: 0,
  prompt_evolutions: 0,
  current_regime: "QUIET",
  hottest_strategy: "",
  coldest_strategy: "",
  bankroll_growth_rate: 0,
  last_micro_cycle: 0,
  last_meso_cycle: 0,
  last_macro_cycle: 0,
  last_consolidation: 0,
};

// ═══════════════════════════════════════════════════════
// REFLEX LOOP — runs on every trade resolution
// Time scale: instant
// ═══════════════════════════════════════════════════════
export function reflexLoop(params: {
  signalId: string;
  strategy: string;
  asset: string | null;
  category: string;
  won: boolean;
  pnl: number;
  promptId?: number;
  narrative: string;
  context: any;
}) {
  // 1. Record resolution in performance tracker
  recordResolution(params.signalId, params.won, params.pnl);

  // 2. Update Bayesian strategy weight (this is the magic)
  updateWeight(params.strategy, params.won, params.pnl);

  // 3. Track prompt performance
  if (params.promptId) trackPromptResult(params.promptId, params.won, params.pnl);

  // 4. Record episode for memory consolidation later
  recordEpisode(
    params.narrative,
    params.context,
    params.won ? "win" : "loss",
    params.won ? "Strategy worked in these conditions" : "Strategy failed in these conditions",
    params.signalId
  );

  state.trades_processed++;
}

// ═══════════════════════════════════════════════════════
// MICRO CYCLE — every 5 minutes
// Quick tactical adjustments based on very recent activity
// ═══════════════════════════════════════════════════════
export async function microCycle() {
  state.cycle_count++;
  state.last_micro_cycle = Date.now();
  console.log(`\n  🧬 [μ] Micro evolution cycle #${state.cycle_count}`);

  // 1. Detect current market regime
  const regime = detectRegime();
  state.current_regime = regime.regime;
  console.log(`     Regime: ${regime.regime} (conf: ${(regime.confidence * 100).toFixed(0)}%)`);
  console.log(`     Recommended: ${regime.recommended_strategies.join(", ")}`);
  console.log(`     Aggression: ${regime.recommended_aggression.toFixed(2)}x`);

  // 2. Check strategy weights — flag any significant changes
  const weights = getAllWeights();
  const hot = weights.filter((w) => w.status === "hot");
  const cold = weights.filter((w) => w.status === "cold" || w.status === "frozen");

  if (hot.length > 0) {
    console.log(`     🔥 Hot strategies: ${hot.map((w) => `${w.strategy}(${(w.expected_win_rate * 100).toFixed(0)}%)`).join(", ")}`);
    state.hottest_strategy = hot[0].strategy;
  }
  if (cold.length > 0) {
    console.log(`     ❄️  Cold/frozen: ${cold.map((w) => `${w.strategy}(${w.status})`).join(", ")}`);
    state.coldest_strategy = cold[0].strategy;
  }

  // 3. Get last 30 minutes performance
  const recent = getPerformance({ since_ms: Date.now() - 30 * 60 * 1000 });
  if (recent.trades > 0) {
    console.log(`     Last 30m: ${recent.trades} trades, ${(recent.win_rate * 100).toFixed(0)}% WR, $${recent.total_pnl.toFixed(2)} PnL, trend: ${recent.recent_trend}`);
  }
}

// ═══════════════════════════════════════════════════════
// MESO CYCLE — every 15 minutes
// Pattern reinforcement and strategy mutation
// ═══════════════════════════════════════════════════════
export async function mesoCycle(currentBankroll: number, startingBankroll: number) {
  state.last_meso_cycle = Date.now();
  console.log(`\n  🧬 [m] Meso evolution cycle`);

  // 1. Top performers by dimension
  const topAssets = getTopPerformers("asset", 60 * 60 * 1000);
  const topHours = getTopPerformers("hour_of_day", 24 * 60 * 60 * 1000);
  const topCats = getTopPerformers("category", 6 * 60 * 60 * 1000);

  if (topAssets.length > 0) {
    console.log(`     🏆 Best assets (1h): ${topAssets.slice(0, 3).map((a) => `${a.dimension}($${a.total_pnl.toFixed(2)})`).join(", ")}`);
  }
  if (topHours.length > 0) {
    console.log(`     ⏰ Best hours (24h): ${topHours.slice(0, 3).map((h) => `${h.dimension}h(${(h.win_rate * 100).toFixed(0)}%)`).join(", ")}`);
  }
  if (topCats.length > 0) {
    console.log(`     📂 Best categories: ${topCats.slice(0, 3).map((c) => `${c.dimension}($${c.total_pnl.toFixed(2)})`).join(", ")}`);
  }

  // 2. Calculate bankroll growth rate
  const elapsedHours = (Date.now() - (state.last_macro_cycle || Date.now() - 3600000)) / 3600000;
  if (elapsedHours > 0 && startingBankroll > 0) {
    const growth = (currentBankroll - startingBankroll) / startingBankroll;
    state.bankroll_growth_rate = growth / Math.max(0.1, elapsedHours);
    console.log(`     📈 Growth rate: ${(state.bankroll_growth_rate * 100).toFixed(2)}%/hr`);
  }
}

// ═══════════════════════════════════════════════════════
// MACRO CYCLE — every hour
// Pattern discovery and prompt evolution
// ═══════════════════════════════════════════════════════
export async function macroCycle() {
  state.last_macro_cycle = Date.now();
  console.log(`\n  🧬 [M] Macro evolution cycle`);

  try {
    // 1. Discover patterns from recent episodes
    console.log("     🔍 Searching for patterns in recent episodes...");
    const patterns = await discoverPatterns();
    if (patterns.discovered > 0) {
      state.patterns_discovered += patterns.discovered;
      patterns.details.forEach((d) => console.log(`     ${d}`));
    } else {
      console.log("     No new patterns this cycle");
    }

    // 2. Evolve the analyst prompt
    console.log("     🧠 Evolving analyst prompt...");
    const evolution = await evolveAnalystPrompt();
    if (evolution.evolved) {
      state.prompt_evolutions++;
      console.log(`     ✨ New prompt v${evolution.new_version}`);
      console.log(`     Reasoning: ${evolution.reasoning?.slice(0, 150)}...`);
    } else {
      console.log("     Prompt unchanged (insufficient signal or no improvement found)");
    }

    // 3. Show active playbooks
    const playbooks = getActivePlaybooks();
    if (playbooks.length > 0) {
      console.log(`     📖 Active playbooks: ${playbooks.length}`);
      playbooks.slice(0, 3).forEach((p) => 
        console.log(`        • ${p.playbook_name}: ${p.success_count}W/${p.failure_count}L`)
      );
    }
  } catch (err: any) {
    console.error(`     Error in macro cycle: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════
// CONSOLIDATION — every 6 hours
// Deep review, archival, parameter tuning
// ═══════════════════════════════════════════════════════
export async function consolidationCycle() {
  state.last_consolidation = Date.now();
  console.log(`\n  🧬 [Ω] Consolidation cycle`);

  // Get full performance picture
  const overall = getPerformance({ since_ms: Date.now() - 6 * 60 * 60 * 1000 });
  console.log(`     📊 Last 6h: ${overall.trades} trades, ${(overall.win_rate * 100).toFixed(0)}% WR, $${overall.total_pnl.toFixed(2)} PnL`);
  console.log(`     Sharpe: ${overall.sharpe.toFixed(2)} | Trend: ${overall.recent_trend}`);

  // Show evolution summary
  console.log(`     🧬 Evolution stats:`);
  console.log(`        Cycles run: ${state.cycle_count}`);
  console.log(`        Trades processed: ${state.trades_processed}`);
  console.log(`        Patterns discovered: ${state.patterns_discovered}`);
  console.log(`        Prompt evolutions: ${state.prompt_evolutions}`);
  console.log(`        Current regime: ${state.current_regime}`);
}

// ═══════════════════════════════════════════════════════
// MASTER EVOLUTION SETUP
// ═══════════════════════════════════════════════════════
export function startEvolutionLoops(getBankroll: () => number, startingBankroll: number) {
  // Micro: every 5 minutes
  setInterval(() => microCycle().catch(console.error), 5 * 60 * 1000);

  // Meso: every 15 minutes
  setInterval(() => mesoCycle(getBankroll(), startingBankroll).catch(console.error), 15 * 60 * 1000);

  // Macro: every hour
  setInterval(() => macroCycle().catch(console.error), 60 * 60 * 1000);

  // Consolidation: every 6 hours
  setInterval(() => consolidationCycle().catch(console.error), 6 * 60 * 60 * 1000);

  // Run initial cycles immediately to bootstrap
  setTimeout(() => microCycle().catch(console.error), 30 * 1000);

  console.log("✅ Evolution loops engaged: μ(5m) → m(15m) → M(1h) → Ω(6h)");
}

export function getEvolutionState(): EvolutionState {
  return { ...state };
}
