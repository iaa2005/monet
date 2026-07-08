/**
 * MCP IPC — manage Connectors (MCP servers) from Settings.
 *
 * Config lives in <dataDir>/mcp-servers.json; connections are managed by
 * mcp/manager. After any config change we reconnect and return fresh statuses.
 */

import { ipcMain } from "electron";
import {
  ensureConnected,
  getServerStatuses,
  loadConfig,
  reconnectAll,
  saveConfig,
  type McpServerConfig,
  type McpServerStatus,
} from "../mcp/manager.js";

async function refresh(): Promise<McpServerStatus[]> {
  await ensureConnected();
  return getServerStatuses();
}

export function registerMcpIPC(): void {
  ipcMain.handle("mcp:list", () => refresh());

  ipcMain.handle(
    "mcp:add",
    async (
      _e,
      payload: { name: string; config: McpServerConfig },
    ): Promise<McpServerStatus[]> => {
      const name = payload?.name?.trim();
      if (!name) throw new Error("Connector name is required");
      const config = loadConfig();
      config.mcpServers[name] = { enabled: true, ...payload.config };
      saveConfig(config);
      return refresh();
    },
  );

  ipcMain.handle(
    "mcp:remove",
    async (_e, name: string): Promise<McpServerStatus[]> => {
      const config = loadConfig();
      delete config.mcpServers[name];
      saveConfig(config);
      return refresh();
    },
  );

  ipcMain.handle(
    "mcp:toggle",
    async (
      _e,
      payload: { name: string; enabled: boolean },
    ): Promise<McpServerStatus[]> => {
      const config = loadConfig();
      const server = config.mcpServers[payload.name];
      if (server) {
        server.enabled = payload.enabled;
        saveConfig(config);
      }
      return refresh();
    },
  );

  ipcMain.handle("mcp:reconnect", async (): Promise<McpServerStatus[]> => {
    await reconnectAll();
    return getServerStatuses();
  });
}
