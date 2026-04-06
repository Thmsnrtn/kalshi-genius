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

  // ── Cycle Sniper (short-duration crypto) ──
  SNIPER_SYMBOLS: ["btcusdt", "ethusdt", "solusdt"],
  SNIPER_ENTRY_WINDOW_START: 25,    // Enter between 25 seconds...
  SNIPER_ENTRY_WINDOW_END: 5,       // ...and 5 seconds before cycle end
  SNIPER_MIN_CONTRACT_PRICE: 0.82,  // Only buy contracts priced $0.82-$0.96
  SNIPER_MAX_CONTRACT_PRICE: 0.96,  // (these are near-certain outcomes)
  SNIPER_MIN_MOMENTUM_PCT: 0.10,    // Minimum 0.10% confirmed move on exchange
  SNIPER_ORACLE_CHECK: true,        // Cross-check Chainlink oracle (Itan Scott's Bot 2)
  SNIPER_SCAN_INTERVAL_MS: 3000,    // Scan every 3 seconds

  // ── NegRisk Scanner ──
  NEGRISK_SCAN_INTERVAL_MS: 60000,  // Scan every 1 minute
  NEGRISK_MIN_SPREAD: 0.02,         // Min 2% spread after fees
  NEGRISK_MIN_DEPTH: 50,            // Min $50 liquidity at ask

  // ── Claude Analysis ──
  CLAUDE_SCAN_INTERVAL_MS: 180000,  // Every 3 minutes
  CLAUDE_MARKETS_PER_SCAN: 8,       // Analyze top 8 markets
  MIN_MARKET_LIQUIDITY: 5000,

  // ── APIs ──
  CLOB_API_URL: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
  GAMMA_API_URL: process.env.GAMMA_API_URL ?? "https://gamma-api.polymarket.com",
  POLYMARKET_PRIVATE_KEY: process.env.POLYMARKET_PRIVATE_KEY ?? "",
  POLYMARKET_WALLET_ADDRESS: process.env.POLYMARKET_WALLET_ADDRESS ?? "",
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
