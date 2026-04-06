// src/genius/strategy_genetics.ts
//
// STRATEGY BREEDING VIA GENETIC ALGORITHM
//
// Current bot has 5 static strategies. A genius bot INVENTS new strategies
// by combining and mutating the ones that work.
//
// Each strategy is encoded as a "genome" — a set of parameters and
// conditions. The genetic algorithm:
//
// 1. FITNESS: Each strategy is scored by risk-adjusted returns
// 2. SELECTION: Top performers are selected as "parents"
// 3. CROSSOVER: Two parents create a child with traits from both
// 4. MUTATION: Random parameter tweaks introduce variation
// 5. TOURNAMENT: New strategies compete with existing ones
// 6. CULLING: Losers are archived, winners become new strategies
//
// Over time, the bot's strategy portfolio EVOLVES to match market conditions.

import { getDb } from "../core/db.js";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface StrategyGenome {
  id: number;
  name: string;
  parent_1?: string;
  parent_2?: string;
  generation: number;
  // Genome parameters
  min_edge: number;
  min_confidence: number;
  max_position_pct: number;
  preferred_regime: string[];
  preferred_categories: string[];
  preferred_hours: number[];
  entry_conditions: string; // JSON
  exit_conditions: string;  // JSON
  // Fitness
  trials: number;
  wins: number;
  total_pnl: number;
  sharpe: number;
  fitness: number;
  status: "active" | "testing" | "archived";
  created_at: number;
}

export function initStrategyGenetics() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategy_genomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      parent_1 TEXT,
      parent_2 TEXT,
      generation INTEGER DEFAULT 0,
      min_edge REAL DEFAULT 0.08,
      min_confidence REAL DEFAULT 0.6,
      max_position_pct REAL DEFAULT 0.08,
      preferred_regime TEXT DEFAULT '[]',
      preferred_categories TEXT DEFAULT '[]',
      preferred_hours TEXT DEFAULT '[]',
      entry_conditions TEXT DEFAULT '{}',
      exit_conditions TEXT DEFAULT '{}',
      trials INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      total_pnl REAL DEFAULT 0,
      sharpe REAL DEFAULT 0,
      fitness REAL DEFAULT 0,
      status TEXT DEFAULT 'testing',
      created_at INTEGER NOT NULL
    );
  `);
  // Seed with base strategies as generation 0
  seedBaseGenomes();
}

function seedBaseGenomes() {
  const db = getDb();
  const bases = [
    { name: "cycle_sniper_gen0", min_edge: 0.08, min_confidence: 0.7, max_position_pct: 0.10, regime: ["TRENDING_UP", "TRENDING_DOWN", "QUIET"], categories: ["crypto"] },
    { name: "negrisk_arb_gen0", min_edge: 0.02, min_confidence: 0.99, max_position_pct: 0.15, regime: [], categories: [] },
    { name: "mispricing_gen0", min_edge: 0.10, min_confidence: 0.6, max_position_pct: 0.06, regime: ["QUIET", "NEWS_DRIVEN"], categories: [] },
    { name: "cross_corr_gen0", min_edge: 0.08, min_confidence: 0.75, max_position_pct: 0.08, regime: [], categories: [] },
    { name: "whale_consensus_gen0", min_edge: 0.05, min_confidence: 0.65, max_position_pct: 0.05, regime: [], categories: [] },
  ];
  for (const b of bases) {
    db.prepare(`
      INSERT OR IGNORE INTO strategy_genomes 
      (name, generation, min_edge, min_confidence, max_position_pct, preferred_regime, preferred_categories, status, created_at)
      VALUES (?, 0, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      b.name, b.min_edge, b.min_confidence, b.max_position_pct,
      JSON.stringify(b.regime), JSON.stringify(b.categories), Date.now()
    );
  }
}

// ── Compute fitness score for a genome ──
function computeFitness(genome: any): number {
  if (genome.trials < 10) return 0; // Insufficient data
  const winRate = genome.wins / genome.trials;
  const avgPnl = genome.total_pnl / genome.trials;
  // Fitness = win rate × avg pnl × sharpe, penalized by low sample size
  const sampleBoost = Math.min(1, genome.trials / 50);
  return winRate * avgPnl * (genome.sharpe || 1) * sampleBoost;
}

