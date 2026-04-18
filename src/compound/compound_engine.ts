// src/compound/compound_engine.ts — 6-phase compound growth engine
//
// Manages bankroll-dependent strategy unlocks, capital allocation,
// and yield attribution. Wraps around existing getPhaseParams() —
// does NOT replace it.
//
// Phases:
//   0: Seedling  ($25-100)   — mechanical strategies only, max aggression
//   1: Sprout    ($100-500)  — unlock council + market maker
//   2: Sapling   ($500-2k)   — unlock liquidity engine + cross-platform
//   3: Tree      ($2k-10k)   — all strategies, diversified
//   4: Grove     ($10k-50k)  — scale positions, lower risk
//   5: Forest    ($50k+)     — full power, preservation mode

import { config, getPhaseParams } from "../core/config.js";

// ── Phase definitions ──
export interface CompoundPhase {
  name: string;
  emoji: string;
  min_bankroll: number;
  max_bankroll: number;
  strategies_unlocked: string[];
  max_capital_per_strategy_pct: number;
  description: string;
}

// Strategy unlock tiers (research-backed progression):
//
// $0+    high_confidence: 85-94¢ near-close markets (zero API cost, high win rate)
// $0+    hourly_sniper: Binance live price vs Kalshi strike (zero API cost)
// $0+    monotonicity_arb: grouped market violations (zero API cost)
// $0+    weather_edge: NWS + GFS ensemble forecasts (zero API cost)
// $0+    economic_release: FRED data edge (zero API cost)
// $100+  market_maker: spread capture (needs capital for two-sided quotes)
// $150+  mispricing: Claude cognitive council (API cost ~$0.07/deliberation)
// $500+  multi_model_ensemble: Claude + GPT-4o weighted consensus (API cost ~$0.05/eval)
// $500+  cross_platform: Polymarket price divergence
// $500+  liquidity: spread capture engine
// $2000+ whale_consensus: whale wallet tracking

const PHASES: CompoundPhase[] = [
  {
    name: "Seedling", emoji: "🌱", min_bankroll: 0, max_bankroll: 100,
    strategies_unlocked: ["high_confidence", "hourly_sniper", "monotonicity_arb", "economic_release", "weather_edge"],
    max_capital_per_strategy_pct: 0.40,
    description: "Mechanical strategies only — free external data (FRED, NWS, GFS), no AI costs",
  },
  {
    name: "Sprout", emoji: "🌿", min_bankroll: 100, max_bankroll: 500,
    strategies_unlocked: ["high_confidence", "hourly_sniper", "monotonicity_arb", "economic_release", "weather_edge", "mispricing", "market_maker"],
    max_capital_per_strategy_pct: 0.30,
    description: "Council unlocked — AI-powered analysis on high-value markets",
  },
  {
    name: "Sapling", emoji: "🌳", min_bankroll: 500, max_bankroll: 2000,
    strategies_unlocked: ["high_confidence", "hourly_sniper", "monotonicity_arb", "economic_release", "weather_edge", "mispricing", "market_maker", "multi_model_ensemble", "cross_platform", "liquidity"],
    max_capital_per_strategy_pct: 0.20,
    description: "Multi-model ensemble + liquidity engine + cross-platform",
  },
  {
    name: "Tree", emoji: "🌲", min_bankroll: 2000, max_bankroll: 10000,
    strategies_unlocked: ["high_confidence", "hourly_sniper", "monotonicity_arb", "economic_release", "weather_edge", "mispricing", "market_maker", "multi_model_ensemble", "cross_platform", "liquidity", "whale_consensus"],
    max_capital_per_strategy_pct: 0.15,
    description: "All strategies active — diversified growth",
  },
  {
    name: "Grove", emoji: "🏕️", min_bankroll: 10000, max_bankroll: 50000,
    strategies_unlocked: ["high_confidence", "hourly_sniper", "monotonicity_arb", "economic_release", "weather_edge", "mispricing", "market_maker", "multi_model_ensemble", "cross_platform", "liquidity", "whale_consensus"],
    max_capital_per_strategy_pct: 0.10,
    description: "Scaled positions, lower concentration risk",
  },
  {
    name: "Forest", emoji: "🌲🌲", min_bankroll: 50000, max_bankroll: Infinity,
    strategies_unlocked: ["high_confidence", "hourly_sniper", "monotonicity_arb", "economic_release", "weather_edge", "mispricing", "market_maker", "multi_model_ensemble", "cross_platform", "liquidity", "whale_consensus"],
    max_capital_per_strategy_pct: 0.08,
    description: "Full power — capital preservation with steady compound",
  },
];

// ── Tracking state ──
interface CompoundState {
  current_phase: number;
  phase_name: string;
  phase_emoji: string;
  bankroll_at_start: number;
  phase_entered_at: number;
  highest_bankroll: number;
  phase_transitions: Array<{ from: number; to: number; bankroll: number; timestamp: number }>;
  yield_by_strategy: Map<string, number>;
}

