// src/strategies/cross_correlation.ts — Cross-Market Logical Contradiction Finder
//
// THE EDGE: "Chiefs are an AFC team. If they win, an AFC team wins. But
// Chiefs individual win probability was priced HIGHER than 'any AFC team wins.'"
// These persist because traders focus on single markets, not relationships.
//
// Uses Claude to identify semantic relationships between markets,
// then checks for mathematical impossibilities.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface CorrelationSignal {
  market_a: { question: string; condition_id: string; yes_price: number; token_id: string };
  market_b: { question: string; condition_id: string; yes_price: number; token_id: string };
  relationship: "subset" | "superset" | "mutually_exclusive" | "correlated";
  contradiction: string;
  trade_action: string;  // e.g., "Buy B (superset), price should be >= A"
  edge: number;
  confidence: number;
}

// ── Use Claude to find related market pairs ──
export async function findCorrelatedPairs(
  markets: Array<{ question: string; condition_id: string; tokens: any[] }>
): Promise<CorrelationSignal[]> {
  if (markets.length < 10) return [];

  // Send market list to Claude to identify logical relationships
  const marketList = markets.slice(0, 60).map((m, i) => {
    const yes = m.tokens?.find((t: any) => t.outcome === "Yes");
    return `${i}: "${m.question}" — YES: $${parseFloat(yes?.price ?? "0.5").toFixed(2)}`;
  }).join("\n");

  const res = await client.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 2000,
    system: `You are a prediction market analyst looking for LOGICAL CONTRADICTIONS between related markets.

A contradiction exists when:
- Market A is a SUBSET of Market B (e.g., "Chiefs win" is a subset of "AFC team wins"), but A is priced HIGHER than B. This is mathematically impossible.
- Two markets are MUTUALLY EXCLUSIVE but their combined YES prices sum to more than $1.00.
- Market A IMPLIES Market B, but B is priced lower than A.

You MUST call the "contradictions" tool. If no contradictions exist, return an empty array.
Only flag relationships where the math is CLEARLY wrong, not just slightly off.`,
    tools: [{
      name: "contradictions",
      description: "List of logical contradictions found",
      input_schema: {
        type: "object" as const,
        properties: {
          pairs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index_a: { type: "number", description: "Index of market A" },
                index_b: { type: "number", description: "Index of market B" },
                relationship: { type: "string", enum: ["subset", "superset", "mutually_exclusive", "correlated"] },
                explanation: { type: "string", description: "Why this is a contradiction" },
                trade: { type: "string", description: "What to buy/sell to exploit it" },
                edge_estimate: { type: "number", description: "Estimated edge as decimal" },
              },
              required: ["index_a", "index_b", "relationship", "explanation", "trade", "edge_estimate"],
            },
          },
        },
        required: ["pairs"],
      },
    }],
    messages: [{
      role: "user",
      content: `Analyze these Polymarket markets for LOGICAL CONTRADICTIONS — situations where the prices are mathematically impossible given the relationship between events:\n\n${marketList}`,
    }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use" && b.name === "contradictions");
  if (!toolUse || toolUse.type !== "tool_use") return [];

  const input = toolUse.input as { pairs: any[] };
  const signals: CorrelationSignal[] = [];

  for (const pair of (input.pairs ?? [])) {
    const mA = markets[pair.index_a];
    const mB = markets[pair.index_b];
    if (!mA || !mB) continue;

    const yesA = mA.tokens?.find((t: any) => t.outcome === "Yes");
    const yesB = mB.tokens?.find((t: any) => t.outcome === "Yes");
    if (!yesA || !yesB) continue;

    signals.push({
      market_a: {
        question: mA.question,
        condition_id: mA.condition_id,
        yes_price: parseFloat(yesA.price ?? "0.5"),
        token_id: yesA.token_id ?? "",
      },
      market_b: {
        question: mB.question,
        condition_id: mB.condition_id,
        yes_price: parseFloat(yesB.price ?? "0.5"),
        token_id: yesB.token_id ?? "",
      },
      relationship: pair.relationship,
      contradiction: pair.explanation,
      trade_action: pair.trade,
      edge: pair.edge_estimate,
      confidence: 0.8, // High — these are logical, not probabilistic
    });
  }

  return signals;
}
