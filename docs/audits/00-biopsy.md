# Bot Biopsy — Full Repo Audit

**Date:** 2026-04-18
**Codebase:** ~57,000 lines across 54 TypeScript source files
**Runtime:** Bun 1.3, Docker on Fly.io (single machine `d892369b636558`)
**Database:** SQLite at `/data/polybot.db`, persisted via Fly volume

---

## 1. Architecture Overview

The bot has an 8-layer architecture, most of which was built for general prediction markets (Polymarket origin) and later adapted for Kalshi:

| Layer | Files | Purpose | 15-min Relevant? |
|-------|-------|---------|-------------------|
| **Strategies** | `kalshi_strategies.ts`, `turbo_brain.ts`, `turbo_tracker.ts`, `market_maker.ts`, `cross_correlation.ts`, `multi_model_ensemble.ts`, `whale_tracker.ts` | Signal generation | Partially — turbo_brain is purpose-built; others are generic |
| **Evolution** | `evolution_loop.ts`, `memory.ts`, `performance_tracker.ts`, `prompt_evolver.ts`, `regime_detector.ts`, `strategy_weights.ts` | Self-improvement | Partially — regime detector useful; evolution loop needs safeguards |
| **Genius** | `cognitive_council.ts`, `counterfactual_engine.ts`, `hypothesis_lab.ts`, `strategy_genetics.ts`, `calibration_engine.ts`, `genius_orchestrator.ts` | LLM-powered analysis | Mostly overhead — council deliberation too slow for 15-min windows |
| **Intelligence** | `analyst.ts`, `self_improve.ts` | Claude-based market analysis | Not applicable — designed for multi-day prediction markets |
| **Alpha Sources** | `alpha_orchestrator.ts`, `news_intelligence.ts`, `orderbook_microstructure.ts`, `whale_tracker_onchain.ts` | External data | Partially — orderbook microstructure useful; on-chain/news not for turbos |
| **Feeds** | `binance.ts`, `binance_advanced.ts`, `fred.ts`, `nws.ts`, `odds_movement.ts`, `open_meteo.ts` | Data ingestion | `binance.ts` + `binance_advanced.ts` are critical; FRED/NWS/weather irrelevant |
| **Core** | `config.ts`, `db.ts`, `risk.ts`, `position_manager.ts`, `resolution_tracker.ts`, `aggressive_kelly.ts`, `genius_signals.ts`, `smart_execution.ts`, `tax_tracker.ts`, `telemetry.ts`, `notify.ts` | Infrastructure | Mostly relevant — needs hardening |
| **Compound/Velocity/Liquidity** | `compound_engine.ts`, `velocity_engine.ts`, `velocity_orchestrator.ts`, 6x `liquidity/*.ts` | Advanced position mgmt | Overkill for current bankroll — adds complexity for no value at $5-$50 |

---

## 2. What's Actually Firing (vs Dead Code)

### Active and Trading
- **`turbo_brain.ts`** (1,949 lines) — The real engine. 18-signal composite scorer for 15-min crypto windows. This is purpose-built and sophisticated. It runs every 15 seconds.
- **`turbo_tracker.ts`** — Per-asset/per-signal win rate tracking, adaptive sizing, skip logic
- **Hourly sniper** in `kalshi_strategies.ts` — Scans for turbo markets, feeds them to turbo_brain
- **`binance.ts`** + **`binance_advanced.ts`** — REST price polling (5s intervals), OBI, VPIN, VWAP, funding rate, liquidation detection
- **`position_manager.ts`** — Exit management with turbo-specific smart exits (momentum reversal, early cut)
- **`resolution_tracker.ts`** — Tracks market settlement for PnL recording

### Running But Not Useful at Current Scale
- **`compound_engine.ts`** — Phase-based capital allocation. At $8 bankroll, phases are irrelevant
- **`velocity_engine.ts` / `velocity_orchestrator.ts`** — Multi-tranche entry. Can't split a $0.50 trade into tranches
- **`liquidity/*`** (6 files, ~1,200 lines) — Full market-making engine with adverse selection, inventory management, quote generation. Not firing because TURBO_ONLY_MODE=true
- **`market_maker.ts`** — Kalshi market-making strategy. Disabled by turbo-only mode
- **Evolution loop** — Running but fitness evaluation is shallow (no holdout validation, no regime stratification)
- **Genius council** — Running deliberations via Claude API. Adds latency and cost without clear edge attribution

