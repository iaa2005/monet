/**
 * Connectors — a curated catalog over MCP. Each connector is a known service
 * with a pre-filled MCP server template; "Connect" opens an editable form
 * (verify the details, paste your token) and saves it via the MCP manager, so
 * the protocol underneath is plain MCP — no new connector protocol.
 */
import { useEffect, useState } from "react";
import {
  Github,
  Mail,
  MessageSquare,
  ListChecks,
  Bug,
  Activity,
  Calendar,
  NotebookPen,
  Plug,
  Check,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

type Transport = "remote" | "stdio";

interface CatalogEntry {
  id: string;
  name: string;
  icon: LucideIcon;
  desc: string;
  transport: Transport;
  /** remote */
  url?: string;
  authHeader?: string; // e.g. "Authorization"
  authPrefix?: string; // e.g. "Bearer "
  /** stdio */
  command?: string;
  args?: string[];
  envKey?: string; // env var the token goes into
  tokenLabel?: string; // what secret to paste
  docs?: string;
}

// Conservative, EDITABLE templates — the connect form shows them so you can
// verify the server details before connecting. Not all services ship an
// official MCP server; when unsure, adjust the command/url in the form.
const CATALOG: CatalogEntry[] = [
  { id: "github", name: "GitHub", icon: Github, desc: "Issues, pull requests, repositories.", transport: "remote", url: "https://api.githubcopilot.com/mcp/", authHeader: "Authorization", authPrefix: "Bearer ", tokenLabel: "GitHub token (PAT)" },
  { id: "gmail", name: "Gmail", icon: Mail, desc: "Read, search, and draft email.", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-gmail"], envKey: "GMAIL_TOKEN", tokenLabel: "Gmail OAuth token" },
  { id: "slack", name: "Slack", icon: MessageSquare, desc: "Post and read channel messages.", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], envKey: "SLACK_BOT_TOKEN", tokenLabel: "Slack bot token" },
  { id: "linear", name: "Linear", icon: ListChecks, desc: "Issues, projects, triage.", transport: "remote", url: "https://mcp.linear.app/sse", authHeader: "Authorization", authPrefix: "Bearer ", tokenLabel: "Linear API key" },
  { id: "sentry", name: "Sentry", icon: Bug, desc: "Errors and issue details.", transport: "remote", url: "https://mcp.sentry.dev/sse", authHeader: "Authorization", authPrefix: "Bearer ", tokenLabel: "Sentry auth token" },
  { id: "datadog", name: "Datadog", icon: Activity, desc: "Metrics, monitors, incidents.", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-datadog"], envKey: "DD_API_KEY", tokenLabel: "Datadog API key" },
  { id: "gcal", name: "Google Calendar", icon: Calendar, desc: "Events and availability.", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-gcal"], envKey: "GOOGLE_TOKEN", tokenLabel: "Google OAuth token" },
  { id: "notion", name: "Notion", icon: NotebookPen, desc: "Pages and databases.", transport: "remote", url: "https://mcp.notion.com/sse", authHeader: "Authorization", authPrefix: "Bearer ", tokenLabel: "Notion integration token" },
];

interface McpStatus {
  name: string;
  status: string;
}

export function ConnectorsCatalog(): JSX.Element {
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [entry, setEntry] = useState<CatalogEntry | null>(null);

  const load = (): void => {
    void api()
      ?.mcp.list()
      .then((rows) =>
        setConnected(
          new Set((rows as McpStatus[]).map((r) => r.name.toLowerCase())),
        ),
      )
      .catch(() => {});
  };
  useEffect(load, []);

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-base font-semibold">Connectors</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          One-click service integrations, built on MCP. Connecting adds an MCP
          server whose tools the agent and your routines can use. For a raw
          server, use MCP Servers.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {CATALOG.map((c) => {
          const isConnected = connected.has(c.id) || connected.has(c.name.toLowerCase());
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setEntry(c)}
              className="flex items-start gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <c.icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  {c.name}
                  {isConnected && (
                    <span className="flex items-center gap-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                      <Check className="size-3" /> connected
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[13px] text-muted-foreground">{c.desc}</p>
              </div>
              <Plug className="size-4 shrink-0 text-muted-foreground/60" />
            </button>
          );
        })}
      </div>

      {entry && (
        <ConnectModal
          entry={entry}
          onClose={() => setEntry(null)}
          onConnected={() => {
            setEntry(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function ConnectModal({
  entry,
  onClose,
  onConnected,
}: {
  entry: CatalogEntry;
  onClose: () => void;
  onConnected: () => void;
}): JSX.Element {
  const [token, setToken] = useState("");
  const [url, setUrl] = useState(entry.url ?? "");
  const [command, setCommand] = useState(entry.command ?? "");
  const [args, setArgs] = useState((entry.args ?? []).join(" "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const config =
        entry.transport === "remote"
          ? {
              type: "sse" as const,
              url,
              headers:
                entry.authHeader && token
                  ? { [entry.authHeader]: `${entry.authPrefix ?? ""}${token}` }
                  : undefined,
            }
          : {
              command,
              args: args.split(/\s+/).filter(Boolean),
              env: entry.envKey && token ? { [entry.envKey]: token } : undefined,
            };
      await api()?.mcp.add({ name: entry.id, config });
      onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Connect ${entry.name}`}>
      <div className="space-y-3">
        <p className="text-[13px] text-muted-foreground">
          This adds an MCP server for {entry.name}. Verify the details below —
          not every service ships an official MCP server, so adjust if needed.
        </p>
        {entry.transport === "remote" ? (
          <div>
            <label className="text-xs text-muted-foreground">Server URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-foreground/30"
            />
          </div>
        ) : (
          <div className="flex gap-2">
            <div className="w-28">
              <label className="text-xs text-muted-foreground">Command</label>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-foreground/30"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-muted-foreground">Args</label>
              <input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-foreground/30"
              />
            </div>
          </div>
        )}
        <div>
          <label className="text-xs text-muted-foreground">
            {entry.tokenLabel ?? "Token"}
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste your token — stored locally, sent only to the server"
            className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/30"
          />
        </div>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void connect()}
            disabled={busy}
            className={cn(
              "flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60",
            )}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Connect
          </button>
        </div>
      </div>
    </Modal>
  );
}
