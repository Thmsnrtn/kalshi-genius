// src/core/genius_signals.ts — Genius-level signal intelligence
//
// ITEMS BUILT:
// #2  Regime Classifier (Momentum vs Mean Reversion)
// #3  Stale Price Sniping
// #8  Multi-Signal Confluence Scoring
// #10 Time-of-Day Profiling
// #11 Consecutive Loss Circuit Breaker
// #17 Correlation-Aware Position Sizing

import { getPrice, predictSettlement, detectCrossAssetCascade } from "../feeds/binance.js";
import { getOrderBookImbalance, getFundingBias, detectLiquidationCascade, getVPIN, getVWAP } from "../feeds/binance_advanced.js";
import { getDb } from "./db.js";

// ═══════════════════════════════════════════════════════════
// #2: REGIME CLASSIFIER
// ═══════════════════════════════════════════════════════════

export type MarketRegimeType = "momentum" | "mean_reversion" | "volatile" | "dead";

interface RegimeState {
  regime: MarketRegimeType;
  confidence: number;
  autocorrelation: number;
  vwap_slope: number;
  recommended_strategy: "follow_trend" | "fade_extremes" | "reduce_size" | "skip";
}

const regimeCache: Map<string, RegimeState> = new Map();

export function classifyRegime(symbol: string): RegimeState {
  const cached = regimeCache.get(symbol);
  if (cached && Date.now() - (cached as any)._ts < 30000) return cached; // 30s cache

  const snap = getPrice(symbol);
  const vwap = getVWAP(symbol);

  // Compute autocorrelation of 1-min returns
  // Positive = momentum, Negative = mean reversion
  let autocorrelation = 0;
  const vpin = getVPIN(symbol);

  // Use change60s as proxy for recent return pattern
  if (snap) {
    // Simple heuristic: if 5s and 30s and 60s all same direction, momentum is strong
    const same_dir = (snap.change5s > 0 && snap.change30s > 0 && snap.change60s > 0) ||
                     (snap.change5s < 0 && snap.change30s < 0 && snap.change60s < 0);
    autocorrelation = same_dir ? 0.5 : -0.3;

    // Adjust by magnitude consistency
    if (same_dir) {
      const consistency = Math.min(
        Math.abs(snap.change5s), Math.abs(snap.change30s), Math.abs(snap.change60s)
      ) / Math.max(Math.abs(snap.change5s), Math.abs(snap.change30s), Math.abs(snap.change60s), 0.001);
      autocorrelation = 0.3 + consistency * 0.4;
    }
  }

  const vwapSlope = vwap?.slope ?? 0;

  // Time-of-day adjustment
  const hourUTC = new Date().getUTCHours();
  const isAsianSession = hourUTC >= 0 && hourUTC < 8;
  const isUSOpen = hourUTC >= 13 && hourUTC < 16;

  let regime: MarketRegimeType;
  let confidence: number;
  let recommended: RegimeState["recommended_strategy"];

  if (autocorrelation > 0.3 && Math.abs(vwapSlope) > 0.02) {
    regime = "momentum";
    confidence = Math.min(0.90, 0.60 + autocorrelation * 0.3);
    recommended = "follow_trend";
    // Boost confidence during US session (more trend persistence)
    if (isUSOpen) confidence = Math.min(0.95, confidence * 1.1);
  } else if (autocorrelation < -0.1 || (Math.abs(vwapSlope) < 0.01 && vpin.vpin < 0.3)) {
    regime = "mean_reversion";
    confidence = Math.min(0.85, 0.55 + Math.abs(autocorrelation) * 0.3);
    recommended = "fade_extremes";
    // Boost during Asian session
    if (isAsianSession) confidence = Math.min(0.90, confidence * 1.1);
  } else if (vpin.vpin > 0.7) {
    regime = "volatile";
    confidence = 0.70;
    recommended = "reduce_size";
  } else {
    regime = "dead";
    confidence = 0.50;
    recommended = "skip";
  }

  const state: RegimeState = {
    regime, confidence, autocorrelation, vwap_slope: vwapSlope, recommended_strategy: recommended,
  };
  (state as any)._ts = Date.now();
  regimeCache.set(symbol, state);
  return state;
}

// ═══════════════════════════════════════════════════════════
// #3: STALE PRICE SNIPING
// ═══════════════════════════════════════════════════════════

export interface StalePriceSignal {
  asset: string;
  binance_price: number;
  kalshi_implied_price: number;
  divergence_pct: number;
  direction: "YES" | "NO";
  confidence: number;
  latency_advantage_ms: number;
}

