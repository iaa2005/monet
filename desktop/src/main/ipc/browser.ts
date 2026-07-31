/**
 * Browser IPC — config, the session partition the panel's <webview> mounts
 * with, and dev-server discovery.
 *
 * Toggling the feature resets the vendor tool cache so the Code toolset picks
 * the browser tools up (or drops them) immediately, and turning it OFF shuts
 * the external browser down.
 */

import { BrowserWindow, dialog, ipcMain, session } from "electron";
import {
  getBrowserConfig,
  setBrowserConfig,
  type BrowserConfig,
} from "../browser/config.js";
import { partitionFor } from "../browser/session.js";
import { detectDevServers, type DevServer } from "../browser/dev-servers.js";
import {
  readServers,
  serverOutput,
  mergeDetected,
  serverStates,
  startServer,
  stopServer,
  suggestFromPackage,
  watchServers,
  writeServers,
  type ServerConfig,
  type ServerState,
} from "../browser/servers.js";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { resetVendorTools } from "../agent/vendor-tools.js";
import { shutdownBrowser } from "../browser/chrome.js";
import { disconnectCdp } from "../browser/page.js";
import {
  activeContents,
  registerTab,
  setActiveTab,
  unregisterTab,
} from "../browser/registry.js";
import { getTransport } from "../browser/transport.js";
import { setDesignMode } from "../browser/inspect.js";
import { onInspectMessage } from "../browser/selection.js";
import { getWorkspacePath } from "./workspace.js";
import { getUiState, setUiState, type SessionUiState } from "../ui-state.js";

export function registerBrowserIPC(): void {
  // The panel redraws whenever a server changes state, rather than polling —
  // "starting" turning into "running" is the moment you are waiting for.
  watchServers(() => {
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send("browser:serversChanged");
  });

  ipcMain.handle("browser:getConfig", (): BrowserConfig => getBrowserConfig());
  ipcMain.handle(
    "browser:setConfig",
    (_e, patch: Partial<BrowserConfig>): BrowserConfig => {
      const before = getBrowserConfig();
      const next = setBrowserConfig(patch);
      resetVendorTools();
      // Turning the tools off tears down both engines. Switching AWAY from the
      // external one closes its window — leaving a Chrome nobody is driving
      // running in the background is how users end up force-quitting it.
      if (!next.enabled) {
        disconnectCdp();
        shutdownBrowser();
      } else if (before.engine === "external" && next.engine === "embedded") {
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

  // The tab registry. The renderer reports ids because it is the only side
  // that knows which guest belongs to which tab, and which tab is on screen.
  ipcMain.handle(
    "browser:registerTab",
    (_e, tabId: string, webContentsId: number): void =>
      registerTab(tabId, webContentsId),
  );
  ipcMain.handle("browser:unregisterTab", (_e, tabId: string): void =>
    unregisterTab(tabId),
  );
  ipcMain.handle("browser:activateTab", (_e, tabId: string): void =>
    setActiveTab(tabId),
  );

  // ── Declared dev servers ────────────────────────────────────────────
  // Declared entries PLUS whatever else is listening, so a server the agent
  // started in a shell shows up like any other.
  ipcMain.handle("servers:list", async (): Promise<ServerState[]> => {
    const workspace = getWorkspacePath();
    const [declared, detected] = await Promise.all([
      serverStates(workspace),
      detectDevServers(workspace),
    ]);
    return mergeDetected(declared, detected);
  });
  ipcMain.handle("servers:save", (_e, servers: ServerConfig[]): void =>
    writeServers(getWorkspacePath(), servers),
  );
  ipcMain.handle("servers:start", (_e, id: string): void =>
    startServer(getWorkspacePath(), id),
  );
  ipcMain.handle("servers:stop", (_e, id: string): void => stopServer(id));
  ipcMain.handle("servers:output", (_e, id: string): string => serverOutput(id));
  // What to offer when the list is empty: the project's own npm scripts, but
  // only the ones that name a port — see suggestFromPackage.
  ipcMain.handle("servers:suggest", (): ServerConfig[] => {
    const workspace = getWorkspacePath();
    if (readServers(workspace).length > 0) return [];
    try {
      return suggestFromPackage(
        readFileSync(join(workspace, "package.json"), "utf-8"),
      );
    } catch {
      return [];
    }
  });

  // Per-chat workspace layout — which panel, which pages. See ui-state.ts.
  ipcMain.handle("uistate:get", (_e, sessionId: string): SessionUiState | null =>
    getUiState(sessionId),
  );
  ipcMain.handle(
    "uistate:set",
    (_e, sessionId: string, state: SessionUiState): void =>
      setUiState(sessionId, state),
  );

  // "Open file" in the panel menu — a local page, previewed without a server.
  ipcMain.handle("browser:pickFile", async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: "Open in the Browser panel",
      properties: ["openFile"],
      filters: [
        { name: "Web pages", extensions: ["html", "htm", "svg", "pdf", "md"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    const file = r.filePaths[0];
    return file ? `file:///${file.replace(/\\/g, "/")}` : null;
  });

  // "Save screenshot" — the page as the user sees it, to wherever they say.
  ipcMain.handle(
    "browser:saveScreenshot",
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const wc = activeContents();
        if (!wc) return { ok: false, error: "No page is open." };
        const image = await wc.capturePage();
        const png = image.toPNG();
        if (png.length === 0)
          return { ok: false, error: "The page produced an empty frame." };
        const win =
          BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (!win) return { ok: false, error: "No window." };
        const r = await dialog.showSaveDialog(win, {
          title: "Save screenshot",
          defaultPath: `screenshot-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`,
          filters: [{ name: "PNG image", extensions: ["png"] }],
        });
        if (r.canceled || !r.filePath) return { ok: false };
        writeFileSync(r.filePath, png);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // Design mode. The overlay is injected through CDP rather than a webview
  // preload because it must run in the page's MAIN world — React's fibre is an
  // expando on the DOM node, and expandos are invisible across worlds.
  ipcMain.handle(
    "browser:setDesignMode",
    async (_e, on: boolean): Promise<{ ok: boolean; error?: string }> => {
      try {
        await setDesignMode(await getTransport(), on, (msg) => {
          void onInspectMessage(msg);
        });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
