/**
 * Computer Use overlay — while the agent is driving the mouse/keyboard, a
 * glowing brand-coloured frame breathes around the screen edge.
 *
 * The app window ALSO dodges into the top-right corner at its minimum size,
 * on every platform: there is no other way to keep it watchable — and Stop
 * reachable — without it sitting on top of the apps being driven.
 *
 * macOS needs one extra step first. A window in native fullscreen owns a
 * Space of its own and cannot be reframed while it does, so the run begins by
 * leaving fullscreen and ends by returning to it. Parked, the card also joins
 * every Space, or activating a fullscreen target app would leave it behind on
 * the desktop the user just left.
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

import { BrowserWindow, globalShortcut, screen } from "electron";
import { APP_MIN_HEIGHT, APP_MIN_WIDTH } from "../app/main-window.js";

const IS_MAC = process.platform === "darwin";

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
/** macOS: the window was in native fullscreen when the run started, and owes
 * itself a return to it. */
let macWasFullScreen = false;

/**
 * Toggle native fullscreen and wait for the animation to finish.
 *
 * The transition is asynchronous and about half a second long; acting on the
 * window before it lands (showing the frame, reading bounds) catches it
 * mid-flight. The timeout is there because the event does not arrive at all
 * when the window is already in the requested state.
 */
function setFullScreenAwaited(
  win: BrowserWindow,
  full: boolean,
): Promise<void> {
  if (win.isFullScreen() === full) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 1500);
    // Subscribed per branch: Electron types these as separate overloads, so a
    // union of the two names matches neither.
    if (full) win.once("enter-full-screen", done);
    else win.once("leave-full-screen", done);
    win.setFullScreen(full);
  });
}

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

/** The display the frame belongs on: the one holding the pointer, so a
 * multi-monitor user sees it around the screen actually being driven. */
function overlayDisplay(): Electron.Display {
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch {
    return screen.getPrimaryDisplay();
  }
}

/**
 * Make the frame float over EVERYTHING, on every Space.
 *
 * Re-applied on every show rather than only at creation. On macOS a window's
 * collection behaviour and its sharing type are both reset by ordinary
 * hide/show cycles and by a Space switch; on Windows the display affinity of
 * a transparent window does not reliably survive create/hide either (checked
 * live with GetWindowDisplayAffinity — it read 0x0 with only the
 * creation-time call). Asserting it every time is cheap and is the difference
 * between a frame that always works and one that works until the user moves
 * to another desktop.
 */
function assertOverlayLevel(win: BrowserWindow): void {
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true);
  if (IS_MAC) {
    // Without this the frame is invisible the moment the user is in a
    // fullscreen app or a second Space — exactly when Computer Use runs.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  if (!process.env.MONET_OVERLAY_CAPTURABLE) win.setContentProtection(true);
}

function ensureOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay;
  overlay = new BrowserWindow({
    ...overlayDisplay().bounds,
    frame: false,
    transparent: true,
    // A non-activating panel is what lets a window sit above a fullscreen
    // app on macOS; a plain window is confined to its own Space.
    ...(IS_MAC ? { type: "panel" as const } : {}),
    backgroundColor: "#00000000",
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
  assertOverlayLevel(overlay);
  // The frame is visible to the user and absent from every screen capture
  // (including the agent's own) — see assertOverlayLevel.
  // MONET_OVERLAY_CAPTURABLE=1 keeps it in captures, the only way to verify
  // the glow visually in an automated run.
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
  const wa = overlayDisplay().workArea;
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
  // Defensive: the run normally leaves fullscreen before the frame is built
  // (see touchComputerOverlay), because a fullscreen window cannot be
  // reframed and because the frame's all-Spaces request strands one. This
  // covers any other caller.
  if (IS_MAC) await leaveFullScreenForRun(win);
  savedPlacement = { bounds: win.getBounds(), maximized: win.isMaximized() };
  if (savedPlacement.maximized) win.unmaximize();
  // The parked card stays watchable over a maximized target app — but the
  // AGENT must not know it exists: content protection keeps it out of the
  // vision capture (same trick as the glow frame), the element filter and the
  // click guard handle the rest. The renderer collapses its sidebar so the
  // chat fits the narrow card — see "computer:parked" in App.tsx.
  win.setAlwaysOnTop(true, "floating");
  win.setContentProtection(true);
  // Follow the user across Spaces. Without it, the agent activating a
  // fullscreen app leaves the card behind on the desktop they came from —
  // which is the whole of what it is for. Safe here and not on the frame:
  // fullscreen is already over by this point.
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.send("computer:parked", true);
  await tweenBounds(win, dodgeTarget(), gen);
}

async function restoreApp(gen: number): Promise<void> {
  const win = dodgeWindow;
  const saved = savedPlacement;
  if (!saved) return;
  savedPlacement = null;
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(false);
  win.setContentProtection(false);
  if (IS_MAC) win.setVisibleOnAllWorkspaces(false);
  win.webContents.send("computer:parked", false);
  await tweenBounds(win, saved.bounds, gen);
  if (gen !== generation) return;
  if (saved.maximized) win.maximize();
  // Fullscreen last: it is an animation of its own, and starting it before
  // the window is back at its old frame makes the restore visibly fight it.
  if (macWasFullScreen) {
    macWasFullScreen = false;
    await setFullScreenAwaited(win, true);
  }
}

/** Leave native fullscreen for the duration of a run, remembering to go back.
 * A no-op off macOS and on a window that is not fullscreen. */
async function leaveFullScreenForRun(win: BrowserWindow): Promise<void> {
  if (!IS_MAC || !win.isFullScreen()) return;
  macWasFullScreen = true;
  await setFullScreenAwaited(win, false);
}

/**
 * The panic key, live only while the agent is driving.
 *
 * Always-on-top puts the card where the user can SEE it, but not where they
 * can reliably click Stop: every action the agent takes pulls focus back to
 * the app it is working in, so the click and the next focus steal race. A
 * global shortcut does not need focus, which is the whole point.
 */
const STOP_HOTKEY = "Ctrl+Alt+Esc";

function armStopHotkey(): void {
  try {
    if (globalShortcut.isRegistered(STOP_HOTKEY)) return;
    const ok = globalShortcut.register(STOP_HOTKEY, () => {
      void (async () => {
        const { abortAllRuns } = await import("../ipc/chat.js");
        const n = abortAllRuns();
        console.log(`[computer] ${STOP_HOTKEY} — aborted ${n} run(s)`);
        releaseComputerOverlay();
      })();
    });
    if (!ok) console.warn(`[computer] could not register ${STOP_HOTKEY}`);
  } catch {
    /* a hotkey is a convenience — never fail a run over it */
  }
}

function disarmStopHotkey(): void {
  try {
    globalShortcut.unregister(STOP_HOTKEY);
  } catch {
    /* ignore */
  }
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
  if (shown) {
    // Re-assert on every action, not just the first: an app that grabs
    // topmost for itself (installers, some Office dialogs) would otherwise
    // bury the card for the rest of the run, and the user's way to watch —
    // and to reach Stop — goes with it.
    const win = dodgeWindow;
    if (savedPlacement && win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, "floating");
      win.moveTop();
    }
    // The frame has the same problem and no card to fall back on: a target
    // app going fullscreen mid-run used to hide it for good.
    if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
      const d = overlayDisplay().bounds;
      const cur = overlay.getBounds();
      if (cur.x !== d.x || cur.y !== d.y || cur.width !== d.width || cur.height !== d.height)
        overlay.setBounds(d);
      assertOverlayLevel(overlay);
    }
    return;
  }
  shown = true;
  armStopHotkey();
  const gen = ++generation;
  // Fullscreen ends FIRST on macOS, before the frame exists. The frame asks
  // to be visible on every Space, and that request lands on the whole app:
  // made while our own window is still in native fullscreen, it drops that
  // window out of its Space presentation and leaves a stranded copy of its
  // old frame behind (reproduced with CGWindowList — the restored 1200x800
  // frame appears the moment setVisibleOnAllWorkspaces runs, and only then).
  // Only the fullscreen exit is awaited here; the park itself animates
  // alongside the frame, as everywhere else.
  if (IS_MAC && dodgeWindow && !dodgeWindow.isDestroyed())
    await leaveFullScreenForRun(dodgeWindow);
  const win = ensureOverlay();
  win.setBounds(overlayDisplay().bounds);
  win.setOpacity(0);
  win.showInactive();
  assertOverlayLevel(win);
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
  disarmStopHotkey();
  const gen = ++generation;
  const win = overlay;
  if (win && !win.isDestroyed()) {
    void tweenOpacity(win, 0, gen).then(() => {
      if (gen === generation && win && !win.isDestroyed()) win.hide();
      // Mac: the frame is hidden now, so restoring fullscreen cannot collide
      // with its all-Spaces request. Elsewhere the two are independent and
      // the window comes back while the frame fades.
      if (IS_MAC) void restoreApp(gen);
    });
    if (!IS_MAC) void restoreApp(gen);
  } else {
    void restoreApp(gen);
  }
}

/** Settings → "Preview": run the whole show for a few seconds. */
export async function previewComputerOverlay(ms = 4000): Promise<void> {
  await touchComputerOverlay();
  setTimeout(() => releaseComputerOverlay(), ms);
}
