/**
 * Browser IPC — config, the session partition the panel's <webview> mounts
 * with, and dev-server discovery.
 *
 * Toggling the feature resets the vendor tool cache so the Code toolset picks
 * the browser tools up (or drops them) immediately, and turning it OFF shuts
 * the external browser down.
 */

import { ipcMain, session } from "electron";
import {
  getBrowserConfig,
  setBrowserConfig,
  type BrowserConfig,
} from "../browser/config.js";
import { partitionFor } from "../browser/session.js";
import { detectDevServers, type DevServer } from "../browser/dev-servers.js";
import { resetVendorTools } from "../agent/vendor-tools.js";
import { shutdownBrowser } from "../browser/chrome.js";
import { disconnectCdp } from "../browser/cdp.js";
import { getWorkspacePath } from "./workspace.js";

export function registerBrowserIPC(): void {
  ipcMain.handle("browser:getConfig", (): BrowserConfig => getBrowserConfig());
  ipcMain.handle(
    "browser:setConfig",
    (_e, patch: Partial<BrowserConfig>): BrowserConfig => {
      const next = setBrowserConfig(patch);
      resetVendorTools();
      if (!next.enabled || next.engine !== "external") {
        disconnectCdp();
        shutdownBrowser();
      }
      return next;
    },
  );

  // The panel asks for its partition rather than deriving one: the naming rule
  // decides which logins carry over between runs, and one authority for it is
  // the difference between "still signed into staging" and "signed out again".
  ipcMain.handle("browser:partition", (_e, sessionId?: string): string =>
    partitionFor({
      mode: getBrowserConfig().persistSessions,
      workspace: getWorkspacePath(),
      sessionId,
    }),
  );

  ipcMain.handle("browser:clearData", async (_e, partition: string): Promise<void> => {
    if (!partition.startsWith("monet-browser") && !partition.startsWith("persist:monet-browser"))
      return;
    const ses = session.fromPartition(partition);
    await ses.clearStorageData();
    await ses.clearCache();
  });

  ipcMain.handle("browser:devServers", (): Promise<DevServer[]> =>
    detectDevServers(getWorkspacePath()),
  );
}
