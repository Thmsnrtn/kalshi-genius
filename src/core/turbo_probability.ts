// src/core/turbo_probability.ts — Proper probability model for 15-min crypto binary options
//
// This replaces the naive settlement probability model with:
// 1. Realized volatility from Binance log returns
// 2. Actual cycle open price tracking (quarter-hour boundaries)
// 3. Black-Scholes binary option pricing: P(up) = Φ((current - open) / (σ * √T_rem))
// 4. Fee-aware mispricing detection: edge = model_prob - kalshi_implied - fees
// 5. Volatility regime classification

import { getPrice, getPriceHistoryRaw } from "../feeds/binance.js";
import { config } from "./config.js";

// ═══════════════════════════════════════════════════════
// 1. CYCLE OPEN PRICE TRACKING
// ═══════════════════════════════════════════════════════

// Track the Binance price at the start of each 15-min cycle.
// Kalshi turbo markets settle based on whether the price is above/below
// the opening price at cycle start (quarter-hour: :00, :15, :30, :45).

interface CycleOpenRecord {
  symbol: string;
  cycleKey: string;    // e.g. "btcusdt:2026-04-18T12:15"
  openPrice: number;
  openTime: number;
  recorded: boolean;   // true = we have a real observation, not an estimate
}

const cycleOpens = new Map<string, CycleOpenRecord>();
const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt"];

// Get the quarter-hour boundary for a given timestamp
function getCycleKey(symbol: string, ts: number): string {
  const d = new Date(ts);
  const min = d.getUTCMinutes();
  const quarterMin = Math.floor(min / 15) * 15;
  d.setUTCMinutes(quarterMin, 0, 0);
  return `${symbol}:${d.toISOString().slice(0, 16)}`;
}

// Get the start time of the current 15-min cycle
function getCycleStartTime(ts: number): number {
  const d = new Date(ts);
  const min = d.getUTCMinutes();
  const quarterMin = Math.floor(min / 15) * 15;
  d.setUTCMinutes(quarterMin, 0, 0);
  return d.getTime();
}

// Call this every scan to record cycle opens
export function updateCycleOpens(): void {
  const now = Date.now();
  for (const symbol of SYMBOLS) {
    const key = getCycleKey(symbol, now);
    if (cycleOpens.has(key)) continue; // Already recorded

    const snap = getPrice(symbol);
    if (!snap) continue;

    // If we're within the first 60 seconds of a cycle, use current price as the open
    const cycleStart = getCycleStartTime(now);
    const secondsIntoCycle = (now - cycleStart) / 1000;

    if (secondsIntoCycle <= 60) {
      cycleOpens.set(key, {
        symbol,
        cycleKey: key,
        openPrice: snap.price,
        openTime: now,
        recorded: true,
      });
    } else {
      // We missed the open — estimate from price history
      const hist = getPriceHistoryRaw(symbol);
      const openEstimate = findPriceNear(hist, cycleStart);
      if (openEstimate) {
        cycleOpens.set(key, {
          symbol,
          cycleKey: key,
          openPrice: openEstimate,
          openTime: cycleStart,
          recorded: false, // estimated, not observed
        });
      }
    }
  }

  // Cleanup old entries (keep last 2 hours = 8 cycles)
  const cutoff = now - 2 * 3600 * 1000;
  for (const [key, record] of cycleOpens) {
    if (record.openTime < cutoff) cycleOpens.delete(key);
  }
}

function findPriceNear(hist: Array<{ price: number; ts: number }>, targetTs: number): number | null {
  if (hist.length === 0) return null;
  let best = hist[0];
  let bestDiff = Math.abs(hist[0].ts - targetTs);
  for (const h of hist) {
    const diff = Math.abs(h.ts - targetTs);
    if (diff < bestDiff) {
      best = h;
      bestDiff = diff;
    }
  }
  // Only use if within 90 seconds of target
  return bestDiff <= 90_000 ? best.price : null;
}

// Get the cycle open price for the current cycle
export function getCycleOpenPrice(symbol: string): { price: number; estimated: boolean } | null {
  const key = getCycleKey(symbol, Date.now());
  const record = cycleOpens.get(key);
  if (record) return { price: record.openPrice, estimated: !record.recorded };
  return null;
}