// Called with Kalshi market data + Binance live prices
export function detectStalePrice(
  kalshiYesPrice: number,  // 0-1
  kalshiNoPrice: number,
  strikePrice: number,
  asset: string,
  minutesRemaining: number,
): StalePriceSignal | null {
  const symbolMap: Record<string, string> = {
    "BTC": "btcusdt", "ETH": "ethusdt", "SOL": "solusdt", "XRP": "xrpusdt",
  };
  const symbol = symbolMap[asset];
  if (!symbol) return null;

  const snap = getPrice(symbol);
  if (!snap) return null;

  const binancePrice = snap.price;
  const distFromStrike = (binancePrice - strikePrice) / strikePrice;

  // Estimate fair probability based on distance and time
  // Rough sigmoid: if price is 0.5% above strike with 5 min left, ~75% YES
  const timeFactor = Math.max(0.1, minutesRemaining / 15); // Normalize to 15-min window
  const fairProb = 1 / (1 + Math.exp(-distFromStrike * 100 / timeFactor));

  // Divergence between our estimate and Kalshi's price
  const divergence = Math.abs(fairProb - kalshiYesPrice);

  // Only signal if divergence > 5%
  if (divergence < 0.05) return null;

  const direction = fairProb > kalshiYesPrice ? "YES" : "NO";
  const confidence = Math.min(0.95, 0.50 + divergence * 2);

  // Estimate how stale the price is based on recent price movement speed
  const priceSpeed = Math.abs(snap.change5s) / 5; // % per second
  const latencyMs = priceSpeed > 0 ? (divergence / priceSpeed) * 1000 : 5000;

  return {
    asset,
    binance_price: binancePrice,
    kalshi_implied_price: kalshiYesPrice,
    divergence_pct: divergence * 100,
    direction,
    confidence,
    latency_advantage_ms: Math.min(60000, latencyMs),
  };
}

// ═══════════════════════════════════════════════════════════
// #8: MULTI-SIGNAL CONFLUENCE SCORING
// ═══════════════════════════════════════════════════════════

export interface ConfluenceScore {
  total_score: number;     // 0-10
  signals_agreeing: number; // Count of signals that agree
  signals_total: number;
  breakdown: Record<string, { agrees: boolean; weight: number; detail: string }>;
  recommendation: "strong_trade" | "trade" | "weak" | "skip";
}

