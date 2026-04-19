// src/core/kill_switch.ts — File-based emergency halt.
//
// OPERATOR RULE #2: From anywhere with shell access, `touch state/STOP`
// must halt all new order placement within one order-placement cycle —
// no redeploy, no chat round-trip, no DB write. Bot keeps running so
// position_manager can still exit open positions, but no new entries.
//
// Path is configurable via KILL_SWITCH_PATH env (default ./state/STOP).

import { existsSync, mkdirSync, watch, statSync, type FSWatcher } from "fs";
import { dirname, join } from "path";

const KILL_SWITCH_PATH = process.env.KILL_SWITCH_PATH ?? join(process.cwd(), "state", "STOP");

let cachedActive = false;
let cachedAt = 0;
const CACHE_TTL_MS = 500;   // re-stat at most twice per second on hot paths
let watcher: FSWatcher | null = null;
let lastLoggedState: boolean | null = null;

function statePath(): string {
  return KILL_SWITCH_PATH;
}

export function initKillSwitch(): void {
  // Ensure parent directory exists so operators can just `touch state/STOP`
  const dir = dirname(statePath());
  try { mkdirSync(dir, { recursive: true }); } catch {}

  // Prime the cache and log initial state
  const active = isKillSwitchActive({ force: true });
  console.log(`🛑 Kill-switch armed: ${statePath()}  (currently ${active ? "🚨 ACTIVE" : "✅ clear"})`);
  lastLoggedState = active;

  // Watch the directory so we log transitions immediately (don't rely on cache expiry)
  try {
    watcher = watch(dir, (_evt, filename) => {
      if (filename === "STOP") {
        const now = isKillSwitchActive({ force: true });
        if (now !== lastLoggedState) {
          lastLoggedState = now;
          if (now) {
            console.log(`\n🚨🚨🚨 KILL-SWITCH ENGAGED — ${statePath()} detected. No new orders will be placed. 🚨🚨🚨\n`);
          } else {
            console.log(`\n✅ Kill-switch cleared. New orders are allowed again.\n`);
          }
        }
      }
    });
  } catch (err: any) {
    // Watcher is a nice-to-have; the stat cache still works without it.
    console.warn(`[KillSwitch] fs.watch unavailable (${err?.message ?? "unknown"}). Relying on stat polling only.`);
  }
}

export function isKillSwitchActive(opts?: { force?: boolean }): boolean {
  const now = Date.now();
  if (!opts?.force && now - cachedAt < CACHE_TTL_MS) return cachedActive;
  let active = false;
  try {
    active = existsSync(statePath());
    if (active) {
      // Stat to make sure it's a real file, not a stale directory, etc.
      const s = statSync(statePath());
      active = s.isFile();
    }
  } catch {
    active = false;
  }
  cachedActive = active;
  cachedAt = now;
  return active;
}

export function killSwitchPath(): string {
  return statePath();
}

export function shutdownKillSwitch(): void {
  if (watcher) {
    try { watcher.close(); } catch {}
    watcher = null;
  }
}
