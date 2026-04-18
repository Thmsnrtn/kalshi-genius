// src/genius/genius_orchestrator.ts
//
// THE GENIUS ORCHESTRATOR
//
// This integrates the 5 genius modules into unified higher-order loops:
//
// - DELIBERATION: Before any major trade, convene the cognitive council
// - RETROSPECTION: After resolution, compute counterfactuals
// - VALIDATION: Patterns must pass hypothesis tests before becoming playbooks
// - INVENTION: Periodically breed new strategies via genetic algorithm
// - CALIBRATION: All probabilities get corrected based on historical bias
//
// These run on top of the evolution loops (reflex/micro/meso/macro/omega)
// creating a complete cognitive architecture.

import { convene, type CouncilVerdict } from "./cognitive_council.js";
export type { CouncilVerdict };
import { recordDecisionState, computeCounterfactuals, getRegretStats, extractCounterfactualInsight, initCounterfactuals } from "./counterfactual_engine.js";
import { initHypothesisLab, recordTrial, shouldTradeHypothesis, getLabReport, registerHypothesis, getValidatedHypotheses } from "./hypothesis_lab.js";
import { initStrategyGenetics, breed, cullWeakStrategies, inventStrategy, getGeneticsReport, updateFitness } from "./strategy_genetics.js";
import { initCalibration, recordPrediction, recordPredictionOutcome, calibrate, getCalibrationReport } from "./calibration_engine.js";

export interface GeniusState {
  council_convened: number;
  counterfactuals_computed: number;
  hypotheses_tested: number;
  strategies_bred: number;
  strategies_invented: number;
  calibration_corrections_applied: number;
  last_breed: number;
  last_invent: number;
  last_cull: number;
}

const state: GeniusState = {
  council_convened: 0,
  counterfactuals_computed: 0,
  hypotheses_tested: 0,
  strategies_bred: 0,
  strategies_invented: 0,
  calibration_corrections_applied: 0,
  last_breed: 0,
  last_invent: 0,
  last_cull: 0,
};

// ── Initialize all genius subsystems ──
export function initGenius() {
  initCounterfactuals();
  initHypothesisLab();
  initStrategyGenetics();
  initCalibration();
  console.log("🧠 GENIUS LAYER initialized: Council, Counterfactuals, Hypotheses, Genetics, Calibration");
}

// ── DELIBERATE: Convene council for high-stakes trades ──
export async function deliberate(
  question: string,
  description: string,
  yesPrice: number,
  noPrice: number,
  category: string,
  bankroll: number
): Promise<CouncilVerdict & { calibrated_probability: number; should_trade: boolean }> {
  state.council_convened++;

  const verdict = await convene(question, description, yesPrice, noPrice, category);

  // Apply calibration correction to council's probability estimate
  const calibratedProb = calibrate(verdict.probability, "cognitive_council");
  if (Math.abs(calibratedProb - verdict.probability) > 0.02) {
    state.calibration_corrections_applied++;
  }

  // Recompute edge with calibrated probability
  const marketPrice = verdict.direction === "YES" ? yesPrice : (verdict.direction === "NO" ? noPrice : 0.5);
  const calibratedEdge = verdict.direction === "YES" 
    ? calibratedProb - yesPrice 
    : (verdict.direction === "NO" ? (1 - calibratedProb) - noPrice : 0);

  // Record this prediction for future calibration
  recordPrediction(calibratedProb, "cognitive_council");

  // Decision gate: trade when edge exists and council leans toward action
  // Lowered agreement from 0.5→0.35 to allow 2-of-4 member consensus
  // Lowered edge from 0.05→0.03 — the calibration already corrected it
  const shouldTrade = verdict.verdict === "TAKE" &&
                      calibratedEdge > 0.03 &&
                      verdict.confidence > 0.4 &&
                      verdict.council_agreement > 0.35;

  return {
    ...verdict,
    calibrated_probability: calibratedProb,
    should_trade: shouldTrade,
  };
}

// ── RETROSPECT: Process resolution with counterfactual analysis ──
export function retrospect(params: {
  signalId: string;
  hypothesisName?: string;
  strategyName: string;
  won: boolean;
  pnl: number;
  marketResolvedYES: boolean;
  predictionId?: number;
}) {
  state.counterfactuals_computed++;

  // Counterfactual analysis
  computeCounterfactuals(params.signalId, params.marketResolvedYES).catch(() => {});

  // Update hypothesis test if registered
  if (params.hypothesisName) {
    recordTrial(params.hypothesisName, params.won);
    state.hypotheses_tested++;
  }

  // Update strategy genome fitness
  updateFitness(params.strategyName, params.won, params.pnl);

  // Update calibration
  if (params.predictionId) {
    recordPredictionOutcome(params.predictionId, params.won);
  }
}

// ── REGISTER DECISION: store state for counterfactual analysis ──
export function registerDecision(params: {
  signalId: string;
  marketQuestion: string;
  yesPrice: number;
  noPrice: number;
  direction: "YES" | "NO" | "SKIP";
  size: number;
  strategy: string;
  bankroll: number;
  confidence: number;
  verdict?: CouncilVerdict;
}) {
  recordDecisionState({
    signalId: params.signalId,
    marketQuestion: params.marketQuestion,
    yesPrice: params.yesPrice,
    noPrice: params.noPrice,
    actualDirection: params.direction,
    actualSize: params.size,
    strategy: params.strategy,
    bankroll: params.bankroll,
    confidence: params.confidence,
    councilVerdict: params.verdict,
  });
}