export function scoreConfluence(
  symbol: string,
  direction: "YES" | "NO",
  asset: string,
): ConfluenceScore {
  const breakdown: ConfluenceScore["breakdown"] = {};
  let totalWeight = 0;
  let agreeWeight = 0;
  let signalsAgreeing = 0;
  let signalsTotal = 0;

  const bullish = direction === "YES";

  // 1. Momentum (weight: 2)
  const snap = getPrice(symbol);
  if (snap) {
    signalsTotal++;
    const momentumBull = snap.change5s > 0 && snap.change30s > 0;
    const momentumBear = snap.change5s < 0 && snap.change30s < 0;
    const agrees = bullish ? momentumBull : momentumBear;
    if (agrees) { agreeWeight += 2; signalsAgreeing++; }
    totalWeight += 2;
    breakdown["momentum"] = { agrees, weight: 2, detail: `5s:${snap.change5s.toFixed(3)}% 30s:${snap.change30s.toFixed(3)}%` };
  }

  // 2. Order Book Imbalance (weight: 2)
  const obi = getOrderBookImbalance(symbol);
  if (obi.confidence > 0) {
    signalsTotal++;
    const agrees = (bullish && obi.signal.includes("buy")) || (!bullish && obi.signal.includes("sell"));
    if (agrees) { agreeWeight += 2; signalsAgreeing++; }
    totalWeight += 2;
    breakdown["orderbook"] = { agrees, weight: 2, detail: `OBI: ${obi.weighted_imbalance.toFixed(3)} (${obi.signal})` };
  }

  // 3. VPIN (weight: 1.5)
  const vpin = getVPIN(symbol);
  if (vpin.vpin > 0) {
    signalsTotal++;
    const agrees = (bullish && vpin.bucket_imbalance > 0.1) || (!bullish && vpin.bucket_imbalance < -0.1);
    if (agrees) { agreeWeight += 1.5; signalsAgreeing++; }
    totalWeight += 1.5;
    breakdown["vpin"] = { agrees, weight: 1.5, detail: `VPIN: ${vpin.vpin.toFixed(2)}, imbalance: ${vpin.bucket_imbalance.toFixed(3)}` };
  }

  // 4. Funding Rate (weight: 1)
  const funding = getFundingBias(symbol);
  if (funding) {
    signalsTotal++;
    const agrees = (bullish && funding.bias === "bullish") || (!bullish && funding.bias === "bearish");
    if (agrees) { agreeWeight += 1; signalsAgreeing++; }
    totalWeight += 1;
    breakdown["funding"] = { agrees, weight: 1, detail: `Rate: ${(funding.rate * 100).toFixed(4)}%, z: ${funding.z_score.toFixed(1)} (${funding.bias})` };
  }

  // 5. VWAP (weight: 1.5)
  const vwap = getVWAP(symbol);
  if (vwap) {
    signalsTotal++;
    // In momentum regime: VWAP confirms trend. In reversion: overbought/oversold
    const regime = classifyRegime(symbol);
    let agrees = false;
    if (regime.regime === "momentum") {
      agrees = (bullish && vwap.slope > 0) || (!bullish && vwap.slope < 0);
    } else {
      agrees = (bullish && vwap.signal === "oversold") || (!bullish && vwap.signal === "overbought");
    }
    if (agrees) { agreeWeight += 1.5; signalsAgreeing++; }
    totalWeight += 1.5;
    breakdown["vwap"] = { agrees, weight: 1.5, detail: `Dev: ${vwap.deviation.toFixed(2)}σ, slope: ${vwap.slope.toFixed(3)}% (${vwap.signal})` };
  }

  // 6. Liquidation cascade (weight: 1.5)
  const liq = detectLiquidationCascade(symbol);
  if (liq.active) {
    signalsTotal++;
    const agrees = (bullish && liq.direction === "short_squeeze") || (!bullish && liq.direction === "long_squeeze");
    if (agrees) { agreeWeight += 1.5; signalsAgreeing++; }
    totalWeight += 1.5;
    breakdown["liquidation"] = { agrees, weight: 1.5, detail: `${liq.direction} intensity: ${liq.intensity.toFixed(2)}, $${(liq.volume_usd / 1000).toFixed(0)}K` };
  }

  // 7. Cross-asset cascade (weight: 1)
  const cascades = detectCrossAssetCascade();
  const relevantCascade = cascades.find(c =>
    (asset === "ETH" && c.follower === "ETH") ||
    (asset === "SOL" && c.follower === "SOL") ||
    (asset === "XRP" && c.follower === "XRP")
  );
  if (relevantCascade) {
    signalsTotal++;
    const agrees = (bullish && relevantCascade.direction === "up") || (!bullish && relevantCascade.direction === "down");
    if (agrees) { agreeWeight += 1; signalsAgreeing++; }
    totalWeight += 1;
    breakdown["cross_asset"] = { agrees, weight: 1, detail: `${relevantCascade.leader}→${relevantCascade.follower} ${relevantCascade.direction}` };
  }

  const totalScore = totalWeight > 0 ? (agreeWeight / totalWeight) * 10 : 0;

  let recommendation: ConfluenceScore["recommendation"] = "skip";
  if (signalsAgreeing >= 5 || totalScore >= 7) recommendation = "strong_trade";
  else if (signalsAgreeing >= 4 || totalScore >= 5) recommendation = "trade";
  else if (signalsAgreeing >= 3 || totalScore >= 3) recommendation = "weak";

  return {
    total_score: Math.round(totalScore * 10) / 10,
    signals_agreeing: signalsAgreeing,
    signals_total: signalsTotal,
    breakdown,
    recommendation,
  };
}

// ═══════════════════════════════════════════════════════════
// #10: TIME-OF-DAY PROFILING
// ═══════════════════════════════════════════════════════════

interface TimeProfile {
  hour_utc: number;
  trades: number;
  wins: number;
  win_rate: number;
  avg_pnl: number;
  should_trade: boolean;
}

// In-memory accumulator, periodically persisted to DB
const timeProfiles: Map<number, { trades: number; wins: number; total_pnl: number }> = new Map();

export function recordTimeProfile(hourUTC: number, won: boolean, pnl: number) {
  if (!timeProfiles.has(hourUTC)) {
    timeProfiles.set(hourUTC, { trades: 0, wins: 0, total_pnl: 0 });
  }
  const p = timeProfiles.get(hourUTC)!;
  p.trades++;
  if (won) p.wins++;
  p.total_pnl += pnl;
}

