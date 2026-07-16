import { app, BrowserWindow, ipcMain } from "electron";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { registerAllIPC } from "./ipc/index.js";
import { createTray } from "./tray.js";
import { applyDataDirEnv } from "./data-dir.js";
import { purgeIncognitoLeftovers } from "./incognito.js";
import { ensureBuiltinSkills } from "./builtin-skills.js";

// The main bundle is ESM ("type": "module"), where __dirname is not defined.
// Derive it from import.meta.url so preload/renderer paths resolve.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Redirect vendored Claude Code config/memory into our data dir before anything
// touches the filesystem.
applyDataDirEnv();

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: "Claude Code Desktop",
    // Hide the native title bar but keep the resizable window frame so we can
    // draw a custom header + window controls (looks native, not Electron).
    titleBarStyle: "hidden",
    backgroundColor: "#f7f6f1",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
    },
  });

  // Open DevTools in dev mode for debugging
  // DevTools only with CLAUDE_DEVTOOLS=1
  if (isDev && process.env.CLAUDE_DEVTOOLS) {
    mainWindow.webContents.openDevTools();
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
    title: "Claude Code Desktop",
    titleBarStyle: "hidden",
    backgroundColor: "#f7f6f1",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
    },
  });
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
  registerAllIPC();

  // Incognito hygiene: a crash can leave incognito artifacts/sandboxes on
  // disk — sweep them before anything else runs.
  purgeIncognitoLeftovers();

  // Ship the built-in skills (created only when missing).
  ensureBuiltinSkills();


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
