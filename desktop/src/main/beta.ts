/**
 * Time-limited beta builds.
 *
 * The deadline is BAKED IN at build time (electron.vite.config.ts injects
 * MONET_BETA_EXPIRES via `define`) — a runtime env var would be trivially
 * removable by whoever runs the binary. The check runs on every launch and
 * every 10 minutes after, so a long-running instance expires too. A normal
 * build (no env var) has an empty constant and none of this exists for it.
 */

import { app, dialog } from "electron";

// Replaced at build time; empty string = not a beta build.
declare const __BETA_EXPIRES__: string;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const RECHECK_MS = 10 * 60_000;

/** The baked deadline, or null for a normal build / unparseable value.
 * Date-only strings mean "valid THROUGH that day". */
export function betaExpiry(): Date | null {
  const raw = typeof __BETA_EXPIRES__ === "string" ? __BETA_EXPIRES__.trim() : "";
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return null;
  return new Date(DATE_ONLY.test(raw) ? ts + 24 * 3_600_000 : ts);
}

export function isBetaBuild(): boolean {
  return betaExpiry() !== null;
}

function expired(): boolean {
  const at = betaExpiry();
  return at !== null && Date.now() > at.getTime();
}

function quitExpired(): void {
  dialog.showErrorBox(
    "Beta period ended",
    `This beta build of Code Monet stopped working on ${betaExpiry()?.toLocaleDateString() ?? "its deadline"}.\n\nAsk for a current build to continue.`,
  );
  // exit, not quit: close-to-tray and window-all-closed handlers must not be
  // able to keep an expired build alive.
  app.exit(1);
}

/**
 * Launch gate. Returns false (after showing the dialog and scheduling exit)
 * when the beta has expired — the caller must NOT create windows then.
 * While the app runs, re-checks periodically so the deadline also lands
 * mid-session, not only at the next restart.
 */
export function initBetaGuard(): boolean {
  if (!isBetaBuild()) return true;
  if (expired()) {
    quitExpired();
    return false;
  }
  const timer = setInterval(() => {
    if (expired()) {
      clearInterval(timer);
      quitExpired();
    }
  }, RECHECK_MS);
  timer.unref?.();
  return true;
}