### Truly Dead Code
- **`fred.ts`** / **`nws.ts`** / **`open_meteo.ts`** — Federal Reserve, National Weather Service, weather feeds. Zero relevance to crypto turbos
- **`whale_tracker.ts`** / `whale_tracker_onchain.ts` — On-chain whale tracking for Polymarket. Doesn't work on Kalshi
- **`cross_correlation.ts`** — Cross-platform arb (Polymarket vs Kalshi). Polymarket is no longer connected
- **`multi_model_ensemble.ts`** — Multi-LLM ensemble for prediction markets. Too slow and expensive for turbos
- **`analyst.ts`** / `self_improve.ts` — Claude-based market analysis for multi-day markets
- **Tax tracker** — Premature; needed at $10k+ not $8

---

## 3. Strategy Classification

### (a) Directly Applicable to 15-min Crypto Windows
1. **Turbo Brain** (`turbo_brain.ts`) — Purpose-built 18-signal composite scorer. This is the core.
2. **Turbo Tracker** (`turbo_tracker.ts`) — Per-asset learning, win rate tracking, adaptive sizing
3. **Hourly Sniper** (in `kalshi_strategies.ts`) — Market scanner that feeds turbo_brain
4. **Binance Feeds** (`binance.ts`, `binance_advanced.ts`) — Price data, OBI, VPIN, VWAP, funding, liquidation detection
5. **Regime Detector** (`regime_detector.ts`) — QUIET/TRENDING_UP/TRENDING_DOWN/VOLATILE classification

### (b) Adaptable
1. **Position Manager** — Exit logic is generic but has turbo-specific code. Keep and refine
2. **Resolution Tracker** — Needs market finalization PnL (V6 fix already applied). Keep
3. **Aggressive Kelly** — Sizing engine. Needs fee-awareness and minimum-viable-trade gating
4. **Risk module** — Daily loss limit exists but no auto-pause-to-paper. Critical gap
5. **Calibration Engine** — Brier score tracking. Good concept, needs to actually feed sizing decisions
6. **Config** — Phase thresholds tuned for $25 start, need adjustment for $5-$8 reality

### (c) Inapplicable — Archive
1. `fred.ts`, `nws.ts`, `open_meteo.ts` — Weather/economics feeds
2. `whale_tracker.ts`, `whale_tracker_onchain.ts` — On-chain tracking
3. `cross_correlation.ts` — Cross-platform arb
4. `multi_model_ensemble.ts` — Multi-LLM ensemble
5. `analyst.ts`, `self_improve.ts` — Long-horizon analysis
6. `liquidity/*` (6 files) — Market-making engine. Archive until bankroll > $500
7. `velocity_engine.ts`, `velocity_orchestrator.ts` — Multi-tranche entry. Archive until bankroll > $100
8. `compound_engine.ts` — Phase-based allocation. Overkill at current scale
9. `tax_tracker.ts` — Premature

---

## 4. Kalshi Adapter Audit

### `kalshi_client.ts` — Confirmed Working
- **Signing**: RSA-PSS with SHA-256, `Date.now()` millisecond timestamps. Confirmed working in production (bot is placing live orders).
- **Price parsing**: `parseKalshiMarket()` correctly converts dollar strings to cents via `Math.round(yesBid * 100)`. Also stores sub-cent precision.
- **`kalshiMarketToUnified()`**: Correctly computes mid-price in probability space: `(cents_bid + cents_ask) / 2 / 100`.
- **Sports filtering**: Triple-checks exclusion for Massachusetts legal compliance. Belt-and-suspenders.
- **`placeOrder()`**: Accepts `client_order_id` for idempotency — but callers don't always provide one.

### Bugs and Gaps
1. **No retry logic** — All API errors throw immediately. No distinction between transient (5xx, timeout) and permanent (4xx) errors. No rate-limit handling (429).
2. **No reconciliation on restart** — If bot crashes mid-order, orphaned positions are not detected. `getOrders()` and `getPositions()` exist but are never called on startup.
3. **Fixed 15s timeout** — Not configurable per-endpoint. Order placement may need longer.
4. **No startup position sync** — Bot doesn't query Kalshi positions on startup to reconcile with local SQLite state.

### `kalshi_websocket.ts`
1. **Reconnect limit** — Max 10 attempts with exponential backoff, then permanent disconnect. Should retry indefinitely for a 24/7 bot.
2. **Orderbook delta race** — If delta arrives before snapshot, update is silently dropped. No explicit resync on reconnect.
3. **Silent send failures** — If WebSocket not OPEN, send() drops commands without logging.
4. **No listener cleanup** — `on()` only, no `off()` — potential memory leak.

---

## 5. Risk Controls Audit

