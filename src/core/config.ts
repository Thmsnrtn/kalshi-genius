// src/core/config.ts — BEAST MODE: Tuned for explosive $25 → $10k+ compounding

export const config = {
  // ── Mode ──
  DRY_RUN: (process.env.DRY_RUN ?? "true").toLowerCase() === "true",
  STARTING_BANKROLL: parseFloat(process.env.BANKROLL ?? "25"),

  // ══════════════════════════════════════════════════
  // STRATEGY ENABLES — all on by default
  // ══════════════════════════════════════════════════
  STRATEGY_CYCLE_SNIPER: true,
  STRATEGY_NEGRISK_ARB: true,
  STRATEGY_MISPRICING: true,
  STRATEGY_CROSS_CORRELATION: true,
  STRATEGY_WHALE_CONSENSUS: true,
  // Market maker re-enabled 2026-04-10: removed invalid status="active"
  // filter that returned 400 from Kalshi V2 API.
  STRATEGY_MARKET_MAKER: true,
  STRATEGY_WEATHER: true,
  STRATEGY_ECONOMIC: true,
  STRATEGY_HIGH_CONFIDENCE: true,
  STRATEGY_MULTI_MODEL: true,

  // ── High-Confidence Near-Close ──
  HIGH_CONFIDENCE_SCAN_INTERVAL_MS: 60000,  // Scan every 1 min
  HIGH_CONFIDENCE_MAX_TRADES: 6,            // Max 6 per day (small edge per trade)

  // ── Multi-Model Ensemble ──
  MULTI_MODEL_SCAN_INTERVAL_MS: 300000,     // Every 5 min (API cost conscious)
  MULTI_MODEL_MIN_EDGE: 0.12,              // 12% divergence required

  // ══════════════════════════════════════════════════
  // AGGRESSIVE COMPOUNDING — tuned for $25 start
  // ══════════════════════════════════════════════════
  // Phase 0: $25-100   — BEAST MODE: high frequency, aggressive sizing
  // Phase 1: $100-500  — Growth: still aggressive, more strategies
  // Phase 2: $500-2000 — Scale: diversified, steady compound
  // Phase 3: $2000+    — Full power: all strategies, max diversification
  PHASE_THRESHOLDS: [100, 500, 2000, 10000],
  PHASE_KELLY: [0.35, 0.30, 0.25, 0.20, 0.15],
  PHASE_MAX_POS_PCT: [0.30, 0.20, 0.12, 0.10, 0.08],
  PHASE_MAX_POSITIONS: [6, 10, 15, 20, 30],
  PHASE_MIN_EDGE: [0.03, 0.04, 0.05, 0.04, 0.03],

  // ── Trading Mode ──
  TURBO_ONLY_MODE: true,             // Only trade 15-min crypto turbo markets (KXBTC15M, KXETH15M, KXSOL15M, KXXRP15M)

  // ── Risk (hard limits) ──
  ABSOLUTE_MAX_SINGLE_TRADE: 0.30,   // Up from 0.15 — $25 needs concentration
  DAILY_LOSS_LIMIT_PCT: 0.25,        // Stop after 25% daily loss
  CORRELATION_LIMIT: 0.40,           // Allow more correlated positions when small

  // ── Position Management ──
  TAKE_PROFIT_PCT: 0.60,             // Exit when market moved 60% toward target — lock profits faster
  STOP_LOSS_PCT: 0.50,               // Cut at 50% of invested value lost
  TRAILING_STOP_PCT: 0.20,           // Trail 20% from peak — tighter to lock in gains
  MAX_HOLD_HOURS: 4,                 // Force exit after 4h — fast capital recycling for compounding
  SCALE_OUT_AT_PCT: 0.35,            // Sell half when 35% of target reached — early partial profits
  CHECK_POSITIONS_INTERVAL_MS: 30000, // Check exits every 30s — faster recycling

  // ── Hourly Sniper (Kalshi crypto/finance close markets) ──
  SNIPER_SCAN_INTERVAL_MS: 15000,    // Every 15s — aggressive turbo scanning
  SNIPER_MIN_CONTRACT_PRICE: 0.80,
  SNIPER_MAX_CONTRACT_PRICE: 0.97,

  // ── Monotonicity Arb (Kalshi grouped markets) ──
  MONOTONICITY_SCAN_INTERVAL_MS: 45000,
  MONOTONICITY_MIN_EDGE_CENTS: 2,

  // ── Cross-Platform Scanner ──
  CROSS_PLATFORM_SCAN_INTERVAL_MS: 180000,  // Down from 300s

  // ── Claude Analysis ──
  CLAUDE_SCAN_INTERVAL_MS: 180000,   // 3 min — faster scanning, Haiku is cheap (~$0.07/deliberation)
  CLAUDE_MARKETS_PER_SCAN: 5,        // Top 5 — cast a wider net
  MIN_MARKET_LIQUIDITY: 0,

  // ── Market Making ──
  MARKET_MAKER_MIN_SPREAD_CENTS: 8,  // Only make markets with 8+ cent spread
  MARKET_MAKER_ORDER_SIZE_PCT: 0.05, // 5% of bankroll per side
  MARKET_MAKER_MAX_INVENTORY: 3,     // Max 3 contracts one-sided before hedging
  MARKET_MAKER_REFRESH_MS: 120000,   // Refresh quotes every 2 min

  // ── Resolution Tracking ──
  RESOLUTION_CHECK_INTERVAL_MS: 120000,  // Check every 2 min
  PRICE_HISTORY_INTERVAL_MS: 60000,      // Snapshot prices every 1 min

  // ── Data Feeds ──
  FRED_API_KEY: process.env.FRED_API_KEY ?? "",  // Optional — works without key for basic access
  NWS_STATIONS: (process.env.NWS_STATIONS ?? "KNYC,KORD,KLAX,KDFW,KJFK").split(","),

  // ── Kalshi ──
  KALSHI_ENV: (process.env.KALSHI_ENV ?? "demo") as "demo" | "production",
  KALSHI_API_KEY_ID: process.env.KALSHI_API_KEY_ID ?? "",
  KALSHI_PRIVATE_KEY_PATH: process.env.KALSHI_PRIVATE_KEY_PATH ?? "./kalshi_private_key.pem",

  // ── APIs ──
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  CLAUDE_MODEL: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-20250514",

  // ── Whale Wallets ──
  WHALE_WALLETS: (process.env.WHALE_WALLETS ?? "0x9d84ce0306f8551e02efef1680475fc0f1dc1344,0xd218e474776403a330142299f7796e8ba32eb5c9").split(",").filter(Boolean),

  // ── Telegram ──
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",

  // ── Self-Improvement ──
  IMPROVEMENT_INTERVAL_MS: 4 * 60 * 60 * 1000,  // Down from 6h

  // ── Bankroll Milestones ──
  MILESTONES: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000],
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
    label: ["🔥 Beast ($25-100)", "🌿 Growth ($100-500)", "🌳 Scale ($500-2k)", "🚀 Power ($2k-10k)", "👑 Apex ($10k+)"][phase],
    aggressive: phase === 0,  // Beast mode when under $100
  };
}
