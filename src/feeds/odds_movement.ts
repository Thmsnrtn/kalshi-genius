// src/feeds/odds_movement.ts — Odds movement / price velocity detection
// Detects smart money signals from unusual price movements and volume spikes

import { getDb, getPriceVelocity, logPriceSnapshot } from "../core/db.js";

export interface OddsMovement {
  ticker: string;
  market_question: string;
  velocity_1h: number;
  velocity_4h: number;
  volume_spike: boolean;
  direction: "YES" | "NO";
  confidence: number;
  reasoning: string;
  signal_strength: "strong" | "moderate" | "weak";
}

export function recordPriceSnapshots(
  markets: Array<{ condition_id: string; yes_price: number; no_price: number; volume?: number; volume_24h?: number }>,
): void {
  for (const m of markets) {
    try {
      logPriceSnapshot(m.condition_id, m.yes_price, m.no_price, m.volume ?? 0, m.volume_24h ?? 0);
    } catch (err) {
      console.error(`[OddsMovement] Failed to record snapshot for ${m.condition_id}:`, err);
    }
  }
}

export function detectOddsMovements(
  markets: Array<{ condition_id: string; question: string; yes_price: number; no_price: number; volume_24h?: number }>,
): OddsMovement[] {
  const movements: OddsMovement[] = [];

  for (const market of markets) {
    try {
      const vel1h = getPriceVelocity(market.condition_id, 60);
      const vel4h = getPriceVelocity(market.condition_id, 240);

      const absVel1h = Math.abs(vel1h.velocity);
      const absVel4h = Math.abs(vel4h.velocity);

      // Determine signal strength
      let signalStrength: OddsMovement["signal_strength"] | null = null;
      if (absVel1h > 5 && Math.sign(vel1h.velocity) === Math.sign(vel4h.velocity)) {
        signalStrength = "strong";
      } else if (absVel1h > 3 || absVel4h > 8) {
        signalStrength = "moderate";
      } else if (absVel1h > 2) {
        signalStrength = "weak";
      }

      if (!signalStrength) continue;

      // Check volume spike
      const volumeSpike = detectVolumeSpike(market.condition_id, market.volume_24h ?? 0);

      // Direction based on velocity
      const direction: "YES" | "NO" = vel1h.velocity > 0 ? "YES" : "NO";

      // Confidence: 0.5 + (velocity_1h / 20), capped at 0.9
      const confidence = Math.min(0.9, 0.5 + absVel1h / 20);

      const reasoning = buildReasoning(vel1h.velocity, vel4h.velocity, volumeSpike, signalStrength, vel1h.data_points);

      movements.push({
        ticker: market.condition_id,
        market_question: market.question,
        velocity_1h: Math.round(vel1h.velocity * 100) / 100,
        velocity_4h: Math.round(vel4h.velocity * 100) / 100,
        volume_spike: volumeSpike,
        direction,
        confidence: Math.round(confidence * 1000) / 1000,
        reasoning,
        signal_strength: signalStrength,
      });
    } catch (err) {
      console.error(`[OddsMovement] Error analyzing ${market.condition_id}:`, err);
    }
  }

  // Sort by signal strength: strong > moderate > weak
  const strengthOrder: Record<string, number> = { strong: 0, moderate: 1, weak: 2 };
  movements.sort((a, b) => strengthOrder[a.signal_strength] - strengthOrder[b.signal_strength]);

  return movements;
}

export function getSmartMoneySignal(ticker: string): {
  signal: "buy_yes" | "buy_no" | "none";
  confidence: number;
  velocity: number;
} {
  try {
    const vel1h = getPriceVelocity(ticker, 60);
    const vel4h = getPriceVelocity(ticker, 240);

    const absVel1h = Math.abs(vel1h.velocity);

    // Need at least moderate signal
    if (absVel1h < 3 && Math.abs(vel4h.velocity) < 8) {
      return { signal: "none", confidence: 0, velocity: vel1h.velocity };
    }

    // Check for volume spike for extra confirmation
    const volumeSpike = detectVolumeSpike(ticker);

    // Base confidence from velocity
    let confidence = Math.min(0.9, 0.5 + absVel1h / 20);

    // Boost confidence if volume spike confirms
    if (volumeSpike) {
      confidence = Math.min(0.9, confidence + 0.10);
    }

    // Boost if 1h and 4h agree
    if (Math.sign(vel1h.velocity) === Math.sign(vel4h.velocity) && Math.abs(vel4h.velocity) > 3) {
      confidence = Math.min(0.9, confidence + 0.05);
    }

    const direction = vel1h.velocity > 0 ? "buy_yes" : "buy_no";

    return {
      signal: direction as "buy_yes" | "buy_no",
      confidence: Math.round(confidence * 1000) / 1000,
      velocity: Math.round(vel1h.velocity * 100) / 100,
    };
  } catch (err) {
    console.error(`[OddsMovement] Error getting smart money signal for ${ticker}:`, err);
    return { signal: "none", confidence: 0, velocity: 0 };
  }
}

function detectVolumeSpike(ticker: string, currentVolume24h?: number): boolean {
  try {
    const d = getDb();
    // Get average volume_24h over the last 24 hours of snapshots
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const row = d
      .prepare(`SELECT AVG(volume_24h) as avg_vol FROM price_history WHERE ticker = ? AND timestamp > ? AND volume_24h > 0`)
      .get(ticker, since) as { avg_vol: number | null } | undefined;

    if (!row?.avg_vol || row.avg_vol === 0) return false;

    // If currentVolume24h provided, compare against historical average
    if (currentVolume24h != null && currentVolume24h > 0) {
      return currentVolume24h >= row.avg_vol * 2;
    }

    // Otherwise compare latest snapshot volume against average
    const latest = d
      .prepare(`SELECT volume_24h FROM price_history WHERE ticker = ? ORDER BY timestamp DESC LIMIT 1`)
      .get(ticker) as { volume_24h: number } | undefined;

    if (!latest || latest.volume_24h === 0) return false;
    return latest.volume_24h >= row.avg_vol * 2;
  } catch {
    return false;
  }
}

function buildReasoning(
  vel1h: number,
  vel4h: number,
  volumeSpike: boolean,
  strength: string,
  dataPoints: number,
): string {
  const parts: string[] = [];

  const dir = vel1h > 0 ? "YES" : "NO";
  parts.push(`Price moved ${vel1h > 0 ? "+" : ""}${vel1h.toFixed(1)}c in 1h toward ${dir}`);

  if (Math.abs(vel4h) > 1) {
    const dir4h = vel4h > 0 ? "YES" : "NO";
    parts.push(`4h trend: ${vel4h > 0 ? "+" : ""}${vel4h.toFixed(1)}c toward ${dir4h}`);
  }

  if (volumeSpike) {
    parts.push("VOLUME SPIKE detected (2x+ average)");
  }

  parts.push(`Signal: ${strength} (${dataPoints} data points)`);

  return parts.join(". ");
}
