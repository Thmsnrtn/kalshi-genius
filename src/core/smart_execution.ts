// src/core/smart_execution.ts — #12 Smart Order Routing + #13 Partial Position Scaling

// ── Fill stats tracking (in-memory) ─────────────────────────────

interface FillRecord {
  maker: { attempts: number; fills: number };
  taker: { attempts: number; fills: number };
}

const fillStats: FillRecord = {
  maker: { attempts: 0, fills: 0 },
  taker: { attempts: 0, fills: 0 },
};

export function recordFillStats(orderType: 'maker' | 'taker', filled: boolean): void {
  fillStats[orderType].attempts += 1;
  if (filled) fillStats[orderType].fills += 1;
}

export function getFillStats(): {
  maker: { attempts: number; fills: number; rate: number };
  taker: { attempts: number; fills: number; rate: number };
} {
  const makerRate = fillStats.maker.attempts > 0
    ? fillStats.maker.fills / fillStats.maker.attempts
    : 0;
  const takerRate = fillStats.taker.attempts > 0
    ? fillStats.taker.fills / fillStats.taker.attempts
    : 0;
  return {
    maker: { ...fillStats.maker, rate: Math.round(makerRate * 1000) / 1000 },
    taker: { ...fillStats.taker, rate: Math.round(takerRate * 1000) / 1000 },
  };
}

// ── #12 Smart Order Routing ─────────────────────────────────────

export interface OrderStrategy {
  type: 'market' | 'limit';
  price: number;
  reason: string;
}

/**
 * Decide maker vs taker based on spread width and time to close.
 *
 * @param side        'yes' or 'no'
 * @param targetPrice The price we want to trade at (cents, 0–99)
 * @param bestBid     Current best bid (cents)
 * @param bestAsk     Current best ask (cents)
 * @param minutesToClose  Minutes until market closes
 */
export function getOrderStrategy(
  side: 'yes' | 'no',
  targetPrice: number,
  bestBid: number,
  bestAsk: number,
  minutesToClose: number,
): OrderStrategy {
  const spread = bestAsk - bestBid;

  // Rule 1: Closing soon — speed trumps savings
  if (minutesToClose < 2) {
    const price = side === 'yes' ? bestAsk : bestBid;
    return {
      type: 'market',
      price,
      reason: `Market closes in <2 min (${minutesToClose.toFixed(1)}m) — taker for speed`,
    };
  }

  // Rule 2: Wide spread — place a limit 1¢ inside
  if (spread > 3) {
    const price = side === 'yes'
      ? bestBid + 1   // buy 1¢ above best bid
      : bestAsk - 1;  // sell 1¢ below best ask
    return {
      type: 'limit',
      price,
      reason: `Spread ${spread}¢ > 3¢ — limit 1¢ inside (maker)`,
    };
  }

  // Rule 3: Tight spread — just cross it
  const price = side === 'yes' ? bestAsk : bestBid;
  return {
    type: 'market',
    price,
    reason: `Spread ${spread}¢ ≤ 3¢ — taker (tight spread)`,
  };
}

// ── #13 Partial Position Scaling ────────────────────────────────

export interface ScaledEntry {
  initialSize: number;   // contracts for first tranche (50%)
  scaleInSize: number;   // contracts for second tranche (50%)
  scaleInTrigger: number; // cents of favorable move to trigger scale-in
}

/**
 * Split target size into two tranches.
 * Scale-in trigger: price moves 1¢ in our favor within 60s window (caller checks time).
 */
export function createScaledEntry(targetSize: number): ScaledEntry {
  const initialSize = Math.ceil(targetSize * 0.5);
  const scaleInSize = targetSize - initialSize;
  return {
    initialSize,
    scaleInSize,
    scaleInTrigger: 1, // 1¢ favorable move
  };
}

export interface ScaleOutResult {
  shouldScale: boolean;
  scaleSize: number;
  reason: string;
}

/**
 * Check whether we should scale out of a position.
 * At 60% of take-profit target, sell 30% of position.
 *
 * @param entryPrice     Price we entered at (cents)
 * @param currentPrice   Current market price (cents)
 * @param side           'yes' or 'no'
 * @param positionSize   Current position size (contracts)
 * @param takeProfitPct  Take-profit target as a fraction (e.g. 0.10 for 10%)
 */
export function checkScaleOut(
  entryPrice: number,
  currentPrice: number,
  side: 'yes' | 'no',
  positionSize: number,
  takeProfitPct: number,
): ScaleOutResult {
  // How far price has moved in our favor
  const move = side === 'yes'
    ? currentPrice - entryPrice
    : entryPrice - currentPrice;

  // Full take-profit distance in cents
  const tpDistance = entryPrice * takeProfitPct;

  // Trigger at 60% of the take-profit distance
  const scaleOutThreshold = tpDistance * 0.6;

  if (tpDistance <= 0) {
    return { shouldScale: false, scaleSize: 0, reason: 'Invalid take-profit target' };
  }

  if (move >= scaleOutThreshold) {
    const scaleSize = Math.floor(positionSize * 0.3);
    if (scaleSize < 1) {
      return { shouldScale: false, scaleSize: 0, reason: 'Position too small to scale out' };
    }
    return {
      shouldScale: true,
      scaleSize,
      reason: `Price moved ${move.toFixed(1)}¢ (≥${scaleOutThreshold.toFixed(1)}¢ = 60% of TP) — selling 30% (${scaleSize} contracts)`,
    };
  }

  return {
    shouldScale: false,
    scaleSize: 0,
    reason: `Move ${move.toFixed(1)}¢ < ${scaleOutThreshold.toFixed(1)}¢ threshold — holding`,
  };
}