// ── Update fitness after trials ──
export function updateFitness(name: string, won: boolean, pnl: number) {
  const db = getDb();
  const g = db.prepare(`SELECT * FROM strategy_genomes WHERE name = ?`).get(name) as any;
  if (!g) return;

  const newTrials = g.trials + 1;
  const newWins = g.wins + (won ? 1 : 0);
  const newPnl = g.total_pnl + pnl;

  // Rough Sharpe approximation
  const avgPnl = newPnl / newTrials;
  const sharpe = avgPnl > 0 ? Math.min(5, avgPnl / Math.max(0.1, Math.abs(avgPnl) * 0.5)) : 0;

  const fitness = computeFitness({ trials: newTrials, wins: newWins, total_pnl: newPnl, sharpe });

  db.prepare(`
    UPDATE strategy_genomes
    SET trials = ?, wins = ?, total_pnl = ?, sharpe = ?, fitness = ?
    WHERE name = ?
  `).run(newTrials, newWins, newPnl, sharpe, fitness, name);
}

// ── Selection: pick top performers as parents ──
function selectParents(count = 2): any[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM strategy_genomes 
    WHERE trials >= 10 AND status = 'active' AND fitness > 0
    ORDER BY fitness DESC LIMIT ?
  `).all(count) as any[];
}

// ── Crossover: combine two parents into a child ──
function crossover(parent1: any, parent2: any, generation: number): Omit<StrategyGenome, "id"> {
  // Average numerical params, randomly pick categorical
  const random = Math.random;

  const childName = `gen${generation}_${parent1.name.split("_")[0]}x${parent2.name.split("_")[0]}_${Date.now() % 10000}`;
  const p1Regime = JSON.parse(parent1.preferred_regime || "[]");
  const p2Regime = JSON.parse(parent2.preferred_regime || "[]");
  const childRegime = [...new Set([...p1Regime, ...p2Regime])].filter(() => random() > 0.3);
  const p1Cats = JSON.parse(parent1.preferred_categories || "[]");
  const p2Cats = JSON.parse(parent2.preferred_categories || "[]");
  const childCats = [...new Set([...p1Cats, ...p2Cats])].filter(() => random() > 0.3);

  return {
    name: childName,
    parent_1: parent1.name,
    parent_2: parent2.name,
    generation,
    min_edge: (parent1.min_edge + parent2.min_edge) / 2,
    min_confidence: (parent1.min_confidence + parent2.min_confidence) / 2,
    max_position_pct: (parent1.max_position_pct + parent2.max_position_pct) / 2,
    preferred_regime: childRegime,
    preferred_categories: childCats,
    preferred_hours: [],
    entry_conditions: "{}",
    exit_conditions: "{}",
    trials: 0,
    wins: 0,
    total_pnl: 0,
    sharpe: 0,
    fitness: 0,
    status: "testing",
    created_at: Date.now(),
  };
}

// ── Mutation: random tweaks to a genome ──
function mutate(genome: Omit<StrategyGenome, "id">): Omit<StrategyGenome, "id"> {
  const mutationRate = 0.3;
  const mutated = { ...genome };
  if (Math.random() < mutationRate) mutated.min_edge *= 0.8 + Math.random() * 0.4;
  if (Math.random() < mutationRate) mutated.min_confidence = Math.max(0.5, Math.min(0.95, mutated.min_confidence + (Math.random() - 0.5) * 0.1));
  if (Math.random() < mutationRate) mutated.max_position_pct *= 0.8 + Math.random() * 0.4;
  return mutated;
}

// ── BREED: create a new strategy from the best ones ──
export async function breed(): Promise<{ created: boolean; child?: string }> {
  const parents = selectParents(2);
  if (parents.length < 2) return { created: false };

  const db = getDb();
  const generation = Math.max(...parents.map((p) => p.generation)) + 1;
  let child = crossover(parents[0], parents[1], generation);
  child = mutate(child);

  db.prepare(`
    INSERT INTO strategy_genomes 
    (name, parent_1, parent_2, generation, min_edge, min_confidence, max_position_pct,
     preferred_regime, preferred_categories, preferred_hours, entry_conditions, exit_conditions, 
     status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    child.name, child.parent_1 ?? null, child.parent_2 ?? null, child.generation,
    child.min_edge, child.min_confidence, child.max_position_pct,
    JSON.stringify(child.preferred_regime),
    JSON.stringify(child.preferred_categories),
    JSON.stringify(child.preferred_hours),
    child.entry_conditions, child.exit_conditions,
    "testing", child.created_at
  );

  return { created: true, child: child.name };
}