### What Exists
| Control | Status | Location |
|---------|--------|----------|
| Daily loss limit | **Exists** but snoozable | `risk.ts:47-59` — 25% daily limit, can be snoozed via dashboard |
| Per-trade max size | **Exists** | `config.ts:49` — 30% of bankroll cap |
| Max concurrent positions | **Exists** | `config.ts:42` — 6 in beast mode |
| Edge threshold | **Exists** | `risk.ts:63-79` — per-strategy minimums |
| Exposure limit | **Exists** | `risk.ts:82-90` — 80% max exposure in beast mode |
| Minimum bankroll | **Exists** | `risk.ts:50` — $0.50 floor |
| Consecutive loss circuit breaker | **Exists** in turbo_brain | `turbo_brain.ts:165-167` — reduces size after 2-4 losses, doesn't halt |
| Loss pattern blocking | **Exists** in turbo_brain | `turbo_brain.ts:95-106` — blocks repeated loss patterns |

### What's MISSING (Critical Gaps)
| Control | Status | Impact |
|---------|--------|--------|
| **Auto-pause-to-paper on bankroll decrease** | **DOES NOT EXIST** | Operator's #1 requirement. Bot will trade to $0 |
| **Bankroll watermark tracking** | **DOES NOT EXIST** | No drawdown-from-peak measurement |
| **Fee budget** | **DOES NOT EXIST** | No tracking of cumulative fees |
| **Correlation-aware position sizing** | **Partial** | turbo_brain has correlation penalty but it's cosmetic |
| **Global kill switch** | **Partial** | `paused` flag exists but no single-button emergency stop |
| **Heartbeat watchdog** | **DOES NOT EXIST** | If main loop hangs, no alert |
| **Strategy-level kill switch** | **Partial** | Config booleans exist but require restart to change |
| **Per-trade fee deduction** | **DOES NOT EXIST** | PnL calculations ignore Kalshi fees entirely |
| **Paper mode: realistic simulation** | **BROKEN** | Uses hardcoded 82% win rate coin flip, not real market outcomes |

---

## 6. Position Sizing Analysis

### Current Implementation
- **Kelly formula**: `edge / (1 - price)` in `aggressive_kelly.ts:105`
- **Multiplier chain**: bankroll_mult (1.5x at <$50) × strategy_mult (1.3x for sniper) × calibration × confidence_boost × streak_bonus
- **Then in turbo_brain**: another multiplier chain: size_mult × opponent_adj × explore_penalty × loss_pattern_adj × contrarian_boost × correlation_adj × regime_scale × compound_mult × growth_mult
- **Final cap**: 0.2x to 4.0x of base Kelly in turbo_brain, 30% of bankroll hard cap in config

### Problems
1. **Two separate sizing chains** — aggressive_kelly and turbo_brain both apply multipliers independently. Total multiplication can be absurd (1.5 × 1.3 × 1.2 × 1.5 × 1.3 × ... = easily 5x+ Kelly)
2. **No fee-aware sizing** — Kelly edge doesn't subtract expected fees/slippage
3. **Minimum bet floor at $0.50** rounds UP — If Kelly says $0.30, it trades $0.50 instead of skipping. This is anti-Kelly (taking on worse risk/reward than the model recommends)
4. **Streak bonus compounds danger** — 5% per consecutive win, up to 25%. After a lucky streak, sizing balloons right before the mean-reversion hit

---

## 7. Dashboard Assessment

### `page.html` — Recently Rewritten (V6)
- 4 tabs: Money, Trades, Controls, Chat
- SSE real-time updates every 5 seconds
- Equity curve with range selection (1H/1D/7D/30D)
- Growth target progress bar
- Asset performance bars
- Position detail sheet with live price chart

### What Works
- Clean mobile-first design
- Real-time balance updates
- Active position cards
- Mode indicator (PAPER/LIVE) prominent

### What's Missing
- **No mode switch reason** — When in PAPER, doesn't show why (manual vs auto-triggered)
- **No bankroll watermark** — Can't see distance to auto-pause threshold
- **No fee attribution** — Can't see how much fees are costing
- **No calibration curve** — Brier score not displayed
- **No signal skip log** — Can't see what the bot chose NOT to trade
- **Paper PnL is fake** — Shows inflated numbers from simulated resolution with 82% win rate

---

## 8. Paper Mode Assessment

### Current Implementation
- Trades fire, logged with `dry_run: true`
- Positions opened in SQLite same as live
- Resolution: `simulateResolution()` at line 1619 — runs 1-3 minutes after entry with hardcoded win probabilities (82% for hourly_sniper)
- Bankroll tracked via in-memory accumulator

### Problems
1. **Fake outcomes** — Win probabilities are hardcoded, not derived from actual market settlement. Paper PnL is meaningless for evaluating strategy quality
2. **Faster resolution** — 1-3 min vs 15 min real market. Temporal dynamics are completely different
3. **No fee simulation** — Paper trades don't deduct fees
4. **No slippage simulation** — Paper fills assume perfect execution at mid-price
5. **Calibration data is poisoned** — Paper outcomes feed the calibration engine with fake data, making the bot overconfident when it switches back to live

