// src/core/config.ts — Wildcard Edition: Tuned for explosive compounding

export const config = {
  // ── Mode ──
  DRY_RUN: (process.env.DRY_RUN ?? "true").toLowerCase() === "true",
  STARTING_BANKROLL: parseFloat(process.env.BANKROLL ?? "100"),

  // ══════════════════════════════════════════════════
  // STRATEGY ENABLES — all on by default
  // ══════════════════════════════════════════════════
  STRATEGY_CYCLE_SNIPER: true,     // The 0x8dxd $313→$438K strategy (adapted for makers)
  STRATEGY_NEGRISK_ARB: true,      // Risk-free multi-outcome arb ($29M extracted/year)
  STRATEGY_MISPRICING: true,       // 3-pass Claude probability analysis
  STRATEGY_CROSS_CORRELATION: true,// Logical contradictions between markets
  STRATEGY_WHALE_CONSENSUS: true,  // Smart money convergence signals

  // ══════════════════════════════════════════════════
  // AGGRESSIVE COMPOUNDING — the wildcard multiplier
  // ══════════════════════════════════════════════════
  // Phase 1: $100-500 — conservative, prove edge exists
  // Phase 2: $500-2000 — increase sizing, more strategies
  // Phase 3: $2000+ — full aggression, all strategies max
  PHASE_THRESHOLDS: [500, 2000, 10000],
  PHASE_KELLY: [0.20, 0.30, 0.35, 0.40],          // Quarter → third → higher Kelly as bankroll grows
  PHASE_MAX_POS_PCT: [0.06, 0.08, 0.10, 0.12],    // Max position % scales up
  PHASE_MAX_POSITIONS: [5, 8, 12, 20],             // More concurrent positions
  PHASE_MIN_EDGE: [0.10, 0.08, 0.06, 0.05],       // Lower edge threshold as we scale

  // ── Risk (hard limits that never change) ──
  ABSOLUTE_MAX_SINGLE_TRADE: 0.15,  // Never >15% on one trade regardless of phase
  DAILY_LOSS_LIMIT_PCT: 0.20,       // Stop after 20% daily loss
  CORRELATION_LIMIT: 0.30,          // Max 30% in correlated positions

  // ── Hourly Sniper (Kalshi crypto/finance close markets) ──
  SNIPER_SCAN_INTERVAL_MS: 60000,   // Scan every 1 minute (hourly markets, not 5-min)
  SNIPER_MIN_CONTRACT_PRICE: 0.82,  // Only buy contracts priced $0.82-$0.96
  SNIPER_MAX_CONTRACT_PRICE: 0.96,

  // ── Monotonicity Arb (Kalshi grouped markets) ──
  MONOTONICITY_SCAN_INTERVAL_MS: 60000,  // Scan every 1 minute
  MONOTONICITY_MIN_EDGE_CENTS: 2,        // Min 2 cents edge

  // ── Cross-Platform Scanner ──
  CROSS_PLATFORM_SCAN_INTERVAL_MS: 300000, // Every 5 minutes

  // ── Claude Analysis ──
  CLAUDE_SCAN_INTERVAL_MS: 180000,  // Every 3 minutes
  CLAUDE_MARKETS_PER_SCAN: 8,       // Analyze top 8 markets
  MIN_MARKET_LIQUIDITY: 0,  // Kalshi: filter by price presence, not volume

  // ── Kalshi ──
  KALSHI_ENV: (process.env.KALSHI_ENV ?? "demo") as "demo" | "production",
  KALSHI_API_KEY_ID: process.env.KALSHI_API_KEY_ID ?? "",
  KALSHI_PRIVATE_KEY_PATH: process.env.KALSHI_PRIVATE_KEY_PATH ?? "./kalshi_private_key.pem",

  // ── APIs ──
  GAMMA_API_URL: process.env.GAMMA_API_URL ?? "https://gamma-api.polymarket.com",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  CLAUDE_MODEL: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-20250514",

  // ── Whale Wallets ──
  WHALE_WALLETS: (process.env.WHALE_WALLETS ?? "0x9d84ce0306f8551e02efef1680475fc0f1dc1344,0xd218e474776403a330142299f7796e8ba32eb5c9").split(",").filter(Boolean),

  // ── Telegram ──
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",

  // ── Self-Improvement ──
  IMPROVEMENT_INTERVAL_MS: 6 * 60 * 60 * 1000, // Every 6 hours
};

// ── Dynamic phase-based parameters ──
export function getPhaseParams(bankroll: number) {
  let phase = 0;
  for (let i = 0; i < config.PHASE_THRESHOLDS.length; i++) {
    if (bankroll >= config.PHASE_THRESHOLDS[i]) phase = i + 1;
  }
  return {
    phase,
    kelly: config.PHASE_KELLY[phase],
    maxPosPct: config.PHASE_MAX_POS_PCT[phase],
    maxPositions: config.PHASE_MAX_POSITIONS[phase],
    minEdge: config.PHASE_MIN_EDGE[phase],
    label: ["🌱 Seed", "🌿 Growth", "🌳 Scale", "🚀 Full Power"][phase],
  };
}
