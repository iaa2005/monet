/**
 * Computer Use overlay — while the agent is driving the mouse/keyboard, a
 * glowing brand-coloured frame breathes around the screen edge and the app
 * window dodges into the bottom-right corner so it does not sit on top of the
 * apps being controlled.
 *
 * The frame is click-through (`setIgnoreMouseEvents`) and content-protected
 * (`setContentProtection` → WDA_EXCLUDEFROMCAPTURE on Windows), so the USER
 * sees it but no screen capture does — including the agent's own screenshots,
 * which therefore show the desktop exactly as the target apps render it.
 *
 * Lifecycle: every computer action calls `touchComputerOverlay()` (shows the
 * frame on the first action of a run and refreshes an idle timer); the agent
 * run's `finally` calls `releaseComputerOverlay()`. The idle timer is only a
 * safety net for a run that dies without reaching its finally.
 */

import { BrowserWindow, screen } from "electron";
import { APP_MIN_HEIGHT, APP_MIN_WIDTH } from "../app/main-window.js";

const BRAND_HUE = 211; // matches --brand-hue in the renderer's globals.css
/** Pure dead-run insurance — the real release is the agent run's finally.
 * This was 60s and behaved like a FEATURE: a reasoning model thinking for
 * two minutes between actions got the window restored mid-run, on top of
 * the app being driven, and the next clicks landed in our own chat. */
const IDLE_MS = 10 * 60_000;
const DODGE_MARGIN = 12;
const TWEEN_MS = 220;

const GLOW_HTML = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden}
#f{position:fixed;inset:0;pointer-events:none;
  box-shadow:inset 0 0 0 2px hsl(${BRAND_HUE} 90% 60% / .85),
             inset 0 0 34px 10px hsl(${BRAND_HUE} 90% 60% / .30);
  animation:b 2.6s ease-in-out infinite}
@keyframes b{50%{box-shadow:inset 0 0 0 2px hsl(${BRAND_HUE} 90% 65% / 1),
                 inset 0 0 56px 18px hsl(${BRAND_HUE} 90% 60% / .45)}}
