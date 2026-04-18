// src/genius/cognitive_council.ts
//
// Cost optimization: Bull/Bear/Quant/Sage use Haiku (~$0.01 each),
// Judge uses Sonnet (~$0.03) for the final synthesis. Total ~$0.07/deliberation.
//
// THE COGNITIVE COUNCIL
//
// Instead of one Claude analyzing each trade, FOUR specialized Claude
// personas debate it, then a FIFTH synthesizes their positions into
// a final decision. This is how real trading desks work — multiple
// perspectives forced to defend themselves against each other.
//
// THE FOUR COUNCIL MEMBERS:
//
// 🔴 THE BULL  - Aggressive, seeks upside, argues the thesis FOR the trade
// 🔵 THE BEAR  - Skeptical, seeks risks, argues the thesis AGAINST
// 🟢 THE QUANT - Pure numbers, base rates, no narrative, statistical view
// 🟣 THE SAGE  - Meta-level: "What are we all missing? What would make us wrong?"
//
// THE JUDGE:
// ⚖️  THE JUDGE - Reviews all four positions, identifies crux of disagreement,
//                 weighs evidence, issues final verdict with confidence level.
//
// This architecture achieves what single-prompt analysis cannot:
// - Each persona specializes, avoiding jack-of-all-trades mediocrity
// - Adversarial structure surfaces hidden assumptions
// - The Sage provides epistemic humility (knowing what we don't know)
// - The Judge forces synthesis rather than averaging

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface CouncilVerdict {
  verdict: "TAKE" | "PASS" | "REVERSE";
  direction: "YES" | "NO" | "SKIP";
  confidence: number;      // 0.0-1.0
  probability: number;     // Fair value estimate
  edge: number;
  size_multiplier: number; // 0.0-1.5 — how much of base size to use
  council_agreement: number; // How unified the council is
  // Positions
  bull_thesis: string;
  bear_thesis: string;
  quant_view: string;
  sage_insight: string;
  judge_reasoning: string;
  // Meta
  crux: string;            // The key disagreement
  what_would_change_mind: string; // Epistemic humility
}

// ═══ THE BULL ═══
async function bullAnalyze(question: string, description: string, yesPrice: number, noPrice: number, category: string) {
  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    system: `You are THE BULL — an aggressive prediction market trader who argues FOR taking positions.
Your job: find the strongest possible thesis for why this market is a BUY.
You lean into stories, narratives, and momentum. You're not reckless, but you're biased toward action.
You identify upside catalysts, overlooked evidence, and reasons the market is underpricing an outcome.
Be SPECIFIC and ACTIONABLE. Give your best bull case, with a direction and confidence.
You MUST call the "bull_position" tool.`,
    tools: [{
      name: "bull_position",
      description: "The bull case for this market",
      input_schema: {
        type: "object" as const,
        properties: {
          direction: { type: "string", enum: ["YES", "NO"], description: "Which side to buy" },
          thesis: { type: "string", description: "The strongest bull case" },
          probability: { type: "number", description: "Your probability estimate" },
          catalysts: { type: "array", items: { type: "string" }, description: "Specific catalysts" },
          confidence: { type: "number", description: "0.0-1.0" },
        },
        required: ["direction", "thesis", "probability", "catalysts", "confidence"],
      },
    }],
    messages: [{
      role: "user",
      content: `Market: ${question}\nDescription: ${description}\nYES: $${yesPrice.toFixed(3)} | NO: $${noPrice.toFixed(3)}\nCategory: ${category}\n\nGive me the bull case. Which side should we buy and WHY?`,
    }],
  });
  const toolUse = res.content.find((b) => b.type === "tool_use");
  return toolUse?.type === "tool_use" ? (toolUse.input as any) : null;
}

