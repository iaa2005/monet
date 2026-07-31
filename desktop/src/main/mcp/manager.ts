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
import { getService } from "../connectors/services/registry.js";
import { getSecret, listAccounts } from "../connectors/store.js";
import { ConnectorOAuthProvider } from "../connectors/lib/mcp-oauth-provider.js";
import { mcpAuthProvider } from "./oauth/index.js";
import { filterTools, resolveHeaders } from "./config-rules.js";

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
  /**
   * Name of an environment variable holding a bearer token, rather than the
   * token itself. Keeps the credential out of mcp-servers.json, which is
   * plain text and lands in backups and screen shares.
   */
  bearerTokenEnvVar?: string;
  /** Optional OAuth client id for a remote server (stored for future auth). */
  oauthClientId?: string;
  /** Per-request timeout in seconds (applied to tool calls). */
  timeout?: number;
  /** How long to wait for the server to come up. Default 30s. */
  startupTimeoutMs?: number;
  /**
   * Tool allow-list. When set, ONLY these tools are exposed to the model —
   * a server offering forty tools can be reduced to the two that are wanted,
   * which is a context saving as much as a safety one.
   */
  enabledTools?: string[];
  /** Tool block-list, applied after `enabledTools`. */
  disabledTools?: string[];
  /** default true */
  enabled?: boolean;
  /** Internal: the connector account id backing a remote-OAuth server.
   * Set by connectorServers(); used to build an authProvider. Not persisted. */
  _accountId?: string;
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

/**
 * Servers contributed by connector accounts (Notion, GitHub, Slack…, and
 * remote OAuth MCP like Dropbox).
 *
 * Built fresh on every read with the token decrypted straight from safeStorage,
 * so the secret exists only in memory and in the spawned child's env — it is
 * never part of loadConfig/saveConfig and so can never land in
 * mcp-servers.json. That's the whole point of routing these through connectors.
 *
 * Local MCP servers (command/args/envKey) get the token in env; remote MCP
 * servers (url/transport) get an authProvider that reads/writes OAuth tokens
 * from the encrypted secret store.
 */
function connectorServers(): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  try {
    for (const account of listAccounts()) {
      if (!account.enabled) continue;
      const mcp = getService(account.presetId)?.capabilities.mcp;
      if (!mcp) continue;
      if ("command" in mcp) {
        // Local stdio server — token in env.
        const token = getSecret(account.id).password;
        if (!token) continue;
        out[account.presetId] = {
          command: mcp.command,
          args: mcp.args,
          env: { [mcp.envKey]: token },
        };
      } else {
        // Remote OAuth MCP — authProvider reads tokens from the secret store.
        out[account.presetId] = {
          url: mcp.url,
          type: mcp.transport ?? "http",
          _accountId: account.id,
        };
      }
    }
  } catch {
    /* connectors unavailable — fall back to file servers only */
  }
  return out;
}

/**
 * What actually gets connected: hand-written servers from the file, plus the
 * connector-backed ones. Use this for connecting and for "is anything
 * configured"; use loadConfig() for the raw MCP Servers UI, which edits the
 * file and must never see (or rewrite) a connector's secret.
 */
export function effectiveConfig(): McpConfig {
  return { mcpServers: { ...loadConfig().mcpServers, ...connectorServers() } };
}

/** Names of the MCP servers a connector account supplies (Notion, GitHub…), as
 * opposed to hand-written ones from the file. Home is allowed the former only. */
