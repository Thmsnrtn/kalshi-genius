// Pure research calculations. Prices and probabilities are fractions in [0, 1].
// This is not a venue fee or fill model.
export function yesProbabilityFromChosenSide(modelProbabilityWin: number, direction: "YES" | "NO"): number {
  if (!Number.isFinite(modelProbabilityWin) || modelProbabilityWin < 0 || modelProbabilityWin > 1) {
    throw new RangeError("Invalid chosen-side probability");
  }
  return direction === "YES" ? modelProbabilityWin : 1 - modelProbabilityWin;
}

export function grossProbabilityEdge(modelProbabilityWin: number, chosenSideAsk: number): number {
  if (!Number.isFinite(modelProbabilityWin) || modelProbabilityWin < 0 || modelProbabilityWin > 1 ||
      !Number.isFinite(chosenSideAsk) || chosenSideAsk <= 0 || chosenSideAsk >= 1) {
    throw new RangeError("Invalid forecast or ask");
  }
  return modelProbabilityWin - chosenSideAsk;
}

export function capRiskAfterWeights(weightedSize: number, bankroll: number, maximumFraction = 0.10): number {
  if (!Number.isFinite(weightedSize) || !Number.isFinite(bankroll) || bankroll <= 0 ||
      !Number.isFinite(maximumFraction) || maximumFraction <= 0 || maximumFraction > 1) return 0;
  return Math.max(0, Math.min(weightedSize, bankroll * maximumFraction));
}
