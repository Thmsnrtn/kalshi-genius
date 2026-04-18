// src/strategies/whale_tracker.ts — Smart money consensus signals
// Monitors top Polymarket wallets and generates signals when multiple
// whales converge on the same position

import { config } from "../core/config.js";

interface WhalePosition {
  wallet: string;
  market_slug: string;
  side: "YES" | "NO";
  size_usd: number;
  timestamp: number;
}

interface WhaleConsensus {
  market_slug: string;
  market_question: string;
  consensus_side: "YES" | "NO";
  whale_count: number;
  total_whale_size: number;
  consensus_strength: number; // 0-1
  wallets: string[];
}

// Fetch positions for a given wallet from Polymarket's public API
async function fetchWalletPositions(wallet: string): Promise<WhalePosition[]> {
  try {
    const url = `https://gamma-api.polymarket.com/positions?user=${wallet}&sizeThreshold=100`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data: any[] = await res.json();

    return data.map((p) => ({
      wallet,
      market_slug: p.market?.slug ?? "",
      side: parseFloat(p.size ?? "0") > 0 ? "YES" as const : "NO" as const,
      size_usd: Math.abs(parseFloat(p.currentValue ?? "0")),
      timestamp: Date.now(),
    }));
  } catch {
    return [];
  }
}

// Scan all tracked whale wallets and find consensus
export async function scanWhaleConsensus(): Promise<WhaleConsensus[]> {
  if (config.WHALE_WALLETS.length === 0) {
    return [];
  }

  console.log(`  🐋 Scanning ${config.WHALE_WALLETS.length} whale wallets...`);

  // Fetch all positions in parallel
  const allPositions = await Promise.all(
    config.WHALE_WALLETS.map((w) => fetchWalletPositions(w))
  );
  const flat = allPositions.flat();

  // Group by market
  const byMarket = new Map<string, WhalePosition[]>();
  for (const pos of flat) {
    if (!pos.market_slug) continue;
    if (!byMarket.has(pos.market_slug)) byMarket.set(pos.market_slug, []);
    byMarket.get(pos.market_slug)!.push(pos);
  }

  // Find consensus (>60% of whales on same side)
  const consensusSignals: WhaleConsensus[] = [];
  for (const [slug, positions] of byMarket) {
    if (positions.length < 2) continue; // Need at least 2 whales

    const yesSide = positions.filter((p) => p.side === "YES");
    const noSide = positions.filter((p) => p.side === "NO");

    const totalWhales = positions.length;
    const yesCount = yesSide.length;
    const noCount = noSide.length;

    const dominantSide = yesCount >= noCount ? "YES" : "NO";
    const dominantCount = Math.max(yesCount, noCount);
    const strength = dominantCount / totalWhales;

    if (strength >= 0.6) {
      const dominantPositions = dominantSide === "YES" ? yesSide : noSide;
      consensusSignals.push({
        market_slug: slug,
        market_question: slug, // Will be enriched by caller
        consensus_side: dominantSide,
        whale_count: dominantCount,
        total_whale_size: dominantPositions.reduce((s, p) => s + p.size_usd, 0),
        consensus_strength: strength,
        wallets: dominantPositions.map((p) => p.wallet),
      });
    }
  }

  return consensusSignals.sort((a, b) => b.consensus_strength - a.consensus_strength);
}

// Default whale wallets (top performers from public leaderboard)
// Users should update these in .env with current top wallets
export const DEFAULT_WHALE_WALLETS = [
  "0x9d84ce0306f8551e02efef1680475fc0f1dc1344", // 63% WR, $2.6M profit
  "0xd218e474776403a330142299f7796e8ba32eb5c9", // 67% WR, $958K profit
];
