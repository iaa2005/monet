import { app, BrowserWindow, ipcMain } from "electron";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { registerAllIPC } from "./ipc/index.js";
import { createTray } from "./tray.js";
import { applyDataDirEnv } from "./data-dir.js";

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

app.whenReady().then(() => {
  registerAllIPC();

  // Custom window controls (frameless title bar).
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:toggleMaximize", () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle("window:close", () => mainWindow?.close());
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
