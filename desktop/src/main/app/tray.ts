import { app, Tray, Menu, BrowserWindow } from "electron";
import { APP_NAME } from "@shared/brand.js";
import { appIconImage } from "./icon.js";

let tray: Tray | null = null;
let isQuitting = false;

export function createTray(mainWindow: BrowserWindow): void {
  if (process.platform === "darwin") {
    // The menu bar wants a TEMPLATE image — macOS keeps only the alpha
    // channel and paints it black/white to match the bar, in both themes.
    // A colored 16px PNG there renders as a smudged full-color dot.
    const img = appIconImage(18);
    img.setTemplateImage(true);
    tray = new Tray(img);
  } else {
    tray = new Tray(appIconImage(16));
  }
  tray.setToolTip(APP_NAME);

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
