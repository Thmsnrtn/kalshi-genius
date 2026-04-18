// src/velocity/velocity_engine.ts — Capital velocity with parallel tranches
//
// Splits bankroll into independent tranches that trade in parallel.
// Each tranche has its own capital, active position, and exit plan.
// Tranche count scales with compound phase (more capital = more parallel trades).
//
// Laddered exits: each position gets a 5-tier front-loaded exit plan
// (30/25/20/15/10) so profits are taken incrementally, not all-or-nothing.

import { getCompoundPhase } from "../compound/compound_engine.js";

// ── Phase-scaled tranche counts ──
// Seedling=2, Sprout=3, Sapling=5, Tree=8, Grove=10, Forest=12
const PHASE_TRANCHE_COUNTS = [2, 3, 5, 8, 10, 12];

// ── Laddered exit tiers (front-loaded) ──
// Sell 30% at first target, 25% at second, etc.
const EXIT_TIERS = [
  { pct: 0.30, target_pct: 0.20 },  // Sell 30% when 20% of edge captured
  { pct: 0.25, target_pct: 0.40 },  // Sell 25% when 40% captured
  { pct: 0.20, target_pct: 0.60 },  // Sell 20% when 60% captured
  { pct: 0.15, target_pct: 0.80 },  // Sell 15% when 80% captured
  { pct: 0.10, target_pct: 1.00 },  // Sell remaining 10% at full target
];

export interface Tranche {
  id: number;
  capital_usd: number;        // Capital allocated to this tranche
  available: boolean;          // True if no active position
  position_id: string | null;  // Signal ID of active position
  ticker: string | null;
  entry_price: number | null;  // 0-1 dollar price
  contracts: number;
  side: "YES" | "NO" | null;
  entered_at: number | null;
  last_exit_at: number;        // When this tranche last freed up
  total_round_trips: number;
  total_pnl_usd: number;
}

export interface LadderedExitPlan {
  position_id: string;
  ticker: string;
  side: "YES" | "NO";
  total_contracts: number;
  entry_price: number;
  target_price: number;       // Full target (edge fully captured)
  tiers: ExitTier[];
}

export interface ExitTier {
  tier: number;               // 0-4
  contracts: number;          // How many contracts to sell at this level
  target_price: number;       // Price at which to exit this tier
  pct_of_position: number;    // 0.30, 0.25, 0.20, 0.15, 0.10
  executed: boolean;
  executed_at: number | null;
  executed_price: number | null;
}

export interface VelocityAllocation {
  tranche_id: number;
  capital_usd: number;
  contracts: number;
  exit_plan: LadderedExitPlan;
  passthrough: boolean;       // True if velocity is bypassed (bankroll < $50)
}

export interface VelocityMetrics {
  total_tranches: number;
  active_tranches: number;
  available_tranches: number;
  avg_turnover_per_hour: number;
  total_round_trips: number;
  total_velocity_pnl: number;
}

// ── Engine state ──
let tranches: Tranche[] = [];
let exitPlans: Map<string, LadderedExitPlan> = new Map(); // positionId -> plan
let engineStartedAt = 0;

// Initialize tranches based on bankroll and phase
export function initTranches(bankroll: number) {
  const phase = getCompoundPhase(bankroll);
  const trancheCount = PHASE_TRANCHE_COUNTS[phase] ?? 2;
  const capitalPerTranche = bankroll / trancheCount;

  tranches = [];
  for (let i = 0; i < trancheCount; i++) {
    tranches.push({
      id: i,
      capital_usd: capitalPerTranche,
      available: true,
      position_id: null,
      ticker: null,
      entry_price: null,
      contracts: 0,
      side: null,
      entered_at: null,
      last_exit_at: 0,
      total_round_trips: 0,
      total_pnl_usd: 0,
    });
  }

  engineStartedAt = Date.now();
  console.log(`  ⚡ Velocity engine: ${trancheCount} tranches × $${capitalPerTranche.toFixed(2)} each`);
}