// ═══════════════════════════════════════════════════════
// 2. REALIZED VOLATILITY TRACKER
// ═══════════════════════════════════════════════════════

export interface VolatilityEstimate {
  symbol: string;
  vol_15m: number;          // annualized 15-min realized vol (as fraction, e.g. 0.005 = 0.5%)
  vol_15m_annualized: number; // same but annualized
  regime: VolRegime;
  sample_count: number;     // number of return observations used
}

export type VolRegime = "LOW" | "NORMAL" | "HIGH" | "EXTREME";

// Compute realized 15-min volatility from Binance price history.
// Uses log returns over the available history (up to 15 min of data at 10s polling).
export function computeRealizedVol(symbol: string): VolatilityEstimate {
  const hist = getPriceHistoryRaw(symbol);
  const defaultVol: VolatilityEstimate = {
    symbol,
    vol_15m: 0.003,        // default ~0.3% per 15 min (typical BTC)
    vol_15m_annualized: 0.003 * Math.sqrt(4 * 24 * 365),
    regime: "NORMAL",
    sample_count: 0,
  };

  if (hist.length < 5) return defaultVol;

  // Compute log returns between consecutive observations
  const returns: number[] = [];
  for (let i = 1; i < hist.length; i++) {
    if (hist[i].price > 0 && hist[i - 1].price > 0) {
      returns.push(Math.log(hist[i].price / hist[i - 1].price));
    }
  }

  if (returns.length < 3) return defaultVol;

  // Compute standard deviation of log returns
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const sdPerObservation = Math.sqrt(variance);

  // Scale to 15-min vol:
  // Each observation is ~10s apart (REST polling interval)
  // 15 min = 900s, so ~90 observations per 15-min window
  const avgIntervalMs = hist.length >= 2
    ? (hist[hist.length - 1].ts - hist[0].ts) / (hist.length - 1)
    : 10_000;
  const observationsIn15m = (15 * 60 * 1000) / Math.max(avgIntervalMs, 1000);
  const vol_15m = sdPerObservation * Math.sqrt(observationsIn15m);

  // Annualize: 15m vol * sqrt(periods per year)
  // 4 periods/hr * 24 hrs * 365 days = 35,040 periods
  const vol_15m_annualized = vol_15m * Math.sqrt(4 * 24 * 365);

  // Classify regime based on 15-min vol
  // Calibrated from crypto markets:
  // LOW:     < 0.15% per 15 min (very quiet, e.g. weekend doldrums)
  // NORMAL:  0.15-0.40% (typical market)
  // HIGH:    0.40-0.80% (active trading, news)
  // EXTREME: > 0.80% (liquidation cascades, major events)
  let regime: VolRegime;
  if (vol_15m < 0.0015) regime = "LOW";
  else if (vol_15m < 0.004) regime = "NORMAL";
  else if (vol_15m < 0.008) regime = "HIGH";
  else regime = "EXTREME";

  return { symbol, vol_15m, vol_15m_annualized, regime, sample_count: returns.length };
}

// ═══════════════════════════════════════════════════════
// 3. BLACK-SCHOLES BINARY OPTION PROBABILITY MODEL
// ═══════════════════════════════════════════════════════

// Standard normal CDF approximation (Abramowitz & Stegun, max error 7.5e-8)
function normalCDF(x: number): number {
  if (x > 8) return 1;
  if (x < -8) return 0;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1 + sign * y);
}

export interface BinaryOptionProbability {
  prob_up: number;           // P(price will be above open at settlement)
  prob_down: number;         // 1 - prob_up
  z_score: number;           // how many σ above/below the open price
  current_price: number;
  open_price: number;
  distance_pct: number;      // (current - open) / open as percentage
  vol_15m: number;           // realized 15-min vol used
  minutes_remaining: number;
  open_estimated: boolean;   // whether the open price was estimated or observed
}

