// src/feeds/nws.ts — National Weather Service API integration
// Free, no auth needed — provides weather data edge for Kalshi prediction markets

export interface WeatherForecast {
  station: string;
  temperature_f: number;
  precipitation_chance: number;
  snowfall_inches: number;
  wind_speed_mph: number;
  forecast_text: string;
  valid_time: string;
}

export interface WeatherEdge {
  ticker: string;
  market_question: string;
  market_implied_prob: number;
  nws_implied_prob: number;
  edge: number;
  direction: "YES" | "NO";
  confidence: number;
  reasoning: string;
}

import {
  getGFSEnsemble,
  ensembleTempExceedsProbability,
  ensembleTempBelowProbability,
  ensembleSnowExceedsProbability,
  ensemblePrecipProbability,
} from "./open_meteo.js";

const NWS_BASE = "https://api.weather.gov";
const NWS_HEADERS = {
  "User-Agent": "(polymarket-genius, contact@example.com)",
  Accept: "application/geo+json",
};

// City name to NWS station ID mapping
const CITY_STATION_MAP: Record<string, string> = {
  "new york": "KNYC",
  nyc: "KNYC",
  manhattan: "KNYC",
  chicago: "KORD",
  "los angeles": "KLAX",
  la: "KLAX",
  dallas: "KDFW",
  jfk: "KJFK",
  miami: "KMIA",
  denver: "KDEN",
  seattle: "KSEA",
  boston: "KBOS",
  atlanta: "KATL",
  houston: "KIAH",
  phoenix: "KPHX",
  philadelphia: "KPHL",
  "san francisco": "KSFO",
  washington: "KDCA",
  dc: "KDCA",
  detroit: "KDTW",
  minneapolis: "KMSP",
};

// Station to NWS gridpoint office mapping (for forecast endpoint)
const STATION_GRID_MAP: Record<string, { office: string; gridX: number; gridY: number }> = {
  KNYC: { office: "OKX", gridX: 33, gridY: 37 },
  KORD: { office: "LOT", gridX: 65, gridY: 76 },
  KLAX: { office: "LOX", gridX: 149, gridY: 48 },
  KDFW: { office: "FWD", gridX: 80, gridY: 103 },
  KJFK: { office: "OKX", gridX: 36, gridY: 35 },
  KMIA: { office: "MFL", gridX: 109, gridY: 50 },
  KDEN: { office: "BOU", gridX: 62, gridY: 60 },
  KSEA: { office: "SEW", gridX: 124, gridY: 67 },
  KBOS: { office: "BOX", gridX: 71, gridY: 90 },
  KATL: { office: "FFC", gridX: 50, gridY: 86 },
  KIAH: { office: "HGX", gridX: 65, gridY: 97 },
  KPHX: { office: "PSR", gridX: 159, gridY: 57 },
  KPHL: { office: "PHI", gridX: 49, gridY: 75 },
  KSFO: { office: "MTR", gridX: 85, gridY: 105 },
  KDCA: { office: "LWX", gridX: 96, gridY: 70 },
  KDTW: { office: "DTX", gridX: 65, gridY: 33 },
  KMSP: { office: "MPX", gridX: 107, gridY: 71 },
};

export async function getNWSForecast(station: string): Promise<WeatherForecast[]> {
  try {
    // Fetch current observations
    const obsResp = await fetch(`${NWS_BASE}/stations/${station}/observations/latest`, { headers: NWS_HEADERS });
    if (!obsResp.ok) {
      console.error(`[NWS] Observation fetch failed for ${station}: ${obsResp.status}`);
      return [];
    }
    const obsData = await obsResp.json() as any;
    const props = obsData?.properties;

    const current: WeatherForecast = {
      station,
      temperature_f: props?.temperature?.value != null ? celsiusToF(props.temperature.value) : 0,
      precipitation_chance: 0,
      snowfall_inches: 0,
      wind_speed_mph: props?.windSpeed?.value != null ? kphToMph(props.windSpeed.value) : 0,
      forecast_text: props?.textDescription ?? "",
      valid_time: props?.timestamp ?? new Date().toISOString(),
    };

    const results: WeatherForecast[] = [current];

    // Fetch 7-day forecast via gridpoint
    const grid = STATION_GRID_MAP[station];
    if (grid) {
      try {
        const fcstResp = await fetch(
          `${NWS_BASE}/gridpoints/${grid.office}/${grid.gridX},${grid.gridY}/forecast`,
          { headers: NWS_HEADERS },
        );
        if (fcstResp.ok) {
          const fcstData = await fcstResp.json() as any;
          const periods = fcstData?.properties?.periods ?? [];

          for (const period of periods.slice(0, 14)) {
            results.push({
              station,
              temperature_f: period.temperature ?? 0,
              precipitation_chance: period.probabilityOfPrecipitation?.value ?? 0,
              snowfall_inches: extractSnowfall(period.detailedForecast ?? ""),
              wind_speed_mph: parseWindSpeed(period.windSpeed ?? ""),
              forecast_text: period.detailedForecast ?? period.shortForecast ?? "",
              valid_time: period.startTime ?? "",
            });
          }
        }
      } catch (err) {
        console.error(`[NWS] Forecast fetch failed for ${station}:`, err);
      }
    }

    return results;
  } catch (err) {
    console.error(`[NWS] Failed to fetch data for ${station}:`, err);
    return [];
  }
}