// Rebalance tranches when bankroll changes significantly
export function rebalanceTranches(bankroll: number) {
  const phase = getCompoundPhase(bankroll);
  const targetCount = PHASE_TRANCHE_COUNTS[phase] ?? 2;

  // Only rebalance if tranche count needs to change
  if (targetCount === tranches.length) {
    // Just update capital for available tranches
    const activeTranches = tranches.filter(t => !t.available);
    const availableTranches = tranches.filter(t => t.available);
    const capitalInUse = activeTranches.reduce((s, t) => s + t.capital_usd, 0);
    const remainingCapital = Math.max(0, bankroll - capitalInUse);

    if (availableTranches.length > 0) {
      const perTranche = remainingCapital / availableTranches.length;
      for (const t of availableTranches) {
        t.capital_usd = perTranche;
      }
    }
    return;
  }

  // Phase changed — add or remove tranches
  if (targetCount > tranches.length) {
    // Add new tranches
    const availableCapital = tranches.filter(t => t.available).reduce((s, t) => s + t.capital_usd, 0);
    const newCount = targetCount - tranches.length;
    const capitalPerNew = availableCapital / (tranches.filter(t => t.available).length + newCount);

    // Resize existing available tranches
    for (const t of tranches.filter(t => t.available)) {
      t.capital_usd = capitalPerNew;
    }

    // Add new ones
    for (let i = 0; i < newCount; i++) {
      tranches.push({
        id: tranches.length,
        capital_usd: capitalPerNew,
        available: true,
        position_id: null,
        ticker: null,
        entry_price: null,
        contracts: 0,
        side: null,
        entered_at: null,
        last_exit_at: 0,
        total_round_trips: 0,
        total_pnl_usd: 0,
      });
    }
    console.log(`  ⚡ Velocity: scaled up to ${targetCount} tranches`);
  }
  // If targetCount < tranches.length, we don't remove active tranches — just let them drain
}

// Find the best available tranche for a new trade
function findAvailableTranche(minCapital: number): Tranche | null {
  // Prefer tranches that have been idle longest (maximize capital velocity)
  const available = tranches
    .filter(t => t.available && t.capital_usd >= minCapital)
    .sort((a, b) => a.last_exit_at - b.last_exit_at); // Longest idle first

  return available.length > 0 ? available[0] : null;
}

// Allocate a tranche for a trade
export function allocateTranche(
  ticker: string,
  entryPrice: number,     // 0-1 dollar price
  contracts: number,
  side: "YES" | "NO",
  positionId: string,
  edge: number,           // Expected edge (0-1)
): VelocityAllocation | null {
  const minCapital = contracts * entryPrice;
  const tranche = findAvailableTranche(minCapital);

  if (!tranche) return null;

  // Cap contracts to tranche capital
  const maxContracts = Math.floor(tranche.capital_usd / Math.max(entryPrice, 0.01));
  const actualContracts = Math.min(contracts, maxContracts);

  // Mark tranche as occupied
  tranche.available = false;
  tranche.position_id = positionId;
  tranche.ticker = ticker;
  tranche.entry_price = entryPrice;
  tranche.contracts = actualContracts;
  tranche.side = side;
  tranche.entered_at = Date.now();

  // Build laddered exit plan
  const exitPlan = buildExitPlan(positionId, ticker, side, actualContracts, entryPrice, edge);
  exitPlans.set(positionId, exitPlan);

  return {
    tranche_id: tranche.id,
    capital_usd: actualContracts * entryPrice,
    contracts: actualContracts,
    exit_plan: exitPlan,
    passthrough: false,
  };
}

// Build a 5-tier laddered exit plan
function buildExitPlan(
  positionId: string,
  ticker: string,
  side: "YES" | "NO",
  totalContracts: number,
  entryPrice: number,
  edge: number,
): LadderedExitPlan {
  // Target price = entry + full edge captured
  const targetPrice = side === "YES"
    ? Math.min(0.99, entryPrice + edge)
    : Math.max(0.01, entryPrice - edge);

  // Use only as many tiers as we have contracts (can't split 3 contracts into 5 tiers)
  const activeTierCount = Math.min(EXIT_TIERS.length, totalContracts);
  const activeTiers = EXIT_TIERS.slice(0, activeTierCount);

  // Redistribute percentages to sum to 1.0 for the active tiers
  const activePctSum = activeTiers.reduce((s, t) => s + t.pct, 0);

  const tiers: ExitTier[] = activeTiers.map((tier, i) => {
    const normalizedPct = tier.pct / activePctSum;
    const tierContracts = Math.floor(totalContracts * normalizedPct);
    const tierTarget = side === "YES"
      ? entryPrice + (targetPrice - entryPrice) * tier.target_pct
      : entryPrice - (entryPrice - targetPrice) * tier.target_pct;

    return {
      tier: i,
      contracts: Math.max(1, tierContracts),
      target_price: Math.round(tierTarget * 100) / 100,
      pct_of_position: normalizedPct,
      executed: false,
      executed_at: null,
      executed_price: null,
    };
  });

  // Adjust last tier to absorb rounding remainder (guaranteed non-negative
  // because activeTierCount <= totalContracts)
  const allocated = tiers.reduce((s, t) => s + t.contracts, 0);
  if (allocated !== totalContracts && tiers.length > 0) {
    tiers[tiers.length - 1].contracts += totalContracts - allocated;
  }

  return { position_id: positionId, ticker, side, total_contracts: totalContracts, entry_price: entryPrice, target_price: targetPrice, tiers };
}