// Core probability computation:
// P(settle above open) = Φ(z) where z = (current - open) / (σ * √(T_remaining / T_total))
//
// For a 15-min binary option with T_total = 15 min:
// - σ is the realized 15-min volatility (as a price return fraction)
// - T_remaining is minutes left until settlement
// - z measures how far current price has moved relative to expected remaining vol
//
// Intuition:
// - If BTC is 0.3% above open with 2 min left, and 15-min vol is 0.2%,
//   z = 0.003 / (0.002 * √(2/15)) = 0.003 / 0.00073 ≈ 4.1 → P(up) ≈ 99.998%
// - If BTC is 0.1% above open with 10 min left, and vol is 0.3%,
//   z = 0.001 / (0.003 * √(10/15)) = 0.001 / 0.00245 ≈ 0.41 → P(up) ≈ 66%
export function computeBinaryProbability(
  symbol: string,
  minutesRemaining: number,
): BinaryOptionProbability | null {
  const snap = getPrice(symbol);
  if (!snap) return null;

  const cycleOpen = getCycleOpenPrice(symbol);
  if (!cycleOpen) return null;

  const vol = computeRealizedVol(symbol);

  const currentPrice = snap.price;
  const openPrice = cycleOpen.price;
  const distance = (currentPrice - openPrice) / openPrice;

  // Time ratio: how much of the 15-min window remains
  // Clamp to avoid division by zero at settlement
  const timeRatio = Math.max(0.01, minutesRemaining / 15);

  // Adjusted vol: scale 15-min vol by √(time_remaining / time_total)
  // This is the expected remaining price movement
  const remainingVol = Math.max(0.0001, vol.vol_15m * Math.sqrt(timeRatio));

  // Z-score: positive = above open, negative = below open
  const z = distance / remainingVol;

  const prob_up = normalCDF(z);

  return {
    prob_up,
    prob_down: 1 - prob_up,
    z_score: z,
    current_price: currentPrice,
    open_price: openPrice,
    distance_pct: distance * 100,
    vol_15m: vol.vol_15m,
    minutes_remaining: minutesRemaining,
    open_estimated: cycleOpen.estimated,
  };
}

// ═══════════════════════════════════════════════════════
// 4. FEE-AWARE MISPRICING SCANNER
// ═══════════════════════════════════════════════════════

export interface MispricingResult {
  has_edge: boolean;
  direction: "YES" | "NO";
  model_prob: number;        // our P(YES) from the probability model
  kalshi_implied_prob: number; // Kalshi's implied P(YES) from ask price
  raw_edge: number;          // model_prob - kalshi_implied (before fees)
  fee_cost: number;          // round-trip fee as fraction
  net_edge: number;          // raw_edge - fee_cost (this is the real edge)
  kalshi_yes_price: number;
  kalshi_no_price: number;
  expected_value: number;    // EV per dollar risked
  kelly_fraction: number;    // optimal fraction of bankroll to bet (quarter-Kelly)
  reasoning: string;
}

