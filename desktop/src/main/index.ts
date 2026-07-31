import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { APP_NAME } from "@shared/brand.js";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { EventEmitter } from "node:events";
import { registerAllIPC } from "./ipc/index.js";
import { createTray } from "./tray.js";
import { applyDataDirEnv } from "./data-dir.js";
import { recordTitle, recordVisit } from "./browser/bookmarks.js";
import { purgeIncognitoLeftovers } from "./incognito.js";
import { ensureBuiltinSkills } from "./builtin-skills.js";
import { initPowerSaveBlocker } from "./power.js";
import { initBetaGuard } from "./beta.js";
import { applyLeanEnv } from "./agent/lean-context.js";
import { initNightlyConsolidation } from "./memory/nightly.js";
import { initDevApi } from "./dev-api.js";
import { isAcpLaunch, runAcpMode } from "./acp/index.js";

// The main bundle is ESM ("type": "module"), where __dirname is not defined.
// Derive it from import.meta.url so preload/renderer paths resolve.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Redirect vendored Claude Code config/memory into our data dir before anything
// touches the filesystem.
applyDataDirEnv();

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
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && !win.isDestroyed())
        win.webContents.send("browser:openTab", url);
      return { action: "deny" };
    });

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
          backgroundColor: "#f7f6f1",
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
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    // Hide the native title bar but keep the resizable window frame so we can
    // draw a custom header + window controls (looks native, not Electron).
    titleBarStyle: "hidden",
    backgroundColor: "#f7f6f1",
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
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    titleBarStyle: "hidden",
    backgroundColor: "#f7f6f1",
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
  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
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


  // One-time: give pre-transcript chats a (text-only) durable transcript.
  // Deferred + guarded by a marker so it never blocks startup.
  setTimeout(() => {
    void import("./migrate-transcripts.js")
      .then((m) => m.migrateTranscriptsOnce())
      .catch(() => {});
  }, 2_000);

  // Arm scheduled routines (cron) + the localhost webhook/API trigger server.
  setTimeout(() => {
    void import("./routines/scheduler.js")
      .then((m) => m.startScheduler())
      .catch(() => {});
    void import("./routines/trigger-server.js")
      .then((m) => m.startTriggerServer())
      .catch(() => {});
  }, 3_000);

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

  createWindow();
  if (mainWindow) createTray(mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("will-quit", () => {
  // Kill the managed Browser Use instance so it doesn't outlive the app.
  void import("./browser/chrome.js")
    .then((m) => m.shutdownBrowser())
    .catch(() => {});
  // Dev servers the panel started. Nothing we spawned keeps a port after we
  // are gone — otherwise the next launch cannot bind it and blames the user.
  void import("./browser/servers.js")
    .then((m) => m.stopAllServers())
    .catch(() => {});
  // Shut down any language servers spawned by the LSP tool.
  void import("./agent/lsp/manager.js")
    .then((m) => m.stopAllLsp())
    .catch(() => {});
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
