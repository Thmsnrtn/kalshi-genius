// src/genius/counterfactual_engine.ts
//
// COUNTERFACTUAL LEARNING
//
// A normal trader learns from actual outcomes: "I bought, I won."
// A genius trader learns from paths not taken: "What would have happened
// if I had passed? If I had taken the opposite side? If I had sized 2x?
// If I had waited 5 minutes?"
//
// This multiplies the learning rate by ~10x because every decision
// produces multiple data points instead of just one.
//
// HOW IT WORKS:
// 1. For every trade, we store the full state at decision time
// 2. When the market resolves, we compute outcomes for ALL alternatives
// 3. Each alternative becomes a training signal for the evolution layer
// 4. The bot learns "I should have done X" as strongly as "I did Y and it worked"

import { getDb } from "../core/db.js";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";
import { recordEpisode } from "../evolution/memory.js";

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface Counterfactual {
  scenario: "actual" | "pass" | "reverse" | "half_size" | "double_size" | "wait_5min" | "skip_low_confidence";
  would_have_pnl: number;
  regret: number; // actual_pnl - counterfactual_pnl (positive = we made right call)
  lesson: string;
}

export function initCounterfactuals() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS counterfactuals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT NOT NULL,
      decision_state TEXT NOT NULL,
      actual_direction TEXT NOT NULL,
      actual_size REAL NOT NULL,
      actual_pnl REAL,
      resolved_at INTEGER,
      resolution_outcome TEXT,
      alternatives_json TEXT,
      total_regret REAL,
      key_lesson TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cf_signal ON counterfactuals(signal_id);
  `);
}

// ── Store decision state for later counterfactual analysis ──
export function recordDecisionState(params: {
  signalId: string;
  marketQuestion: string;
  yesPrice: number;
  noPrice: number;
  actualDirection: "YES" | "NO" | "SKIP";
  actualSize: number;
  strategy: string;
  bankroll: number;
  confidence: number;
  councilVerdict?: any;
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO counterfactuals (signal_id, decision_state, actual_direction, actual_size)
    VALUES (?, ?, ?, ?)
  `).run(
    params.signalId,
    JSON.stringify(params),
    params.actualDirection,
    params.actualSize
  );
}