// ═══ THE BEAR ═══
async function bearAnalyze(question: string, description: string, yesPrice: number, noPrice: number, category: string, bullPosition: any) {
  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    system: `You are THE BEAR — a skeptical prediction market trader who argues AGAINST positions.
Your job: find every reason the Bull might be WRONG.
You identify risks, overconfidence, missing information, and scenarios where this trade fails.
You're not a permabear — if the Bull is right, acknowledge it, but STRESS TEST the thesis hard.
You must propose either: (a) take the opposite side, (b) pass entirely, or (c) confirm a weaker version of the bull thesis.
You MUST call the "bear_position" tool.`,
    tools: [{
      name: "bear_position",
      description: "The bear case and critique",
      input_schema: {
        type: "object" as const,
        properties: {
          critique: { type: "string", description: "What's wrong with the bull case" },
          risks: { type: "array", items: { type: "string" }, description: "Specific risks" },
          alternative_direction: { type: "string", enum: ["YES", "NO", "SKIP"], description: "What YOU would do" },
          alternative_probability: { type: "number", description: "Your probability estimate" },
          bull_blind_spot: { type: "string", description: "What the bull is missing" },
        },
        required: ["critique", "risks", "alternative_direction", "alternative_probability", "bull_blind_spot"],
      },
    }],
    messages: [{
      role: "user",
      content: `Market: ${question}\nDescription: ${description}\nYES: $${yesPrice.toFixed(3)} | NO: $${noPrice.toFixed(3)}\n\nBULL POSITION:\nDirection: ${bullPosition?.direction}\nThesis: ${bullPosition?.thesis}\nProbability: ${bullPosition?.probability}\n\nCRITIQUE this bull case. What's being missed? What could make this trade lose?`,
    }],
  });
  const toolUse = res.content.find((b) => b.type === "tool_use");
  return toolUse?.type === "tool_use" ? (toolUse.input as any) : null;
}

// ═══ THE QUANT ═══
async function quantAnalyze(question: string, description: string, yesPrice: number, noPrice: number, category: string) {
  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 700,
    system: `You are THE QUANT — a pure numbers analyst with zero narrative bias.
Your job: compute base rates. Ignore stories entirely. Work from reference classes.
For this market, identify the CORRECT reference class and compute the historical base rate.
- Political markets: historical frequency of similar outcomes
- Crypto short-duration: base rate is ~50% (random walk over short periods)
- Sports: team statistics, ELO, head-to-head history
- Economic: historical frequency of the exact condition being asked
Be ruthlessly statistical. If you don't have data, SAY you don't have data.
You MUST call the "quant_view" tool.`,
    tools: [{
      name: "quant_view",
      description: "Statistical view",
      input_schema: {
        type: "object" as const,
        properties: {
          reference_class: { type: "string", description: "The correct reference class for this market" },
          base_rate: { type: "number", description: "Historical frequency of YES outcome" },
          sample_size: { type: "string", description: "How much data supports this base rate" },
          market_vs_base_rate: { type: "string", description: "Is market pricing above or below base rate?" },
          recommendation: { type: "string", enum: ["YES", "NO", "SKIP"], description: "Statistical recommendation" },
          epistemic_uncertainty: { type: "number", description: "0.0-1.0, how uncertain this base rate is" },
        },
        required: ["reference_class", "base_rate", "sample_size", "market_vs_base_rate", "recommendation", "epistemic_uncertainty"],
      },
    }],
    messages: [{
      role: "user",
      content: `Market: ${question}\nDescription: ${description}\nYES: $${yesPrice.toFixed(3)} | NO: $${noPrice.toFixed(3)}\nCategory: ${category}\n\nWhat does the DATA say? What's the base rate?`,
    }],
  });
  const toolUse = res.content.find((b) => b.type === "tool_use");
  return toolUse?.type === "tool_use" ? (toolUse.input as any) : null;
}

