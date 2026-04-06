// src/evolution/prompt_evolver.ts
//
// PROMPT EVOLUTION
//
// The bot's Claude analysis prompts are not static. Every hour, the bot
// reviews which prompts produced winning analyses vs losing analyses,
// then asks Claude to REWRITE the prompts to amplify what works.
//
// This is meta-learning: the bot is learning HOW to ask Claude better.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";
import { getDb } from "../core/db.js";
import { getRecentEpisodes } from "./memory.js";

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export function initPromptEvolution() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL,
      prompt_type TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      trades_with_this_version INTEGER DEFAULT 0,
      wins_with_this_version INTEGER DEFAULT 0,
      pnl_with_this_version REAL DEFAULT 0,
      active INTEGER DEFAULT 0
    );
  `);

  // Seed initial prompts if empty
  const count = db.prepare(`SELECT COUNT(*) as c FROM prompt_versions`).get() as any;
  if (count.c === 0) seedInitialPrompts();
}

const INITIAL_ANALYST_PROMPT = `You are a world-class prediction market analyst.

CALIBRATION RULES:
- When you say 70%, events should happen 70% of the time
- Base rates matter more than narratives. Always anchor to base rates first.
- Recent evidence updates the base rate, it doesn't replace it
- If uncertain, your probability should be closer to 50%, not further from it
- Markets are often roughly right. A 10%+ edge means the market is meaningfully wrong.

You MUST call the "estimate" tool with your structured response.`;

function seedInitialPrompts() {
  const db = getDb();
  db.prepare(`
    INSERT INTO prompt_versions (version, prompt_type, prompt_text, created_at, active)
    VALUES (1, 'analyst_system', ?, ?, 1)
  `).run(INITIAL_ANALYST_PROMPT, Date.now());
}

// ── Get currently active prompt ──
export function getActivePrompt(promptType: string): { id: number; version: number; text: string } {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, version, prompt_text FROM prompt_versions
    WHERE prompt_type = ? AND active = 1 LIMIT 1
  `).get(promptType) as any;
  if (!row) return { id: 0, version: 1, text: INITIAL_ANALYST_PROMPT };
  return { id: row.id, version: row.version, text: row.prompt_text };
}

// ── Track a result from a specific prompt version ──
export function trackPromptResult(promptId: number, won: boolean, pnl: number) {
  const db = getDb();
  db.prepare(`
    UPDATE prompt_versions
    SET trades_with_this_version = trades_with_this_version + 1,
        wins_with_this_version = wins_with_this_version + ?,
        pnl_with_this_version = pnl_with_this_version + ?
    WHERE id = ?
  `).run(won ? 1 : 0, pnl, promptId);
}

// ── EVOLVE: Have Claude rewrite the prompt based on results ──
export async function evolveAnalystPrompt(): Promise<{ evolved: boolean; new_version?: number; reasoning?: string }> {
  const db = getDb();
  const current = getActivePrompt("analyst_system");

  // Get current version stats
  const stats = db.prepare(`SELECT * FROM prompt_versions WHERE id = ?`).get(current.id) as any;
  if (!stats || stats.trades_with_this_version < 15) {
    return { evolved: false }; // Not enough data
  }

  const winRate = stats.wins_with_this_version / stats.trades_with_this_version;
  const avgPnl = stats.pnl_with_this_version / stats.trades_with_this_version;

  // Get recent winning and losing episodes
  const episodes = getRecentEpisodes(30);
  const wins = episodes.filter((e) => e.outcome === "win").slice(0, 10);
  const losses = episodes.filter((e) => e.outcome === "loss").slice(0, 10);

  if (wins.length < 3 || losses.length < 3) return { evolved: false };

  console.log(`  🧬 Evolving analyst prompt (current v${current.version}, WR: ${(winRate * 100).toFixed(0)}%)...`);

  const res = await client.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 2500,
    system: `You are a meta-cognitive prompt engineer. You analyze a trading bot's performance with its current Claude analysis prompt and generate an IMPROVED version of that prompt.

Your goal: rewrite the prompt to amplify what's working and reduce what's failing. The new prompt should be specific, actionable, and grounded in the actual evidence from wins/losses.

Be SURGICAL. Don't rewrite everything. Identify 1-3 specific improvements that would shift behavior. Add specific warnings about failure modes you observed in losses. Reinforce winning patterns.

You MUST call the "evolved_prompt" tool.`,
    tools: [{
      name: "evolved_prompt",
      description: "Improved version of the analyst prompt",
      input_schema: {
        type: "object" as const,
        properties: {
          should_evolve: { type: "boolean", description: "Is there enough signal to warrant a new version?" },
          new_prompt: { type: "string", description: "The complete new system prompt" },
          changes: { type: "string", description: "Specific changes made and why" },
          expected_improvement: { type: "string", description: "What you expect this to fix" },
        },
        required: ["should_evolve", "new_prompt", "changes", "expected_improvement"],
      },
    }],
    messages: [{
      role: "user",
      content: `CURRENT PROMPT (version ${current.version}):
"""
${current.text}
"""

CURRENT PERFORMANCE:
- Trades: ${stats.trades_with_this_version}
- Win rate: ${(winRate * 100).toFixed(1)}%
- Avg PnL: $${avgPnl.toFixed(2)}

RECENT WINS (what's working):
${wins.map((w, i) => `${i + 1}. ${w.narrative} | Lesson: ${w.lesson}`).join("\n")}

RECENT LOSSES (what's failing):
${losses.map((l, i) => `${i + 1}. ${l.narrative} | Lesson: ${l.lesson}`).join("\n")}

Should we evolve this prompt? If yes, write an improved version that addresses the failure patterns while preserving the success patterns.`,
    }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use" && b.name === "evolved_prompt");
  if (!toolUse || toolUse.type !== "tool_use") return { evolved: false };

  const input = toolUse.input as any;
  if (!input.should_evolve) return { evolved: false };

  // Save new version, mark old as inactive
  const newVersion = current.version + 1;
  db.prepare(`UPDATE prompt_versions SET active = 0 WHERE prompt_type = 'analyst_system'`).run();
  db.prepare(`
    INSERT INTO prompt_versions (version, prompt_type, prompt_text, created_at, active)
    VALUES (?, 'analyst_system', ?, ?, 1)
  `).run(newVersion, input.new_prompt, Date.now());

  console.log(`  ✨ Evolved to v${newVersion}: ${input.changes.slice(0, 100)}...`);

  return {
    evolved: true,
    new_version: newVersion,
    reasoning: input.changes,
  };
}
