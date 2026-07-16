/**
 * Keep awake — stop the machine sleeping out from under a long run.
 *
 * A sleeping computer doesn't just pause things: an agent turn dies mid-flight,
 * and a routine scheduled for 09:00 while the lid is shut simply never fires
 * (setTimeout doesn't fire during sleep, and we don't schedule OS wake timers).
 *
 * Uses "prevent-app-suspension", not "prevent-display-sleep": the point is to
 * keep the SYSTEM running, and there's no reason to burn the screen for it —
 * the display can still turn off normally.
 *
 * What this cannot do, deliberately unadvertised in the UI copy: it can't wake a
 * machine that's already asleep, and it doesn't override sleeping the lid
 * manually or a forced hibernate. It only holds off idle sleep while the app
 * runs.
 */

import { powerSaveBlocker } from "electron";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "./data-dir.js";

export interface PowerConfig {
  keepAwake: boolean;
}

const DEFAULT: PowerConfig = { keepAwake: false };

function configPath(): string {
  return join(getDataDir(), "power.json");
}

export function getPowerConfig(): PowerConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf-8")) as Partial<PowerConfig>;
    return { keepAwake: raw.keepAwake === true };
  } catch {
    return { ...DEFAULT };
  }
}

let blockerId: number | null = null;

/** True when a blocker is actually held right now (not merely configured). */
export function isKeepingAwake(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId);
}

/** Apply `on` to the live blocker. Idempotent — starting twice would leak an id
 * we could no longer stop, leaving the machine awake with the toggle off. */
function apply(on: boolean): void {
  if (on) {
    if (isKeepingAwake()) return;
    blockerId = powerSaveBlocker.start("prevent-app-suspension");
    return;
  }
  if (blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

export function setPowerConfig(patch: Partial<PowerConfig>): PowerConfig {
  const next = { ...getPowerConfig(), ...patch };
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
  apply(next.keepAwake);
  return next;
}

/** Restore the setting at startup — a preference that forgets itself on restart
 * is worse than none, since the user believes the machine is being held awake. */
export function initPowerSaveBlocker(): void {
  apply(getPowerConfig().keepAwake);
}
