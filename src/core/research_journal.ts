import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

export interface ResearchForecast {
  schema_version: 1;
  signal_id: string;
  ticker: string;
  direction: "YES" | "NO";
  model_p_yes: number;
  chosen_side_ask: number;
  recorded_at: string;
  strategy: string;
  predictor_source: "legacy_turbo_brain";
  contract_rule_status: "unverified";
  fill_status: "none";
  outcome_status: "unknown";
}

// Append-only signal observations. A forecast is neither a filled order nor a
// verified settlement; Foundry must join later venue evidence separately.
export function appendResearchForecast(
  input: Omit<ResearchForecast, "schema_version" | "recorded_at" | "predictor_source" |
    "contract_rule_status" | "fill_status" | "outcome_status">,
  path = process.env.FOUNDRY_RESEARCH_JOURNAL_PATH ?? "foundry-research-signals.ndjson",
): ResearchForecast {
  if (!input.signal_id || !input.ticker || !input.strategy ||
      !Number.isFinite(input.model_p_yes) || input.model_p_yes < 0 || input.model_p_yes > 1 ||
      !Number.isFinite(input.chosen_side_ask) || input.chosen_side_ask <= 0 || input.chosen_side_ask >= 1 ||
      !["YES", "NO"].includes(input.direction)) {
    throw new RangeError("Invalid research forecast");
  }
  const forecast: ResearchForecast = {
    ...input,
    schema_version: 1,
    recorded_at: new Date().toISOString(),
    predictor_source: "legacy_turbo_brain",
    contract_rule_status: "unverified",
    fill_status: "none",
    outcome_status: "unknown",
  };
  const fd = openSync(path, "a", 0o600);
  try {
    const record = Buffer.from(JSON.stringify(forecast) + "\n", "utf8");
    let offset = 0;
    while (offset < record.length) {
      const written = writeSync(fd, record, offset, record.length - offset);
      if (written <= 0) throw new Error("Research journal write did not advance");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return forecast;
}
