import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from "electron";
import { canvasFor } from "../shared/canvas-colour.js";
import { APP_NAME } from "@shared/brand.js";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { EventEmitter } from "node:events";
import { registerAllIPC } from "./ipc/index.js";
import { createTray } from "./app/tray.js";
import { appIconPath } from "./app/icon.js";
import { applyDataDirEnv } from "./data-dir.js";
import { fixGuiPath } from "./app/shell-path.js";
import { recordTitle, recordVisit } from "./browser/bookmarks.js";
import { purgeIncognitoLeftovers } from "./session/incognito.js";
import { ensureBuiltinSkills } from "./skills/builtin.js";
import { initPowerSaveBlocker } from "./app/power.js";
import { initBetaGuard } from "./app/beta.js";
import { applyLeanEnv } from "./agent/lean-context.js";
import { initNightlyConsolidation } from "./memory/nightly.js";
import { initDevApi } from "./app/dev-api.js";
import { isAcpLaunch, runAcpMode } from "./acp/index.js";
import { setDodgeWindow } from "./computer/overlay.js";
import {
  APP_MIN_HEIGHT,
  APP_MIN_WIDTH,
  setMainWindow,
} from "./app/main-window.js";

// The main bundle is ESM ("type": "module"), where __dirname is not defined.
// Derive it from import.meta.url so preload/renderer paths resolve.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Redirect vendored Claude Code config/memory into our data dir before anything
// touches the filesystem.
applyDataDirEnv();

// GUI launches inherit launchd's bare PATH on macOS — graft the login shell's
// PATH on before any subsystem spawns a process or probes for a binary.
fixGuiPath();

// `--acp`: an editor spawned us to speak the Agent Client Protocol over
// stdio. Same engine, no window. Taken before any window or tray code runs —
// and before anything can log, since stdout IS the protocol stream there.
if (isAcpLaunch(process.argv)) {
  void runAcpMode().catch((err) => {
    process.stderr.write(`[acp] ${err instanceof Error ? err.stack : String(err)}\n`);
    app.exit(1);
  });
}

// Lean context: the vendor memoises its auto-memory prompt section on first
// build, so the opt-out has to be set now — before any prompt exists.
applyLeanEnv();

// Every new webContents starts from this, and a popup's first request can
// leave before any per-window handler runs. Session-level setUserAgent was not
// enough: Google still answered "this browser or app may not be secure".
app.userAgentFallback = chromeUserAgent();

// FedCM is ON in this Chromium but has no UI in Electron, and that kills
// "Sign in with Google" buttons built on Google Identity Services without a
// trace: GIS sees IdentityCredential, calls navigator.credentials.get, and
// waits for a browser dialog that no one will ever draw — no popup, no error,
// a dead click (seen live on kimi.com). With the feature off, GIS falls back
// to its window.open popup flow, which the window-open handler below turns
// into a real child window. Must be set before app is ready.
app.commandLine.appendSwitch("disable-features", "FedCm");

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let fatalErrorHandled = false;

