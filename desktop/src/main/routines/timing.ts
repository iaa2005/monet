/**
 * Scheduling arithmetic for cron routines — jitter and catch-up.
 *
 * Pure functions, no clock and no store, so the behaviour can be tested
 * without waiting for real time to pass.
 *
 * Both rules are taken from Kimi Code's cron implementation, which had already
 * met the two failure modes an exact-minute scheduler produces:
 *
 *  - **Thundering herd.** `0 * * * *` means every routine on every machine
 *    fires at exactly :00. If those routines call the same API or the same
 *    model endpoint, they collide on the one second of the hour when everyone
 *    else is calling too.
 *  - **Silently skipped runs.** The old scheduler computed the next fire from
 *    `new Date()` at startup, so a routine whose time passed while the laptop
 *    was closed simply never ran — no run record, no error, nothing to notice.
 *
 * Kimi's third rule — delete recurring tasks older than 7 days — is
 * deliberately NOT copied. Theirs are created by the model inside a session
 * and are meant to expire; ours are user-configured automations with a UI, and
 * silently deleting one after a week would be destroying the user's work.
 */

/** Longest the jitter may ever push a run out. */
const MAX_JITTER_MS = 15 * 60_000;

/** Fraction of the period used when that is smaller than MAX_JITTER_MS. */
const JITTER_FRACTION = 0.1;

/**
 * How far past its due time a missed run may still be worth firing.
 *
 * Kimi fires once on wake-up no matter how long the machine slept. That is
 * right for a reminder and wrong for a digest: "summarise yesterday's email",
 * fired three weeks late, produces a confidently stale answer. A day is the
 * point where a missed run is still about the present.
 */
const CATCH_UP_WINDOW_MS = 24 * 60 * 60_000;

/** FNV-1a. Small, dependency-free, and — the part that matters — stable across
 * restarts, so a routine's jitter does not move every time the app opens. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A stable offset in `[0, min(10% of period, 15min))` for this routine.
 *
 * Derived from the routine id, never from the clock or a random source: the
 * scheduled time is shown in the UI and stored as `nextRun`, so a jitter that
 * changed on each re-arm would make that display a lie.
 *
 * Always forward. Firing a cron EARLY would break the one promise the
 * expression makes.
 */
export function stableJitterMs(routineId: string, periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return 0;
  const cap = Math.min(Math.floor(periodMs * JITTER_FRACTION), MAX_JITTER_MS);
  if (cap <= 0) return 0;
  return hash32(routineId) % cap;
}

export interface CatchUpDecision {
  /** Run once, right now, before arming the next timer. */
  fire: boolean;
  /** How many scheduled times went by unfired (at least 1 when `fire`). */
  missed: number;
  /** Why it is not firing — for the log, when `fire` is false. */
  reason?: "no-previous-schedule" | "not-due" | "already-ran" | "too-old";
}

/**
 * Whether a routine that was due while the app was shut has a run to make up.
 *
 * Collapses every missed occurrence into ONE run. Five missed hourly digests
 * are not five things the user wants to read; they are one thing that is five
 * hours late, and `missed` carries that count so the run can say so.
 *
 * `lastRun` is what keeps this from looping. Rescheduling happens immediately
 * AFTER a normal fire, at which point the stored `nextRun` is a moment in the
 * past — indistinguishable from a missed run by time alone. A run that already
 * happened has `lastRun` at or after its due time, and is not made up.
 */
export function catchUpDecision(
  storedNextRun: string | undefined,
  lastRun: string | undefined,
  now: Date,
  periodMs: number,
): CatchUpDecision {
  if (!storedNextRun) return { fire: false, missed: 0, reason: "no-previous-schedule" };
  const due = Date.parse(storedNextRun);
  if (!Number.isFinite(due)) {
    return { fire: false, missed: 0, reason: "no-previous-schedule" };
  }

  const ran = lastRun ? Date.parse(lastRun) : NaN;
  if (Number.isFinite(ran) && ran >= due) {
    return { fire: false, missed: 0, reason: "already-ran" };
  }

  const lateBy = now.getTime() - due;
  if (lateBy <= 0) return { fire: false, missed: 0, reason: "not-due" };
  if (lateBy > CATCH_UP_WINDOW_MS) {
    // Still report the count: the caller logs it, so a routine that has been
    // dead for a month leaves a trace instead of looking like it never ran.
    return { fire: false, missed: missedCount(lateBy, periodMs), reason: "too-old" };
  }
  return { fire: true, missed: missedCount(lateBy, periodMs) };
}

function missedCount(lateByMs: number, periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return 1;
  return Math.max(1, Math.floor(lateByMs / periodMs) + 1);
}

/** The note handed to a caught-up run so its output can admit it is late. */
export function catchUpNote(missed: number, dueAt: string): string {
  const when = new Date(dueAt).toLocaleString();
  return missed <= 1
    ? `This run is late: it was scheduled for ${when} and the app was not running then.`
    : `This run is late and stands in for ${missed} missed occurrences; the earliest was scheduled for ${when}.`;
}