let state: CompoundState = {
  current_phase: 0,
  phase_name: "Seedling",
  phase_emoji: "🌱",
  bankroll_at_start: config.STARTING_BANKROLL,
  phase_entered_at: Date.now(),
  highest_bankroll: config.STARTING_BANKROLL,
  phase_transitions: [],
  yield_by_strategy: new Map(),
};

// Initialize compound tracking
export function initCompoundTracking(startingBankroll: number) {
  const phase = getCompoundPhase(startingBankroll);
  state = {
    current_phase: phase,
    phase_name: PHASES[phase].name,
    phase_emoji: PHASES[phase].emoji,
    bankroll_at_start: startingBankroll,
    phase_entered_at: Date.now(),
    highest_bankroll: startingBankroll,
    phase_transitions: [],
    yield_by_strategy: new Map(),
  };
  console.log(`  📈 Compound engine: ${PHASES[phase].emoji} ${PHASES[phase].name} phase ($${startingBankroll.toFixed(2)})`);
}

// Get current compound phase index (0-5)
export function getCompoundPhase(bankroll: number): number {
  for (let i = PHASES.length - 1; i >= 0; i--) {
    if (bankroll >= PHASES[i].min_bankroll) return i;
  }
  return 0;
}

// Check if a strategy is unlocked at current bankroll
export function isStrategyUnlocked(strategy: string, bankroll: number): boolean {
  const phase = getCompoundPhase(bankroll);
  return PHASES[phase].strategies_unlocked.includes(strategy);
}

// Get max capital allocation for a strategy
export function getMaxCapitalForStrategy(strategy: string, bankroll: number): number {
  const phase = getCompoundPhase(bankroll);
  return bankroll * PHASES[phase].max_capital_per_strategy_pct;
}

// Update tracking when bankroll changes (call after each trade/resolution)
export function updateCompoundState(bankroll: number) {
  const newPhase = getCompoundPhase(bankroll);

  if (bankroll > state.highest_bankroll) {
    state.highest_bankroll = bankroll;
  }

  if (newPhase !== state.current_phase) {
    const direction = newPhase > state.current_phase ? "⬆️" : "⬇️";
    console.log(`  ${direction} Phase transition: ${PHASES[state.current_phase].emoji} ${PHASES[state.current_phase].name} → ${PHASES[newPhase].emoji} ${PHASES[newPhase].name} ($${bankroll.toFixed(2)})`);

    state.phase_transitions.push({
      from: state.current_phase,
      to: newPhase,
      bankroll,
      timestamp: Date.now(),
    });

    state.current_phase = newPhase;
    state.phase_name = PHASES[newPhase].name;
    state.phase_emoji = PHASES[newPhase].emoji;
    state.phase_entered_at = Date.now();
  }
}

// Record yield attribution per strategy
export function recordStrategyYield(strategy: string, pnl: number) {
  const current = state.yield_by_strategy.get(strategy) ?? 0;
  state.yield_by_strategy.set(strategy, current + pnl);
}

// Allocate capital for a trade — respects phase limits
export function allocateCapital(
  strategy: string,
  requestedSize: number,
  bankroll: number,
): { size: number; capped: boolean; reason?: string } {
  // Check if strategy is unlocked
  if (!isStrategyUnlocked(strategy, bankroll)) {
    return { size: 0, capped: true, reason: `${strategy} locked until $${getUnlockBankroll(strategy)}` };
  }

  // Apply per-strategy capital cap
  const maxCap = getMaxCapitalForStrategy(strategy, bankroll);
  if (requestedSize > maxCap) {
    return { size: maxCap, capped: true, reason: `capped at ${(PHASES[getCompoundPhase(bankroll)].max_capital_per_strategy_pct * 100).toFixed(0)}% of bankroll` };
  }

  return { size: requestedSize, capped: false };
}

// Get bankroll needed to unlock a strategy
function getUnlockBankroll(strategy: string): number {
  for (const phase of PHASES) {
    if (phase.strategies_unlocked.includes(strategy)) return phase.min_bankroll;
  }
  return Infinity;
}

// ════════════════════════��═════════════════════════════════════
// AUTO-WITHDRAWAL SYSTEM — Build a nest egg while staying aggressive
// ══════════════════════════════════════════════════════════════
//
// Rules:
//   1. No withdrawals until bankroll > $500 (need critical mass first)
//   2. At each milestone, skim a percentage of PROFITS into "nest egg"
//   3. Withdrawal % scales with bankroll — more profit = more skimmed
//   4. Remaining bankroll stays fully deployed for aggressive compounding
//   5. Withdrawals are suggested (logged + flagged) — user confirms via chat/dashboard
//
// Schedule:
//   $500  milestone → skim 10% of profits above $500
//   $1000 milestone → skim 15% of profits above $1000
//   $2500 milestone → skim 20% of profits above $2500
//   $5000 milestone → skim 25% of profits above $5000
//   $10k+ milestone → skim 30% of profits, every $5k increment

interface WithdrawalSchedule {
  threshold: number;
  skim_pct: number;
}

