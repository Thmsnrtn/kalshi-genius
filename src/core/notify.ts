// src/notify.ts — Telegram notifications (optional)

import { config, getPhaseParams } from "./config.js";
import type { EliteAnalysis } from "../intelligence/analyst.js";

const enabled = !!(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);

async function send(text: string) {
  if (!enabled) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.TELEGRAM_CHAT_ID,
          text,
          parse_mode: "Markdown",
        }),
      }
    );
  } catch (err) {
    console.error("[Telegram] Failed to send:", err);
  }
}

export async function notifyTrade(analysis: EliteAnalysis, size: number, dryRun: boolean) {
  const mode = dryRun ? "🧪 PAPER" : "🔴 LIVE";
  await send(
    `${mode} *TRADE*\n` +
    `📊 ${analysis.market_question}\n` +
    `Direction: *${analysis.direction}* @ $${analysis.yes_price.toFixed(2)}\n` +
    `Edge: ${(analysis.edge * 100).toFixed(1)}%\n` +
    `Size: $${size.toFixed(2)}\n` +
    `Confidence: ${analysis.confidence}\n` +
    `_${analysis.final_reasoning}_`
  );
}

export async function notifySkip(question: string, reason: string) {
  // Don't spam Telegram with skips — only log locally
  // Uncomment below if you want skip notifications:
  // await send(`⏭ Skip: ${question.slice(0, 60)}...\n${reason}`);
}

export async function notifySummary(stats: {
  scanned: number;
  analyzed: number;
  traded: number;
  bankroll: number;
  mode: string;
}) {
  await send(
    `📈 *Hourly Summary*\n` +
    `Mode: ${stats.mode}\n` +
    `Markets scanned: ${stats.scanned}\n` +
    `Analyzed by Claude: ${stats.analyzed}\n` +
    `Trades placed: ${stats.traded}\n` +
    `Bankroll: $${stats.bankroll.toFixed(2)}`
  );
}

export async function notifyStartup() {
  await send(
    `🤖 *Polymarket Claude Bot Started*\n` +
    `Mode: ${config.DRY_RUN ? "🧪 Paper Trading" : "🔴 LIVE"}\n` +
    `Bankroll: $${config.STARTING_BANKROLL}\n` +
    `Scan interval: ${config.CLAUDE_SCAN_INTERVAL_MS / 1000}s\n` +
    `Min edge: ${(getPhaseParams(config.STARTING_BANKROLL).minEdge * 100).toFixed(0)}%\n` +
    `Max positions: ${getPhaseParams(config.STARTING_BANKROLL).maxPositions}`
  );
}

export async function notifyError(error: string) {
  await send(`❌ *Error*\n${error}`);
}

export async function notifyExit(ticker: string, pnl: number, reason: string, bankroll: number) {
  const emoji = pnl >= 0 ? "✅" : "❌";
  await send(
    `${emoji} *Position Closed*\n` +
    `${ticker}\n` +
    `PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n` +
    `Reason: ${reason}\n` +
    `Bankroll: $${bankroll.toFixed(2)}`
  );
}

export async function notifyMilestone(milestone: number, bankroll: number, totalTrades: number) {
  await send(
    `🏆 *MILESTONE REACHED: $${milestone}*\n` +
    `Bankroll: $${bankroll.toFixed(2)}\n` +
    `Total trades: ${totalTrades}`
  );
}

export async function notifyDailyDigest(stats: {
  bankroll: number;
  pnl: number;
  trades: number;
  wins: number;
  apiCost: number;
}) {
  const emoji = stats.pnl >= 0 ? "📈" : "📉";
  await send(
    `${emoji} *Daily Digest*\n` +
    `Bankroll: $${stats.bankroll.toFixed(2)}\n` +
    `Today PnL: ${stats.pnl >= 0 ? "+" : ""}$${stats.pnl.toFixed(2)}\n` +
    `Trades: ${stats.trades} (${stats.wins} wins)\n` +
    `API cost: $${stats.apiCost.toFixed(2)}`
  );
}
