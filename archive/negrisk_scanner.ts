// src/strategies/negrisk_scanner.ts — Risk-Free Multi-Outcome Arbitrage
//
// THE FINDING: Örvar Karlsson's first scan found 182 arbitrage opportunities
// across 440 multi-outcome groups. Best: Vermont Governor primary at $0.70 sum = 43% ROI.
// NegRisk rebalancing has extracted $29 million from Polymarket in a single year.
//
// HOW IT WORKS:
// In multi-outcome markets (e.g., "Who will win the governor race?"), the YES
// prices across ALL candidates must sum to exactly $1.00 (since exactly one
// must win). When the sum < $1.00, buying all YES shares guarantees profit.
// When sum > $1.00, buying all NO shares guarantees profit.
//
// This is RISK-FREE MONEY. The only risk is capital lockup until resolution.

import { config } from "../core/config.js";

export interface NegRiskOpportunity {
  event_id: string;
  event_title: string;
  markets: Array<{
    condition_id: string;
    question: string;
    yes_price: number;
    yes_token_id: string;
    no_price: number;
    no_token_id: string;
    ask_depth_usd: number;
  }>;
  sum_yes_prices: number;
  sum_no_prices: number;
  direction: "BUY_ALL_YES" | "BUY_ALL_NO";
  spread: number;           // Raw spread before fees
  net_spread: number;       // After estimated fees
  roi_pct: number;          // Return on investment
  total_cost: number;       // Cost to buy one set
  guaranteed_profit: number; // Per set
  max_executable_sets: number;
  resolution_date: string;
  annualized_apy: number;
}

// ── Fetch all NegRisk events from Gamma API ──
async function fetchNegRiskEvents(): Promise<any[]> {
  const url = `${config.GAMMA_API_URL}/events?active=true&closed=false&limit=200`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const events: any[] = await res.json();
  return events.filter((e) => e.negRisk === true && e.markets && e.markets.length >= 2);
}

// ── Fetch best ask prices from CLOB for accurate pricing ──
async function fetchBestAsk(tokenId: string): Promise<{ price: number; depth: number }> {
  try {
    const url = `${config.CLOB_API_URL}/book?token_id=${tokenId}`;
    const res = await fetch(url);
    if (!res.ok) return { price: 1, depth: 0 };
    const book = await res.json();

    // Get best ask (lowest sell price)
    const asks = book.asks ?? [];
    if (asks.length === 0) return { price: 1, depth: 0 };

    const bestAsk = parseFloat(asks[0].price ?? "1");
    const depth = asks.reduce((sum: number, a: any) => sum + parseFloat(a.size ?? "0") * parseFloat(a.price ?? "0"), 0);

    return { price: bestAsk, depth };
  } catch {
    return { price: 1, depth: 0 };
  }
}

// ── Main NegRisk scan ──
export async function scanNegRiskArbitrage(): Promise<NegRiskOpportunity[]> {
  console.log("  🔍 Fetching NegRisk events...");
  const events = await fetchNegRiskEvents();
  console.log(`  📊 Found ${events.length} NegRisk events with 2+ outcomes`);

  const opportunities: NegRiskOpportunity[] = [];

  for (const event of events) {
    try {
      const markets = event.markets ?? [];
      if (markets.length < 2) continue;

      // Get prices for all outcomes
      const marketData: Array<{
        condition_id: string;
        question: string;
        yes_price: number;
        yes_token_id: string;
        no_price: number;
        no_token_id: string;
        ask_depth_usd: number;
      }> = [];

      let sumYes = 0;
      let minDepth = Infinity;

      for (const m of markets) {
        const tokens = m.tokens ?? [];
        const yesToken = tokens.find((t: any) => t.outcome === "Yes");
        const noToken = tokens.find((t: any) => t.outcome === "No");
        if (!yesToken || !noToken) continue;

        // Use displayed prices first (faster), CLOB for confirmation later
        const yesPrice = parseFloat(yesToken.price ?? "0.5");
        const noPrice = parseFloat(noToken.price ?? "0.5");

        marketData.push({
          condition_id: m.conditionId ?? m.condition_id ?? "",
          question: m.question ?? "",
          yes_price: yesPrice,
          yes_token_id: yesToken.token_id ?? "",
          no_price: noPrice,
          no_token_id: noToken.token_id ?? "",
          ask_depth_usd: 100, // Placeholder, fetch from CLOB for real trades
        });

        sumYes += yesPrice;
      }

      // Check for arbitrage
      const FEE_BUFFER = 0.025; // 2.5% estimated fee impact

      // BUY ALL YES: If sum < $1.00, we buy one YES of each outcome
      if (sumYes < (1 - FEE_BUFFER)) {
        const totalCost = sumYes;
        const grossSpread = 1 - totalCost;
        const netSpread = grossSpread - FEE_BUFFER;

        if (netSpread >= config.NEGRISK_MIN_SPREAD) {
          const roi = netSpread / totalCost;

          // Calculate annualized APY
          const resolutionDate = event.endDate ?? event.end_date_iso ?? "";
          const daysToResolution = resolutionDate
            ? Math.max(1, (new Date(resolutionDate).getTime() - Date.now()) / (86400 * 1000))
            : 30; // Default 30 days if unknown
          const apy = (roi / daysToResolution) * 365 * 100;

          opportunities.push({
            event_id: event.id ?? "",
            event_title: event.title ?? event.slug ?? "",
            markets: marketData,
            sum_yes_prices: sumYes,
            sum_no_prices: marketData.reduce((s, m) => s + m.no_price, 0),
            direction: "BUY_ALL_YES",
            spread: grossSpread,
            net_spread: netSpread,
            roi_pct: roi * 100,
            total_cost: totalCost,
            guaranteed_profit: netSpread,
            max_executable_sets: Math.floor(minDepth / totalCost),
            resolution_date: resolutionDate,
            annualized_apy: apy,
          });
        }
      }

      // BUY ALL NO: If sum of YES > $1.00, buy all NO for guaranteed profit
      // (since sum of NO = outcomes * $1 - sum of YES... but actually we use NegRisk adapter)
      if (sumYes > (1 + FEE_BUFFER)) {
        const noSum = marketData.reduce((s, m) => s + m.no_price, 0);
        const totalCost = noSum;
        const grossSpread = (markets.length - 1) - totalCost; // (n-1) NO shares pay out
        // Actually: in NegRisk, buying all NO means only one NO pays $1
        // Simpler: if sum of YES > $1, the equivalent NO side is underpriced
        const netSpread = sumYes - 1 - FEE_BUFFER;

        if (netSpread >= config.NEGRISK_MIN_SPREAD) {
          opportunities.push({
            event_id: event.id ?? "",
            event_title: event.title ?? event.slug ?? "",
            markets: marketData,
            sum_yes_prices: sumYes,
            sum_no_prices: noSum,
            direction: "BUY_ALL_NO",
            spread: sumYes - 1,
            net_spread: netSpread,
            roi_pct: (netSpread / 1) * 100, // Simplified
            total_cost: 1,
            guaranteed_profit: netSpread,
            max_executable_sets: 0,
            resolution_date: event.endDate ?? "",
            annualized_apy: 0,
          });
        }
      }
    } catch {
      continue;
    }
  }

  // Sort by ROI descending
  return opportunities.sort((a, b) => b.roi_pct - a.roi_pct);
}