export async function getWeatherEdge(
  kalshiMarkets: Array<{ ticker: string; title: string; yes_ask: number; subtitle?: string; close_time?: string }>,
): Promise<WeatherEdge[]> {
  const edges: WeatherEdge[] = [];

  for (const market of kalshiMarkets) {
    try {
      const parsed = parseWeatherMarket(market.title, market.subtitle);
      if (!parsed) continue;

      // PRIMARY: GFS 31-member ensemble (probability distribution, not point estimate)
      let prob: number | null = null;
      let source = "nws";

      const ensemble = await getGFSEnsemble(parsed.station);
      if (ensemble) {
        if (parsed.metric === "temperature_high") {
          prob = ensembleTempExceedsProbability(ensemble, parsed.threshold, market.close_time);
          source = "gfs_ensemble";
        } else if (parsed.metric === "temperature_low") {
          prob = ensembleTempBelowProbability(ensemble, parsed.threshold, market.close_time);
          source = "gfs_ensemble";
        } else if (parsed.metric === "snowfall") {
          prob = ensembleSnowExceedsProbability(ensemble, parsed.threshold, market.close_time);
          source = "gfs_ensemble";
        } else if (parsed.metric === "precipitation") {
          prob = ensemblePrecipProbability(ensemble, market.close_time);
          source = "gfs_ensemble";
        }
      }

      // FALLBACK: NWS point forecast with sigmoid approximation
      if (prob === null) {
        const forecasts = await getNWSForecast(parsed.station);
        if (forecasts.length === 0) continue;
        prob = computeNWSProbability(forecasts, parsed, market.close_time);
        source = "nws";
      }

      if (prob === null) continue;

      const marketProb = market.yes_ask;
      const edge = prob - marketProb;
      const absEdge = Math.abs(edge);

      if (absEdge < 0.03) continue; // Skip tiny edges

      // GFS ensemble gives higher confidence than NWS point forecast
      const baseConfidence = source === "gfs_ensemble" ? 0.60 : 0.50;
      const confidence = Math.min(0.93, baseConfidence + absEdge * 2);

      edges.push({
        ticker: market.ticker,
        market_question: market.title,
        market_implied_prob: marketProb,
        nws_implied_prob: Math.round(prob * 1000) / 1000,
        edge: Math.round(edge * 1000) / 1000,
        direction: edge > 0 ? "YES" : "NO",
        confidence,
        reasoning: `${source === "gfs_ensemble" ? "GFS 31-member ensemble" : "NWS forecast"}: ${Math.round(prob * 100)}% vs market ${Math.round(marketProb * 100)}%. Station: ${parsed.station}, metric: ${parsed.metric}, threshold: ${parsed.threshold}`,
      });
    } catch {
      // Skip markets we can't parse
    }
  }

  return edges;
}

interface ParsedWeatherMarket {
  station: string;
  metric: "temperature_high" | "temperature_low" | "snowfall" | "precipitation";
  threshold: number;
  comparison: "above" | "below";
}

