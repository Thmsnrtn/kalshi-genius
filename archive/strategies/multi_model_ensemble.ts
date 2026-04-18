// src/strategies/multi_model_ensemble.ts — Multi-Model Ensemble Strategy
//
// Research-backed: the dominant profitable approach uses multiple LLMs
// weighted together for probability estimation. Each model independently
// estimates, then results are aggregated via trimmed mean.
//
// Trades when ensemble consensus diverges >15% from market price.
//
// Unlocks at $500+ bankroll (Sapling phase) — API costs justified.
// Cost: ~$0.03-0.05 per evaluation (Haiku + GPT-4o-mini)

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";

export interface EnsembleSignal {
  ticker: string;
  question: string;
  direction: "YES" | "NO";
  ensemble_probability: number;
  market_probability: number;
  edge: number;
  confidence: number;
  model_estimates: { model: string; probability: number }[];
  reasoning: string;
}

interface MarketForEvaluation {
  ticker: string;
  question: string;
  description?: string;
  yes_price: number; // 0-1 format
  category: string;
  close_time?: string;
}

const SYSTEM_PROMPT = `You are a precise probability estimator for prediction markets. Given a market question, estimate the TRUE probability of YES (0.00-1.00).

Rules:
- Output ONLY a JSON object: {"probability": 0.XX, "reasoning": "one sentence"}
- Be calibrated: if you say 0.70, it should happen 70% of the time
- Consider base rates, current events, and domain knowledge
- Do NOT anchor to the market price — form your own independent estimate
- If uncertain, estimate closer to 0.50 rather than extreme values`;

async function getClaudeEstimate(market: MarketForEvaluation): Promise<{ probability: number; reasoning: string } | null> {
  try {
    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Market: "${market.question}"${market.description ? `\nContext: ${market.description}` : ""}${market.close_time ? `\nCloses: ${market.close_time}` : ""}\nCategory: ${market.category}\n\nEstimate the TRUE probability of YES:`,
      }],
    });

    const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    const match = text.match(/\{[^}]*"probability"\s*:\s*([\d.]+)[^}]*\}/);
    if (!match) return null;

    const prob = parseFloat(match[1]);
    if (isNaN(prob) || prob < 0 || prob > 1) return null;

    const reasonMatch = text.match(/"reasoning"\s*:\s*"([^"]+)"/);
    return { probability: prob, reasoning: reasonMatch?.[1] ?? "" };
  } catch (err: any) {
    console.error(`[Ensemble] Claude estimate failed: ${err.message}`);
    return null;
  }
}

async function getOpenAIEstimate(market: MarketForEvaluation): Promise<{ probability: number; reasoning: string } | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 150,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Market: "${market.question}"${market.description ? `\nContext: ${market.description}` : ""}${market.close_time ? `\nCloses: ${market.close_time}` : ""}\nCategory: ${market.category}\n\nEstimate the TRUE probability of YES:`,
          },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const text = data.choices?.[0]?.message?.content ?? "";

    const match = text.match(/\{[^}]*"probability"\s*:\s*([\d.]+)[^}]*\}/);
    if (!match) return null;

    const prob = parseFloat(match[1]);
    if (isNaN(prob) || prob < 0 || prob > 1) return null;

    const reasonMatch = text.match(/"reasoning"\s*:\s*"([^"]+)"/);
    return { probability: prob, reasoning: reasonMatch?.[1] ?? "" };
  } catch (err: any) {
    console.error(`[Ensemble] OpenAI estimate failed: ${err.message}`);
    return null;
  }
}

/**
 * Evaluate a market with multiple models and return a signal if edge > threshold.
 */
export async function evaluateWithEnsemble(
  market: MarketForEvaluation,
  minEdge: number = 0.12,
): Promise<EnsembleSignal | null> {
  // Run models in parallel
  const [claudeResult, openaiResult] = await Promise.all([
    getClaudeEstimate(market),
    getOpenAIEstimate(market),
  ]);

  const estimates: { model: string; probability: number; weight: number }[] = [];

  if (claudeResult) {
    estimates.push({ model: "claude-haiku", probability: claudeResult.probability, weight: 0.55 });
  }
  if (openaiResult) {
    estimates.push({ model: "gpt-4o-mini", probability: openaiResult.probability, weight: 0.45 });
  }

  // Need at least 1 model to proceed (ideally 2)
  if (estimates.length === 0) return null;

  // If only one model, require stronger edge
  const singleModelPenalty = estimates.length === 1 ? 0.05 : 0;

  // Weighted average (trimmed mean if we add more models later)
  const totalWeight = estimates.reduce((s, e) => s + e.weight, 0);
  const ensembleProb = estimates.reduce((s, e) => s + e.probability * e.weight, 0) / totalWeight;

  // Calculate edge vs market
  const edge = ensembleProb - market.yes_price;
  const absEdge = Math.abs(edge);

  if (absEdge < minEdge + singleModelPenalty) return null;

  // Agreement bonus: models that agree get higher confidence
  const modelAgreement = estimates.length >= 2
    ? 1 - Math.abs(estimates[0].probability - estimates[1].probability)
    : 0.5;

  const direction: "YES" | "NO" = edge > 0 ? "YES" : "NO";
  const confidence = Math.min(0.90, 0.50 + absEdge + modelAgreement * 0.15);

  const reasonParts = estimates.map(e =>
    `${e.model}: ${(e.probability * 100).toFixed(0)}%`
  );

  return {
    ticker: market.ticker,
    question: market.question,
    direction,
    ensemble_probability: Math.round(ensembleProb * 1000) / 1000,
    market_probability: market.yes_price,
    edge: Math.round(edge * 1000) / 1000,
    confidence,
    model_estimates: estimates.map(e => ({ model: e.model, probability: e.probability })),
    reasoning: `Ensemble (${reasonParts.join(", ")}) → ${(ensembleProb * 100).toFixed(0)}% vs market ${(market.yes_price * 100).toFixed(0)}%. Edge: ${(absEdge * 100).toFixed(1)}%. Agreement: ${(modelAgreement * 100).toFixed(0)}%.`,
  };
}

/**
 * Scan a batch of markets with the multi-model ensemble.
 * Designed to be called with pre-filtered high-value markets.
 */
export async function scanWithEnsemble(
  markets: MarketForEvaluation[],
  minEdge: number = 0.12,
): Promise<EnsembleSignal[]> {
  const signals: EnsembleSignal[] = [];

  // Evaluate top markets (limit to 3 to control API costs)
  for (const market of markets.slice(0, 3)) {
    const signal = await evaluateWithEnsemble(market, minEdge);
    if (signal) signals.push(signal);
  }

  return signals.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
}
