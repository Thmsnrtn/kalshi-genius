import { test } from "node:test";
import assert from "node:assert/strict";
import { yesProbabilityFromChosenSide, grossProbabilityEdge, capRiskAfterWeights } from "../src/core/forecast_math.ts";

test("the payout ratio cannot stand in for a probability edge", () => {
  assert.equal(grossProbabilityEdge(0.50, 0.50), 0);
  assert.ok(Math.abs(grossProbabilityEdge(0.53, 0.50) - 0.03) < 1e-12);
  assert.ok(Math.abs(grossProbabilityEdge(0.70, 0.50) - 0.20) < 1e-12);
  assert.notEqual((1 - 0.50) / 0.50, grossProbabilityEdge(0.50, 0.50));
});

test("NO-side forecast is recorded as P(YES) for resolution scoring", () => {
  assert.equal(yesProbabilityFromChosenSide(0.70, "YES"), 0.70);
  assert.ok(Math.abs(yesProbabilityFromChosenSide(0.70, "NO") - 0.30) < 1e-12);
  assert.throws(() => yesProbabilityFromChosenSide(NaN, "YES"), RangeError);
});

test("weighting cannot defeat the final capital cap", () => {
  assert.equal(capRiskAfterWeights(15, 100), 10);
  assert.equal(capRiskAfterWeights(1, 5), 0.50);
  assert.equal(capRiskAfterWeights(1, 0), 0);
});
