/**
 * Browser Use IPC — read/write the enabled toggle. Toggling it resets the
 * vendor tool cache so the Code toolset picks the browser tools up/drops them
 * immediately, and turning it OFF shuts the managed browser down.
 */

import { ipcMain } from "electron";
import {
  getBrowserConfig,
  setBrowserConfig,
  type BrowserConfig,
} from "../browser/config.js";
import { resetVendorTools } from "../agent/vendor-tools.js";
import { shutdownBrowser } from "../browser/chrome.js";
import { disconnectCdp } from "../browser/cdp.js";

export function registerBrowserIPC(): void {
  ipcMain.handle("browser:getConfig", (): BrowserConfig => getBrowserConfig());
  ipcMain.handle(
    "browser:setConfig",
    (_e, patch: Partial<BrowserConfig>): BrowserConfig => {
      const next = setBrowserConfig(patch);
      resetVendorTools();
      if (!next.enabled) {
        disconnectCdp();
        shutdownBrowser();
      }
      return next;
    },
  );
}