// Detect mispricing between our model probability and Kalshi's implied probability.
// Only signals "has_edge" when the NET edge (after fees) is positive.
export function detectMispricing(params: {
  symbol: string;
  minutesRemaining: number;
  kalshiYesPrice: number;   // ask price for YES in [0,1]
  kalshiNoPrice: number;    // ask price for NO in [0,1]
  isUpMarket: boolean;      // true if this market settles YES when price goes up
}): MispricingResult {
  const { symbol, minutesRemaining, kalshiYesPrice, kalshiNoPrice, isUpMarket } = params;

  const noEdge: MispricingResult = {
    has_edge: false,
    direction: "YES",
    model_prob: 0.5,
    kalshi_implied_prob: kalshiYesPrice,
    raw_edge: 0,
    fee_cost: config.KALSHI_FEE_ROUND_TRIP_PCT,
    net_edge: 0,
    kalshi_yes_price: kalshiYesPrice,
    kalshi_no_price: kalshiNoPrice,
    expected_value: 0,
    kelly_fraction: 0,
    reasoning: "No model data",
  };

  const prob = computeBinaryProbability(symbol, minutesRemaining);
  if (!prob) return noEdge;

  // Our model's probability for YES (price goes up)
  const modelProbYes = isUpMarket ? prob.prob_up : prob.prob_down;
  const modelProbNo = 1 - modelProbYes;

  // Kalshi's implied probabilities (ask prices ARE the implied probabilities
  // since you pay the ask to buy the contract, which pays $1 if you win)
  const kalshiImpliedYes = kalshiYesPrice;
  const kalshiImpliedNo = kalshiNoPrice;

  // Check both sides for edge
  const yesEdge = modelProbYes - kalshiImpliedYes;
  const noEdgeRaw = modelProbNo - kalshiImpliedNo;

  // Pick the side with more edge
  const direction = yesEdge >= noEdgeRaw ? "YES" as const : "NO" as const;
  const rawEdge = direction === "YES" ? yesEdge : noEdgeRaw;
  const modelProb = direction === "YES" ? modelProbYes : modelProbNo;
  const kalshiImplied = direction === "YES" ? kalshiImpliedYes : kalshiImpliedNo;
  const price = direction === "YES" ? kalshiYesPrice : kalshiNoPrice;

  // Subtract fees
  const feeCost = config.KALSHI_FEE_ROUND_TRIP_PCT;
  const netEdge = rawEdge - feeCost;

  // Expected value per dollar risked:
  // EV = P(win) * payout - P(lose) * cost
  // For binary: payout = (1 - price) / price per dollar invested
  // EV = modelProb * (1 - price) - (1 - modelProb) * price
  const ev = modelProb * (1 - price) - (1 - modelProb) * price;

  // Quarter-Kelly sizing: f* = edge / (1 - price), then divide by 4 for safety
  // Only positive when net_edge > 0
  const fullKelly = netEdge > 0 ? netEdge / (1 - price) : 0;
  const quarterKelly = fullKelly * 0.25;

  const hasEdge = netEdge > 0.01; // Require at least 1% net edge after fees

  const reasoning = [
    `Model: ${(modelProb * 100).toFixed(1)}% ${direction}`,
    `Kalshi: ${(kalshiImplied * 100).toFixed(1)}%`,
    `Raw edge: ${(rawEdge * 100).toFixed(1)}%`,
    `Fees: -${(feeCost * 100).toFixed(1)}%`,
    `Net edge: ${(netEdge * 100).toFixed(1)}%`,
    `z=${prob.z_score.toFixed(2)}`,
    `dist=${prob.distance_pct.toFixed(3)}%`,
    `vol=${(prob.vol_15m * 100).toFixed(2)}%`,
    `${minutesRemaining.toFixed(1)}m left`,
    prob.open_estimated ? "(open estimated)" : "(open observed)",
  ].join(" | ");

  return {
    has_edge: hasEdge,
    direction,
    model_prob: modelProb,
    kalshi_implied_prob: kalshiImplied,
    raw_edge: rawEdge,
    fee_cost: feeCost,
    net_edge: netEdge,
    kalshi_yes_price: kalshiYesPrice,
    kalshi_no_price: kalshiNoPrice,
    expected_value: ev,
    kelly_fraction: quarterKelly,
    reasoning,
  };
}

// ═══════════════════════════════════════════════════════
// 5. VOLATILITY REGIME HELPERS
// ═══════════════════════════════════════════════════════

// Get the minimum net edge required for the current vol regime.
// Higher vol = need more edge to overcome uncertainty.
export function getMinEdgeForRegime(regime: VolRegime): number {
  switch (regime) {
    case "LOW":     return 0.02;   // 2% — quiet market, smaller edges are reliable
    case "NORMAL":  return 0.03;   // 3% — standard
    case "HIGH":    return 0.05;   // 5% — need more edge in choppy markets
    case "EXTREME": return 0.08;   // 8% — only take very clear mispricings
  }
}

// Get maximum contract price we should pay, by vol regime.
// Higher vol = stick to cheaper contracts (better risk/reward).
export function getMaxPriceForRegime(regime: VolRegime): number {
  switch (regime) {
    case "LOW":     return 0.55;   // Quiet: prices near 50¢ are fine (predictable)
    case "NORMAL":  return 0.48;   // Standard: stay below 48¢
    case "HIGH":    return 0.42;   // Choppy: only cheap contracts
    case "EXTREME": return 0.35;   // Chaos: very cheap or skip
  }
}