export function getTimeAdvice(): { should_trade: boolean; confidence_multiplier: number; reason: string } {
  const hourUTC = new Date().getUTCHours();
  const profile = timeProfiles.get(hourUTC);

  if (!profile || profile.trades < 10) {
    return { should_trade: true, confidence_multiplier: 1.0, reason: "Insufficient data for this hour" };
  }

  const winRate = profile.wins / profile.trades;
  const avgPnl = profile.total_pnl / profile.trades;

  if (winRate < 0.35 && profile.trades >= 20) {
    return { should_trade: false, confidence_multiplier: 0.5, reason: `Hour ${hourUTC}:00 UTC has ${(winRate * 100).toFixed(0)}% win rate (n=${profile.trades}) — reduce exposure` };
  }

  if (winRate > 0.65 && profile.trades >= 15) {
    return { should_trade: true, confidence_multiplier: 1.2, reason: `Hour ${hourUTC}:00 UTC is a hot hour: ${(winRate * 100).toFixed(0)}% win rate` };
  }

  return { should_trade: true, confidence_multiplier: 1.0, reason: `Hour ${hourUTC}:00 UTC: ${(winRate * 100).toFixed(0)}% win rate (n=${profile.trades})` };
}

export function getAllTimeProfiles(): TimeProfile[] {
  return Array.from({ length: 24 }, (_, h) => {
    const p = timeProfiles.get(h);
    if (!p || p.trades === 0) return { hour_utc: h, trades: 0, wins: 0, win_rate: 0, avg_pnl: 0, should_trade: true };
    return {
      hour_utc: h,
      trades: p.trades,
      wins: p.wins,
      win_rate: p.wins / p.trades,
      avg_pnl: p.total_pnl / p.trades,
      should_trade: p.trades < 10 || (p.wins / p.trades) >= 0.35,
    };
  });
}

// ═══════════════════════════════════════════════════════════
// #11: CONSECUTIVE LOSS CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════════

interface CircuitBreakerState {
  consecutive_losses: number;
  last_loss_time: number;
  cooldown_until: number;
  size_multiplier: number; // 1.0 = normal, 0.5 = reduced, 0 = paused
  status: "normal" | "caution" | "cooldown";
}

const circuitBreaker: CircuitBreakerState = {
  consecutive_losses: 0,
  last_loss_time: 0,
  cooldown_until: 0,
  size_multiplier: 1.0,
  status: "normal",
};

export function recordTradeResult(won: boolean) {
  if (won) {
    circuitBreaker.consecutive_losses = 0;
    circuitBreaker.size_multiplier = 1.0;
    circuitBreaker.status = "normal";
  } else {
    circuitBreaker.consecutive_losses++;
    circuitBreaker.last_loss_time = Date.now();

    if (circuitBreaker.consecutive_losses >= 5) {
      // 5+ losses: cooldown for 30 min
      circuitBreaker.cooldown_until = Date.now() + 30 * 60 * 1000;
      circuitBreaker.size_multiplier = 0;
      circuitBreaker.status = "cooldown";
      console.log(`  🛑 [Circuit Breaker] 5 consecutive losses — cooling down for 30 min`);
    } else if (circuitBreaker.consecutive_losses >= 3) {
      // 3-4 losses: reduce size by 50%
      circuitBreaker.size_multiplier = 0.5;
      circuitBreaker.status = "caution";
      console.log(`  ⚠️ [Circuit Breaker] ${circuitBreaker.consecutive_losses} consecutive losses — reducing size 50%`);
    }
  }
}

export function getCircuitBreakerState(): CircuitBreakerState {
  // Check if cooldown has expired
  if (circuitBreaker.cooldown_until > 0 && Date.now() > circuitBreaker.cooldown_until) {
    circuitBreaker.cooldown_until = 0;
    circuitBreaker.size_multiplier = 0.5; // Come back at half size
    circuitBreaker.status = "caution";
    console.log(`  ✅ [Circuit Breaker] Cooldown expired — resuming at 50% size`);
  }
  return { ...circuitBreaker };
}

export function canTradeCircuitBreaker(): { ok: boolean; size_multiplier: number; reason?: string } {
  const state = getCircuitBreakerState();

  if (state.status === "cooldown") {
    const remaining = Math.ceil((state.cooldown_until - Date.now()) / 60000);
    return { ok: false, size_multiplier: 0, reason: `Circuit breaker cooldown: ${remaining}m remaining` };
  }

  return { ok: true, size_multiplier: state.size_multiplier };
}

// ═══════════════════════════════════════════════════════════
// #17: CORRELATION-AWARE POSITION SIZING
// ═══════════════════════════════════════════════════════════

