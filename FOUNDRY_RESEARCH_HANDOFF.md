# Foundry research handoff (legacy Kalshi Genius)

This branch is a quarantine and source repair, **not a validated trading system**.
The central Kalshi `placeOrder` method rejects submissions. It intentionally
leaves read-only market/account reads and order cancellation available. The
legacy endpoint, fill assumptions, settlement proxy, fee math, and restart
reconciliation require replacement before an execution adapter can exist.

## What changed

- Turbo Brain's chosen-side model probability now travels with its signal.
  The hourly sizing path uses `P(win) - chosen-side ask`, not the gross payout
  ratio, and stores `P(YES)` separately for eventual official-outcome scoring.
  Legacy heuristic signals without a model probability are rejected by this path.
- A persisted auto-pause resets dry run on boot and the shared strategy order
  function checks the pause again before submission. Size weights cannot undo
  its 10% cap; a sub-contract allocation is rejected instead of rounded up.
- The shared strategy's dry-run path records the decision without inventing a
  fill or P&L. The old simulator remains in the source for historical reference
  but is no longer reached through that path. Other dashboard/manual paper
  paths have **not** been validated as Foundry evidence.
- Model-bearing decisions append to `foundry-research-signals.ndjson` (or
  `FOUNDRY_RESEARCH_JOURNAL_PATH`). This is an append-only observation export,
  explicitly labeled `unverified` rule, `none` fill and `unknown` outcome.
  It contains no proof of an edge and must be imported by Foundry as research.

## Remaining gaps before Foundry integration

1. Archive exact contract terms, target/reference and official settlement
   evidence by ticker. The Binance quarter-hour open is a predictor proxy.
2. Build an immutable point-in-time forecast/skip journal, with model version,
   quote depth, source/receipt timestamps, and a separate market baseline.
3. Replace the flat 3% cost assumption with an effective-dated venue fee
   schedule, rounding rules, and side/series-specific executions.
4. Use the current venue order API and reconcile accepted, partial, canceled,
   and settled quantities before recording any position, P&L, or calibration.
5. Audit **all** alternative order paths and chat controls. The central order
   guard is a quarantine, not a finished authority system.

Run `node --test tests/*.test.mjs` for pure sizing/forecast regression checks.
These tests do not establish predictive accuracy or historical profitability.