---

## 9. Key Strengths

1. **Turbo Brain is genuinely sophisticated** — 18-signal composite with signal accuracy tracking, opponent modeling, settlement probability model, multi-cycle memory, pre-market analysis. This is real quantitative work.
2. **Binance integration is solid** — OBI, VPIN, VWAP, funding rate, liquidation cascade detection. Good data foundation.
3. **Adaptive threshold** — Trade frequency adjusts based on brain win rate. Not just static thresholds.
4. **Loss pattern memory** — Blocks repeated losing patterns. Good defensive behavior.
5. **Regime awareness** — QUIET/TRENDING/VOLATILE classification influences both entry and sizing.

---

## 10. Key Weaknesses

1. **No auto-pause-to-paper** — The single most important safety mechanism doesn't exist
2. **Paper mode is broken** — Fake outcomes poison learning data
3. **Fee-blind** — No part of the system accounts for Kalshi fees in edge calculations or PnL
4. **Massive dead code** — ~60% of the codebase (weather, whales, cross-platform, market making, velocity, liquidity, multi-model) adds cognitive load and startup overhead for zero value
5. **No reconciliation** — Bot doesn't know about orphaned positions after restart
6. **Double-barrel sizing** — Two independent multiplier chains can produce dangerously large positions
7. **No startup position sync** — Local state can diverge from Kalshi reality after any crash
8. **Evolution loop has no overfitting safeguards** — No holdout validation, no rollback on degradation
9. **Genius council is latency/cost overhead** — Claude API calls for trade decisions in a 15-minute market

---

## 11. Files to Change (Phase 1 Surgery)

### Archive to `/archive/`
- `src/feeds/fred.ts`
- `src/feeds/nws.ts`
- `src/feeds/open_meteo.ts`
- `src/strategies/whale_tracker.ts`
- `src/alpha_sources/whale_tracker_onchain.ts`
- `src/strategies/cross_correlation.ts`
- `src/strategies/multi_model_ensemble.ts`
- `src/intelligence/analyst.ts`
- `src/intelligence/self_improve.ts`
- `src/liquidity/` (entire directory, 6 files)
- `src/velocity/` (entire directory, 2 files)
- `src/compound/compound_engine.ts`
- `src/core/tax_tracker.ts`
- `src/core/smart_execution.ts` (multi-tranche entry, useless at $8)

### Modify
- `src/index.ts` — Remove imports/wiring for archived modules. This will be a major cleanup
- `src/core/config.ts` — Remove irrelevant config. Adjust defaults for $5-$10 bankroll reality
- `src/core/risk.ts` — Add auto-pause-to-paper, bankroll watermark
- `src/core/aggressive_kelly.ts` — Add fee-awareness, fix minimum-bet rounding
- `src/core/position_manager.ts` — Simplify exit logic now that velocity/liquidity are archived
- `src/dashboard/server.ts` — Remove archived module references, add new metrics
- `src/dashboard/page.html` — Add auto-pause status, watermark display, fee tracking
- `src/strategies/kalshi/turbo_brain.ts` — Fee-aware edge calculation, fix paper mode simulation
- `src/exchanges/kalshi/kalshi_client.ts` — Add retry logic, error classification
- `src/exchanges/kalshi/kalshi_websocket.ts` — Remove reconnect limit, add resync

### Keep As-Is
- `src/feeds/binance.ts` — Working well
- `src/feeds/binance_advanced.ts` — Working well
- `src/strategies/kalshi/turbo_tracker.ts` — Working well
- `src/evolution/regime_detector.ts` — Useful as-is
- `src/core/db.ts` — Functional, may need new tables for watermark/fees
- `src/core/notify.ts` — Telegram notifications, useful

---

## 12. Immediate Action Items (Ordered by Risk)

1. **Build auto-pause-to-paper** — This is the operator's #1 rule and it doesn't exist
2. **Fix paper mode** — Stop poisoning calibration data with fake outcomes
3. **Add fee-awareness** — Edge calculations must subtract expected Kalshi fees
4. **Archive dead code** — Remove 60% of codebase that adds zero value
5. **Add startup reconciliation** — Query Kalshi positions on boot, sync with local state
6. **Add retry logic** to Kalshi REST client
7. **Remove reconnect limit** on WebSocket
8. **Fix sizing chain** — Merge or cap the double-barrel multiplier problem
9. **Add bankroll watermark** tracking and dashboard display
10. **Build fee attribution** dashboard metrics
