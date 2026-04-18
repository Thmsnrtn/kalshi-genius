// src/feeds/open_meteo.ts — Open-Meteo GFS Ensemble API integration
//
// 31-member GFS ensemble forecasts give PROBABILITY DISTRIBUTIONS
// instead of point estimates. This is the key edge for weather markets:
// instead of "forecast says 85°F" we get "23 of 31 members say >85°F = 74% probability"
//
// Free, no API key. Rate limit: 10,000 calls/day.

export interface EnsembleForecast {
  latitude: number;
  longitude: number;
  times: string[];
  // Each member is a full hourly array
  temperature_members: number[][];   // 31 members × N hours (°F)
  precipitation_members: number[][]; // 31 members × N hours (inches)
  snowfall_members: number[][];      // 31 members × N hours (inches, converted from cm)
}

// City coordinates for Kalshi weather markets
const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  KNYC: { lat: 40.71, lon: -74.01 },
  KORD: { lat: 41.88, lon: -87.63 },
  KLAX: { lat: 33.94, lon: -118.41 },
  KDFW: { lat: 32.90, lon: -97.04 },
  KJFK: { lat: 40.64, lon: -73.78 },
  KMIA: { lat: 25.80, lon: -80.29 },
  KDEN: { lat: 39.86, lon: -104.67 },
  KSEA: { lat: 47.45, lon: -122.31 },
  KBOS: { lat: 42.36, lon: -71.01 },
  KATL: { lat: 33.64, lon: -84.43 },
  KIAH: { lat: 29.98, lon: -95.34 },
  KPHX: { lat: 33.43, lon: -112.01 },
  KPHL: { lat: 39.87, lon: -75.24 },
  KSFO: { lat: 37.62, lon: -122.38 },
  KDCA: { lat: 38.85, lon: -77.04 },
  KDTW: { lat: 42.21, lon: -83.35 },
  KMSP: { lat: 44.88, lon: -93.22 },
};