const WITHDRAWAL_SCHEDULE: WithdrawalSchedule[] = [
  { threshold: 500,   skim_pct: 0.10 },
  { threshold: 1000,  skim_pct: 0.15 },
  { threshold: 2500,  skim_pct: 0.20 },
  { threshold: 5000,  skim_pct: 0.25 },
  { threshold: 10000, skim_pct: 0.30 },
  { threshold: 15000, skim_pct: 0.30 },
  { threshold: 20000, skim_pct: 0.30 },
  { threshold: 30000, skim_pct: 0.30 },
  { threshold: 50000, skim_pct: 0.30 },
];

interface WithdrawalState {
  total_withdrawn: number;
  nest_egg: number;
  last_withdrawal_at: number;
  milestones_hit: number[];
  pending_withdrawal: { amount: number; reason: string } | null;
}

const withdrawalState: WithdrawalState = {
  total_withdrawn: 0,
  nest_egg: 0,
  last_withdrawal_at: 0,
  milestones_hit: [],
  pending_withdrawal: null,
};

// Check if a withdrawal should be suggested
export function checkAutoWithdrawal(bankroll: number, startingBankroll: number): {
  should_withdraw: boolean;
  amount: number;
  reason: string;
  remaining_bankroll: number;
} | null {
  const profits = bankroll - startingBankroll;
  if (profits <= 0 || bankroll < 500) return null;

  // Find the highest milestone we've crossed that we haven't withdrawn for
  for (const sched of WITHDRAWAL_SCHEDULE) {
    if (bankroll >= sched.threshold && !withdrawalState.milestones_hit.includes(sched.threshold)) {
      const profitsAboveThreshold = bankroll - sched.threshold;
      const skimAmount = Math.max(10, Math.floor(profitsAboveThreshold * sched.skim_pct));

      // Don't skim if it would drop us below the threshold
      if (bankroll - skimAmount < sched.threshold * 0.9) continue;

      withdrawalState.pending_withdrawal = {
        amount: skimAmount,
        reason: `Milestone $${sched.threshold}: skim ${(sched.skim_pct * 100).toFixed(0)}% of profits above threshold`,
      };

      return {
        should_withdraw: true,
        amount: skimAmount,
        reason: withdrawalState.pending_withdrawal.reason,
        remaining_bankroll: bankroll - skimAmount,
      };
    }
  }
  return null;
}

// Confirm a withdrawal (called when user approves via chat)
export function confirmWithdrawal(amount: number) {
  withdrawalState.total_withdrawn += amount;
  withdrawalState.nest_egg += amount;
  withdrawalState.last_withdrawal_at = Date.now();
  if (withdrawalState.pending_withdrawal) {
    // Mark this milestone as hit
    for (const sched of WITHDRAWAL_SCHEDULE) {
      if (withdrawalState.pending_withdrawal.reason.includes(`$${sched.threshold}`)) {
        withdrawalState.milestones_hit.push(sched.threshold);
      }
    }
    withdrawalState.pending_withdrawal = null;
  }
  console.log(`  💰 Withdrawal confirmed: $${amount.toFixed(2)} → nest egg (total: $${withdrawalState.nest_egg.toFixed(2)})`);
}

export function getWithdrawalState() {
  return { ...withdrawalState };
}

// Get full state for dashboard
export function getCompoundState(): {
  phase: number;
  phase_name: string;
  phase_emoji: string;
  phase_description: string;
  highest_bankroll: number;
  phase_entered_at: number;
  transitions: CompoundState["phase_transitions"];
  yield_by_strategy: Record<string, number>;
  strategies_unlocked: string[];
  next_phase: { name: string; emoji: string; bankroll_needed: number } | null;
  phases: Array<{ name: string; emoji: string; min: number; max: number; unlocked: boolean }>;
  withdrawal: { nest_egg: number; total_withdrawn: number; pending: { amount: number; reason: string } | null };
} {
  const currentPhaseDef = PHASES[state.current_phase];
  const nextPhaseDef = state.current_phase < PHASES.length - 1 ? PHASES[state.current_phase + 1] : null;

  const ws = getWithdrawalState();
  return {
    phase: state.current_phase,
    phase_name: state.phase_name,
    phase_emoji: state.phase_emoji,
    phase_description: currentPhaseDef.description,
    highest_bankroll: state.highest_bankroll,
    phase_entered_at: state.phase_entered_at,
    transitions: state.phase_transitions,
    yield_by_strategy: Object.fromEntries(state.yield_by_strategy),
    strategies_unlocked: currentPhaseDef.strategies_unlocked,
    next_phase: nextPhaseDef ? {
      name: nextPhaseDef.name,
      emoji: nextPhaseDef.emoji,
      bankroll_needed: nextPhaseDef.min_bankroll,
    } : null,
    phases: PHASES.map((p, i) => ({
      name: p.name,
      emoji: p.emoji,
      min: p.min_bankroll,
      max: p.max_bankroll === Infinity ? -1 : p.max_bankroll,
      unlocked: i <= state.current_phase,
    })),
    withdrawal: {
      nest_egg: ws.nest_egg,
      total_withdrawn: ws.total_withdrawn,
      pending: ws.pending_withdrawal,
    },
  };
}
