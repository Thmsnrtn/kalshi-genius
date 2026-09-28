import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendResearchForecast } from "../src/core/research_journal.ts";

test("a forecast is appended without pretending an order filled or resolved", () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-forecast-"));
  try {
    const path = join(dir, "journal.ndjson");
    const input = { signal_id: "s1", ticker: "KXBTC15M-EXAMPLE", direction: "NO",
      model_p_yes: 0.30, chosen_side_ask: 0.50, strategy: "hourly_sniper" };
    appendResearchForecast(input, path);
    appendResearchForecast({ ...input, signal_id: "s2" }, path);
    const rows = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].model_p_yes, 0.30);
    assert.equal(rows[0].contract_rule_status, "unverified");
    assert.equal(rows[0].fill_status, "none");
    assert.equal(rows[0].outcome_status, "unknown");
    assert.equal(rows[1].signal_id, "s2");
    assert.throws(() => appendResearchForecast({ ...input, model_p_yes: NaN }, path), RangeError);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