// Crypto assets are highly correlated — BTC/ETH ~0.85, BTC/SOL ~0.75
const CORRELATION_MATRIX: Record<string, Record<string, number>> = {
  "BTC": { "BTC": 1.0, "ETH": 0.85, "SOL": 0.75, "XRP": 0.70 },
  "ETH": { "BTC": 0.85, "ETH": 1.0, "SOL": 0.70, "XRP": 0.65 },
  "SOL": { "BTC": 0.75, "ETH": 0.70, "SOL": 1.0, "XRP": 0.60 },
  "XRP": { "BTC": 0.70, "ETH": 0.65, "SOL": 0.60, "XRP": 1.0 },
};

export function correlationDiscount(
  newAsset: string,
  newDirection: "YES" | "NO",
  openPositions: Array<{ asset: string; direction: string; size_usd: number }>,
): number {
  if (openPositions.length === 0) return 1.0; // No discount

  let totalCorrelation = 0;
  let totalWeight = 0;

  for (const pos of openPositions) {
    const corr = CORRELATION_MATRIX[newAsset]?.[pos.asset] ?? 0.3;
    // Same direction positions are additive risk
    const sameDirection = (newDirection === pos.direction);
    const effectiveCorr = sameDirection ? corr : -corr * 0.5; // Opposite direction partially hedges
    totalCorrelation += effectiveCorr * pos.size_usd;
    totalWeight += pos.size_usd;
  }

  if (totalWeight === 0) return 1.0;
  const avgCorrelation = totalCorrelation / totalWeight;

  // Discount: 0% at zero correlation, 30% at 0.8+ correlation
  const discount = Math.max(0.5, 1 - avgCorrelation * 0.4);
  return discount;
}

// ═══════════════════════════════════════════════════════════
// #14: SIGNAL BACKTESTER (record all signals for analysis)
// ═══════════════════════════════════════════════════════════

export function recordSignalOutcome(params: {
  strategy: string;
  ticker: string;
  direction: string;
  confidence: number;
  confluence_score: number;
  regime: string;
  hour_utc: number;
  traded: boolean;
  won?: boolean;
  pnl?: number;
}) {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS signal_backtest (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      strategy TEXT, ticker TEXT, direction TEXT,
      confidence REAL, confluence_score REAL,
      regime TEXT, hour_utc INTEGER,
      traded INTEGER, won INTEGER, pnl REAL
    )`);
    db.prepare(`INSERT INTO signal_backtest (strategy, ticker, direction, confidence, confluence_score, regime, hour_utc, traded, won, pnl)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      params.strategy, params.ticker, params.direction,
      params.confidence, params.confluence_score,
      params.regime, params.hour_utc,
      params.traded ? 1 : 0, params.won != null ? (params.won ? 1 : 0) : null, params.pnl ?? null,
    );
  } catch {}
}

// ═══════════════════════════════════════════════════════════
// #15: ADAPTIVE PARAMETER OPTIMIZATION
// ═══════════════════════════════════════════════════════════

export function getOptimalParameters(): {
  optimal_confidence_threshold: number;
  optimal_min_confluence: number;
  optimal_max_positions: number;
  sample_size: number;
} {
  try {
    const db = getDb();
    // Ensure table exists
    db.exec(`CREATE TABLE IF NOT EXISTS signal_backtest (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      strategy TEXT, ticker TEXT, direction TEXT,
      confidence REAL, confluence_score REAL,
      regime TEXT, hour_utc INTEGER,
      traded INTEGER, won INTEGER, pnl REAL
    )`);
    const rows = db.prepare(`SELECT confidence, confluence_score, won, pnl FROM signal_backtest WHERE traded = 1 AND won IS NOT NULL ORDER BY id DESC LIMIT 200`).all() as any[];

    if (rows.length < 30) {
      return { optimal_confidence_threshold: 0.45, optimal_min_confluence: 3, optimal_max_positions: 6, sample_size: rows.length };
    }

    // Find confidence threshold that maximizes profit
    const thresholds = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];
    let bestThreshold = 0.45;
    let bestPnl = -Infinity;

    for (const t of thresholds) {
      const filtered = rows.filter((r: any) => r.confidence >= t);
      const totalPnl = filtered.reduce((s: number, r: any) => s + (r.pnl || 0), 0);
      const winRate = filtered.filter((r: any) => r.won).length / (filtered.length || 1);
      // Optimize for total PnL weighted by win rate
      const score = totalPnl * winRate;
      if (score > bestPnl && filtered.length >= 10) {
        bestPnl = score;
        bestThreshold = t;
      }
    }

    return {
      optimal_confidence_threshold: bestThreshold,
      optimal_min_confluence: 3,
      optimal_max_positions: 6,
      sample_size: rows.length,
    };
  } catch {
    return { optimal_confidence_threshold: 0.45, optimal_min_confluence: 3, optimal_max_positions: 6, sample_size: 0 };
  }
}