function logProcessError(kind: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[main] ${kind}: ${detail}`);
}

// An uncaught exception can leave application state partially mutated. Log it,
// then terminate through Electron's normal shutdown path instead of continuing
// with a potentially corrupted main process.
process.on("uncaughtException", (error) => {
  logProcessError("uncaughtException", error);
  if (!fatalErrorHandled) {
    fatalErrorHandled = true;
    app.quit();
  }
});

process.on("unhandledRejection", (reason) => {
  logProcessError("unhandledRejection", reason);
});

type ChildProcessGoneDetails = {
  type: string;
  reason: string;
  exitCode: number;
};

function installWindowProcessHandlers(win: BrowserWindow, label: string): void {
  let recoveryAttempts = 0;
  let lastRecoveryAt = 0;
  const recoveryCooldownMs = 30_000;
  const maxRecoveryAttempts = 1;

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      `[main] render-process-gone (${label}): reason=${details.reason}, exitCode=${details.exitCode}`,
    );

    const now = Date.now();
    const canRecover =
      recoveryAttempts < maxRecoveryAttempts &&
      now - lastRecoveryAt >= recoveryCooldownMs &&
      !win.isDestroyed();
    if (!canRecover) {
      console.error(`[main] renderer recovery skipped (${label}): retry limit reached`);
      return;
    }

    recoveryAttempts += 1;
    lastRecoveryAt = now;
    console.error(`[main] reloading renderer once (${label})`);
    win.reload();
  });

  // Electron 33 emits this event, but the bundled WebContents typings do not
  // expose its overload. Keep the listener typed without weakening the rest of
  // the BrowserWindow API.
  (win.webContents as unknown as EventEmitter).on(
    "child-process-gone",
    (_event: unknown, details: ChildProcessGoneDetails) => {
      console.error(
        `[main] child-process-gone (${label}): type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}`,
      );
    },
  );
}

/**
 * Everything a <webview> guest is allowed to be.
 *
 * The renderer sets the guest's attributes, so a bug (or injected page content
 * that reaches our own DOM) could ask for a preload script or Node. Main has
 * the last word here, and takes it: the panel needs no preload at all — the
 * design-mode overlay is injected through CDP, because React's fibre expandos
 * live on the main world and a preload could not read them anyway.
 */
function installWebviewGuards(win: BrowserWindow): void {
  win.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.webSecurity = true;

    const src = String(params.src ?? "");
    if (src && !/^(https?:|file:|about:blank$|data:text\/html)/i.test(src)) {
      console.error(`[browser] refused to attach a webview to ${src}`);
      _event.preventDefault();
    }
  });

  // target=_blank / window.open inside a page. Opening a real OS window would
  // put a page outside every control this app has over it; the panel's own tab
  // strip is where it belongs.
  win.webContents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(({ url, disposition }) => {
      // A POPUP GETS A REAL WINDOW. A LINK GETS A TAB. No host list.
      //
      // Denying every window.open and re-opening it as a tab is right for
      // target=_blank and wrong for a popup, because a popup ANSWERS ITS
      // OPENER: an OAuth flow hands its result back through
      // window.opener/postMessage, and a tab has no opener, so a sign-in that
      // succeeds has nowhere to return and the page simply sits there. It is
      // also invisible when it fails — a popup usually opens on about:blank and
      // is filled by script, so the https test below never matched it: deny, no
      // tab, no trace on screen.
      //
      // Chromium already tells the two apart and the answer is in `disposition`:
      // window.open with features is 'new-window', a plain target=_blank is
      // 'foreground-tab'. Keying on that needs no list of sites, works for a
      // domain nobody thought of, and keeps the tab strip for the case it was
      // built for.
      if (disposition === "new-window" || disposition === "other") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 520,
            height: 680,
            autoHideMenuBar: true,
            // No partition override: the child inherits the guest's session, so
            // the cookie a sign-in sets is the one the panel will read.
            webPreferences: { nodeIntegration: false, contextIsolation: true },
          },
        };
      }
      if (/^https?:/i.test(url) && !win.isDestroyed())
        win.webContents.send("browser:openTab", url);
      return { action: "deny" };
    });

    guest.on("did-create-window", (child) => {
      child.webContents.setUserAgent(chromeUserAgent());
      child.once("ready-to-show", () => child.show());
    });

    // ONE UA for the whole pane, set on the session so every request in it —
    // the page, its popups, their subresources — carries the same thing.
    //
    // Ours says Electron, and Google refuses OAuth in anything that does
    // (disallowed_useragent, their rule against embedded webviews). Stripping it
    // is not a lie: this IS Chromium, and the version below is its real one. Set
    // on the session rather than per-window because a popup's first request can
    // be on the wire before any window handler runs.
    const ses = guest.session;
    if (!uaSet.has(ses)) {
      uaSet.add(ses);
      ses.setUserAgent(chromeUserAgent());
      // THE CLIENT HINTS ARE THE OTHER TELL — but not the way the first fix
      // here assumed. Measured on this exact runtime (Electron 33 / Chromium
      // 130): the page-side API is alive and answers
      //   navigator.userAgentData.brands = "Not?A_Brand";99, "Chromium";130
      // — no Electron in it — while the NETWORK side sends no Sec-CH-UA
      // header at all, on any request. A UA string claiming Chrome/130 with
      // no client hints beside it is a combination no real browser produces
      // (real Chromium sends the three low-entropy hints with every https
      // request), and Google's sign-in reads that inconsistency as "this
      // browser or app may not be secure". The first fix made it worse: it
      // invented a "Google Chrome" brand in the headers that the page's own
      // JS then contradicted.
      //
      // So the headers now say EXACTLY what the JS already says — brands,
      // order and GREASE token copied from navigator.userAgentData of this
      // runtime, not invented.
      const major = (process.versions.chrome || "130").split(".")[0];
      const platform =
        process.platform === "darwin"
          ? "macOS"
          : process.platform === "win32"
            ? "Windows"
            : "Linux";
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const h = details.requestHeaders;
        h["User-Agent"] = chromeUserAgent();
        if (/^https:/i.test(details.url)) {
          h["sec-ch-ua"] = `"Not?A_Brand";v="99", "Chromium";v="${major}"`;
          h["sec-ch-ua-mobile"] = "?0";
          h["sec-ch-ua-platform"] = `"${platform}"`;
        }
        callback({ requestHeaders: h });
      });
    }

    // The visit log behind the empty tab's "Recent" section. Recorded here
    // rather than in the renderer because every page the panel shows IS a
    // webview guest attaching to some window — one hook covers every tab in
    // every window, including ones the agent navigates. Titles arrive on
    // their own event, usually a beat after the navigation.
    guest.on("did-navigate", (_e, url) => recordVisit(url));
    guest.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (isMainFrame) recordVisit(url);
    });
    guest.on("page-title-updated", (_e, title) =>
      recordTitle(guest.getURL(), title),
    );
  });

  // The same rule for the app's OWN window. Without a handler, any stray
  // target="_blank" that survives review opens a bare Electron window: no
  // address bar, no tabs, no way to tell what you are looking at. The renderer
  // routes clicks itself (lib/open-link.ts); this is the floor under that.
  //
  // ONE exception: the dock's popout — our own popout.html, same origin. That
  // window must share the renderer's process (dockview ADOPTS the group's
  // live DOM into it), which window.open gives and a BrowserWindow would not.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isPopoutUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: canvasFor(nativeTheme.shouldUseDarkColors),
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            // The Browser panel can be popped out too, webviews and all.
            webviewTag: true,
          },
        },
      };
    }
    if (/^https?:/i.test(url) && !win.isDestroyed())
      win.webContents.send("browser:openTab", url);
    return { action: "deny" };
  });

  // A popout is a real BrowserWindow: it needs the same webview hardening and
  // the same window-open floor as the window it came from — a page inside a
  // popped-out Browser panel calling window.open must land in a tab, not in
  // an unguarded OS window.
  win.webContents.on("did-create-window", (child) => {
    installWebviewGuards(child);
  });
}

/**
 * Only the app's own popout host page may become a real window.
 *
 * Dev: the vite origin. Packaged: a file: URL inside our renderer output.
 * Everything else stays denied — this must never widen into "any file:".
 */
/**
 * A plain Chrome User-Agent, built from the Chromium this app already runs.
 *
 * Google refuses OAuth in anything whose UA says Electron — `disallowed_useragent`,
 * their policy against embedded webviews — and ours says it twice: the app name
 * and `Electron/x.y.z`. Stripping both leaves a UA that is not a lie: it is the
 * same Chromium, and the version is its real one.
 */
export function chromeUserAgent(): string {
  const chrome = process.versions.chrome || "120.0.0.0";
  return (
    `Mozilla/5.0 (${uaPlatformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${chrome} Safari/537.36`
  );
}

/** The OS token real Chrome sends on this platform — the UA must not claim
 * Windows on a Mac, or sites serve Ctrl-key shortcuts and Windows downloads,
 * and the sec-ch-ua-platform header (set elsewhere) would contradict it. */
function uaPlatformToken(): string {
  if (process.platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  if (process.platform === "win32") return "Windows NT 10.0; Win64; x64";
  return "X11; Linux x86_64";
}

/** Sessions already given the plain Chrome UA. */
const uaSet = new WeakSet<Electron.Session>();

function isPopoutUrl(url: string): boolean {
  if (!/popout\.html(\?|#|$)/.test(url)) return false;
  const devOrigin = process.env["ELECTRON_RENDERER_URL"];
  if (devOrigin) {
    try {
      return new URL(url).origin === new URL(devOrigin).origin;
    } catch {
      return false;
    }
  }
  const rendererRoot = pathToFileURL(join(__dirname, "../renderer/")).href;
  return url.startsWith(rendererRoot);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // Half the old floor: 800 was wider than the layout actually needs, and it
    // stopped the window from being parked narrow beside something else.
    minWidth: APP_MIN_WIDTH,
    minHeight: APP_MIN_HEIGHT,
    show: false,
    title: APP_NAME,
    // Packaged builds take the icon from the exe; a dev launch is plain
    // Electron and shows Electron's own logo unless it is handed one.
    ...(appIconPath() ? { icon: appIconPath() as string } : {}),
    // Hide the native title bar but keep the resizable window frame so we can
    // draw a custom header + window controls (looks native, not Electron).
    titleBarStyle: "hidden",
    // macOS keeps its native traffic lights; center them in the custom
    // header (36px tall) instead of the default top-left corner spot.
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 12, y: 10 } }
      : {}),
    backgroundColor: canvasFor(nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      devTools: isDev,
      // The Browser panel embeds pages as <webview>. Guests are hardened in
      // installWebviewGuards — enabling the tag alone grants nothing.
      webviewTag: true,
    },
  });

  installWindowProcessHandlers(mainWindow, "main");
  installWebviewGuards(mainWindow);
  // During Computer Use this window dodges into a corner — see computer/overlay.
  setDodgeWindow(mainWindow);
  // The window IPC handlers talk to — never getAllWindows()[0], which can be
  // the Computer Use overlay. See app/main-window.ts for the incident.
  setMainWindow(mainWindow);

  // Open DevTools in dev mode for debugging
  // DevTools only with CLAUDE_DEVTOOLS=1
  if (isDev && process.env.CLAUDE_DEVTOOLS) {
    mainWindow.webContents.openDevTools();
  }

  // Block devtools shortcuts (F12, Ctrl/Cmd+Shift+I, Ctrl/Cmd+Shift+J,
  // Ctrl/Cmd+R) in packaged builds so users can't open devtools.
  if (!isDev) {
    mainWindow.webContents.on("before-input-event", (event, input) => {
      const mod = input.control || input.meta;
      const devtoolsShortcut =
        input.key === "F12" ||
        (mod && input.alt && (input.key === "I" || input.key === "i")) ||
        (mod && input.alt && (input.key === "J" || input.key === "j"));
      const reloadShortcut = mod && (input.key === "R" || input.key === "r");
      if (devtoolsShortcut || reloadShortcut) {
        event.preventDefault();
      }
    });
  }

  // Log load failures
  mainWindow.webContents.on("did-fail-load", (_event, code, desc, url) => {
    console.error(`Failed to load: ${url} — ${code}: ${desc}`);
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  // Notify the renderer when the maximized state changes so the custom
  // maximize/restore button can update its icon.
  mainWindow.on("maximize", () =>
    mainWindow?.webContents.send("window:maximized", true),
  );
  mainWindow.on("unmaximize", () =>
    mainWindow?.webContents.send("window:maximized", false),
  );
  // macOS hides the traffic lights in fullscreen; the header's inset for
  // them must collapse with them or the logo floats 72px from the edge.
  mainWindow.on("enter-full-screen", () =>
    mainWindow?.webContents.send("window:fullscreen", true),
  );
  mainWindow.on("leave-full-screen", () =>
    mainWindow?.webContents.send("window:fullscreen", false),
  );

  // Load renderer
  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

/** Open an additional, independent app window (shares the same session DB / data
 * dir). Used by the "New window" menu item. */
function openSecondaryWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // Half the old floor: 800 was wider than the layout actually needs, and it
    // stopped the window from being parked narrow beside something else.
    minWidth: APP_MIN_WIDTH,
    minHeight: APP_MIN_HEIGHT,
    show: false,
    title: APP_NAME,
    // Packaged builds take the icon from the exe; a dev launch is plain
    // Electron and shows Electron's own logo unless it is handed one.
    ...(appIconPath() ? { icon: appIconPath() as string } : {}),
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 12, y: 10 } }
      : {}),
    backgroundColor: canvasFor(nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      devTools: isDev,
      // The Browser panel embeds pages as <webview>. Guests are hardened in
      // installWebviewGuards — enabling the tag alone grants nothing.
      webviewTag: true,
    },
  });
  installWindowProcessHandlers(win, "secondary");
  installWebviewGuards(win);

  if (!isDev) {
    win.webContents.on("before-input-event", (event, input) => {
      const mod = input.control || input.meta;
      const devtoolsShortcut =
        input.key === "F12" ||
        (mod && input.alt && (input.key === "I" || input.key === "i")) ||
        (mod && input.alt && (input.key === "J" || input.key === "j"));
      const reloadShortcut = mod && (input.key === "R" || input.key === "r");
      if (devtoolsShortcut || reloadShortcut) {
        event.preventDefault();
      }
    });
  }
  win.on("ready-to-show", () => win.show());
  win.on("maximize", () => win.webContents.send("window:maximized", true));
  win.on("unmaximize", () => win.webContents.send("window:maximized", false));
  win.on("enter-full-screen", () =>
    win.webContents.send("window:fullscreen", true),
  );
  win.on("leave-full-screen", () =>
    win.webContents.send("window:fullscreen", false),
  );
  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// Windows attributes every toast to an AppUserModelID. Unset, that is
// "electron.app.Electron" — which is what the notification then calls itself.
// Packaged, it must equal electron-builder's appId so the toast matches the
// Start Menu shortcut the installer wrote (that shortcut is where Windows
// reads the app's name and icon from). In dev there is no such shortcut, so
// Windows falls back to printing the id itself — hence the readable name.
if (process.platform === "win32") {
  app.setAppUserModelId(app.isPackaged ? "com.codemonet.desktop" : APP_NAME);
}

app.whenReady().then(() => {
  // ACP mode owns the process: no window, no tray, no menu. runAcpMode has
  // its own whenReady and drives everything from stdio.
  if (isAcpLaunch(process.argv)) return;

  // In packaged builds, replace the default menu (which exposes
  // "Toggle Developer Tools" and "Reload") with an empty one so users
  // can't open devtools via the menu bar.
  if (!isDev) {
    Menu.setApplicationMenu(null);
  }

  // Time-limited beta builds die here — before any window or IPC exists.
  if (!initBetaGuard()) return;

  registerAllIPC();
  // Rows from chats that no longer exist — a crash, or a version that did not
  // clean up after a delete. Startup-only: an incognito chat has no session
  // row while it runs, so sweeping mid-session would erase a live one.
  void import("./session/purge.js")
    .then((m) => m.sweepOrphans())
    .catch(() => {});

  // Incognito hygiene: a crash can leave incognito artifacts/sandboxes on
  // disk — sweep them before anything else runs.
  purgeIncognitoLeftovers();

  // Ship the built-in skills (created only when missing).
  ensureBuiltinSkills();

  // Memory: distil the day's logs into memory files overnight (or on catch-up
  // if the machine was off at 3am). No-ops unless there's new signal.
  initNightlyConsolidation();

  // Dev-only local API for driving the app from outside (prompt evals).
  // No-ops unless MONET_DEV_API=1, and refuses in a packaged build.
  initDevApi();

  // Re-arm "keep awake" if it was left on — a preference that forgets itself on
  // restart is worse than none, since the user thinks the machine is held awake.
  initPowerSaveBlocker();

  // If the browser tools drive the user's OWN browser, start listening for its
  // extension NOW. The extension is the side that dials, and it can only dial
  // something that answers: a server brought up lazily on the first tool call
  // leaves the extension saying "Waiting for Code Monet…" from the moment the
  // app starts until the agent happens to need a page — which reads as the
  // pairing being broken. Cheap: a loopback listener with no client.
  void import("./browser/config.js").then(async ({ getBrowserConfig }) => {
    const cfg = getBrowserConfig();
    if (cfg.enabled && cfg.engine === "bridge") {
      const { startBridge } = await import("./browser/bridge.js");
      startBridge();
    }
  });


  // Arm scheduled routines (cron) + the localhost webhook/API trigger server.
  setTimeout(() => {
    void import("./routines/scheduler.js")
      .then((m) => m.startScheduler())
      .catch(() => {});
    void import("./routines/trigger-server.js")
      .then((m) => m.startTriggerServer())
      .catch(() => {});
  }, 3_000);

  // Background auto-update from GitHub Releases; surfaces only as the
  // "Relaunch to update" pill once a new version is downloaded.
  void import("./app/updater.js")
    .then((m) => m.startAutoUpdater())
    .catch(() => {});

  // Put a bundled/previously-downloaded portable Podman on PATH so the engine
  // finds it; if Podman is the selected sandbox, provision it in the
  // background so the first run doesn't stall on the download.
  void import("./sandbox/podman-binary.js")
    .then(async (m) => {
      m.addPodmanToPath();
      const { getSandboxConfig } = await import("./sandbox/config.js");
      if (getSandboxConfig().engine === "docker") await m.ensurePodmanBinary();
    })
    .catch(() => {});

  // Custom window controls (frameless title bar).
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:toggleMaximize", () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.handle("window:new", () => openSecondaryWindow());
  ipcMain.handle(
    "window:isMaximized",
    () => mainWindow?.isMaximized() ?? false,
  );
  // Answered from the window the CALL came from, not mainWindow — the
  // secondary window's header asks about itself.
  ipcMain.handle(
    "window:isFullScreen",
    (e) => BrowserWindow.fromWebContents(e.sender)?.isFullScreen() ?? false,
  );

  createWindow();
  if (mainWindow) createTray(mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("will-quit", () => {
  // Hidden per-chat browser windows must not outlive the app.
  void import("./browser/headless.js")
    .then((m) => m.destroyAllHeadless())
    .catch(() => {});
  // Background sandbox containers, likewise.
  void import("./sandbox/bg-tasks.js")
    .then((m) => m.killAllBgTasks())
    .catch(() => {});
  // Kill the managed Browser Use instance so it doesn't outlive the app.
  void import("./browser/chrome.js")
    .then((m) => m.shutdownBrowser())
    .catch(() => {});
  // Dev servers the panel started. Nothing we spawned keeps a port after we
  // are gone — otherwise the next launch cannot bind it and blames the user.
  void import("./browser/servers.js")
    .then((m) => m.stopAllServers())
    .catch(() => {});
  // Sandbox preview containers (ServeSandbox) — they hold a published port,
  // so leaving one behind breaks the next chat that wants to serve.
  void import("./sandbox/podman-server.js")
    .then((m) => m.stopAllSandboxServers())
    .catch(() => {});
  // Shut down any language servers spawned by the LSP tool.
  void import("./agent/lsp/manager.js")
    .then((m) => m.stopAllLsp())
    .catch(() => {});
  // The chats' shells. They are built to outlive their panel and the chat
  // switch, which means nothing else ever ends them — a `podman run -it` left
  // behind holds the chat's folder open.
  void import("./terminal/sessions.js")
    .then((m) => m.closeAllTerminals())
    .catch(() => {});
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