// ── CULL: archive underperforming strategies ──
export function cullWeakStrategies(): { archived: string[] } {
  const db = getDb();
  const weak = db.prepare(`
    SELECT name FROM strategy_genomes 
    WHERE status = 'testing' AND trials >= 15 AND fitness <= 0
  `).all() as any[];

  for (const w of weak) {
    db.prepare(`UPDATE strategy_genomes SET status = 'archived' WHERE name = ?`).run(w.name);
  }

  // Promote testing strategies with strong fitness
  const winners = db.prepare(`
    SELECT name FROM strategy_genomes 
    WHERE status = 'testing' AND trials >= 20 AND fitness > 0.5
  `).all() as any[];

  for (const w of winners) {
    db.prepare(`UPDATE strategy_genomes SET status = 'active' WHERE name = ?`).run(w.name);
  }

  return { archived: weak.map((w) => w.name) };
}

// ── Get all active strategies ──
export function getActiveStrategies(): StrategyGenome[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM strategy_genomes WHERE status = 'active' ORDER BY fitness DESC`).all() as StrategyGenome[];
}

// ── Claude-guided strategy invention ──
// Instead of random mutation, ask Claude to design a new strategy
export async function inventStrategy(marketContext: string): Promise<{ invented: boolean; name?: string }> {
  const activeStrategies = getActiveStrategies();
  const report = activeStrategies.map((s) => 
    `${s.name}: ${s.trials} trials, ${(s.wins/Math.max(1,s.trials)*100).toFixed(0)}% WR, fitness ${s.fitness.toFixed(2)}`
  ).join("\n");

  const res = await client.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 1500,
    system: `You are a trading strategy inventor. You review the current portfolio of strategies and invent a NEW strategy that fills a gap or improves on existing ones.
Be creative but grounded. The strategy must be implementable with the bot's existing capabilities.
You MUST call the "new_strategy" tool.`,
    tools: [{
      name: "new_strategy",
      description: "New strategy invention",
      input_schema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Short snake_case name" },
          rationale: { type: "string", description: "Why this strategy fills a gap" },
          min_edge: { type: "number" },
          min_confidence: { type: "number" },
          max_position_pct: { type: "number" },
          preferred_regimes: { type: "array", items: { type: "string" } },
          preferred_categories: { type: "array", items: { type: "string" } },
          entry_rule: { type: "string", description: "When to enter in plain English" },
          exit_rule: { type: "string", description: "When to exit in plain English" },
        },
        required: ["name", "rationale", "min_edge", "min_confidence", "max_position_pct", "preferred_regimes", "preferred_categories", "entry_rule", "exit_rule"],
      },
    }],
    messages: [{
      role: "user",
      content: `Current strategies and their performance:\n\n${report}\n\nMarket context: ${marketContext}\n\nInvent a NEW strategy that fills a gap or outperforms these.`,
    }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return { invented: false };

  const input = toolUse.input as any;
  const db = getDb();
  const uniqueName = `invented_${input.name}_${Date.now() % 10000}`;

  db.prepare(`
    INSERT INTO strategy_genomes 
    (name, generation, min_edge, min_confidence, max_position_pct,
     preferred_regime, preferred_categories, entry_conditions, exit_conditions,
     status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'testing', ?)
  `).run(
    uniqueName, 99, // Generation 99 = claude-invented
    input.min_edge, input.min_confidence, input.max_position_pct,
    JSON.stringify(input.preferred_regimes),
    JSON.stringify(input.preferred_categories),
    JSON.stringify({ rule: input.entry_rule, rationale: input.rationale }),
    JSON.stringify({ rule: input.exit_rule }),
    Date.now()
  );

  return { invented: true, name: uniqueName };
}

export function getGeneticsReport(): { active: number; testing: number; archived: number; generations: number; top_fitness: number } {
  const db = getDb();
  const all = db.prepare(`SELECT * FROM strategy_genomes`).all() as any[];
  return {
    active: all.filter((g) => g.status === "active").length,
    testing: all.filter((g) => g.status === "testing").length,
    archived: all.filter((g) => g.status === "archived").length,
    generations: Math.max(...all.map((g) => g.generation), 0),
    top_fitness: Math.max(...all.map((g) => g.fitness), 0),
  };
}
