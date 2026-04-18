// src/feeds/fred.ts — FRED (Federal Reserve Economic Data) API integration
// Provides economic data edge for Kalshi prediction markets

import { config } from "../core/config.js";

export interface EconomicDataPoint {
  series_id: string;
  value: number;
  date: string;
  previous_value: number;
  change_pct: number;
}

export interface EconomicForecast {
  series_id: string;
  name: string;
  latest_value: number;
  trend: "rising" | "falling" | "stable";
  consensus_next?: number;
  market_relevance: string;
}

const FRED_BASE = "https://api.stlouisfed.org/fred";

const TRACKED_SERIES: Record<string, { name: string; relevance: string }> = {
  CPIAUCSL: { name: "CPI (Consumer Price Index)", relevance: "inflation markets, Fed rate decisions" },
  UNRATE: { name: "Unemployment Rate", relevance: "jobs markets, recession probability" },
  GDP: { name: "Real GDP", relevance: "GDP growth markets, recession probability" },
  FEDFUNDS: { name: "Federal Funds Rate", relevance: "Fed rate decision markets" },
  T10Y2Y: { name: "10Y-2Y Treasury Spread", relevance: "recession indicator, yield curve markets" },
  DEXUSEU: { name: "USD/EUR Exchange Rate", relevance: "currency markets, trade policy" },
  PAYEMS: { name: "Total Nonfarm Payrolls", relevance: "jobs report markets, employment" },
  PCE: { name: "Personal Consumption Expenditures", relevance: "Fed preferred inflation gauge, rate decisions" },
};

export async function getLatestFredData(seriesId: string): Promise<EconomicDataPoint | null> {
  const apiKey = config.FRED_API_KEY;
  if (!apiKey) {
    console.warn("[FRED] No FRED_API_KEY configured, skipping FRED data fetch");
    return null;
  }

  try {
    const url = `${FRED_BASE}/series/observations?series_id=${seriesId}&sort_order=desc&limit=5&file_type=json&api_key=${apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`[FRED] API error for ${seriesId}: ${resp.status}`);
      return null;
    }

    const data = await resp.json() as { observations?: Array<{ date: string; value: string }> };
    const obs = data.observations;
    if (!obs || obs.length < 2) return null;

    // Filter out entries with "." as value (FRED uses "." for missing data)
    const valid = obs.filter((o) => o.value !== ".");
    if (valid.length < 2) return null;

    const latest = parseFloat(valid[0].value);
    const previous = parseFloat(valid[1].value);
    const changePct = previous !== 0 ? ((latest - previous) / Math.abs(previous)) * 100 : 0;

    return {
      series_id: seriesId,
      value: latest,
      date: valid[0].date,
      previous_value: previous,
      change_pct: Math.round(changePct * 1000) / 1000,
    };
  } catch (err) {
    console.error(`[FRED] Failed to fetch ${seriesId}:`, err);
    return null;
  }
}

export async function getEconomicSnapshot(): Promise<EconomicForecast[]> {
  const apiKey = config.FRED_API_KEY;
  if (!apiKey) {
    console.warn("[FRED] No FRED_API_KEY configured, returning empty snapshot");
    return [];
  }

  const results: EconomicForecast[] = [];

  const fetches = Object.entries(TRACKED_SERIES).map(async ([seriesId, meta]) => {
    try {
      const url = `${FRED_BASE}/series/observations?series_id=${seriesId}&sort_order=desc&limit=5&file_type=json&api_key=${apiKey}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;

      const data = await resp.json() as { observations?: Array<{ date: string; value: string }> };
      const obs = data.observations?.filter((o) => o.value !== ".") ?? [];
      if (obs.length < 3) return null;

      const values = obs.slice(0, 3).map((o) => parseFloat(o.value));
      const trend = computeTrend(values);

      return {
        series_id: seriesId,
        name: meta.name,
        latest_value: values[0],
        trend,
        market_relevance: meta.relevance,
      } as EconomicForecast;
    } catch {
      return null;
    }
  });

  const settled = await Promise.all(fetches);
  for (const result of settled) {
    if (result) results.push(result);
  }

  return results;
}