function parseWeatherMarket(title: string, subtitle?: string): ParsedWeatherMarket | null {
  const text = `${title} ${subtitle ?? ""}`.toLowerCase();

  // Find city/station
  let station: string | null = null;
  for (const [city, stationId] of Object.entries(CITY_STATION_MAP)) {
    if (text.includes(city)) {
      station = stationId;
      break;
    }
  }
  if (!station) return null;

  // Detect metric and threshold
  let metric: ParsedWeatherMarket["metric"] | null = null;
  let threshold: number | null = null;
  let comparison: "above" | "below" = "above";

  // Temperature patterns: "exceed X°F", "above X degrees", "below X°F", "temperature X"
  const tempAbove = text.match(/(?:exceed|above|over|higher than|at least|reach)\s*(\d+)\s*°?\s*f/);
  const tempBelow = text.match(/(?:below|under|lower than|drop below|fall below)\s*(\d+)\s*°?\s*f/);
  const tempGeneral = text.match(/temperature.*?(\d+)/);

  if (tempAbove) {
    metric = "temperature_high";
    threshold = parseFloat(tempAbove[1]);
    comparison = "above";
  } else if (tempBelow) {
    metric = "temperature_low";
    threshold = parseFloat(tempBelow[1]);
    comparison = "below";
  } else if (tempGeneral && text.includes("high")) {
    metric = "temperature_high";
    threshold = parseFloat(tempGeneral[1]);
    comparison = "above";
  }

  // Snow patterns: "more than X inches of snow", "snow exceed X"
  const snowMatch = text.match(/(?:snow|snowfall).*?(?:more than|exceed|above|over|at least)\s*([\d.]+)\s*inch/);
  const snowMatch2 = text.match(/(?:more than|exceed|above|over|at least)\s*([\d.]+)\s*inch.*?(?:snow|snowfall)/);
  if (snowMatch || snowMatch2) {
    metric = "snowfall";
    threshold = parseFloat((snowMatch || snowMatch2)![1]);
    comparison = "above";
  }

  // Precipitation/rain patterns
  const rainMatch = text.match(/(?:rain|precipitation).*?(?:more than|exceed|above)\s*([\d.]+)/);
  if (rainMatch) {
    metric = "precipitation";
    threshold = parseFloat(rainMatch[1]);
    comparison = "above";
  }

  if (!metric || threshold === null) return null;

  return { station, metric, threshold, comparison };
}

function computeNWSProbability(forecasts: WeatherForecast[], parsed: ParsedWeatherMarket, closeTime?: string): number | null {
  if (forecasts.length === 0) return null;

  // Filter forecasts to only include periods BEFORE the market close time
  // This prevents using a hot day 5 days from now to predict tomorrow's market
  let relevantForecasts = forecasts;
  if (closeTime) {
    const closeMs = new Date(closeTime).getTime();
    relevantForecasts = forecasts.filter((f) => {
      if (!f.valid_time) return true; // Keep current observation
      const forecastMs = new Date(f.valid_time).getTime();
      return forecastMs <= closeMs;
    });
    // If no forecasts match the window, fall back to first 2 periods (today/tonight)
    if (relevantForecasts.length === 0) {
      relevantForecasts = forecasts.slice(0, 2);
    }
  }

  if (parsed.metric === "temperature_high" || parsed.metric === "temperature_low") {
    const temps = relevantForecasts.map((f) => f.temperature_f).filter((t) => t !== 0);
    if (temps.length === 0) return null;

    if (parsed.metric === "temperature_high") {
      const maxTemp = Math.max(...temps);
      const diff = maxTemp - parsed.threshold;
      return sigmoid(diff, 3);
    } else {
      const minTemp = Math.min(...temps);
      const diff = parsed.threshold - minTemp;
      return sigmoid(diff, 3);
    }
  }

  if (parsed.metric === "snowfall") {
    const maxSnow = Math.max(...relevantForecasts.map((f) => f.snowfall_inches));
    const diff = maxSnow - parsed.threshold;
    return sigmoid(diff, 2);
  }

  if (parsed.metric === "precipitation") {
    const maxPrecip = Math.max(...relevantForecasts.map((f) => f.precipitation_chance));
    return maxPrecip / 100;
  }

  return null;
}

// Sigmoid function mapping difference to probability (0-1)
function sigmoid(diff: number, scale: number): number {
  const prob = 1 / (1 + Math.exp(-diff / scale));
  return Math.round(prob * 1000) / 1000;
}

function celsiusToF(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

function kphToMph(kph: number): number {
  return Math.round(kph * 0.621371);
}

function parseWindSpeed(windStr: string): number {
  // NWS returns wind as "10 to 15 mph" or "15 mph"
  const match = windStr.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function extractSnowfall(forecastText: string): number {
  // Parse NWS forecast text for snowfall amounts
  // e.g., "Snow accumulation of 3 to 5 inches", "1 to 2 inches of snow"
  const match = forecastText.match(/(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?))?\s*inch(?:es)?\s*(?:of\s*)?(?:new\s*)?snow/i);
  if (match) {
    const low = parseFloat(match[1]);
    const high = match[2] ? parseFloat(match[2]) : low;
    return (low + high) / 2;
  }
  const match2 = forecastText.match(/snow\s*accumulation\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?))?\s*inch/i);
  if (match2) {
    const low = parseFloat(match2[1]);
    const high = match2[2] ? parseFloat(match2[2]) : low;
    return (low + high) / 2;
  }
  return 0;
}
