import { useEffect, useState } from "react";
import { Plus, Plug, RefreshCw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  ElectronAPI,
  McpServerConfig,
  McpServerStatus,
} from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const STATUS_STYLE: Record<McpServerStatus["status"], string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500",
  error: "bg-destructive",
  disabled: "bg-muted-foreground/40",
};

function AddConnectorModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (list: McpServerStatus[]) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"command" | "url">("command");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [urlType, setUrlType] = useState<"http" | "sse">("http");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (!name.trim()) return setError("Name is required");
    const config: McpServerConfig =
      kind === "command"
        ? {
            command: command.trim(),
            args: args.trim() ? args.trim().split(/\s+/) : [],
          }
        : { type: urlType, url: url.trim() };
    if (kind === "command" && !config.command)
      return setError("Command is required");
    if (kind === "url" && !config.url) return setError("URL is required");

    setBusy(true);
    setError(null);
    try {
      const list = await api()?.mcp.add({ name: name.trim(), config });
      onSaved(list ?? []);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add connector");
      setBusy(false);
    }
  };

  const inputCls =
    "mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground/20";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">Add connector</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <X className="size-4" />
          </button>
        </div>

        <label className="block text-sm font-medium">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-server"
          className={inputCls}
        />

        <div className="mt-4 flex gap-1 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.05]">
          {(["command", "url"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-xs font-medium capitalize transition-colors",
                kind === k
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {k === "command" ? "Local (stdio)" : "Remote (URL)"}
            </button>
          ))}
        </div>

        {kind === "command" ? (
          <>
            <label className="mt-4 block text-sm font-medium">Command</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              className={cn(inputCls, "font-mono text-xs")}
            />
            <label className="mt-4 block text-sm font-medium">Arguments</label>
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
              className={cn(inputCls, "font-mono text-xs")}
            />
          </>
        ) : (
          <>
            <label className="mt-4 block text-sm font-medium">URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              className={cn(inputCls, "font-mono text-xs")}
            />
            <div className="mt-4 flex gap-1 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.05]">
              {(["http", "sse"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setUrlType(t)}
                  className={cn(
                    "flex-1 rounded-md px-2 py-1 text-xs font-medium uppercase transition-colors",
                    urlType === t
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </>
        )}

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConnectorsSettings(): JSX.Element {
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = (): void => {
    api()
      ?.mcp.list()
      .then(setServers)
      .catch(() => {});
  };
  useEffect(load, []);

  const reconnect = async (): Promise<void> => {
    setRefreshing(true);
    const list = await api()?.mcp.reconnect();
    if (list) setServers(list);
    setRefreshing(false);
  };

  const toggle = async (name: string, enabled: boolean): Promise<void> => {
    const list = await api()?.mcp.toggle({ name, enabled });
    if (list) setServers(list);
  };

  const remove = async (name: string): Promise<void> => {
    const list = await api()?.mcp.remove(name);
    if (list) setServers(list);
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Connectors (MCP)</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Model Context Protocol servers. Connected tools become available to
            the agent as <span className="font-mono text-xs">mcp__…</span>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reconnect}
            title="Reconnect all"
            className="rounded-lg border border-border p-1.5 text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]"
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
          >
            <Plus className="size-4" /> Add
          </button>
        </div>
      </div>

      {servers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          No connectors yet. Use <span className="font-medium">Add</span> to
          connect an MCP server.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          {servers.map((s) => (
            <div
              key={s.name}
              className="group flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
            >
              <Plug className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{s.name}</span>
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      STATUS_STYLE[s.status],
                    )}
                  />
                  <span className="text-xs text-muted-foreground">
                    {s.status}
                    {s.status === "connected" && ` · ${s.toolCount} tools`}
                  </span>
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {s.config.command
                    ? `${s.config.command} ${(s.config.args ?? []).join(" ")}`
                    : s.config.url}
                </div>
                {s.error && (
                  <div className="truncate text-[11px] text-destructive">
                    {s.error}
                  </div>
                )}
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={s.config.enabled !== false}
                  onChange={(e) => toggle(s.name, e.target.checked)}
                  className="accent-foreground"
                />
                Enabled
              </label>
              <button
                type="button"
                onClick={() => remove(s.name)}
                title="Remove connector"
                className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <AddConnectorModal
          onClose={() => setAdding(false)}
          onSaved={setServers}
        />
      )}
    </div>
  );
}