// Release a tranche when position exits (called from index.ts callbacks)
// Looks up by positionId first, then by ticker as fallback
export function releaseTranche(idOrTicker: string, pnl: number) {
  const tranche = tranches.find(t => t.position_id === idOrTicker)
    ?? tranches.find(t => t.ticker === idOrTicker && !t.available);
  if (!tranche) return;

  tranche.available = true;
  tranche.capital_usd += pnl; // Reinvest profits into the tranche
  if (tranche.capital_usd < 0) tranche.capital_usd = 0;
  tranche.position_id = null;
  tranche.ticker = null;
  tranche.entry_price = null;
  tranche.contracts = 0;
  tranche.side = null;
  tranche.entered_at = null;
  tranche.last_exit_at = Date.now();
  tranche.total_round_trips++;
  tranche.total_pnl_usd += pnl;

  // Clean up exit plan (try idOrTicker directly, or look up from tranche)
  exitPlans.delete(idOrTicker);
  // If idOrTicker was a ticker fallback, also try to find plan by scanning
  for (const [key, plan] of exitPlans) {
    if (plan.ticker === idOrTicker) { exitPlans.delete(key); break; }
  }
}

// Get exit plan for a position (for position manager to check tier targets)
export function getExitPlan(positionId: string): LadderedExitPlan | null {
  return exitPlans.get(positionId) ?? null;
}

// Mark an exit tier as executed
export function markTierExecuted(positionId: string, tierIndex: number, executedPrice: number) {
  const plan = exitPlans.get(positionId);
  if (!plan || tierIndex >= plan.tiers.length) return;

  plan.tiers[tierIndex].executed = true;
  plan.tiers[tierIndex].executed_at = Date.now();
  plan.tiers[tierIndex].executed_price = executedPrice;
}

// Get velocity metrics
export function getVelocityMetrics(): VelocityMetrics {
  const active = tranches.filter(t => !t.available);
  const available = tranches.filter(t => t.available);
  const totalRoundTrips = tranches.reduce((s, t) => s + t.total_round_trips, 0);
  const totalPnl = tranches.reduce((s, t) => s + t.total_pnl_usd, 0);

  // Turnover: round trips per hour across all tranches
  const hoursRunning = Math.max(0.01, (Date.now() - engineStartedAt) / (60 * 60 * 1000));
  const avgTurnover = totalRoundTrips / hoursRunning;

  return {
    total_tranches: tranches.length,
    active_tranches: active.length,
    available_tranches: available.length,
    avg_turnover_per_hour: avgTurnover,
    total_round_trips: totalRoundTrips,
    total_velocity_pnl: totalPnl,
  };
}

// Get all tranches (for dashboard)
export function getAllTranches(): Tranche[] {
  return [...tranches];
}

// Get all active exit plans (for dashboard)
export function getAllExitPlans(): LadderedExitPlan[] {
  return [...exitPlans.values()];
}

// Create a passthrough allocation for bankrolls below the velocity gate
export function createPassthrough(contracts: number, capitalUsd: number): VelocityAllocation {
  return {
    tranche_id: -1,
    capital_usd: capitalUsd,
    contracts,
    exit_plan: {
      position_id: "passthrough",
      ticker: "",
      side: "YES",
      total_contracts: contracts,
      entry_price: 0,
      target_price: 0,
      tiers: [],
    },
    passthrough: true,
  };
}