// Cache to avoid hammering API (forecasts update every 6h)
const forecastCache = new Map<string, { data: EnsembleForecast; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache

export async function getGFSEnsemble(station: string): Promise<EnsembleForecast | null> {
  const coords = CITY_COORDS[station];
  if (!coords) return null;

  // Check cache
  const cached = forecastCache.get(station);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const params = new URLSearchParams({
      latitude: coords.lat.toString(),
      longitude: coords.lon.toString(),
      hourly: "temperature_2m,precipitation,snowfall",
      models: "gfs_seamless",
      forecast_days: "7",
      temperature_unit: "fahrenheit",
      precipitation_unit: "inch",
    });

    const res = await fetch(
      `https://ensemble-api.open-meteo.com/v1/ensemble?${params}`,
      { signal: AbortSignal.timeout(15000) },
    );

    if (!res.ok) {
      console.error(`[GFS] API error for ${station}: ${res.status}`);
      return null;
    }

    const raw = await res.json() as any;
    const hourly = raw.hourly;
    if (!hourly?.time) return null;

    // Extract all 31 ensemble members for each variable
    const tempMembers: number[][] = [];
    const precipMembers: number[][] = [];
    const snowMembers: number[][] = [];

    // Member 00 is the control run (base key without suffix)
    tempMembers.push(hourly.temperature_2m ?? []);
    precipMembers.push(hourly.precipitation ?? []);
    snowMembers.push(hourly.snowfall ?? []);

    // Members 01-30 are perturbation runs
    for (let i = 1; i <= 30; i++) {
      const suffix = `_member${i.toString().padStart(2, "0")}`;
      tempMembers.push(hourly[`temperature_2m${suffix}`] ?? []);
      precipMembers.push(hourly[`precipitation${suffix}`] ?? []);
      snowMembers.push(hourly[`snowfall${suffix}`] ?? []);
    }

    const result: EnsembleForecast = {
      latitude: raw.latitude,
      longitude: raw.longitude,
      times: hourly.time,
      temperature_members: tempMembers,
      precipitation_members: precipMembers,
      snowfall_members: snowMembers,
    };

    forecastCache.set(station, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (err: any) {
    console.error(`[GFS] Failed to fetch ensemble for ${station}: ${err.message}`);
    return null;
  }
}

/**
 * Compute the probability that the max temperature exceeds a threshold
 * using the GFS ensemble. Filters forecasts to only the relevant time window.
 *
 * Returns: fraction of ensemble members where max temp > threshold (0-1)
 */
export function ensembleTempExceedsProbability(
  ensemble: EnsembleForecast,
  threshold: number,
  beforeTime?: string,
): number | null {
  if (ensemble.temperature_members.length === 0) return null;

  const beforeMs = beforeTime ? new Date(beforeTime).getTime() : Infinity;

  // Find which hourly indices are within our time window
  const validIndices: number[] = [];
  for (let i = 0; i < ensemble.times.length; i++) {
    const t = new Date(ensemble.times[i]).getTime();
    if (t <= beforeMs) validIndices.push(i);
  }
  if (validIndices.length === 0) return null;

  // For each member, compute the max temperature within the window
  let membersExceeding = 0;
  const totalMembers = ensemble.temperature_members.length;

  for (const memberTemps of ensemble.temperature_members) {
    let maxTemp = -Infinity;
    for (const idx of validIndices) {
      if (memberTemps[idx] != null && memberTemps[idx] > maxTemp) {
        maxTemp = memberTemps[idx];
      }
    }
    if (maxTemp > threshold) membersExceeding++;
  }

  return membersExceeding / totalMembers;
}

/**
 * Compute the probability that the min temperature drops below a threshold.
 */
export function ensembleTempBelowProbability(
  ensemble: EnsembleForecast,
  threshold: number,
  beforeTime?: string,
): number | null {
  if (ensemble.temperature_members.length === 0) return null;

  const beforeMs = beforeTime ? new Date(beforeTime).getTime() : Infinity;
  const validIndices: number[] = [];
  for (let i = 0; i < ensemble.times.length; i++) {
    if (new Date(ensemble.times[i]).getTime() <= beforeMs) validIndices.push(i);
  }
  if (validIndices.length === 0) return null;

  let membersBelow = 0;
  for (const memberTemps of ensemble.temperature_members) {
    let minTemp = Infinity;
    for (const idx of validIndices) {
      if (memberTemps[idx] != null && memberTemps[idx] < minTemp) {
        minTemp = memberTemps[idx];
      }
    }
    if (minTemp < threshold) membersBelow++;
  }

  return membersBelow / ensemble.temperature_members.length;
}

/**
 * Compute probability that cumulative snowfall exceeds threshold (inches).
 */
export function ensembleSnowExceedsProbability(
  ensemble: EnsembleForecast,
  threshold: number,
  beforeTime?: string,
): number | null {
  if (ensemble.snowfall_members.length === 0) return null;

  const beforeMs = beforeTime ? new Date(beforeTime).getTime() : Infinity;
  const validIndices: number[] = [];
  for (let i = 0; i < ensemble.times.length; i++) {
    if (new Date(ensemble.times[i]).getTime() <= beforeMs) validIndices.push(i);
  }
  if (validIndices.length === 0) return null;

  let membersExceeding = 0;
  for (const memberSnow of ensemble.snowfall_members) {
    let totalSnow = 0;
    for (const idx of validIndices) {
      totalSnow += memberSnow[idx] ?? 0;
    }
    if (totalSnow > threshold) membersExceeding++;
  }

  return membersExceeding / ensemble.snowfall_members.length;
}

/**
 * Compute probability of any precipitation in the window.
 */
export function ensemblePrecipProbability(
  ensemble: EnsembleForecast,
  beforeTime?: string,
): number | null {
  if (ensemble.precipitation_members.length === 0) return null;

  const beforeMs = beforeTime ? new Date(beforeTime).getTime() : Infinity;
  const validIndices: number[] = [];
  for (let i = 0; i < ensemble.times.length; i++) {
    if (new Date(ensemble.times[i]).getTime() <= beforeMs) validIndices.push(i);
  }
  if (validIndices.length === 0) return null;

  let membersWithPrecip = 0;
  for (const memberPrecip of ensemble.precipitation_members) {
    let totalPrecip = 0;
    for (const idx of validIndices) {
      totalPrecip += memberPrecip[idx] ?? 0;
    }
    if (totalPrecip > 0.01) membersWithPrecip++; // > 0.01 inches = measurable
  }

  return membersWithPrecip / ensemble.precipitation_members.length;
}

export function getAvailableStations(): string[] {
  return Object.keys(CITY_COORDS);
}
