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
  reconnectServer,
  saveConfig,
  type McpServerConfig,
  type McpServerStatus,
  getServerTools,
} from "../mcp/manager.js";

async function refresh(): Promise<McpServerStatus[]> {
  await ensureConnected();
  return getServerStatuses();
}

/** Re-establish one server and report the fresh statuses. */
async function reconnect(name: string): Promise<McpServerStatus[]> {
  await reconnectServer(name);
  return getServerStatuses();
}

export function registerMcpIPC(): void {
  ipcMain.handle("mcp:list", () => refresh());
  // A connected server's live tool list — permission UIs render one row per
  // tool instead of one coarse "use the server" switch.
  ipcMain.handle("mcp:tools", (_e, server: string) => getServerTools(server));

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

  // Remote MCP is OAuth 2.1: a pasted bearer token is rejected, so a server
  // that needs a grant can only be reached by running the browser flow.
  ipcMain.handle(
    "mcp:signIn",
    async (
      _e,
      name: string,
    ): Promise<{ ok: boolean; error?: string; servers?: McpServerStatus[] }> => {
      const server = loadConfig().mcpServers[name];
      if (!server?.url)
        return { ok: false, error: `${name} is not a remote server.` };
      try {
        const { signInMcpServer } = await import("../mcp/oauth/index.js");
        await signInMcpServer(name, server.url);
        // Reconnect so the tools appear without the user restarting anything.
        return { ok: true, servers: await reconnect(name) };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "mcp:signOut",
    async (_e, name: string): Promise<McpServerStatus[]> => {
      const server = loadConfig().mcpServers[name];
      if (server?.url) {
        const { signOutMcpServer } = await import("../mcp/oauth/index.js");
        signOutMcpServer(name, server.url);
      }
      return reconnect(name);
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
