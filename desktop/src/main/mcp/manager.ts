/**
 * MCP connection manager (desktop-native).
 *
 * Connects to Model Context Protocol servers via the official
 * @modelcontextprotocol/sdk (not the vendor MCP machinery, which is tied to
 * its own state/UI). Supports stdio (command) servers and remote http/sse
 * servers. Config is a JSON file in the data dir, managed from the Connectors
 * settings panel. Connected servers expose their tools to the agent, which
 * routes `mcp__<server>__<tool>` calls back here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDataDir } from "../data-dir.js";

// ─── Config ────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  /** stdio server */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** remote server */
  type?: "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  /** default true */
  enabled?: boolean;
}

export type McpConfig = { mcpServers: Record<string, McpServerConfig> };

function configPath(): string {
  return join(getDataDir(), "mcp-servers.json");
}

export function loadConfig(): McpConfig {
  try {
    const raw = readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<McpConfig>;
    return { mcpServers: parsed.mcpServers ?? {} };
  } catch {
    return { mcpServers: {} };
  }
}

export function saveConfig(config: McpConfig): void {
  const p = configPath();
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(config, null, 2), "utf-8");
}

// ─── Tool + status types ─────────────────────────────────────────────────

export interface McpTool {
  serverName: string;
  toolName: string;
  fullName: string; // mcp__<server>__<tool>
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type McpStatus = "connected" | "connecting" | "error" | "disabled";

export interface McpServerStatus {
  name: string;
  status: McpStatus;
  toolCount: number;
  error?: string;
  config: McpServerConfig;
}

interface ServerState {
  config: McpServerConfig;
  client?: Client;
  status: McpStatus;
  error?: string;
  tools: McpTool[];
}

// ─── Manager ─────────────────────────────────────────────────────────────

const servers = new Map<string, ServerState>();

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function connectServer(name: string, config: McpServerConfig): Promise<void> {
  const state: ServerState = { config, status: "connecting", tools: [] };
  servers.set(name, state);

  try {
    let transport;
    if (config.command) {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
      });
    } else if (config.url) {
      const url = new URL(config.url);
      transport =
        config.type === "sse"
          ? new SSEClientTransport(url)
          : new StreamableHTTPClientTransport(url);
    } else {
      throw new Error("Server config must have a command or a url");
    }

    const client = new Client(
      { name: "monet-desktop", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);

    const listed = await client.listTools();
    const sname = sanitize(name);
    state.tools = (listed.tools ?? []).map((t) => {
      const schema = (t.inputSchema ?? { type: "object", properties: {} }) as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      return {
        serverName: name,
        toolName: t.name,
        fullName: `mcp__${sname}__${t.name}`,
        description: t.description ?? `${t.name} (via ${name})`,
        inputSchema: {
          type: "object",
          properties: schema.properties ?? {},
          ...(schema.required ? { required: schema.required } : {}),
        },
      };
    });
    state.client = client;
    state.status = "connected";
    state.error = undefined;
  } catch (err) {
    state.status = "error";
    state.error = err instanceof Error ? err.message : String(err);
    state.tools = [];
  }
}

/** Connect every enabled server that isn't already connected. Called before an
 * agent run and by the Connectors UI. */
export async function ensureConnected(): Promise<void> {
  const config = loadConfig();
  const entries = Object.entries(config.mcpServers);

  await Promise.all(
    entries.map(async ([name, cfg]) => {
      const enabled = cfg.enabled !== false;
      const existing = servers.get(name);
      if (!enabled) {
        if (existing?.client) await existing.client.close().catch(() => {});
        servers.set(name, { config: cfg, status: "disabled", tools: [] });
        return;
      }
      // Already connected with the same config — leave it.
      if (
        existing?.status === "connected" &&
        JSON.stringify(existing.config) === JSON.stringify(cfg)
      ) {
        return;
      }
      if (existing?.client) await existing.client.close().catch(() => {});
      await connectServer(name, cfg);
    }),
  );

  // Drop servers removed from config.
  for (const name of [...servers.keys()]) {
    if (!(name in config.mcpServers)) {
      const s = servers.get(name);
      if (s?.client) await s.client.close().catch(() => {});
      servers.delete(name);
    }
  }
}

export async function reconnectAll(): Promise<void> {
  for (const s of servers.values()) {
    if (s.client) await s.client.close().catch(() => {});
  }
  servers.clear();
  await ensureConnected();
}

export function getMcpTools(): McpTool[] {
  const out: McpTool[] = [];
  for (const s of servers.values()) {
    if (s.status === "connected") out.push(...s.tools);
  }
  return out;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

export async function callMcpTool(
  fullName: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  for (const s of servers.values()) {
    const tool = s.tools.find((t) => t.fullName === fullName);
    if (!tool || !s.client) continue;
    try {
      const result = (await s.client.callTool({
        name: tool.toolName,
        arguments: input,
      })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (result.content ?? [])
        .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
        .filter(Boolean)
        .join("\n");
      return { content: text || "(no output)", isError: result.isError === true };
    } catch (err) {
      return {
        content: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
  return { content: `Unknown MCP tool: ${fullName}`, isError: true };
}

export function getServerStatuses(): McpServerStatus[] {
  const config = loadConfig();
  return Object.entries(config.mcpServers).map(([name, cfg]) => {
    const s = servers.get(name);
    return {
      name,
      status: s?.status ?? (cfg.enabled === false ? "disabled" : "connecting"),
      toolCount: s?.tools.length ?? 0,
      error: s?.error,
      config: cfg,
    };
  });
}