// Get the Kelly scaling factor for the current vol regime.
// Higher vol = more conservative sizing.
export function getKellyScaleForRegime(regime: VolRegime): number {
  switch (regime) {
    case "LOW":     return 0.35;   // Can use 35% of full Kelly (slightly more aggressive)
    case "NORMAL":  return 0.25;   // Quarter-Kelly (standard)
    case "HIGH":    return 0.15;   // Eighth-Kelly (cautious)
    case "EXTREME": return 0.10;   // Tenth-Kelly (capital preservation)
  }
}

// ═══════════════════════════════════════════════════════
// 6. COMBINED PROBABILITY + EDGE ANALYSIS
// ═══════════════════════════════════════════════════════

export interface TurboAnalysis {
  // Probability model
  prob: BinaryOptionProbability | null;
  vol: VolatilityEstimate;
  mispricing: MispricingResult;

  // Trading parameters
  should_trade: boolean;
  direction: "YES" | "NO";
  net_edge: number;
  position_size_fraction: number; // fraction of bankroll to risk
  max_contract_price: number;
  min_edge_required: number;
  skip_reason: string | null;
}

// Full analysis: probability model + mispricing + vol regime + sizing
export function analyzeTurboMarket(params: {
  symbol: string;
  minutesRemaining: number;
  kalshiYesPrice: number;
  kalshiNoPrice: number;
  isUpMarket: boolean;
  bankroll: number;
}): TurboAnalysis {
  const { symbol, minutesRemaining, kalshiYesPrice, kalshiNoPrice, isUpMarket, bankroll } = params;

  // 1. Compute volatility
  const vol = computeRealizedVol(symbol);

  // 2. Compute probability
  const prob = computeBinaryProbability(symbol, minutesRemaining);

  // 3. Detect mispricing
  const mispricing = detectMispricing({
    symbol,
    minutesRemaining,
    kalshiYesPrice,
    kalshiNoPrice,
    isUpMarket,
  });

  // 4. Vol regime constraints
  const minEdge = getMinEdgeForRegime(vol.regime);
  const maxPrice = getMaxPriceForRegime(vol.regime);
  const kellyScale = getKellyScaleForRegime(vol.regime);

  // 5. Decision logic
  let skipReason: string | null = null;

  // Check minimum time remaining (don't trade with <2 min left — not enough time for mispricing to resolve)
  if (minutesRemaining < 2) {
    skipReason = `too_late (${minutesRemaining.toFixed(1)}m left)`;
  }

  // Check if we have enough data
  if (!prob && !skipReason) {
    skipReason = "no_probability_data";
  }

  // Check vol regime
  if (vol.regime === "EXTREME" && !skipReason) {
    // In extreme vol, only trade if edge is massive
    if (mispricing.net_edge < 0.08) {
      skipReason = `extreme_vol (vol=${(vol.vol_15m * 100).toFixed(2)}%, edge=${(mispricing.net_edge * 100).toFixed(1)}% < 8%)`;
    }
  }

  // Check net edge
  if (mispricing.net_edge < minEdge && !skipReason) {
    skipReason = `insufficient_edge (${(mispricing.net_edge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(0)}% [${vol.regime}])`;
  }

  // Check contract price
  const price = mispricing.direction === "YES" ? kalshiYesPrice : kalshiNoPrice;
  if (price > maxPrice && !skipReason) {
    skipReason = `price_too_high (${(price * 100).toFixed(0)}¢ > ${(maxPrice * 100).toFixed(0)}¢ [${vol.regime}])`;
  }
  if (price < 0.20 && !skipReason) {
    skipReason = `price_too_low (${(price * 100).toFixed(0)}¢ — Kalshi is pricing this correctly)`;
  }

  // Compute position size: Kelly fraction scaled by vol regime
  const fullKelly = mispricing.net_edge > 0 ? mispricing.net_edge / (1 - price) : 0;
  const positionFraction = fullKelly * kellyScale;

  const shouldTrade = !skipReason && mispricing.has_edge;

  return {
    prob,
    vol,
    mispricing,
    should_trade: shouldTrade,
    direction: mispricing.direction,
    net_edge: mispricing.net_edge,
    position_size_fraction: positionFraction,
    max_contract_price: maxPrice,
    min_edge_required: minEdge,
    skip_reason: skipReason,
  };
}
