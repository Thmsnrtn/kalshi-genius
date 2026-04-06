// src/genius/calibration_engine.ts
//
// CALIBRATION MEASUREMENT AND CORRECTION
//
// A genius trader is CALIBRATED: when they say "70% likely," it
// happens 70% of the time. Most traders and LLMs are poorly calibrated —
// either overconfident or underconfident.
//
// This engine:
// 1. Tracks predictions vs outcomes across confidence buckets
// 2. Computes Brier score (proper scoring rule for probabilities)
// 3. Computes calibration curves
// 4. APPLIES A CORRECTION FUNCTION to raw Claude outputs
//
// Over time, if the bot is systematically overconfident at 80%,
// the correction function will map "Claude said 80%" → "actually 68%"
// before that probability enters any trading decision.

import { getDb } from "../core/db.js";

export interface CalibrationBucket {
  bucket_center: number; // e.g., 0.75 for the 70-80% bucket
  predicted_probability: number; // Avg predicted
  actual_frequency: number;      // Actual win rate in this bucket
  count: number;
  correction: number;            // actual - predicted (to add to future)
}

export function initCalibration() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      predicted_probability REAL NOT NULL,
      bucket INTEGER NOT NULL,
      outcome INTEGER,
      resolved INTEGER DEFAULT 0,
      source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pred_bucket ON predictions(bucket);
    CREATE INDEX IF NOT EXISTS idx_pred_resolved ON predictions(resolved);
  `);
}

// ── Record a prediction ──
export function recordPrediction(probability: number, source: string, predictionId?: string): number {
  const db = getDb();
  const bucket = Math.floor(probability * 10); // 0-9
  const result = db.prepare(`
    INSERT INTO predictions (timestamp, predicted_probability, bucket, source)
    VALUES (?, ?, ?, ?)
  `).run(Date.now(), probability, bucket, source);
  return result.lastInsertRowid as number;
}

// ── Record outcome of a prediction ──
export function recordPredictionOutcome(predictionId: number, happened: boolean) {
  const db = getDb();
  db.prepare(`
    UPDATE predictions SET outcome = ?, resolved = 1 WHERE id = ?
  `).run(happened ? 1 : 0, predictionId);
}

// ── Compute calibration curve ──
export function getCalibrationCurve(source?: string): CalibrationBucket[] {
  const db = getDb();
  const conditions = ["resolved = 1"];
  const params: any[] = [];
  if (source) { conditions.push("source = ?"); params.push(source); }
  const where = conditions.join(" AND ");

  const buckets: CalibrationBucket[] = [];
  for (let b = 0; b < 10; b++) {
    const rows = db.prepare(`
      SELECT predicted_probability, outcome FROM predictions 
      WHERE ${where} AND bucket = ?
    `).all(...params, b) as any[];

    if (rows.length === 0) continue;

    const predicted = rows.reduce((s, r) => s + r.predicted_probability, 0) / rows.length;
    const actual = rows.filter((r) => r.outcome === 1).length / rows.length;

    buckets.push({
      bucket_center: b / 10 + 0.05,
      predicted_probability: predicted,
      actual_frequency: actual,
      count: rows.length,
      correction: actual - predicted,
    });
  }

  return buckets;
}

// ── Brier score (lower is better; 0 = perfect, 0.25 = random) ──
export function getBrierScore(source?: string): number {
  const db = getDb();
  const conditions = ["resolved = 1"];
  const params: any[] = [];
  if (source) { conditions.push("source = ?"); params.push(source); }
  const where = conditions.join(" AND ");

  const rows = db.prepare(`
    SELECT predicted_probability, outcome FROM predictions WHERE ${where}
  `).all(...params) as any[];

  if (rows.length === 0) return 0.25;

  const sum = rows.reduce((s, r) => s + Math.pow(r.predicted_probability - r.outcome, 2), 0);
  return sum / rows.length;
}

// ── APPLY CALIBRATION CORRECTION to a raw prediction ──
// This is the magic: takes a Claude output and adjusts it based on
// how calibrated Claude has been at this confidence level historically.
export function calibrate(rawProbability: number, source: string): number {
  const curve = getCalibrationCurve(source);
  if (curve.length === 0) return rawProbability;

  const bucket = Math.floor(rawProbability * 10);
  const matchingBucket = curve.find((b) => Math.floor(b.bucket_center * 10) === bucket);

  if (!matchingBucket || matchingBucket.count < 10) {
    return rawProbability; // Insufficient data for correction
  }

  // Apply the historical correction
  const corrected = rawProbability + matchingBucket.correction;
  return Math.max(0.01, Math.min(0.99, corrected));
}

// ── Calibration report ──
export interface CalibrationReport {
  overall_brier: number;
  overall_calibration_error: number; // How far off predictions are on average
  sources: Array<{ source: string; brier: number; predictions: number }>;
  worst_buckets: Array<{ bucket: number; predicted: number; actual: number; error: number }>;
  is_overconfident: boolean;
  is_underconfident: boolean;
}

export function getCalibrationReport(): CalibrationReport {
  const db = getDb();
  const sources = db.prepare(`
    SELECT source, COUNT(*) as count FROM predictions 
    WHERE resolved = 1 GROUP BY source
  `).all() as any[];

  const sourceBriers = sources.map((s) => ({
    source: s.source,
    brier: getBrierScore(s.source),
    predictions: s.count,
  }));

  const overallBrier = getBrierScore();
  const curve = getCalibrationCurve();

  // Calibration error: average absolute distance between predicted and actual
  const calibrationError = curve.length > 0
    ? curve.reduce((s, b) => s + Math.abs(b.predicted_probability - b.actual_frequency) * b.count, 0) /
      curve.reduce((s, b) => s + b.count, 0)
    : 0;

  const worstBuckets = curve
    .map((b) => ({ 
      bucket: Math.round(b.bucket_center * 100), 
      predicted: b.predicted_probability, 
      actual: b.actual_frequency,
      error: Math.abs(b.predicted_probability - b.actual_frequency),
    }))
    .sort((a, b) => b.error - a.error)
    .slice(0, 3);

  // Systematic bias detection
  const avgError = curve.length > 0
    ? curve.reduce((s, b) => s + (b.predicted_probability - b.actual_frequency), 0) / curve.length
    : 0;
  const isOverconfident = avgError > 0.05;
  const isUnderconfident = avgError < -0.05;

  return {
    overall_brier: overallBrier,
    overall_calibration_error: calibrationError,
    sources: sourceBriers,
    worst_buckets: worstBuckets,
    is_overconfident: isOverconfident,
    is_underconfident: isUnderconfident,
  };
}