export function connectorServerNames(): Set<string> {
  return new Set(Object.keys(connectorServers()));
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

/** Reject after `ms` unless the promise settles first. */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
      if (config._accountId) {
        // Remote OAuth MCP: the SDK handles auth (discovery, DCR, PKCE, token
        // refresh) via the authProvider. Tokens live in the encrypted secret.
        const authProvider = new ConnectorOAuthProvider(config._accountId);
        transport =
          config.type === "sse"
            ? new SSEClientTransport(url, { authProvider })
            : new StreamableHTTPClientTransport(url, { authProvider });
      } else {
        // Hand-written remote server. Remote MCP is OAuth 2.1 and rejects a
        // pasted bearer token, so a stored OAuth grant is used when this
        // server has one; `headers` still works for the servers that accept
        // a static token. mcpAuthProvider returns undefined without stored
        // tokens on purpose — handing the transport an empty provider makes
        // it start an interactive flow from a background reconnect, which
        // hangs instead of failing, and a plain 401 is what lets the UI
        // offer "Sign in".
        const authProvider = mcpAuthProvider(name, config.url);
        const headers = resolveHeaders(config);
        const requestInit = headers ? { headers } : undefined;
        const opts = authProvider ? { authProvider } : { requestInit };
        transport =
          config.type === "sse"
            ? new SSEClientTransport(url, opts)
            : new StreamableHTTPClientTransport(url, opts);
      }
    } else {
      throw new Error("Server config must have a command or a url");
    }

    const client = new Client(
      { name: "monet-desktop", version: "0.1.0" },
      { capabilities: {} },
    );
    // A server that never answers must not hold the whole connect pass open:
    // ensureConnected() runs before a turn, so one wedged server would stall
    // every chat rather than just being unavailable.
    const startupMs = config.startupTimeoutMs ?? 30_000;
    await withTimeout(
      client.connect(transport),
      startupMs,
      `${name} did not respond within ${Math.round(startupMs / 1000)}s`,
    );

    const listed = await client.listTools();
    const sname = sanitize(name);
    const offered = listed.tools ?? [];
    const kept = filterTools(offered, config);
    if (kept.length !== offered.length) {
      const hidden = offered.length - kept.length;
      console.log(
        `[mcp] ${name}: exposing ${kept.length} of ${offered.length} tools (${hidden} filtered by config)`,
      );
    }
    state.tools = kept.map((t) => {
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
  const config = effectiveConfig();
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

/** Drop and re-establish ONE server (after a sign-in or a config change). */
export async function reconnectServer(name: string): Promise<void> {
  const existing = servers.get(name);
  if (existing?.client) await existing.client.close().catch(() => {});
  servers.delete(name);
  await ensureConnected();
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

/** A connected server's tools — names and descriptions, for permission UIs. */
export function getServerTools(
  name: string,
): { name: string; description: string }[] {
  const s = servers.get(name);
  if (!s) return [];
  return s.tools.map((t) => ({ name: t.toolName, description: t.description }));
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
      const timeoutMs =
        s.config.timeout && s.config.timeout > 0
          ? s.config.timeout * 1000
          : undefined;
      const result = (await s.client.callTool(
        { name: tool.toolName, arguments: input },
        undefined,
        timeoutMs ? { timeout: timeoutMs } : undefined,
      )) as {
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

// ─── Resources ─────────────────────────────────────────────────────────────

export interface McpResource {
  server: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Any MCP servers configured at all (gates the resource tools' advertisement). */
export function hasMcpServers(): boolean {
  return Object.keys(effectiveConfig().mcpServers).length > 0;
}

/** Live status of a connector-backed server, for the Connectors "Test" button.
 * Deliberately returns no config — that would carry the token to the renderer. */
export function getConnectorServerStatus(
  presetId: string,
): { status: McpStatus; toolCount: number; error?: string } | null {
  const s = servers.get(presetId);
  if (!s) return null;
  return { status: s.status, toolCount: s.tools.length, error: s.error };
}

/** List resources across every connected server. Servers that don't implement
 * resources (Method not found) are silently skipped; real errors are collected. */
export async function listMcpResources(): Promise<{
  resources: McpResource[];
  errors: { server: string; error: string }[];
}> {
  const resources: McpResource[] = [];
  const errors: { server: string; error: string }[] = [];
  await Promise.all(
    [...servers.entries()].map(async ([name, s]) => {
      if (s.status !== "connected" || !s.client) return;
      try {
        const listed = (await s.client.listResources()) as {
          resources?: {
            uri: string;
            name?: string;
            description?: string;
            mimeType?: string;
          }[];
        };
        for (const r of listed.resources ?? []) {
          resources.push({
            server: name,
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // -32601 / "Method not found" ⇒ server just has no resources support.
        if (!/-32601|method not found|not supported/i.test(msg))
          errors.push({ server: name, error: msg });
      }
    }),
  );
  return { resources, errors };
}

/** Read one resource by URI from a named server. Binary blobs are reported as
 * a note (size + mime) rather than inlining base64 into the context. */
export async function readMcpResource(
  server: string,
  uri: string,
): Promise<{
  contents: { uri: string; mimeType?: string; text?: string; note?: string }[];
  error?: string;
}> {
  const s = servers.get(server);
  if (!s) return { contents: [], error: `Unknown MCP server: ${server}` };
  if (s.status !== "connected" || !s.client)
    return { contents: [], error: `Server "${server}" is not connected` };
  try {
    const timeoutMs =
      s.config.timeout && s.config.timeout > 0
        ? s.config.timeout * 1000
        : undefined;
    const result = (await s.client.readResource(
      { uri },
      timeoutMs ? { timeout: timeoutMs } : undefined,
    )) as {
      contents?: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
      }[];
    };
    const contents = (result.contents ?? []).map((c) => {
      if (typeof c.text === "string")
        return { uri: c.uri, mimeType: c.mimeType, text: c.text };
      if (typeof c.blob === "string") {
        const bytes = Buffer.from(c.blob, "base64").length;
        return {
          uri: c.uri,
          mimeType: c.mimeType,
          note: `[binary resource, ${bytes} bytes${c.mimeType ? `, ${c.mimeType}` : ""} — not inlined]`,
        };
      }
      return { uri: c.uri, mimeType: c.mimeType, note: "[empty resource]" };
    });
    return { contents };
  } catch (err) {
    return {
      contents: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