// ── Compute counterfactuals after resolution ──
export async function computeCounterfactuals(signalId: string, marketResolvedYES: boolean): Promise<Counterfactual[]> {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM counterfactuals WHERE signal_id = ?`).get(signalId) as any;
  if (!row) return [];

  const state = JSON.parse(row.decision_state);
  const alternatives: Counterfactual[] = [];

  // Compute actual outcome
  let actualPnl: number;
  if (state.actualDirection === "SKIP") {
    actualPnl = 0;
  } else if (state.actualDirection === "YES") {
    actualPnl = marketResolvedYES 
      ? state.actualSize * (1 - state.yesPrice) / state.yesPrice  // Won
      : -state.actualSize; // Lost
  } else {
    actualPnl = !marketResolvedYES
      ? state.actualSize * (1 - state.noPrice) / state.noPrice
      : -state.actualSize;
  }

  // Scenario: PASS (did nothing)
  alternatives.push({
    scenario: "pass",
    would_have_pnl: 0,
    regret: actualPnl - 0,
    lesson: actualPnl > 0 ? "Taking action was correct" : "Should have passed",
  });

  // Scenario: REVERSE (took opposite side)
  let reversePnl: number;
  if (state.actualDirection === "YES" || state.actualDirection === "SKIP") {
    reversePnl = !marketResolvedYES
      ? state.actualSize * (1 - state.noPrice) / state.noPrice
      : -state.actualSize;
  } else {
    reversePnl = marketResolvedYES
      ? state.actualSize * (1 - state.yesPrice) / state.yesPrice
      : -state.actualSize;
  }
  alternatives.push({
    scenario: "reverse",
    would_have_pnl: reversePnl,
    regret: actualPnl - reversePnl,
    lesson: reversePnl > actualPnl ? "The opposite side was correct!" : "Direction was right",
  });

  // Scenario: HALF SIZE
  alternatives.push({
    scenario: "half_size",
    would_have_pnl: actualPnl * 0.5,
    regret: actualPnl - (actualPnl * 0.5),
    lesson: actualPnl > 0 ? "Full size was better" : "Half size would have hurt less",
  });

  // Scenario: DOUBLE SIZE (subject to risk limits)
  alternatives.push({
    scenario: "double_size",
    would_have_pnl: actualPnl * 2,
    regret: actualPnl - (actualPnl * 2),
    lesson: actualPnl > 0 ? "Could have made 2x" : "Full size already too large",
  });

  // Total regret across all alternatives
  const totalRegret = alternatives.reduce((s, a) => s + Math.abs(a.regret), 0);

  // Identify biggest lesson
  const sortedByRegret = [...alternatives].sort((a, b) => b.regret - a.regret);
  const bestAlternative = sortedByRegret[0];
  let keyLesson = "";
  if (bestAlternative && bestAlternative.regret > actualPnl) {
    keyLesson = `MISSED OPPORTUNITY: ${bestAlternative.scenario} would have been better`;
  } else {
    keyLesson = actualPnl > 0 ? "Good decision, no regret" : "Bad trade but no better alternative available";
  }

  // Update the counterfactual record
  db.prepare(`
    UPDATE counterfactuals 
    SET actual_pnl = ?, resolved_at = ?, resolution_outcome = ?, 
        alternatives_json = ?, total_regret = ?, key_lesson = ?
    WHERE signal_id = ?
  `).run(
    actualPnl, Date.now(), marketResolvedYES ? "YES" : "NO",
    JSON.stringify(alternatives), totalRegret, keyLesson, signalId
  );

  // Record as an episode for memory
  recordEpisode(
    `Trade on ${state.marketQuestion.slice(0, 50)}: ${state.actualDirection} $${state.actualSize.toFixed(2)}`,
    { state, alternatives, actualPnl },
    actualPnl > 0 ? "win" : "loss",
    keyLesson,
    signalId
  );

  return alternatives;
}

// ── Get regret statistics (am I making the right calls overall?) ──
export interface RegretStats {
  total_counterfactuals: number;
  avg_regret: number;
  biggest_regret_scenario: string;
  opportunities_missed: number; // Times an alternative would have been much better
  correct_decisions: number;    // Times actual was the best choice
  decision_quality: number;     // 0.0-1.0
}

export function getRegretStats(lookbackMs = 24 * 60 * 60 * 1000): RegretStats {
  const db = getDb();
  const since = Date.now() - lookbackMs;
  const rows = db.prepare(`
    SELECT * FROM counterfactuals 
    WHERE resolved_at >= ? AND actual_pnl IS NOT NULL
  `).all(since) as any[];

  if (rows.length === 0) {
    return { total_counterfactuals: 0, avg_regret: 0, biggest_regret_scenario: "", opportunities_missed: 0, correct_decisions: 0, decision_quality: 0 };
  }

  let opportunitiesMissed = 0;
  let correctDecisions = 0;
  const scenarioRegrets: Record<string, number> = {};
  let totalRegret = 0;

  for (const row of rows) {
    const alts = JSON.parse(row.alternatives_json ?? "[]") as Counterfactual[];
    const bestAlt = alts.reduce((best, a) => a.would_have_pnl > best.would_have_pnl ? a : best, alts[0]);

    if (bestAlt && bestAlt.would_have_pnl > row.actual_pnl * 1.5) {
      opportunitiesMissed++;
    } else {
      correctDecisions++;
    }

    totalRegret += row.total_regret ?? 0;
    for (const alt of alts) {
      scenarioRegrets[alt.scenario] = (scenarioRegrets[alt.scenario] ?? 0) + Math.abs(alt.regret);
    }
  }

  const biggestRegret = Object.entries(scenarioRegrets).sort(([, a], [, b]) => b - a)[0];

  return {
    total_counterfactuals: rows.length,
    avg_regret: totalRegret / rows.length,
    biggest_regret_scenario: biggestRegret?.[0] ?? "",
    opportunities_missed: opportunitiesMissed,
    correct_decisions: correctDecisions,
    decision_quality: correctDecisions / rows.length,
  };
}

// ── Claude-powered counterfactual insight ──
export async function extractCounterfactualInsight(lookbackHours = 6): Promise<{ insights: string[] }> {
  const db = getDb();
  const since = Date.now() - lookbackHours * 60 * 60 * 1000;
  const rows = db.prepare(`
    SELECT * FROM counterfactuals 
    WHERE resolved_at >= ? AND key_lesson LIKE 'MISSED%'
    ORDER BY total_regret DESC LIMIT 20
  `).all(since) as any[];

  if (rows.length < 3) return { insights: [] };

  const narrative = rows.map((r, i) => {
    const state = JSON.parse(r.decision_state);
    return `${i + 1}. Market: ${state.marketQuestion.slice(0, 60)}\n   Took: ${r.actual_direction} $${r.actual_size.toFixed(2)} → $${(r.actual_pnl ?? 0).toFixed(2)}\n   Lesson: ${r.key_lesson}`;
  }).join("\n");

  const res = await client.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 1500,
    system: `You analyze trading counterfactuals. Identify SYSTEMATIC mistakes — patterns where the bot consistently made suboptimal choices.
Focus on actionable insights that would change future behavior. You MUST call the "insights" tool.`,
    tools: [{
      name: "insights",
      description: "Counterfactual insights",
      input_schema: {
        type: "object" as const,
        properties: {
          insights: {
            type: "array",
            items: { type: "string" },
            description: "Specific, actionable insights (2-5 items)",
          },
        },
        required: ["insights"],
      },
    }],
    messages: [{
      role: "user",
      content: `Here are ${rows.length} missed-opportunity counterfactuals:\n\n${narrative}\n\nWhat SYSTEMATIC patterns do you see? What should the bot do differently?`,
    }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return { insights: [] };
  return { insights: (toolUse.input as any).insights ?? [] };
}