// Bankroll getter — set by startGeniusLoops
let _getBankroll: (() => number) | null = null;

// ── GENIUS CYCLE: runs every 30 minutes ──
// Breeding, culling, pattern discovery from counterfactuals
export async function geniusCycle() {
  // Bankroll gate: skip genius optimization when too small to justify API costs
  const currentBankroll = _getBankroll?.() ?? 0;
  if (currentBankroll < 25) {
    console.log(`  🧠 [Genius] Skipping cycle — bankroll $${currentBankroll.toFixed(2)} below $25 gate`);
    return;
  }

  console.log(`\n  🧠 [G] Genius cycle`);

  try {
    // 1. Counterfactual insights
    const insights = await extractCounterfactualInsight(6);
    if (insights.insights.length > 0) {
      console.log("     🔄 Counterfactual insights:");
      insights.insights.forEach((i) => console.log(`        • ${i}`));
    }

    // 2. Regret statistics
    const regret = getRegretStats();
    if (regret.total_counterfactuals > 0) {
      console.log(`     📊 Decision quality: ${(regret.decision_quality * 100).toFixed(0)}% optimal`);
      if (regret.opportunities_missed > regret.correct_decisions) {
        console.log(`     ⚠️  Missing more opportunities than capturing (${regret.opportunities_missed} missed)`);
      }
    }

    // 3. Hypothesis lab report
    const lab = getLabReport();
    if (lab.total_hypotheses > 0) {
      console.log(`     🔬 Hypothesis Lab: ${lab.validated} validated, ${lab.strong_support} strong, ${lab.rejected} rejected`);
      if (lab.top_edges.length > 0) {
        console.log(`     🏆 Top edges:`);
        lab.top_edges.slice(0, 3).forEach((e) => 
          console.log(`        • ${e.name}: ${(e.rate * 100).toFixed(0)}% (n=${e.trials}, p=${e.p.toFixed(3)})`)
        );
      }
    }

    // 4. Calibration report
    const cal = getCalibrationReport();
    if (cal.sources.some((s) => s.predictions >= 10)) {
      console.log(`     🎯 Calibration: Brier ${cal.overall_brier.toFixed(3)}, error ${(cal.overall_calibration_error * 100).toFixed(1)}%`);
      if (cal.is_overconfident) console.log(`     ⚠️  OVERCONFIDENT: predictions are higher than reality`);
      if (cal.is_underconfident) console.log(`     ⚠️  UNDERCONFIDENT: predictions are lower than reality`);
    }

    // 5. Strategy genetics
    const genetics = getGeneticsReport();
    console.log(`     🧬 Genetics: ${genetics.active} active, ${genetics.testing} testing, ${genetics.archived} archived, gen ${genetics.generations}`);

    // 6. Breed new strategies every 30 min if we have parents
    const now = Date.now();
    if (now - state.last_breed > 30 * 60 * 1000) {
      const bred = await breed();
      if (bred.created) {
        state.strategies_bred++;
        state.last_breed = now;
        console.log(`     👶 Bred new strategy: ${bred.child}`);
      }
    }

    // 7. Cull weak strategies every hour
    if (now - state.last_cull > 60 * 60 * 1000) {
      const culled = cullWeakStrategies();
      state.last_cull = now;
      if (culled.archived.length > 0) {
        console.log(`     ☠️  Culled ${culled.archived.length} weak strategies`);
      }
    }

    // 8. Claude-invented strategy every 2 hours
    if (now - state.last_invent > 2 * 60 * 60 * 1000) {
      const marketContext = `Current validated edges: ${lab.top_edges.map((e) => e.name).join(", ")}. Need to fill gaps.`;
      const invented = await inventStrategy(marketContext);
      if (invented.invented) {
        state.strategies_invented++;
        state.last_invent = now;
        console.log(`     💡 Claude invented strategy: ${invented.name}`);
      }
    }
  } catch (err: any) {
    console.error(`     Genius cycle error: ${err.message}`);
  }
}

// ── Start genius loops ──
export function startGeniusLoops(getBankroll?: () => number) {
  _getBankroll = getBankroll ?? null;
  setInterval(() => geniusCycle().catch(console.error), 30 * 60 * 1000);
  setTimeout(() => geniusCycle().catch(console.error), 60 * 1000); // First run after 1 min
  console.log("✅ Genius loops engaged: Council deliberation + 30min genius cycles");
}

export function getGeniusState(): GeniusState {
  return { ...state };
}

// Register initial hypotheses for base strategies
export function registerBaseHypotheses() {
  registerHypothesis("cycle_sniper_wins_trending", "Cycle sniper wins in trending regimes", 0.30);
  registerHypothesis("negrisk_always_profitable", "NegRisk arb is risk-free", 0.48);
  registerHypothesis("mispricing_high_edge_wins", "Mispricing wins when edge > 15%", 0.25);
  registerHypothesis("council_unanimous_wins", "Unanimous council verdicts have higher win rate", 0.30);
  registerHypothesis("late_cycle_sniper_wins", "Sniper wins more in final 10s of cycle", 0.25);
  registerHypothesis("high_confidence_near_close", "85-94¢ markets closing <12h have >90% win rate", 0.10);
  registerHypothesis("gfs_ensemble_beats_nws", "GFS ensemble edge > NWS point forecast edge", 0.20);
  registerHypothesis("multi_model_consensus", "Multi-model ensemble wins when agreement >80%", 0.25);
}
