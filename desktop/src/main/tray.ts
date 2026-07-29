import { app, Tray, Menu, nativeImage, BrowserWindow } from "electron";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// The main bundle is ESM, where __dirname does not exist — same derivation as
// in index.ts. Everything here bundles into out/main/index.js, so this points
// at out/main/ in dev and inside the asar when packaged.
const bundleDir = dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
let isQuitting = false;

/**
 * The tray image.
 *
 * This used to be `nativeImage.createEmpty()` — a literally blank picture, so
 * the tray showed the app's tooltip next to nothing at all.
 *
 * `app.getAppPath()` is the project root in dev and the asar root when
 * packaged, so ONE path covers both — provided `build/icon.png` is in
 * electron-builder's `files`, which it now is. Without that the icon would
 * work all through development and vanish the moment it shipped.
 *
 * Windows wants 16px; the source is 620px, and nativeImage resizes it.
 */
function trayImage(): Electron.NativeImage {
  // Anchored to THIS bundle, not to app.getAppPath(): that returns whatever
  // directory Electron was pointed at, which differs between `electron .`,
  // `electron path/to/script`, and a packaged launch. The bundle always sits
  // at `out/main/`, in dev and inside the asar alike, so `../../build` is one
  // expression that holds everywhere.
  const fromBundle = join(bundleDir, "..", "..", "build");
  const candidates = [
    join(fromBundle, "icon.png"),
    join(fromBundle, "icon.ico"),
    join(app.getAppPath(), "build", "icon.png"),
    // Packaged layouts that keep resources outside the asar.
    join(process.resourcesPath ?? "", "build", "icon.png"),
    join(process.resourcesPath ?? "", "icon.png"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const img = nativeImage.createFromPath(path);
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  }
  // Nothing found: say so rather than installing a blank icon silently, which
  // is exactly how this went unnoticed the first time.
  console.warn(
    `[tray] no icon found (looked in: ${candidates.join(", ")}) — the tray will be blank`,
  );
  return nativeImage.createEmpty();
}

export function createTray(mainWindow: BrowserWindow): void {
  tray = new Tray(trayImage());
  tray.setToolTip("Code Monet");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show/Hide",
      click: () => {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}
