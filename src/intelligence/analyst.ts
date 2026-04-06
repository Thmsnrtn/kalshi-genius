// src/intelligence/analyst.ts — Elite multi-pass Claude analysis engine
// Pass 1: Initial probability estimate with web search
// Pass 2: Adversarial challenge — argue the opposite side
// Pass 3: Final calibrated judgment incorporating both passes

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface EliteAnalysis {
  market_question: string;
  yes_price: number;
  no_price: number;
  // Pass 1
  initial_probability: number;
  initial_reasoning: string;
  // Pass 2
  adversarial_probability: number;
  adversarial_reasoning: string;
  // Pass 3 (final)
  final_probability: number;
  confidence: "low" | "medium" | "high";
  confidence_score: number; // 0-100
  edge: number;
  direction: "YES" | "NO" | "SKIP";
  final_reasoning: string;
  key_uncertainties: string;
  timestamp: string;
}

// ── PASS 1: Initial Analysis with Web Search ──
async function pass1_analyze(question: string, description: string, yesPrice: number, category: string) {
  const res = await client.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 1200,
    system: `You are a world-class prediction market analyst and probability calibrator.

CRITICAL CALIBRATION RULES:
- When you say 70%, events should happen 70% of the time
- Base rates matter more than narratives. Always anchor to base rates first.
- Recent evidence updates the base rate, it doesn't replace it
- "Possible" ≠ "probable". Most things are possible. Few are >60% likely.
- If you're uncertain, your probability should be closer to 50%, not further from it
- Markets are often roughly right. A 10%+ edge means the market is meaningfully wrong.

You MUST call the "estimate" tool with your structured response.`,
    tools: [
      {
        name: "estimate",
        description: "Your probability estimate",
        input_schema: {
          type: "object" as const,
          properties: {
            probability: { type: "number", description: "P(YES) from 0.01 to 0.99" },
            base_rate: { type: "string", description: "What base rate did you anchor to?" },
            key_evidence: { type: "string", description: "Most important evidence (2-3 sentences)" },
            confidence_score: { type: "number", description: "0-100 how confident in this estimate" },
          },
          required: ["probability", "base_rate", "key_evidence", "confidence_score"],
        },
      },
    ],
    messages: [{
      role: "user",
      content: `Analyze this prediction market. Search the web for the latest information.

Question: ${question}
Description: ${description || "N/A"}
Category: ${category}
Current YES price: $${yesPrice.toFixed(2)} (${(yesPrice * 100).toFixed(1)}% implied)

Step-by-step:
1. What is the historical base rate for this type of event?
2. What recent evidence updates that base rate?
3. What is your calibrated probability estimate?`,
    }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use" && b.name === "estimate");
  if (!toolUse || toolUse.type !== "tool_use") {
    return { probability: 0.5, reasoning: "Failed to get structured response", confidence: 30 };
  }
  const input = toolUse.input as any;
  return {
    probability: input.probability,
    reasoning: `Base rate: ${input.base_rate}. ${input.key_evidence}`,
    confidence: input.confidence_score,
  };
}

// ── PASS 2: Adversarial — Argue the Opposite ──
async function pass2_adversarial(question: string, pass1Prob: number, pass1Reasoning: string) {
  const oppositeDirection = pass1Prob > 0.5 ? "NO (the event will NOT happen)" : "YES (the event WILL happen)";

  const res = await client.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 800,
    system: `You are a contrarian analyst. Your job is to argue AGAINST the initial estimate. 
Find the strongest possible counterarguments. Be genuinely adversarial, not just devil's advocate.
You MUST call the "counter" tool.`,
    tools: [
      {
        name: "counter",
        description: "Your adversarial counter-estimate",
        input_schema: {
          type: "object" as const,
          properties: {
            counter_probability: { type: "number", description: "Your adversarial P(YES)" },
            strongest_argument: { type: "string", description: "Strongest argument against the initial estimate" },
            blind_spots: { type: "string", description: "What is the initial analysis missing?" },
          },
          required: ["counter_probability", "strongest_argument", "blind_spots"],
        },
      },
    ],
    messages: [{
      role: "user",
      content: `An analyst estimated P(YES) = ${pass1Prob.toFixed(2)} for:
"${question}"

Their reasoning: ${pass1Reasoning}

Make the strongest possible case for ${oppositeDirection}. Search the web for counterevidence. What are they missing?`,
    }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use" && b.name === "counter");
  if (!toolUse || toolUse.type !== "tool_use") {
    return { probability: 0.5, reasoning: "No adversarial response" };
  }
  const input = toolUse.input as any;
  return {
    probability: input.counter_probability,
    reasoning: `${input.strongest_argument} Blind spots: ${input.blind_spots}`,
  };
}

// ── PASS 3: Final Calibrated Judgment ──
async function pass3_calibrate(
  question: string, yesPrice: number,
  pass1: { probability: number; reasoning: string; confidence: number },
  pass2: { probability: number; reasoning: string }
) {
  const res = await client.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 800,
    system: `You are the final decision-maker. You've seen both sides of the argument.
Your job: synthesize into a final, well-calibrated probability and trading decision.

TRADING RULES:
- Only recommend a trade if your edge is >8 percentage points
- "high" confidence = you'd bet your own money
- "medium" = plausible edge but meaningful uncertainty
- "low" = too uncertain to trade
- When in doubt, SKIP. Capital preservation > capturing edge.

You MUST call the "decision" tool.`,
    tools: [{
      name: "decision",
      description: "Final trading decision",
      input_schema: {
        type: "object" as const,
        properties: {
          final_probability: { type: "number" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          confidence_score: { type: "number", description: "0-100" },
          direction: { type: "string", enum: ["YES", "NO", "SKIP"] },
          reasoning: { type: "string", description: "2-3 sentence synthesis" },
          key_uncertainties: { type: "string" },
        },
        required: ["final_probability", "confidence", "confidence_score", "direction", "reasoning", "key_uncertainties"],
      },
    }],
    messages: [{
      role: "user",
      content: `Question: "${question}"
Market YES price: $${yesPrice.toFixed(2)} (${(yesPrice * 100).toFixed(1)}% implied)

ANALYST 1 (initial): P(YES) = ${pass1.probability.toFixed(2)} (confidence: ${pass1.confidence}/100)
Reasoning: ${pass1.reasoning}

ANALYST 2 (adversarial): P(YES) = ${pass2.probability.toFixed(2)}
Counter: ${pass2.reasoning}

Synthesize both views. What is the TRUE probability? Is there a tradeable edge vs the $${yesPrice.toFixed(2)} market price?`,
    }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use" && b.name === "decision");
  if (!toolUse || toolUse.type !== "tool_use") {
    return { probability: 0.5, confidence: "low" as const, confidence_score: 0, direction: "SKIP" as const, reasoning: "No decision", uncertainties: "" };
  }
  const input = toolUse.input as any;
  return {
    probability: input.final_probability,
    confidence: input.confidence as "low" | "medium" | "high",
    confidence_score: input.confidence_score,
    direction: input.direction as "YES" | "NO" | "SKIP",
    reasoning: input.reasoning,
    uncertainties: input.key_uncertainties,
  };
}

// ── Full 3-Pass Analysis Pipeline ──
export async function eliteAnalyze(
  question: string,
  description: string,
  yesPrice: number,
  noPrice: number,
  category: string
): Promise<EliteAnalysis> {
  console.log("     🧠 Pass 1: Initial analysis + web search...");
  const p1 = await pass1_analyze(question, description, yesPrice, category);

  console.log(`     🤺 Pass 2: Adversarial challenge (P1=${p1.probability.toFixed(2)})...`);
  const p2 = await pass2_adversarial(question, p1.probability, p1.reasoning);

  console.log(`     ⚖️  Pass 3: Final calibration (P1=${p1.probability.toFixed(2)} vs P2=${p2.probability.toFixed(2)})...`);
  const p3 = await pass3_calibrate(question, yesPrice, p1, p2);

  const edge = p3.direction === "YES"
    ? p3.probability - yesPrice
    : p3.direction === "NO"
    ? (1 - p3.probability) - noPrice
    : 0;

  return {
    market_question: question,
    yes_price: yesPrice,
    no_price: noPrice,
    initial_probability: p1.probability,
    initial_reasoning: p1.reasoning,
    adversarial_probability: p2.probability,
    adversarial_reasoning: p2.reasoning,
    final_probability: p3.probability,
    confidence: p3.confidence,
    confidence_score: p3.confidence_score,
    edge: Math.round(edge * 100) / 100,
    direction: p3.direction,
    final_reasoning: p3.reasoning,
    key_uncertainties: p3.uncertainties,
    timestamp: new Date().toISOString(),
  };
}
