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
  NotebookPen,
  Plug,
  Check,
  Loader2,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

type Transport = "remote" | "stdio";
/** How a connector authenticates:
 *  - "token"  : paste a long-lived token → works today.
 *  - "oauth"  : remote MCP server behind OAuth 2.1 (the server REJECTS pasted
 *               tokens with 401). Needs app-side OAuth — not wired up yet.
 *  - "manual" : needs your own OAuth client (Google), set up outside this app. */
type AuthKind = "token" | "oauth" | "manual";

interface CatalogEntry {
  id: string;
  name: string;
  icon: LucideIcon;
  desc: string;
  transport: Transport;
  authKind: AuthKind;
  /** remote */
  url?: string;
  authHeader?: string; // e.g. "Authorization"
  authPrefix?: string; // e.g. "Bearer "
  /** stdio */
  command?: string;
  args?: string[];
  envKey?: string; // env var the token goes into
  tokenLabel?: string; // what secret to paste
  /** Where to get the token / read setup docs — opened in the real browser. */
  tokenUrl?: string;
  /** Caveat shown in the connect form. */
  note?: string;
}

// VERIFIED templates only. Every entry below was checked against the live
// registry/endpoint — an earlier version of this catalog guessed, and shipped
// npm packages that don't exist plus OAuth-only URLs fed a pasted token, which
// is what produced the 401/402s. Rules of thumb learned the hard way:
//   - The modern REMOTE servers (Notion/Linear/Sentry/GitHub) are OAuth 2.1 and
//     answer a pasted Bearer with 401 invalid_token. Don't offer a token box.
//   - GitHub's remote server (api.githubcopilot.com) is Copilot-gated → 402.
//   - Where a service issues a real long-lived token, run its LOCAL stdio
//     server and pass the token via env. That path works today.
const CATALOG: CatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    icon: Github,
    desc: "Issues, pull requests, repositories.",
    transport: "stdio",
    authKind: "token",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
    tokenLabel: "GitHub personal access token",
    tokenUrl: "https://github.com/settings/tokens",
    note: "GitHub's remote MCP server needs a Copilot subscription (that's the 402), so this runs the local server with your PAT. Classic tokens work; give it repo scope.",
  },
  {
    id: "notion",
    name: "Notion",
    icon: NotebookPen,
    desc: "Pages and databases.",
    transport: "stdio",
    authKind: "token",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    envKey: "NOTION_TOKEN",
    tokenLabel: "Notion internal integration token (ntn_…)",
    tokenUrl: "https://app.notion.com/developers/tokens",
    note: "After connecting, open each page/database in Notion → ••• → Connections → add your integration. Without that it authenticates fine but sees nothing.",
  },
  {
    id: "slack",
    name: "Slack",
    icon: MessageSquare,
    desc: "Post and read channel messages.",
    transport: "stdio",
    authKind: "token",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    envKey: "SLACK_BOT_TOKEN",
    tokenLabel: "Slack bot token (xoxb-…)",
    tokenUrl: "https://api.slack.com/apps",
    note: "Create an app → OAuth & Permissions → add bot scopes → install to workspace, then copy the Bot User OAuth Token.",
  },
  {
    id: "linear",
    name: "Linear",
    icon: ListChecks,
    desc: "Issues, projects, triage.",
    transport: "remote",
    authKind: "oauth",
    url: "https://mcp.linear.app/mcp",
    tokenUrl: "https://linear.app/docs/mcp",
  },
  {
    id: "sentry",
    name: "Sentry",
    icon: Bug,
    desc: "Errors and issue details.",
    transport: "remote",
    authKind: "oauth",
    url: "https://mcp.sentry.dev/mcp",
    tokenUrl: "https://docs.sentry.io/product/sentry-mcp/",
  },
];
// Gmail/Calendar/Yandex/Telegram are NOT here: they have no usable MCP server,
// but they do speak IMAP/WebDAV/CalDAV/MTProto. They're built-in protocol
// connectors instead — see ProtocolConnectors.tsx.

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

/** Opens a URL in the user's real browser (not a bare Electron window, which is
 * what <a target="_blank"> would give us — and a poor place to sign in). */
function OpenLink({ url, label }: { url: string; label: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => void api()?.shell.openExternal(url)}
      title={url}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-link transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
    >
      {label}
      <ExternalLink className="size-3.5" />
    </button>
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

  // OAuth/manual connectors can't be completed from this form — the server
  // rejects a pasted token (401). Say so instead of offering a box that fails.
  if (entry.authKind !== "token") {
    const oauth = entry.authKind === "oauth";
    return (
      <Modal open onClose={onClose} title={`Connect ${entry.name}`}>
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            {oauth ? (
              <>
                {entry.name} runs a remote MCP server that signs you in with
                your account (OAuth) rather than a pasted token — it answers a
                token with <span className="font-mono text-xs">401</span>. This
                app doesn&apos;t do the OAuth sign-in flow yet, so {entry.name}{" "}
                can&apos;t be connected from here.
              </>
            ) : (
              entry.note
            )}
          </p>
          {oauth && entry.url && (
            <p className="text-[13px] text-muted-foreground">
              Server:{" "}
              <span className="font-mono text-xs">{entry.url}</span>
            </p>
          )}
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            {entry.tokenUrl && <OpenLink url={entry.tokenUrl} label="Read the docs" />}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={`Connect ${entry.name}`}>
      <div className="space-y-3">
        <p className="text-[13px] text-muted-foreground">
          This adds an MCP server for {entry.name}. Verify the details below —
          not every service ships an official MCP server, so adjust if needed.
        </p>
        {entry.note && (
          <p className="rounded-md border border-border bg-black/[0.02] p-2 text-[13px] text-muted-foreground dark:bg-white/[0.03]">
            {entry.note}
          </p>
        )}
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
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs text-muted-foreground">
              {entry.tokenLabel ?? "Token"}
            </label>
            {entry.tokenUrl && <OpenLink url={entry.tokenUrl} label="Get token" />}
          </div>
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