// ═══ THE SAGE ═══
async function sageAnalyze(question: string, bullPos: any, bearPos: any, quantPos: any) {
  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    system: `You are THE SAGE — the meta-level observer who watches the Bull, Bear, and Quant argue.
Your job: identify what ALL THREE are missing.
You ask: "What's the question none of us asked?" "What assumption is everyone making that might be wrong?" "What would change our minds entirely?"
You're not a fourth opinion — you're a HIGHER-LEVEL check on the entire conversation.
Look for: groupthink, framing effects, missing reference classes, unstated assumptions, tail scenarios.
Be brief and incisive. One or two genuine insights is better than a long list.
You MUST call the "sage_insight" tool.`,
    tools: [{
      name: "sage_insight",
      description: "Meta-level insight",
      input_schema: {
        type: "object" as const,
        properties: {
          what_all_missed: { type: "string", description: "The key thing all three agents overlooked" },
          hidden_assumption: { type: "string", description: "An assumption everyone is making" },
          what_would_change_verdict: { type: "string", description: "Specific evidence that would flip the call" },
          epistemic_confidence: { type: "number", description: "0.0-1.0, how confident in the debate quality" },
          recommended_action: { type: "string", enum: ["PROCEED", "PAUSE", "REVERSE", "REDUCE_SIZE"], description: "What to do given meta-analysis" },
        },
        required: ["what_all_missed", "hidden_assumption", "what_would_change_verdict", "epistemic_confidence", "recommended_action"],
      },
    }],
    messages: [{
      role: "user",
      content: `The council is debating: ${question}\n\nBULL: ${bullPos?.thesis} (${bullPos?.direction}, p=${bullPos?.probability})\nBEAR: ${bearPos?.critique} (alt: ${bearPos?.alternative_direction})\nQUANT: Base rate ${quantPos?.base_rate} (${quantPos?.recommendation})\n\nWhat are they ALL missing? What would make the whole debate different?`,
    }],
  });
  const toolUse = res.content.find((b) => b.type === "tool_use");
  return toolUse?.type === "tool_use" ? (toolUse.input as any) : null;
}

// ═══ THE JUDGE ═══
async function judgeVerdict(question: string, yesPrice: number, noPrice: number, bullPos: any, bearPos: any, quantPos: any, sageInsight: any): Promise<CouncilVerdict> {
  const res = await client.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 1200,
    system: `You are THE JUDGE — the final arbiter of the Cognitive Council.
You have received positions from the Bull, Bear, Quant, and Sage.
Your job: synthesize their views into a FINAL DECISION with calibrated confidence.

Decision framework:
1. Identify the CRUX — what is the key disagreement?
2. Weigh evidence — who has the strongest case and why?
3. Account for Sage's meta-observations
4. Decide: TAKE (execute), PASS (no edge), or REVERSE (flip direction)
5. Size based on council agreement — high agreement = larger size, dissent = smaller
6. Set confidence = f(council_agreement, quant_base_rate_certainty, edge_magnitude)

IMPORTANT BIAS TOWARD ACTION: You are running a high-frequency prediction market bot.
- The bot's edge is SPEED and TURNOVER — trading many short-duration markets, not holding long-term.
- If edge > 5% and at least 2 council members agree on direction, verdict should be TAKE.
- PASS should only be used when edge is truly negligible (<3%) or risk is extreme.
- Even moderate disagreement is OK — set a lower size_multiplier (0.3-0.6) rather than passing entirely.
- Markets resolve within hours to days. Fast capital turnover = more compounding cycles.
- Think of it this way: a 5% edge traded 20 times beats a 15% edge traded once.

You MUST call the "verdict" tool. Be DECISIVE — action with small size beats inaction.`,
    tools: [{
      name: "verdict",
      description: "Final council verdict",
      input_schema: {
        type: "object" as const,
        properties: {
          verdict: { type: "string", enum: ["TAKE", "PASS", "REVERSE"], description: "Final action" },
          direction: { type: "string", enum: ["YES", "NO", "SKIP"], description: "Which side" },
          probability: { type: "number", description: "Final fair value estimate (0-1)" },
          confidence: { type: "number", description: "0.0-1.0" },
          edge: { type: "number", description: "Probability minus market price, signed" },
          size_multiplier: { type: "number", description: "0.0-1.5, how much of base size to use" },
          council_agreement: { type: "number", description: "0.0-1.0, how aligned the council was" },
          crux: { type: "string", description: "The key point of disagreement" },
          judge_reasoning: { type: "string", description: "Why this verdict" },
          what_would_change_mind: { type: "string", description: "Specific evidence that would flip this" },
        },
        required: ["verdict", "direction", "probability", "confidence", "edge", "size_multiplier", "council_agreement", "crux", "judge_reasoning", "what_would_change_mind"],
      },
    }],
    messages: [{
      role: "user",
      content: `Market: ${question}\nYES: $${yesPrice.toFixed(3)} | NO: $${noPrice.toFixed(3)}\n\n=== COUNCIL POSITIONS ===\n\n🔴 BULL:\nDirection: ${bullPos?.direction} | Probability: ${bullPos?.probability}\nThesis: ${bullPos?.thesis}\nCatalysts: ${bullPos?.catalysts?.join(", ")}\n\n🔵 BEAR:\nAlt direction: ${bearPos?.alternative_direction} | Alt probability: ${bearPos?.alternative_probability}\nCritique: ${bearPos?.critique}\nRisks: ${bearPos?.risks?.join(", ")}\nBull blind spot: ${bearPos?.bull_blind_spot}\n\n🟢 QUANT:\nReference class: ${quantPos?.reference_class}\nBase rate: ${quantPos?.base_rate} | Sample: ${quantPos?.sample_size}\nRecommendation: ${quantPos?.recommendation}\nUncertainty: ${quantPos?.epistemic_uncertainty}\n\n🟣 SAGE:\nWhat all missed: ${sageInsight?.what_all_missed}\nHidden assumption: ${sageInsight?.hidden_assumption}\nAction rec: ${sageInsight?.recommended_action}\n\nISSUE YOUR VERDICT.`,
    }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return defaultVerdict(bullPos, bearPos, quantPos, sageInsight);
  }
  const input = toolUse.input as any;

  return {
    verdict: input.verdict,
    direction: input.direction,
    confidence: input.confidence,
    probability: input.probability,
    edge: input.edge,
    size_multiplier: input.size_multiplier,
    council_agreement: input.council_agreement,
    bull_thesis: bullPos?.thesis ?? "",
    bear_thesis: bearPos?.critique ?? "",
    quant_view: `${quantPos?.reference_class} base rate: ${quantPos?.base_rate}`,
    sage_insight: sageInsight?.what_all_missed ?? "",
    judge_reasoning: input.judge_reasoning,
    crux: input.crux,
    what_would_change_mind: input.what_would_change_mind,
  };
}

