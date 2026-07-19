import { useEffect, useState } from "react";
import { Plus, Plug, RefreshCw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import type {
  ElectronAPI,
  McpServerConfig,
  McpServerStatus,
} from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const STATUS_STYLE: Record<McpServerStatus["status"], string> = {
  connected: "bg-green-text",
  connecting: "bg-amber-500",
  error: "bg-red-text",
  disabled: "bg-muted-foreground/40",
};

const INPUT =
  "mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground/20";

interface KV {
  key: string;
  value: string;
}

function Field({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="mt-4">
      <label className="text-sm font-medium">
        {label}
        {required && <span className="text-muted-foreground"> *</span>}
      </label>
      {children}
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
        {help}
      </p>
    </div>
  );
}

/** Editable list of key/value pairs (environment variables, headers). */
function KeyValueEditor({
  pairs,
  setPairs,
}: {
  pairs: KV[];
  setPairs: (p: KV[]) => void;
}): JSX.Element {
  const update = (i: number, patch: Partial<KV>): void =>
    setPairs(pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  return (
    <div className="mt-1.5 space-y-1.5">
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            value={p.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder="KEY"
            className="w-2/5 rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-foreground/20"
          />
          <input
            value={p.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder="value"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-foreground/20"
          />
          <button
            type="button"
            onClick={() => setPairs(pairs.filter((_, idx) => idx !== i))}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setPairs([...pairs, { key: "", value: "" }])}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Plus className="size-3.5" /> Add
      </button>
    </div>
  );
}

function pairsToRecord(pairs: KV[]): Record<string, string> {
  return Object.fromEntries(
    pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]),
  );
}

function AddConnectorModal({
  existingNames,
  onClose,
  onSaved,
}: {
  existingNames: string[];
  onClose: () => void;
  onSaved: (list: McpServerStatus[]) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"command" | "url">("command");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState<KV[]>([]);
  const [url, setUrl] = useState("");
  const [urlType, setUrlType] = useState<"http" | "sse">("http");
  const [headers, setHeaders] = useState<KV[]>([]);
  const [oauthClientId, setOauthClientId] = useState("");
  const [timeout, setTimeoutStr] = useState("60");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const taken = existingNames.map((n) => n.toLowerCase());

  const save = async (): Promise<void> => {
    const nm = name.trim();
    if (!nm) return setError("Server name is required");
    if (taken.includes(nm.toLowerCase()))
      return setError(`A connector named “${nm}” already exists`);
    const timeoutNum = timeout.trim()
      ? Math.max(1, parseInt(timeout, 10) || 60)
      : undefined;

    let config: McpServerConfig;
    if (kind === "command") {
      if (!command.trim()) return setError("Command is required");
      config = {
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        ...(Object.keys(pairsToRecord(env)).length
          ? { env: pairsToRecord(env) }
          : {}),
        ...(timeoutNum ? { timeout: timeoutNum } : {}),
      };
    } else {
      if (!url.trim()) return setError("URL is required");
      config = {
        type: urlType,
        url: url.trim(),
        ...(Object.keys(pairsToRecord(headers)).length
          ? { headers: pairsToRecord(headers) }
          : {}),
        ...(oauthClientId.trim()
          ? { oauthClientId: oauthClientId.trim() }
          : {}),
        ...(timeoutNum ? { timeout: timeoutNum } : {}),
      };
    }

    setBusy(true);
    setError(null);
    try {
      const list = await api()?.mcp.add({ name: nm, config });
      onSaved(list ?? []);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add connector");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-base font-semibold">Add connector</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex gap-1 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.05]">
          {(["command", "url"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                kind === k
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {k === "command" ? "Local" : "Remote"}
            </button>
          ))}
        </div>

        <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
          <Field
            label="Server Name"
            required
            help="A unique name used to identify this MCP server."
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-mcp-server"
              className={INPUT}
            />
          </Field>

          {kind === "command" ? (
            <>
              <Field
                label="Command"
                required
                help="Path to the executable that launches the server."
              >
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="/path/to/server"
                  className={cn(INPUT, "font-mono text-xs")}
                />
              </Field>
              <Field
                label="Arguments"
                help="Space-separated arguments passed to the command."
              >
                <input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="--flag value"
                  className={cn(INPUT, "font-mono text-xs")}
                />
              </Field>
              <Field
                label="Environment Variables"
                help="Environment variables provided to the server process."
              >
                <KeyValueEditor pairs={env} setPairs={setEnv} />
              </Field>
            </>
          ) : (
            <>
              <Field
                label="URL"
                required
                help="The base URL of the remote MCP server."
              >
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  className={cn(INPUT, "font-mono text-xs")}
                />
                <div className="mt-1.5 flex gap-1 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.05]">
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
              </Field>
              <Field
                label="Headers"
                help="HTTP headers sent with each request to the server."
              >
                <KeyValueEditor pairs={headers} setPairs={setHeaders} />
              </Field>
            </>
          )}

          <Field
            label="Timeout (seconds)"
            help="How long to wait for the server to respond before timing out."
          >
            <input
              value={timeout}
              onChange={(e) =>
                setTimeoutStr(e.target.value.replace(/[^0-9]/g, ""))
              }
              inputMode="numeric"
              placeholder="60"
              className={cn(INPUT, "w-28")}
            />
          </Field>

          {kind === "url" && (
            <Field
              label="OAuth Client ID"
              help="Optional OAuth client ID used to authenticate with the server."
            >
              <input
                value={oauthClientId}
                onChange={(e) => setOauthClientId(e.target.value)}
                placeholder="Optional OAuth client ID"
                className={INPUT}
              />
            </Field>
          )}

          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-border pt-4">
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
            Save
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
          <h3 className="text-base font-semibold">MCP Servers</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Raw Model Context Protocol servers (stdio/http/sse). Connected tools
            become available to the agent as{" "}
            <span className="font-mono text-xs">mcp__…</span>. For one-click
            service integrations, use Connectors.
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
              <Switch
                checked={s.config.enabled !== false}
                onChange={(v) => void toggle(s.name, v)}
              />
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
          existingNames={servers.map((s) => s.name)}
          onClose={() => setAdding(false)}
          onSaved={setServers}
        />
      )}
    </div>
  );
}