</style><div id="f"></div>`;

let overlay: BrowserWindow | null = null;
let dodgeWindow: BrowserWindow | null = null;
let shown = false;
let idleTimer: NodeJS.Timeout | null = null;
/** Bumped on every show/release so an in-flight tween from the previous state
 * stops moving the window instead of fighting the new one. */
let generation = 0;
let savedPlacement: { bounds: Electron.Rectangle; maximized: boolean } | null = null;

/** The app window that should dodge out of the way. Set once at startup. */
export function setDodgeWindow(win: BrowserWindow): void {
  dodgeWindow = win;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Animate a window's bounds. Windows has no native tween (the `animate` flag
 * of setBounds is macOS-only), so step it by hand. */
function tweenBounds(
  win: BrowserWindow,
  to: Electron.Rectangle,
  gen: number,
): Promise<void> {
  const from = win.getBounds();
  const start = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (win.isDestroyed() || gen !== generation) {
        clearInterval(timer);
        return resolve();
      }
      const t = Math.min(1, (Date.now() - start) / TWEEN_MS);
      const k = easeInOutCubic(t);
      win.setBounds({
        x: Math.round(from.x + (to.x - from.x) * k),
        y: Math.round(from.y + (to.y - from.y) * k),
        width: Math.round(from.width + (to.width - from.width) * k),
        height: Math.round(from.height + (to.height - from.height) * k),
      });
      if (t >= 1) {
        clearInterval(timer);
        resolve();
      }
    }, 16);
  });
}

function tweenOpacity(win: BrowserWindow, to: number, gen: number, ms = 180): Promise<void> {
  const from = win.getOpacity();
  const start = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (win.isDestroyed() || gen !== generation) {
        clearInterval(timer);
        return resolve();
      }
      const t = Math.min(1, (Date.now() - start) / ms);
      win.setOpacity(from + (to - from) * t);
      if (t >= 1) {
        clearInterval(timer);
        resolve();
      }
    }, 16);
  });
}

function ensureOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay;
  overlay = new BrowserWindow({
    ...screen.getPrimaryDisplay().bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    roundedCorners: false,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setIgnoreMouseEvents(true);
  // Visible to the user, absent from every screen capture (incl. our own).
  // MONET_OVERLAY_CAPTURABLE=1 keeps it in captures — the only way to verify
  // the glow visually in an automated run, since exclusion hides it from every
  // screenshot tool on the machine.
  if (!process.env.MONET_OVERLAY_CAPTURABLE) overlay.setContentProtection(true);
  void overlay.loadURL(
    `data:text/html;base64,${Buffer.from(GLOW_HTML, "utf-8").toString("base64")}`,
  );
  return overlay;
}

/**
 * The corner the app parks in: TOP right, at exactly the window's minimum
 * size. Bottom-right was where the taskbar's own popups and notifications
 * live, and it is the busiest corner of a Windows desktop; the top right is
 * clear. Sizing it to the minimum means no minimum-size juggling — the card
 * is simply the smallest the app is allowed to be.
 */
function dodgeTarget(): Electron.Rectangle {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x + wa.width - APP_MIN_WIDTH - DODGE_MARGIN,
    y: wa.y + DODGE_MARGIN,
    width: APP_MIN_WIDTH,
    height: APP_MIN_HEIGHT,
  };
}

async function dodgeApp(gen: number): Promise<void> {
  const win = dodgeWindow;
  if (!win || win.isDestroyed() || !win.isVisible() || savedPlacement) return;
  savedPlacement = { bounds: win.getBounds(), maximized: win.isMaximized() };
  if (savedPlacement.maximized) win.unmaximize();
  await tweenBounds(win, dodgeTarget(), gen);
}

async function restoreApp(gen: number): Promise<void> {
  const win = dodgeWindow;
  const saved = savedPlacement;
  if (!saved) return;
  savedPlacement = null;
  if (!win || win.isDestroyed()) return;
  await tweenBounds(win, saved.bounds, gen);
  if (gen !== generation) return;
  if (saved.maximized) win.maximize();
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => releaseComputerOverlay(), IDLE_MS);
}

/**
 * A computer action is happening: show the frame and dodge the app window if
 * hidden, refresh the idle timer if already up. Resolves after the dodge
 * animation on first show, so the first screenshot is taken with the app
 * already out of the way.
 */
export async function touchComputerOverlay(): Promise<void> {
  armIdleTimer();
  if (shown) return;
  shown = true;
  const gen = ++generation;
  const win = ensureOverlay();
  win.setBounds(screen.getPrimaryDisplay().bounds);
  win.setOpacity(0);
  win.showInactive();
  // Re-assert on every show: on Windows the display affinity of a transparent
  // window does not reliably survive create/hide cycles (checked live with
  // GetWindowDisplayAffinity — it read 0x0 with only the creation-time call).
  if (!process.env.MONET_OVERLAY_CAPTURABLE) win.setContentProtection(true);
  await Promise.all([tweenOpacity(win, 1, gen), dodgeApp(gen)]);
}

/** The run is over (or idle): fade the frame, bring the app window back. */
export function releaseComputerOverlay(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!shown) return;
  shown = false;
  const gen = ++generation;
  const win = overlay;
  void restoreApp(gen);
  if (win && !win.isDestroyed()) {
    void tweenOpacity(win, 0, gen).then(() => {
      if (gen === generation && win && !win.isDestroyed()) win.hide();
    });
  }
}

/** Settings → "Preview": run the whole show for a few seconds. */
export async function previewComputerOverlay(ms = 4000): Promise<void> {
  await touchComputerOverlay();
  setTimeout(() => releaseComputerOverlay(), ms);
}