function defaultVerdict(bullPos: any, bearPos: any, quantPos: any, sageInsight: any): CouncilVerdict {
  return {
    verdict: "PASS", direction: "SKIP", confidence: 0, probability: 0.5, edge: 0,
    size_multiplier: 0, council_agreement: 0,
    bull_thesis: bullPos?.thesis ?? "", bear_thesis: bearPos?.critique ?? "",
    quant_view: "", sage_insight: sageInsight?.what_all_missed ?? "",
    judge_reasoning: "Council failed to produce verdict", crux: "", what_would_change_mind: "",
  };
}

// ═══ MAIN ENTRY POINT ═══
export async function convene(question: string, description: string, yesPrice: number, noPrice: number, category: string): Promise<CouncilVerdict> {
  // Run bull, quant in parallel (they don't need each other)
  const [bullPos, quantPos] = await Promise.all([
    bullAnalyze(question, description, yesPrice, noPrice, category),
    quantAnalyze(question, description, yesPrice, noPrice, category),
  ]);

  // Bear reads the bull position to critique it
  const bearPos = await bearAnalyze(question, description, yesPrice, noPrice, category, bullPos);

  // Quorum shortcut: if all three agree on SKIP/no-edge, skip Sage+Judge (saves 2 API calls)
  const bullDir = bullPos?.direction ?? "SKIP";
  const bearDir = bearPos?.alternative_direction ?? "SKIP";
  const quantDir = quantPos?.recommendation ?? "SKIP";
  if (bullDir === "SKIP" && bearDir === "SKIP" && quantDir === "SKIP") {
    console.log("  ⚡ Council quorum: unanimous SKIP — saving 2 API calls");
    return defaultVerdict(bullPos, bearPos, quantPos, null);
  }

  // Sage sees all three
  const sageInsight = await sageAnalyze(question, bullPos, bearPos, quantPos);

  // Judge synthesizes everything
  return judgeVerdict(question, yesPrice, noPrice, bullPos, bearPos, quantPos, sageInsight);
}
