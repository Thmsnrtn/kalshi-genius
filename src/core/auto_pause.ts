// src/core/auto_pause.ts — Auto-pause-to-paper on bankroll drawdown
//
// OPERATOR RULE #1: The bot must never silently bleed money.
// When the bankroll drops below a watermark threshold, automatically
// switch to paper mode. The operator must explicitly re-enable live.
//
// Behavior:
// - Tracks a high-water mark (HWM) that only ratchets up
// - When bankroll drops >15% below HWM → auto-pause to paper
// - When daily loss exceeds 20% of session start → auto-pause to paper
// - Persists HWM across restarts via SQLite
// - Logs every state transition with clear reasoning
// - Dashboard/chat can query auto-pause state and manually re-arm

import { getBotState as dbGetBotState, setBotState as dbSetBotState } from "./db.js";

export interface AutoPauseState {
  high_water_mark: number;
  session_start_bankroll: number;
  is_auto_paused: boolean;
  pause_reason: string | null;
  pause_timestamp: number | null;
  drawdown_pct: number;        // current drawdown from HWM (0-1)
  session_drawdown_pct: number; // drawdown from session start (0-1)
}

// Thresholds
const DRAWDOWN_PAUSE_PCT = 0.15;    // 15% drawdown from HWM → paper
const SESSION_LOSS_PAUSE_PCT = 0.20; // 20% loss from session start → paper

let state: AutoPauseState = {
  high_water_mark: 0,
  session_start_bankroll: 0,
  is_auto_paused: false,
  pause_reason: null,
  pause_timestamp: null,
  drawdown_pct: 0,
  session_drawdown_pct: 0,
};

// Callbacks set by index.ts
let onAutoPause: ((reason: string) => void) | null = null;

export function setAutoPauseCallback(cb: (reason: string) => void) {
  onAutoPause = cb;
}

// Initialize from DB + current bankroll
export function initAutoPause(currentBankroll: number) {
  const savedHWM = parseFloat(dbGetBotState("auto_pause_hwm", "0"));
  const savedPaused = dbGetBotState("auto_pause_active", "false") === "true";
  const savedReason = dbGetBotState("auto_pause_reason", "");
  const savedTimestamp = parseInt(dbGetBotState("auto_pause_timestamp", "0"));

  state.session_start_bankroll = currentBankroll;
  state.high_water_mark = Math.max(savedHWM, currentBankroll);
  state.is_auto_paused = savedPaused;
  state.pause_reason = savedReason || null;
  state.pause_timestamp = savedTimestamp || null;

  // Persist updated HWM if it increased
  if (state.high_water_mark > savedHWM) {
    dbSetBotState("auto_pause_hwm", state.high_water_mark.toString());
  }

  updateDrawdowns(currentBankroll);

  console.log(`🛡️  Auto-pause initialized: HWM=$${state.high_water_mark.toFixed(2)} | Session start=$${currentBankroll.toFixed(2)} | Auto-paused: ${state.is_auto_paused}${state.is_auto_paused ? ` (${state.pause_reason})` : ""}`);
}

function updateDrawdowns(bankroll: number) {
  state.drawdown_pct = state.high_water_mark > 0
    ? Math.max(0, (state.high_water_mark - bankroll) / state.high_water_mark)
    : 0;
  state.session_drawdown_pct = state.session_start_bankroll > 0
    ? Math.max(0, (state.session_start_bankroll - bankroll) / state.session_start_bankroll)
    : 0;
}

// Call this every time bankroll changes (sync, trade result, exit)
// Returns true if auto-pause was triggered
export function checkAutoPause(currentBankroll: number, isDryRun: boolean): boolean {
  // Don't trigger auto-pause if already in paper mode
  if (isDryRun) {
    // Still update HWM for paper mode tracking
    updateDrawdowns(currentBankroll);
    return false;
  }

  // Update high water mark (only ratchets up)
  if (currentBankroll > state.high_water_mark) {
    state.high_water_mark = currentBankroll;
    dbSetBotState("auto_pause_hwm", state.high_water_mark.toString());
  }

  updateDrawdowns(currentBankroll);

  // Already auto-paused? Don't re-trigger
  if (state.is_auto_paused) return false;

  // Check drawdown from HWM
  if (state.drawdown_pct >= DRAWDOWN_PAUSE_PCT) {
    const reason = `Drawdown ${(state.drawdown_pct * 100).toFixed(1)}% from HWM $${state.high_water_mark.toFixed(2)} → $${currentBankroll.toFixed(2)}`;
    triggerAutoPause(reason);
    return true;
  }

  // Check session loss
  if (state.session_drawdown_pct >= SESSION_LOSS_PAUSE_PCT) {
    const reason = `Session loss ${(state.session_drawdown_pct * 100).toFixed(1)}% from start $${state.session_start_bankroll.toFixed(2)} → $${currentBankroll.toFixed(2)}`;
    triggerAutoPause(reason);
    return true;
  }

  return false;
}

function triggerAutoPause(reason: string) {
  state.is_auto_paused = true;
  state.pause_reason = reason;
  state.pause_timestamp = Date.now();

  dbSetBotState("auto_pause_active", "true");
  dbSetBotState("auto_pause_reason", reason);
  dbSetBotState("auto_pause_timestamp", state.pause_timestamp.toString());

  console.log(`\n🚨🚨🚨 AUTO-PAUSE TRIGGERED 🚨🚨🚨`);
  console.log(`  Reason: ${reason}`);
  console.log(`  Action: Switching to PAPER mode`);
  console.log(`  To resume live: use chat command or dashboard\n`);

  if (onAutoPause) {
    onAutoPause(reason);
  }
}

// Manually re-arm live trading (call from chat/dashboard)
export function clearAutoPause(newBankroll?: number) {
  state.is_auto_paused = false;
  state.pause_reason = null;
  state.pause_timestamp = null;

  dbSetBotState("auto_pause_active", "false");
  dbSetBotState("auto_pause_reason", "");
  dbSetBotState("auto_pause_timestamp", "0");

  // Reset session start to current bankroll
  if (newBankroll !== undefined) {
    state.session_start_bankroll = newBankroll;
    state.high_water_mark = Math.max(state.high_water_mark, newBankroll);
    dbSetBotState("auto_pause_hwm", state.high_water_mark.toString());
  }

  updateDrawdowns(newBankroll ?? state.session_start_bankroll);
  console.log(`✅ Auto-pause cleared. HWM=$${state.high_water_mark.toFixed(2)} | Session reset to $${state.session_start_bankroll.toFixed(2)}`);
}

// Reset HWM (use when operator adds/withdraws funds)
export function resetHighWaterMark(newHWM: number) {
  state.high_water_mark = newHWM;
  state.session_start_bankroll = newHWM;
  dbSetBotState("auto_pause_hwm", newHWM.toString());
  updateDrawdowns(newHWM);
  console.log(`🔄 HWM reset to $${newHWM.toFixed(2)}`);
}

export function getAutoPauseState(): AutoPauseState {
  return { ...state };
}
