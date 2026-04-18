// src/core/telemetry.ts — Strategy execution telemetry
//
// Tracks per-scan outcomes for each strategy so we can answer
// "is the bot working correctly?" with data instead of speculation.
// Counters reset daily at UTC midnight.

export interface ScanOutcomes {
  evaluated: number;
  no_edge: number;
  below_threshold: number;
  size_min: number;
  blocked: number;
  traded: number;
}

export interface CouncilTelemetry {
  deliberations_today: number;
  deliberations_resulting_in_trade: number;
  skip_reasons: Record<string, number>;
}

// ── Per-strategy counters ──
const strategies: Record<string, ScanOutcomes> = {};
let council: CouncilTelemetry = { deliberations_today: 0, deliberations_resulting_in_trade: 0, skip_reasons: {} };
let lastResetDate = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

function ensureStrategy(name: string): ScanOutcomes {
  if (!strategies[name]) {
    strategies[name] = { evaluated: 0, no_edge: 0, below_threshold: 0, size_min: 0, blocked: 0, traded: 0 };
  }
  return strategies[name];
}

function checkDailyReset() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) {
    for (const key of Object.keys(strategies)) {
      strategies[key] = { evaluated: 0, no_edge: 0, below_threshold: 0, size_min: 0, blocked: 0, traded: 0 };
    }
    council = { deliberations_today: 0, deliberations_resulting_in_trade: 0, skip_reasons: {} };
    lastResetDate = today;
  }
}

// ── Strategy telemetry API ──

export function telemetryEvaluated(strategy: string, count: number = 1) {
  checkDailyReset();
  ensureStrategy(strategy).evaluated += count;
}

export function telemetryNoEdge(strategy: string, count: number = 1) {
  checkDailyReset();
  ensureStrategy(strategy).no_edge += count;
}

export function telemetryBelowThreshold(strategy: string, count: number = 1) {
  checkDailyReset();
  ensureStrategy(strategy).below_threshold += count;
}

export function telemetrySizeMin(strategy: string, count: number = 1) {
  checkDailyReset();
  ensureStrategy(strategy).size_min += count;
}

export function telemetryBlocked(strategy: string, count: number = 1) {
  checkDailyReset();
  ensureStrategy(strategy).blocked += count;
}

export function telemetryTraded(strategy: string, count: number = 1) {
  checkDailyReset();
  ensureStrategy(strategy).traded += count;
}

// ── Council telemetry API ──

export function telemetryCouncilDeliberation(resultedInTrade: boolean) {
  checkDailyReset();
  council.deliberations_today++;
  if (resultedInTrade) council.deliberations_resulting_in_trade++;
}

export function telemetryCouncilSkip(reason: string) {
  checkDailyReset();
  council.skip_reasons[reason] = (council.skip_reasons[reason] ?? 0) + 1;
}

// ── Scan logging helpers ──

export function logScanStart(strategy: string, marketCount: number) {
  checkDailyReset();
  console.log(`[${strategy}] Scan start — ${marketCount} markets to evaluate`);
}

export function logScanComplete(strategy: string) {
  checkDailyReset();
  const s = strategies[strategy];
  if (!s) return;
  console.log(`[${strategy}] Scan complete — evaluated ${s.evaluated}: no_edge=${s.no_edge}, below_threshold=${s.below_threshold}, size_min=${s.size_min}, blocked=${s.blocked}, traded=${s.traded}`);
}

// ── Snapshot export ──

export function getStrategyTelemetry(): Record<string, ScanOutcomes> {
  checkDailyReset();
  return { ...strategies };
}

export function getCouncilTelemetry(): CouncilTelemetry {
  checkDailyReset();
  return { ...council, skip_reasons: { ...council.skip_reasons } };
}
