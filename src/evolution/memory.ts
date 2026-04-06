// src/evolution/memory.ts
//
// HIERARCHICAL MEMORY SYSTEM
// 
// Three layers, modeled after human memory architecture:
//
// 1. EPISODIC: Specific memories of individual trades and what happened
//    "On Tuesday at 3pm, I bought BTC YES at 0.91 and won."
//
// 2. SEMANTIC: Generalized patterns extracted from episodes
//    "BTC sniper trades win 94% when momentum > 0.15% AND time < 15s remaining"
//
// 3. PROCEDURAL: Refined playbooks the bot follows
//    "When BTC momentum > 0.15% AND remaining < 15s, buy YES at $0.85-0.95 with 8% sizing"
//
// The bot promotes episodes → patterns → playbooks as evidence accumulates.

import { getDb } from "../core/db.js";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export function initMemory() {
  const db = getDb();
  db.exec(`
    -- Episodic: individual trade memories with full context
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      signal_id TEXT,
      narrative TEXT NOT NULL,
      context_json TEXT,
      outcome TEXT,
      lesson TEXT
    );

    -- Semantic: discovered patterns
    CREATE TABLE IF NOT EXISTS patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL,
      conditions_json TEXT NOT NULL,
      observed_count INTEGER DEFAULT 0,
      win_rate REAL DEFAULT 0,
      avg_pnl REAL DEFAULT 0,
      confidence REAL DEFAULT 0,
      discovered_at INTEGER NOT NULL,
      last_validated INTEGER NOT NULL,
      status TEXT DEFAULT 'hypothesis'
    );

    -- Procedural: refined playbooks
    CREATE TABLE IF NOT EXISTS playbooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playbook_name TEXT UNIQUE NOT NULL,
      trigger_conditions TEXT NOT NULL,
      action TEXT NOT NULL,
      sizing_rule TEXT NOT NULL,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      promoted_from_pattern_id INTEGER,
      promoted_at INTEGER NOT NULL,
      active INTEGER DEFAULT 1
    );
  `);
}

// ── Record an episode ──
export function recordEpisode(narrative: string, context: any, outcome: string, lesson: string, signalId?: string) {
  const db = getDb();
  db.prepare(`
    INSERT INTO episodes (timestamp, signal_id, narrative, context_json, outcome, lesson)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(Date.now(), signalId ?? null, narrative, JSON.stringify(context), outcome, lesson);
}

// ── Promote a pattern from observed episodes ──
// Called by Claude during evolution cycles when it spots a recurring pattern
export function recordPattern(name: string, description: string, conditions: any) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO patterns 
    (pattern_name, description, conditions_json, discovered_at, last_validated, status)
    VALUES (?, ?, ?, ?, ?, 'hypothesis')
  `).run(name, description, JSON.stringify(conditions), Date.now(), Date.now());
}

// ── Update pattern with new observation ──
export function reinforcePattern(name: string, won: boolean, pnl: number) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM patterns WHERE pattern_name = ?`).get(name) as any;
  if (!row) return;

  const newCount = row.observed_count + 1;
  const newWinRate = ((row.win_rate * row.observed_count) + (won ? 1 : 0)) / newCount;
  const newAvgPnl = ((row.avg_pnl * row.observed_count) + pnl) / newCount;
  const confidence = Math.min(0.95, newCount / (newCount + 15));

  // Promote pattern to validated if enough evidence
  let status = row.status;
  if (newCount >= 10 && newWinRate >= 0.7 && confidence >= 0.4) status = "validated";
  else if (newCount >= 15 && newWinRate < 0.4) status = "rejected";

  db.prepare(`
    UPDATE patterns SET observed_count = ?, win_rate = ?, avg_pnl = ?, 
    confidence = ?, last_validated = ?, status = ? WHERE pattern_name = ?
  `).run(newCount, newWinRate, newAvgPnl, confidence, Date.now(), status, name);

  // Auto-promote validated patterns to playbooks
  if (status === "validated" && row.status !== "validated") {
    promoteToPlaybook(row.id, name, row.description, row.conditions_json);
  }
}

function promoteToPlaybook(patternId: number, name: string, description: string, conditionsJson: string) {
  const db = getDb();
  const conditions = JSON.parse(conditionsJson);
  db.prepare(`
    INSERT OR IGNORE INTO playbooks (playbook_name, trigger_conditions, action, sizing_rule, promoted_from_pattern_id, promoted_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    name,
    JSON.stringify(conditions),
    description,
    "kelly_quarter",
    patternId,
    Date.now()
  );
}

// ── Get active playbooks (the bot's current "knowledge") ──
export function getActivePlaybooks() {
  const db = getDb();
  return db.prepare(`SELECT * FROM playbooks WHERE active = 1 ORDER BY success_count DESC`).all() as any[];
}

// ── Get recent episodes for Claude to analyze ──
export function getRecentEpisodes(limit = 30): any[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM episodes ORDER BY timestamp DESC LIMIT ?`).all(limit) as any[];
}

// ── PATTERN DISCOVERY: Have Claude analyze episodes for patterns ──
export async function discoverPatterns(): Promise<{ discovered: number; details: string[] }> {
  const episodes = getRecentEpisodes(50);
  if (episodes.length < 10) return { discovered: 0, details: [] };

  const episodeText = episodes.map((e, i) => 
    `Episode ${i}: ${e.narrative} → ${e.outcome}. Lesson: ${e.lesson}`
  ).join("\n");

  const res = await client.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 2000,
    system: `You are a pattern recognition system analyzing trading bot episodes.
Your job: identify RECURRING patterns where specific conditions led to specific outcomes.
A pattern needs at least 3 supporting episodes. Be specific and actionable.
You MUST call the "patterns" tool.`,
    tools: [{
      name: "patterns",
      description: "Discovered patterns from episodes",
      input_schema: {
        type: "object" as const,
        properties: {
          patterns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Short snake_case identifier" },
                description: { type: "string", description: "What the pattern is" },
                conditions: { type: "string", description: "When it triggers (JSON)" },
                supporting_episodes: { type: "number", description: "How many episodes support this" },
                confidence: { type: "number", description: "0.0-1.0" },
              },
              required: ["name", "description", "conditions", "supporting_episodes", "confidence"],
            },
          },
        },
        required: ["patterns"],
      },
    }],
    messages: [{
      role: "user",
      content: `Analyze these trading episodes and identify patterns:\n\n${episodeText}\n\nWhat conditions consistently lead to wins? What conditions consistently lead to losses?`,
    }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use" && b.name === "patterns");
  if (!toolUse || toolUse.type !== "tool_use") return { discovered: 0, details: [] };

  const input = toolUse.input as { patterns: any[] };
  const details: string[] = [];

  for (const p of (input.patterns ?? [])) {
    if (p.supporting_episodes >= 3 && p.confidence >= 0.6) {
      try {
        recordPattern(p.name, p.description, JSON.parse(p.conditions));
        details.push(`📌 ${p.name}: ${p.description}`);
      } catch {}
    }
  }

  return { discovered: details.length, details };
}