export function getEconomicEdge(
  kalshiTitle: string,
  snapshot: EconomicForecast[],
): { has_edge: boolean; direction: "YES" | "NO"; edge_estimate: number; reasoning: string } | null {
  const titleLower = kalshiTitle.toLowerCase();

  // Match Kalshi market titles to relevant FRED data
  const patterns: Array<{ keywords: string[]; seriesIds: string[]; logic: (forecast: EconomicForecast, title: string) => { direction: "YES" | "NO"; edge: number; reasoning: string } | null }> = [
    {
      keywords: ["inflation", "cpi", "consumer price"],
      seriesIds: ["CPIAUCSL", "PCE"],
      logic: (f, title) => {
        const aboveMatch = title.match(/above\s+([\d.]+)/);
        const belowMatch = title.match(/below\s+([\d.]+)/);
        if (f.trend === "rising") {
          if (aboveMatch) return { direction: "YES", edge: 0.08, reasoning: `${f.name} trending up (${f.latest_value}), supports "above ${aboveMatch[1]}"` };
          if (belowMatch) return { direction: "NO", edge: 0.07, reasoning: `${f.name} trending up (${f.latest_value}), against "below ${belowMatch[1]}"` };
          return { direction: "YES", edge: 0.06, reasoning: `${f.name} trending up at ${f.latest_value}` };
        }
        if (f.trend === "falling") {
          if (belowMatch) return { direction: "YES", edge: 0.08, reasoning: `${f.name} trending down (${f.latest_value}), supports "below ${belowMatch[1]}"` };
          if (aboveMatch) return { direction: "NO", edge: 0.07, reasoning: `${f.name} trending down (${f.latest_value}), against "above ${aboveMatch[1]}"` };
          return { direction: "NO", edge: 0.06, reasoning: `${f.name} trending down at ${f.latest_value}` };
        }
        return null;
      },
    },
    {
      keywords: ["unemployment", "jobless", "jobs report", "nonfarm", "payroll"],
      seriesIds: ["UNRATE", "PAYEMS"],
      logic: (f, title) => {
        if (f.series_id === "UNRATE") {
          if (f.trend === "rising") return { direction: "YES", edge: 0.07, reasoning: `Unemployment trending up (${f.latest_value}%), labor market weakening` };
          if (f.trend === "falling") return { direction: "NO", edge: 0.07, reasoning: `Unemployment trending down (${f.latest_value}%), labor market strong` };
        }
        if (f.series_id === "PAYEMS") {
          if (f.trend === "rising") return { direction: "YES", edge: 0.06, reasoning: `Payrolls growing (${f.latest_value}k), strong job creation` };
          if (f.trend === "falling") return { direction: "NO", edge: 0.06, reasoning: `Payrolls declining, job creation slowing` };
        }
        return null;
      },
    },
    {
      keywords: ["gdp", "growth", "recession"],
      seriesIds: ["GDP", "T10Y2Y"],
      logic: (f, title) => {
        if (f.series_id === "T10Y2Y" && f.latest_value < 0) {
          return { direction: "YES", edge: 0.10, reasoning: `Yield curve inverted (${f.latest_value}), historically strong recession signal` };
        }
        if (f.series_id === "GDP") {
          if (f.trend === "falling") return { direction: "YES", edge: 0.08, reasoning: `GDP growth declining (${f.latest_value}), recession risk elevated` };
          if (f.trend === "rising") return { direction: "NO", edge: 0.07, reasoning: `GDP growth rising (${f.latest_value}), recession risk low` };
        }
        return null;
      },
    },
    {
      keywords: ["fed", "interest rate", "rate cut", "rate hike", "fomc", "federal funds"],
      seriesIds: ["FEDFUNDS"],
      logic: (f, _title) => {
        if (f.trend === "rising") return { direction: "YES", edge: 0.06, reasoning: `Fed funds rate trending up (${f.latest_value}%), hawkish bias` };
        if (f.trend === "falling") return { direction: "NO", edge: 0.06, reasoning: `Fed funds rate trending down (${f.latest_value}%), dovish bias` };
        return null;
      },
    },
  ];

  for (const pattern of patterns) {
    const matched = pattern.keywords.some((kw) => titleLower.includes(kw));
    if (!matched) continue;

    for (const seriesId of pattern.seriesIds) {
      const forecast = snapshot.find((f) => f.series_id === seriesId);
      if (!forecast) continue;

      const result = pattern.logic(forecast, titleLower);
      if (result) {
        return {
          has_edge: result.edge >= 0.05,
          direction: result.direction,
          edge_estimate: result.edge,
          reasoning: result.reasoning,
        };
      }
    }
  }

  return null;
}

function computeTrend(values: number[]): "rising" | "falling" | "stable" {
  // values[0] is most recent, values[1] is previous, values[2] is oldest
  if (values.length < 2) return "stable";

  const recent = values[0];
  const previous = values[1];

  if (previous === 0) return "stable";
  const changePct = Math.abs((recent - previous) / previous) * 100;

  // Require at least 0.5% change to declare a trend
  if (changePct < 0.5) return "stable";
  return recent > previous ? "rising" : "falling";
}
