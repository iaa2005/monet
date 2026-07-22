/**
 * Directory → MCP servers. Search the official registry
 * (registry.modelcontextprotocol.io) and add a server to this app.
 *
 * "Add" never writes anything by itself: it opens the normal Add-connector
 * form pre-filled with the registry's suggestion, so the exact command line —
 * or URL — is on screen, and any token the server needs is typed by the user,
 * into their own config, before it is saved.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  Server,
  Trash2,
} from "lucide-react";
import {
  AddConnectorModal,
  type AddConnectorInitial,
  type KV,
} from "@/components/settings/ConnectorsSettings";
import type { McpServerStatus, RegistryServer } from "@/types/electron";
import { api, CardAction, Chip, DirCard, Empty, matches, Picker } from "./shared";
import { Toolbar } from "./SkillsSection";

const FILTERS = [
  { label: "All", value: "all" },
  { label: "Local (stdio)", value: "stdio" },
  { label: "Remote (http/sse)", value: "remote" },
];
const SORTS = [
  { label: "Name", value: "name" },
  { label: "Publisher", value: "namespace" },
];

/** A registry name is `io.github.owner/server`; the installed server is keyed
 * by whatever the user called it. We suggest the last segment. */
function suggestName(e: RegistryServer, taken: string[]): string {
  const base = e.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

function toInitial(e: RegistryServer, taken: string[]): AddConnectorInitial {
  const vars: KV[] = e.vars.map((v) => ({ key: v.name, value: v.value ?? "" }));
  const required = e.vars.filter((v) => v.required);
  const slots = e.placeholders ?? [];
  const note = [
    `From the MCP registry: ${e.id}${e.version ? ` v${e.version}` : ""}.`,
    slots.length
      ? `Replace ${slots.join(", ")} in the arguments — the registry only names ${slots.length > 1 ? "those slots" : "that slot"}, it can't know your value.`
      : "",
    required.length
      ? `Fill in ${required.map((v) => v.name).join(", ")} before saving — the server needs ${required.length > 1 ? "them" : "it"} to start.`
      : "",
    e.transport === "stdio"
      ? "This runs a command on your machine. Read it before saving."
      : "This talks to a remote server. Check the URL is the one you expect.",
  ]
    .filter(Boolean)
    .join(" ");

  return e.transport === "stdio"
    ? {
        name: suggestName(e, taken),
        kind: "command",
        command: e.command ?? "",
        args: (e.args ?? []).join(" "),
        env: vars,
        note,
      }
    : {
        name: suggestName(e, taken),
        kind: "url",
        url: e.url ?? "",
        urlType: e.transport === "sse" ? "sse" : "http",
        headers: vars,
        note,
      };
}

export function McpSection({ query }: { query: string }): JSX.Element {
  const [servers, setServers] = useState<RegistryServer[] | null>(null);
  const [installed, setInstalled] = useState<McpServerStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("name");
  const [origin, setOrigin] = useState<"all" | "installed" | "registry">("all");
  const [add, setAdd] = useState<AddConnectorInitial | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadInstalled = async (): Promise<void> => {
    setInstalled((await api()?.mcp.list()) ?? []);
  };

  // The registry has thousands of entries, so the text box is a real query —
  // debounced, sent to the API, not a filter over a cached page.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        setServers(null);
        const r = await api()?.mcpRegistry.search({ query, limit: 60 });
        if (cancelled) return;
        setServers(r?.ok ? (r.servers ?? []) : []);
        setError(r?.ok ? null : (r?.error ?? "Could not reach the registry."));
      })();
    }, query ? 350 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  useEffect(() => {
    void loadInstalled();
  }, []);

  const remove = async (name: string): Promise<void> => {
    setBusy(name);
    try {
      setInstalled((await api()?.mcp.remove(name)) ?? []);
    } finally {
      setBusy(null);
    }
  };

  const takenNames = installed.map((s) => s.name);

  const shownInstalled = useMemo(
    () =>
      origin === "registry"
        ? []
        : installed.filter((s) =>
            matches(query, s.name, s.config.command, s.config.url),
          ),
    [installed, query, origin],
  );

  const shownRegistry = useMemo(() => {
    if (origin === "installed") return [];
    let list = (servers ?? []).filter(
      (e) =>
        (filter === "all" ||
          (filter === "stdio"
            ? e.transport === "stdio"
            : e.transport !== "stdio")) &&
        matches(query, e.id, e.description),
    );
    list = [...list];
    if (sort === "namespace")
      list.sort(
        (a, b) =>
          a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name),
      );
    else list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [servers, filter, sort, query, origin]);

  return (
    <>
      <Toolbar
        chips={
          <>
            <Chip
              label="All"
              active={origin === "all"}
              onClick={() => setOrigin("all")}
            />
            <Chip
              label={`Added${installed.length ? ` (${installed.length})` : ""}`}
              active={origin === "installed"}
              onClick={() =>
                setOrigin(origin === "installed" ? "all" : "installed")
              }
            />
            <Chip
              label="MCP registry"
              title="registry.modelcontextprotocol.io"
              active={origin === "registry"}
              onClick={() =>
                setOrigin(origin === "registry" ? "all" : "registry")
              }
            />
            <button
              type="button"
              onClick={() =>
                void api()?.shell.openExternal(
                  "https://registry.modelcontextprotocol.io",
                )
              }
              className="shrink-0 text-[11px] text-link hover:underline"
            >
              registry.modelcontextprotocol.io
            </button>
          </>
        }
        right={
          <>
            <button
              type="button"
              onClick={() => setAdd({ kind: "command" })}
              className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
            >
              Add by hand
            </button>
            <Picker
              label="Filter by"
              value={filter}
              options={FILTERS}
              onChange={setFilter}
            />
            <Picker
              label="Sort by"
              value={sort}
              options={SORTS}
              onChange={setSort}
            />
          </>
        }
      />

      {error && (
        <p className="mb-3 flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3 shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      )}

      {shownInstalled.length > 0 && (
        <>
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Added to Code Monet
          </div>
          <div className="mb-6 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {shownInstalled.map((s) => (
              <DirCard
                key={s.name}
                icon={<Server className="mt-0.5 size-5 text-muted-foreground" />}
                title={s.name}
                meta={
                  <>
                    <span
                      className={
                        s.status === "connected"
                          ? "text-green-text"
                          : s.status === "error"
                            ? "text-destructive"
                            : ""
                      }
                    >
                      {s.status}
                    </span>
                    <span>· {s.toolCount} tools</span>
                  </>
                }
                description={
                  s.error ??
                  (s.config.url ??
                    [s.config.command, ...(s.config.args ?? [])]
                      .filter(Boolean)
                      .join(" "))
                }
                action={
                  <CardAction
                    icon={Trash2}
                    title="Remove this server"
                    variant="danger"
                    busy={busy === s.name}
                    onClick={() => void remove(s.name)}
                  />
                }
              />
            ))}
          </div>
        </>
      )}

      {origin !== "installed" && (
        <>
          {shownInstalled.length > 0 && (
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              MCP registry
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {servers === null ? (
              <Empty>
                <Loader2 className="mx-auto size-5 animate-spin" />
              </Empty>
            ) : shownRegistry.length === 0 ? (
              <Empty>
                {query ? (
                  `Nothing in the registry matches “${query}”.`
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <Search className="size-3.5" /> Search the registry above.
                  </span>
                )}
              </Empty>
            ) : (
              shownRegistry.map((e) => (
                <DirCard
                  key={e.id}
                  icon={
                    <Server className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  }
                  title={e.name}
                  dim={!!e.unsupported}
                  meta={
                    <>
                      <span className="truncate">{e.namespace}</span>
                      {e.version && <span>· v{e.version}</span>}
                      <span className="uppercase">· {e.transport}</span>
                    </>
                  }
                  description={e.unsupported ?? e.description}
                  action={
                    <div className="flex items-center gap-1">
                      {e.repoUrl && (
                        <CardAction
                          icon={ExternalLink}
                          title="Open the repository"
                          onClick={() =>
                            void api()?.shell.openExternal(e.repoUrl!)
                          }
                        />
                      )}
                      {!e.unsupported && (
                        <CardAction
                          icon={Plus}
                          title="Add this server"
                          onClick={() => setAdd(toInitial(e, takenNames))}
                        />
                      )}
                    </div>
                  }
                />
              ))
            )}
          </div>
        </>
      )}

      {add && (
        <AddConnectorModal
          existingNames={takenNames}
          initial={add}
          onClose={() => setAdd(null)}
          onSaved={(list) => setInstalled(list)}
        />
      )}
    </>
  );
}
