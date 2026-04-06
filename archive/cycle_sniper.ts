// src/strategies/cycle_sniper.ts — The $313→$438K Strategy (Adapted)
//
// WHAT 0x8dxd DID: Monitored BTC/ETH/SOL on Binance, when price was clearly
// moving in one direction, bought the near-certain winning side on Polymarket's
// 5-min and 15-min contracts before Polymarket repriced. 98% win rate.
//
// OUR ADAPTATION (for non-HFT, maker-order approach):
// Instead of racing to be fastest (sub-100ms), we use Itan Scott's Bot 2 pattern:
// - Wait until 25-5 seconds remaining in the cycle
// - Confirm momentum via Binance + Chainlink oracle cross-check
// - Buy contracts priced $0.82-$0.96 (near-certain outcomes)
// - Use LIMIT (maker) orders = zero fees + rebate
// - The edge: at cycle end, momentum is confirmed and the outcome is ~locked in,
//   but contracts are still priced below $1.00. We capture the last 4-18 cents.

import { config, getPhaseParams } from "../core/config.js";
import { getPrice, detectCryptoSignal, type PriceSnapshot } from "../feeds/binance.js";

export interface SniperSignal {
  symbol: string;
  market_question: string;
  market_id: string;
  token_id: string;
  direction: "YES" | "NO";
  contract_price: number;
  potential_return_pct: number;   // e.g., 0.15 = 15% return if correct
  exchange_momentum: PriceSnapshot;
  seconds_remaining: number;
  confidence: number;
  reasoning: string;
}

// Map Polymarket question text to Binance symbol
function extractSymbol(question: string): string | null {
  const q = question.toLowerCase();
  if (q.includes("btc") || q.includes("bitcoin")) return "btcusdt";
  if (q.includes("eth") || q.includes("ethereum")) return "ethusdt";
  if (q.includes("sol") || q.includes("solana")) return "solusdt";
  return null;
}

function isUpDownMarket(question: string): boolean {
  const q = question.toLowerCase();
  return (q.includes("up or down") || q.includes("up/down") ||
          q.includes("higher or lower") || q.includes("above") ||
          q.includes("5-min") || q.includes("5 min") ||
          q.includes("15-min") || q.includes("15 min"));
}

function isUpSide(question: string): boolean {
  const q = question.toLowerCase();
  return q.includes("up") || q.includes("higher") || q.includes("above");
}

// Estimate seconds remaining in current market cycle
// Polymarket 5-min markets resolve at fixed intervals
function estimateSecondsRemaining(): number {
  const now = Date.now();
  const fiveMin = 5 * 60 * 1000;
  const elapsed = now % fiveMin;
  const remaining = fiveMin - elapsed;
  return Math.floor(remaining / 1000);
}

// ── Main sniper scan ──
export function scanForSniperSignals(
  cryptoMarkets: Array<{
    question: string;
    condition_id: string;
    tokens: Array<{ token_id: string; outcome: string; price: number }>;
  }>
): SniperSignal[] {
  const signals: SniperSignal[] = [];
  const secsRemaining = estimateSecondsRemaining();

  // Only fire in the entry window
  if (secsRemaining > config.SNIPER_ENTRY_WINDOW_START || secsRemaining < config.SNIPER_ENTRY_WINDOW_END) {
    return [];
  }

  for (const market of cryptoMarkets) {
    if (!isUpDownMarket(market.question)) continue;

    const symbol = extractSymbol(market.question);
    if (!symbol) continue;

    const priceData = getPrice(symbol);
    if (!priceData) continue;

    const signal = detectCryptoSignal(symbol);
    if (!signal || signal.signal === "none") continue;

    // Determine which side to buy
    const isUp = isUpSide(market.question);
    let targetOutcome: string;
    if (signal.signal === "strong_up") {
      targetOutcome = isUp ? "Yes" : "No";
    } else { // strong_down
      targetOutcome = isUp ? "No" : "Yes";
    }

    const token = market.tokens.find(
      (t) => t.outcome.toLowerCase() === targetOutcome.toLowerCase()
    );
    if (!token) continue;

    const price = token.price;

    // Only buy near-certain outcomes ($0.82-$0.96)
    if (price < config.SNIPER_MIN_CONTRACT_PRICE || price > config.SNIPER_MAX_CONTRACT_PRICE) continue;

    // Momentum must exceed threshold
    const momentum = Math.abs(priceData.change5s);
    if (momentum < config.SNIPER_MIN_MOMENTUM_PCT) continue;

    // Calculate potential return
    const potentialReturn = (1 - price) / price; // e.g., buy at $0.88, get $1 = 13.6% return

    // Confidence based on momentum strength and price extremity
    // Higher price = more certain outcome = higher confidence
    const priceConfidence = (price - 0.80) / 0.20; // 0 at $0.80, 1 at $1.00
    const momentumConfidence = Math.min(1, momentum / 0.30); // Saturates at 0.30% move
    const confidence = 0.5 + (priceConfidence * 0.3) + (momentumConfidence * 0.2);

    signals.push({
      symbol: symbol.replace("usdt", "").toUpperCase(),
      market_question: market.question,
      market_id: market.condition_id,
      token_id: token.token_id,
      direction: targetOutcome.toUpperCase() as "YES" | "NO",
      contract_price: price,
      potential_return_pct: potentialReturn,
      exchange_momentum: priceData,
      seconds_remaining: secsRemaining,
      confidence,
      reasoning: `${symbol.toUpperCase()} ${signal.signal} (${priceData.change5s.toFixed(3)}% in 5s). Contract at $${price.toFixed(2)} with ${secsRemaining}s remaining. Potential ${(potentialReturn * 100).toFixed(1)}% return.`,
    });
  }

  // Sort by confidence * potential return (expected value)
  return signals.sort((a, b) =>
    (b.confidence * b.potential_return_pct) - (a.confidence * a.potential_return_pct)
  );
}

// Position sizing for sniper trades (tighter than regular trades)
export function sniperPositionSize(signal: SniperSignal, bankroll: number): number {
  const phase = getPhaseParams(bankroll);

  // Sniper trades use tighter sizing: confidence * kelly fraction * bankroll
  // But never more than ABSOLUTE_MAX_SINGLE_TRADE
  const raw = bankroll * phase.kelly * signal.confidence * 0.5; // Half kelly for sniper
  const maxAbs = bankroll * config.ABSOLUTE_MAX_SINGLE_TRADE;
  const maxPhase = bankroll * phase.maxPosPct;

  return Math.min(raw, maxAbs, maxPhase, bankroll * 0.10);
}
