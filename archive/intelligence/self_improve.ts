// src/intelligence/self_improve.ts — Self-improvement loop
// Every N hours, Claude reviews its own trade history and generates
// updated strategy parameters and lessons learned

import Anthropic from "@anthropic-ai/sdk";
import { config, getPhaseParams } from "../core/config.js";
import { getDb } from "../core/db.js";

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface StrategyAdjustment {
  timestamp: string;
  trades_reviewed: number;
  win_rate: number;
  avg_edge_when_right: number;
  avg_edge_when_wrong: number;
  recommendations: string[];
  new_min_edge: number | null;
  new_min_confidence: string | null;
  categories_to_avoid: string[];
  categories_to_focus: string[];
  reasoning: string;
}

export async function runSelfImprovement(): Promise<StrategyAdjustment | null> {
  const db = getDb();

  // Get recent trade history
  const trades = db.prepare(`
    SELECT a.*, t.pnl, t.status
    FROM analyses a
    LEFT JOIN trades t ON a.condition_id = t.condition_id
    WHERE a.traded = 1
    ORDER BY a.timestamp DESC
    LIMIT 50
  `).all() as any[];

  const MIN_TRADES_FOR_REVIEW = 10;
  if (trades.length < MIN_TRADES_FOR_REVIEW) {
    console.log(`[Self-Improve] Only ${trades.length} trades, need ${MIN_TRADES_FOR_REVIEW}. Skipping.`);
    return null;
  }

  // Calculate stats
  const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = trades.filter((t) => (t.pnl ?? 0) < 0).length;
  const pending = trades.filter((t) => t.status === "open").length;

  // Get skip history too — what did we skip that we shouldn't have?
  const skips = db.prepare(`
    SELECT market_question, claude_probability, yes_price, no_price, 
           confidence, edge, direction, skip_reason, timestamp
    FROM analyses
    WHERE traded = 0 AND direction != 'SKIP'
    ORDER BY timestamp DESC
    LIMIT 30
  `).all() as any[];

  // Get category performance
  const categories = db.prepare(`
    SELECT 
      json_extract(a.reasoning, '$') as reasoning,
      COUNT(*) as count,
      SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END) as wins
    FROM analyses a
    LEFT JOIN trades t ON a.condition_id = t.condition_id
    WHERE a.traded = 1
    GROUP BY a.condition_id
  `).all() as any[];

  const tradeLog = trades.map((t) =>
    `- Q: "${(t.market_question ?? "").slice(0, 80)}" | Dir: ${t.direction} | Edge: ${((t.edge ?? 0) * 100).toFixed(1)}% | Conf: ${t.confidence} | P(YES): ${(t.claude_probability ?? 0).toFixed(2)} vs Market: $${(t.yes_price ?? 0).toFixed(2)} | PnL: ${t.pnl !== null ? `$${t.pnl.toFixed(2)}` : "pending"}`
  ).join("\n");

  const skipLog = skips.slice(0, 10).map((s) =>
    `- Q: "${(s.market_question ?? "").slice(0, 80)}" | Would have: ${s.direction} | Edge: ${((s.edge ?? 0) * 100).toFixed(1)}% | Conf: ${s.confidence} | Skip reason: ${s.skip_reason}`
  ).join("\n");

  console.log("[Self-Improve] Asking Claude to review performance...");

  const res = await client.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 1500,
    system: `You are a quantitative trading strategist reviewing an autonomous prediction market bot's performance. 
Be brutally honest. If the bot is losing money, say so and explain why.
Focus on actionable improvements, not platitudes.
You MUST call the "adjustments" tool.`,
    tools: [{
      name: "adjustments",
      description: "Strategy adjustments based on performance review",
      input_schema: {
        type: "object" as const,
        properties: {
          new_min_edge: { type: "number", description: "Adjusted minimum edge threshold (null to keep current)" },
          new_min_confidence: { type: "string", enum: ["low", "medium", "high"], description: "Adjusted confidence threshold" },
          categories_to_avoid: { items: { type: "string" }, type: "array", description: "Categories with negative performance" },
          categories_to_focus: { items: { type: "string" }, type: "array", description: "Categories with positive performance" },
          recommendations: { items: { type: "string" }, type: "array", description: "Top 3-5 specific, actionable recommendations" },
          reasoning: { type: "string", description: "Overall assessment of bot performance" },
        },
        required: ["recommendations", "reasoning"],
      },
    }],
    messages: [{
      role: "user",
      content: `Review this bot's recent performance and suggest improvements.

CURRENT SETTINGS:
- Min edge: ${(getPhaseParams(config.STARTING_BANKROLL).minEdge * 100).toFixed(0)}%
- Min confidence: high
- Kelly fraction: ${getPhaseParams(config.STARTING_BANKROLL).kelly}
- Max positions: ${getPhaseParams(config.STARTING_BANKROLL).maxPositions}

TRADE HISTORY (${trades.length} trades, ${wins} wins, ${losses} losses, ${pending} pending):
${tradeLog}

SKIPPED OPPORTUNITIES (top 10):
${skipLog}

Overall win rate: ${trades.length > 0 ? ((wins / (wins + losses || 1)) * 100).toFixed(1) : "N/A"}%

QUESTIONS TO ANSWER:
1. Is the bot's edge real or was it lucky?
2. Are there patterns in what it gets right vs wrong?
3. Should the minimum edge or confidence thresholds change?
4. Are there categories it should avoid or focus on?
5. What specific changes would improve performance?`,
    }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use" && b.name === "adjustments");
  if (!toolUse || toolUse.type !== "tool_use") return null;

  const input = toolUse.input as any;
  const adjustment: StrategyAdjustment = {
    timestamp: new Date().toISOString(),
    trades_reviewed: trades.length,
    win_rate: wins / (wins + losses || 1),
    avg_edge_when_right: 0,
    avg_edge_when_wrong: 0,
    recommendations: input.recommendations ?? [],
    new_min_edge: input.new_min_edge ?? null,
    new_min_confidence: input.new_min_confidence ?? null,
    categories_to_avoid: input.categories_to_avoid ?? [],
    categories_to_focus: input.categories_to_focus ?? [],
    reasoning: input.reasoning ?? "",
  };

  // Store adjustment in DB
  db.prepare(`
    INSERT INTO strategy_adjustments (timestamp, data) VALUES (?, ?)
  `).run(adjustment.timestamp, JSON.stringify(adjustment));

  return adjustment;
}
