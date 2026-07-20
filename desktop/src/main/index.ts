import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "node:events";
import { registerAllIPC } from "./ipc/index.js";
import { createTray } from "./tray.js";
import { applyDataDirEnv } from "./data-dir.js";
import { purgeIncognitoLeftovers } from "./incognito.js";
import { ensureBuiltinSkills } from "./builtin-skills.js";
import { initPowerSaveBlocker } from "./power.js";
import { initBetaGuard } from "./beta.js";

// The main bundle is ESM ("type": "module"), where __dirname is not defined.
// Derive it from import.meta.url so preload/renderer paths resolve.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Redirect vendored Claude Code config/memory into our data dir before anything
// touches the filesystem.
applyDataDirEnv();

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: "Code Monet",
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
    },
  });

  installWindowProcessHandlers(mainWindow, "main");

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
    title: "Code Monet",
    titleBarStyle: "hidden",
    backgroundColor: "#f7f6f1",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      devTools: isDev,
    },
  });
  installWindowProcessHandlers(win, "secondary");

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
