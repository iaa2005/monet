/**
 * The dev servers this project declares, started and stopped by hand.
 *
 * Detection tells you what is listening; this is the list of what should be.
 * The difference matters when nothing is: a port scan finds nothing and has
 * nothing to offer, while a named server has a command and a button.
 *
 * The list lives in the workspace at .monet/servers.json, so it is the
 * project's, not this machine's — see main/browser/servers.ts.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Circle,
  Loader2,
  Play,
  Plus,
  Server,
  Square,
  Trash2,
  TriangleAlert,
} from "@/components/icons/hg";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import type { ElectronAPI, ServerConfig, ServerState } from "@/types/electron";

const api = (): ElectronAPI =>
  (window as unknown as { electronAPI: ElectronAPI }).electronAPI;

function StatusDot({ state }: { state: ServerState }): JSX.Element {
  if (state.status === "starting")
    return <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />;
  if (state.status === "failed")
    return <TriangleAlert className="size-3 shrink-0 text-destructive" />;
  return (
    <Circle
      className={cn(
        "size-2.5 shrink-0",
        state.status === "running"
          ? "fill-green-text text-green-text"
          : "fill-border text-border",
      )}
    />
  );
}

export function ServersMenu({
  onOpen,
}: {
  /** Point the panel at a server that is up. */
  onOpen: (url: string) => void;
}): JSX.Element {
  const [servers, setServers] = useState<ServerState[]>([]);
  const [suggested, setSuggested] = useState<ServerConfig[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", command: "", port: "" });
  const workspaceVersion = useChatStore((s) => s.workspaceVersion);

  const refresh = useCallback(async (): Promise<void> => {
    const [list, hints] = await Promise.all([
      api().browser.servers.list(),
      api().browser.servers.suggest(),
    ]);
    setServers(list);
    setSuggested(hints);
  }, []);

  useEffect(() => {
    void refresh();
    // Main pushes on every state change, so "starting" becoming "running"
    // arrives rather than being polled for.
    return api().browser.servers.onChanged(() => void refresh());
  }, [refresh, workspaceVersion]);

  const save = async (next: ServerConfig[]): Promise<void> => {
    await api().browser.servers.save(next);
    await refresh();
  };

  /** A row back to what the file stores — the live status is not config. */
  const asConfig = ({ id, name, command, cwd, port }: ServerState): ServerConfig => ({
    id,
    name,
    command,
    ...(cwd ? { cwd } : {}),
    port,
  });

  const remove = async (s: ServerState): Promise<void> => {
    // Stop it first. Deleting the entry deletes the only handle anything had
    // on that process — an orphan left holding the port cannot be stopped from
    // here, from the list it is no longer in, or from anywhere else.
    if (!s.externallyRunning && s.status !== "stopped")
      await api().browser.servers.stop(s.id);
    await save(
      servers.filter((x) => x.declared && x.id !== s.id).map(asConfig),
    );
  };

  const add = async (): Promise<void> => {
    const port = Number(draft.port);
    if (!draft.command.trim() || !Number.isInteger(port)) return;
    await save([
      // Only the declared ones go back to the file — a found server has no
      // command, and writing it down as a blank one would give it a start
      // button that starts nothing.
      ...servers.filter((x) => x.declared).map(asConfig),
      {
        id: `srv-${Date.now().toString(36)}`,
        name: draft.name.trim() || `:${port}`,
        command: draft.command.trim(),
        port,
      },
    ]);
    setDraft({ name: "", command: "", port: "" });
    setAdding(false);
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void refresh();
        else setAdding(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Dev servers"
          title="Dev servers"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
        >
          <Server className="size-3.5" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Servers</DropdownMenuLabel>

        {servers.length === 0 && suggested.length === 0 && !adding && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            None declared. Add one and it is saved to the project, in
            <span className="font-mono"> .monet/servers.json</span>.
          </div>
        )}

        {servers.map((s) => (
          <div
            key={s.id}
            className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
          >
            <StatusDot state={s} />
            <button
              type="button"
              disabled={s.status !== "running"}
              onClick={() => onOpen(`http://localhost:${s.actualPort ?? s.port}/`)}
              title={
                s.status === "failed"
                  ? (s.error ?? "Failed to start")
                  : `http://localhost:${s.actualPort ?? s.port}/`
              }
              className="min-w-0 flex-1 truncate text-left disabled:cursor-default disabled:text-muted-foreground"
            >
              {s.name}
            </button>
            {/* The port it actually took, when the one it was asked for was
                busy and it moved. Showing the declared number then would send
                you to a port with nothing on it. */}
            <span
              className="shrink-0 font-mono text-[11px] text-muted-foreground"
              title={
                s.actualPort
                  ? `:${s.port} was in use, it took :${s.actualPort}`
                  : undefined
              }
            >
              :{s.actualPort ?? s.port}
            </span>
            {/* Found, not declared: something else is serving this port — the
                agent's shell, or a terminal. There is no command to start it
                with and nothing of ours to stop, so the only offer is to write
                it down. */}
            {!s.declared ? (
              <button
                type="button"
                aria-label={`Declare ${s.name}`}
                title="Add to this project so it has a start button"
                onClick={() => {
                  setDraft({ name: s.name, command: "", port: String(s.port) });
                  setAdding(true);
                }}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
              >
                <Plus className="size-3.5" />
              </button>
            ) : (
              <>
                {/* Removing is per row and needs no confirmation: it deletes a
                    line of config, and the process it might have been running
                    is stopped on the way out. */}
                <button
                  type="button"
                  aria-label={`Remove ${s.name}`}
                  title="Remove from this project"
                  onClick={() => void remove(s)}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="size-3" />
                </button>
                {/* Answering, but started by somebody else: the port is up and
                    the process is not ours to kill. */}
                {s.status === "running" && s.externallyRunning ? (
                  <span className="shrink-0 px-1 text-[10px] text-muted-foreground">
                    external
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={s.status === "stopped" ? "Start" : "Stop"}
                    onClick={() =>
                      void (s.status === "stopped"
                        ? api().browser.servers.start(s.id)
                        : api().browser.servers.stop(s.id))
                    }
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
                  >
                    {s.status === "stopped" ? (
                      <Play className="size-3" />
                    ) : (
                      <Square className="size-3 fill-current" />
                    )}
                  </button>
                )}
              </>
            )}
          </div>
        ))}

        {/* Only while the list is empty: the project's own scripts, and only
            those that pin a port — one we cannot open is not worth offering. */}
        {suggested.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              From package.json
            </DropdownMenuLabel>
            {suggested.map((s) => (
              <DropdownMenuItem
                key={s.id}
                onSelect={(e) => {
                  e.preventDefault();
                  void save([s]);
                }}
              >
                <Plus className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{s.command}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  :{s.port}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}

        <DropdownMenuSeparator />

        {adding ? (
          <div className="space-y-1.5 px-2 py-1.5">
            <input
              autoFocus
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Name"
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-link"
            />
            <input
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder="npm run dev"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:border-link"
            />
            <div className="flex gap-1.5">
              <input
                value={draft.port}
                onChange={(e) =>
                  setDraft({ ...draft, port: e.target.value.replace(/\D/g, "") })
                }
                onKeyDown={(e) => e.key === "Enter" && void add()}
                placeholder="3000"
                inputMode="numeric"
                className="w-20 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:border-link"
              />
              <button
                type="button"
                onClick={() => void add()}
                className="flex-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
              >
                Add
              </button>
            </div>
          </div>
        ) : (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setAdding(true);
            }}
          >
            <Plus className="size-3.5" />
            Add server
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
