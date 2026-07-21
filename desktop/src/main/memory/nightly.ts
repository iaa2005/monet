/**
 * Nightly scheduler for memory consolidation.
 *
 * "At night, if the computer is on" — so this is a wall-clock check on a timer,
 * not a cron the OS would wake the machine for. Two ways it fires:
 *
 *   1. Night window (03:00–05:00 local), at least MIN_HOURS since the last run.
 *   2. Catch-up: more than CATCHUP_HOURS since the last run, any time of day —
 *      for the machine that was asleep or shut down at 3am. Without this a
 *      user who never leaves the app running overnight would never consolidate.
 *
 * The timer doesn't tick while the machine sleeps and resumes on wake, which
 * the catch-up branch absorbs. All gating beyond timing lives in
 * runConsolidation(); this file only decides *when* to ask.
 */

import { getConsolidationState, runConsolidation } from "./consolidate.js";

const CHECK_EVERY_MS = 15 * 60_000;
/** Delay before the first check, so startup isn't competing with it. */
const FIRST_CHECK_MS = 3 * 60_000;
const NIGHT_START_HOUR = 3;
const NIGHT_END_HOUR = 5;
const MIN_HOURS = 20;
const CATCHUP_HOURS = 36;

let timer: NodeJS.Timeout | null = null;

function shouldRunNow(now = new Date()): boolean {
  const hoursSince = (now.getTime() - getConsolidationState().lastConsolidatedAt) / 3_600_000;
  if (hoursSince >= CATCHUP_HOURS) return true;
  const hour = now.getHours();
  return hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR && hoursSince >= MIN_HOURS;
}

async function tick(): Promise<void> {
  try {
    if (!shouldRunNow()) return;
    await runConsolidation();
  } catch {
    /* never let the scheduler throw into the main process */
  }
}

export function initNightlyConsolidation(): void {
  if (timer) return;
  setTimeout(() => void tick(), FIRST_CHECK_MS).unref?.();
  timer = setInterval(() => void tick(), CHECK_EVERY_MS);
  timer.unref?.();
}

export function stopNightlyConsolidation(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Exposed for the smoke test — the timing decision without the side effects. */
export const _shouldRunNow = shouldRunNow;
