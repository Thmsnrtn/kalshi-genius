// src/velocity/velocity_orchestrator.ts — Wire velocity engine into the bot
//
// Main entry point: velocityAllocateTrade(signal)
// Called from executeTrade() AFTER compound gates, BEFORE kalshi.placeOrder.
// Returns allocation with tranche + exit plan, or null if no tranche available.
//
// $50 bankroll gate: below this, returns passthrough (original size, no tranche mgmt).
// All tranches occupied: rejects trade (returns null), logs reason.

import type { KalshiClient } from "../exchanges/kalshi/kalshi_client.js";
import {
  initTranches,
  rebalanceTranches,
  allocateTranche,
  releaseTranche,
  getVelocityMetrics,
  getAllTranches,
  getAllExitPlans,
  createPassthrough,
  type VelocityAllocation,
  type VelocityMetrics,
  type Tranche,
  type LadderedExitPlan,
} from "./velocity_engine.js";

const MIN_BANKROLL = 50;
const REBALANCE_INTERVAL_MS = 60_000; // Rebalance tranches every 1 min

let kalshiRef: KalshiClient | null = null;
let getBankrollFn: (() => number) | null = null;
let isPausedFn: (() => boolean) | null = null;
let dryRunMode = true;
let initialized = false;
let rebalanceTimer: ReturnType<typeof setInterval> | null = null;

export interface VelocitySignal {
  ticker: string;
  side: "YES" | "NO";
  entryPrice: number;       // 0-1 dollar price
  contracts: number;
  sizeUsd: number;           // Dollar size of the trade
  edge: number;              // Expected edge (0-1)
  positionId: string;        // Signal ID
}

export interface VelocityState {
  initialized: boolean;
  bankroll_gate: number;
  metrics: VelocityMetrics;
  tranches: Tranche[];
  active_exit_plans: LadderedExitPlan[];
}

// Initialize — no args needed, just marks ready
export function initVelocityOrchestrator() {
  console.log("  ⚡ Velocity orchestrator initialized (waiting for $50 bankroll)");
}

// Wire Kalshi client
export function wireVelocityOrchestrator(kalshi: KalshiClient) {
  kalshiRef = kalshi;
}

// Start the velocity engine with bankroll tracking
export function startVelocityOrchestrator(
  getBankroll: () => number,
  isPaused: () => boolean,
  dryRun: boolean,
) {
  getBankrollFn = getBankroll;
  isPausedFn = isPaused;
  dryRunMode = dryRun;

  const bankroll = getBankroll();
  if (bankroll >= MIN_BANKROLL) {
    initTranches(bankroll);
    initialized = true;
  } else {
    console.log(`  ⚡ Velocity deferred: $${bankroll.toFixed(2)} < $${MIN_BANKROLL} minimum`);
  }

  // Periodic rebalance — adjusts tranche count/capital as bankroll changes
  rebalanceTimer = setInterval(() => {
    if (!getBankrollFn || isPausedFn?.()) return;
    const currentBankroll = getBankrollFn();

    if (!initialized && currentBankroll >= MIN_BANKROLL) {
      initTranches(currentBankroll);
      initialized = true;
      console.log("  ⚡ Velocity engine activated (bankroll crossed $50)");
    } else if (initialized) {
      rebalanceTranches(currentBankroll);
    }
  }, REBALANCE_INTERVAL_MS);
}

// ── Main entry point: allocate a tranche for a trade ──
// Returns VelocityAllocation or null (reject trade — no tranche available)
export function velocityAllocateTrade(signal: VelocitySignal): VelocityAllocation | null {
  const bankroll = getBankrollFn?.() ?? 0;

  // Below $50: passthrough (no tranche management, use original size)
  if (bankroll < MIN_BANKROLL || !initialized) {
    return createPassthrough(signal.contracts, signal.sizeUsd);
  }

  // Try to allocate a tranche
  const allocation = allocateTranche(
    signal.ticker,
    signal.entryPrice,
    signal.contracts,
    signal.side,
    signal.positionId,
    signal.edge,
  );

  if (!allocation) {
    // All tranches occupied — reject this trade
    const metrics = getVelocityMetrics();
    console.log(`  ⚡ Velocity: all ${metrics.total_tranches} tranches occupied, skipping ${signal.ticker}`);
    return null;
  }

  console.log(`  ⚡ Velocity: tranche #${allocation.tranche_id} → ${signal.ticker} (${allocation.contracts}×$${signal.entryPrice.toFixed(2)}, ${allocation.exit_plan.tiers.length} exit tiers)`);
  return allocation;
}

// Release a tranche when position exits (called from index.ts exit callbacks)
export function velocityReleaseTranche(positionId: string, pnl: number) {
  if (!initialized) return;
  releaseTranche(positionId, pnl);
}

// Get state for dashboard
export function getVelocityState(): VelocityState {
  return {
    initialized,
    bankroll_gate: MIN_BANKROLL,
    metrics: initialized ? getVelocityMetrics() : {
      total_tranches: 0, active_tranches: 0, available_tranches: 0,
      avg_turnover_per_hour: 0, total_round_trips: 0, total_velocity_pnl: 0,
    },
    tranches: initialized ? getAllTranches() : [],
    active_exit_plans: initialized ? getAllExitPlans() : [],
  };
}
