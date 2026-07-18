import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Zap,
  ChevronDown,
  ChevronRight,
  MoreVertical,
  Pencil,
  GitFork,
  Download,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ExportChatModal } from "@/components/chat/ExportChatModal";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

interface RoutineChat {
  id: string;
  title: string;
  at: string;
  routineId: string;
  routineName: string;
}

interface RoutinesListProps {
  onOpen: (id: string) => void;
  currentSessionId?: string;
  onDelete: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  onFork?: (id: string) => void;
}

/** Collapsible sidebar section listing chats produced by routine runs, shown
 * above Recents. Hidden until a routine has produced at least one chat.
 * Chats are grouped by routine name, each group can be collapsed
 * independently. Each chat has a three-dot menu and right-click context menu
 * with Rename, Fork, Export, and Delete actions. */
export function RoutinesList({
  onOpen,
  currentSessionId,
  onDelete,
  onRename,
  onFork,
}: RoutinesListProps): JSX.Element | null {
  const [chats, setChats] = useState<RoutineChat[]>([]);
  const [open, setOpen] = useState(true);
  const [collapsedRoutines, setCollapsedRoutines] = useState<Set<string>>(new Set());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [exportSession, setExportSession] = useState<{ id: string; title: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const showMenu = (id: string, anchor: HTMLElement) => {
    const r = anchor.getBoundingClientRect();
    setMenuPos({ x: r.right, y: r.bottom + 4 });
    setOpenMenuId((prev) => (prev === id ? null : id));
  };

  useEffect(() => {
    const load = (): void => {
      void api()
        ?.routines.chats()
        .then((c) => setChats(c ?? []))
        .catch(() => {});
    };
    load();
    return api()?.routines.onRan(() => load());
  }, []);

  // Close the context menu on outside click.
  useEffect(() => {
    if (!openMenuId) return;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setOpenMenuId(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openMenuId]);

  if (chats.length === 0) return null;

  const groups = new Map<string, RoutineChat[]>();
  for (const c of chats) {
    const name = c.routineName || "Routine";
    const bucket = groups.get(name);
    if (bucket) bucket.push(c);
    else groups.set(name, [c]);
  }

  const toggleRoutine = (name: string) => {
    setCollapsedRoutines((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleDelete = (id: string) => {
    setOpenMenuId(null);
    onDelete(id);
    setChats((prev) => prev.filter((c) => c.id !== id));
  };

  return (
    <div className="shrink-0 px-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2 pb-1 pt-3 text-[11px] font-medium tracking-wide text-muted-foreground hover:text-foreground"
      >
        <Zap className="size-3" />
        Routines
        <span className="ml-auto tabular-nums text-muted-foreground/70">
          {chats.length}
        </span>
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
      </button>
      {open && (
        <div className="max-h-48 space-y-0.5 overflow-y-auto">
          {[...groups.entries()].map(([routineName, routineChats]) => {
            const collapsed = collapsedRoutines.has(routineName);
            return (
              <div key={routineName}>
                <button
                  type="button"
                  onClick={() => toggleRoutine(routineName)}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <span className="truncate">{routineName}</span>
                  <span className="tabular-nums text-muted-foreground/70">
                    {routineChats.length}
                  </span>
                  <span className="ml-auto">
                    {collapsed ? (
                      <ChevronRight className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )}
                  </span>
                </button>
                {!collapsed && (
                  <div className="ml-3">
                    {routineChats.map((c) => {
                      const active = c.id === currentSessionId;
                      return (
                        <div
                          key={c.id}
                          className={cn(
                            "group relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]",
                            active && "bg-black/[0.06] dark:bg-white/[0.08]",
                          )}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            showMenu(c.id, e.currentTarget as HTMLElement);
                          }}
                        >
                          <div
                            className="flex min-w-0 flex-1 items-center gap-2"
                            onClick={() => onOpen(c.id)}
                          >
                            <span
                              className={cn(
                                "size-1.5 shrink-0 rounded-full",
                                active ? "bg-link" : "bg-transparent",
                              )}
                            />
                            <span
                              className={cn(
                                "truncate text-[13px]",
                                active ? "text-foreground" : "text-muted-foreground",
                              )}
                            >
                              {c.title || "Routine run"}
                            </span>
                          </div>

                          {/* ⋮ button — visible on hover */}
                          <button
                            type="button"
                            aria-label="More actions"
                            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-black/10 hover:text-foreground group-hover:opacity-100 dark:hover:bg-white/10"
                            onClick={(e) => {
                              e.stopPropagation();
                              showMenu(c.id, e.currentTarget as HTMLElement);
                            }}
                          >
                            <MoreVertical className="size-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {exportSession && (
        <ExportChatModal
          sessionId={exportSession.id}
          title={exportSession.title}
          onClose={() => setExportSession(null)}
        />
      )}
      {openMenuId &&
        createPortal(
          <div
            ref={menuRef}
            style={{ position: "fixed", top: menuPos.y, left: menuPos.x - 192 }}
            className="z-[9999] w-48 rounded-lg border border-border bg-card p-1 shadow-lg"
          >
            <button
              type="button"
              onClick={() => {
                const c = chats.find((x) => x.id === openMenuId);
                setOpenMenuId(null);
                if (c) onRename?.(c.id, c.title || "");
              }}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
            >
              <Pencil className="size-4 text-muted-foreground" />
              Rename
            </button>
            <button
              type="button"
              onClick={() => {
                const c = chats.find((x) => x.id === openMenuId);
                setOpenMenuId(null);
                if (c) onFork?.(c.id);
              }}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
            >
              <GitFork className="size-4 text-muted-foreground" />
              Fork
            </button>
            <button
              type="button"
              onClick={() => {
                const c = chats.find((x) => x.id === openMenuId);
                setOpenMenuId(null);
                if (c) setExportSession({ id: c.id, title: c.title });
              }}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
            >
              <Download className="size-4 text-muted-foreground" />
              Export…
            </button>
            <div className="-mx-1 my-1 h-px bg-border" />
            <button
              type="button"
              onClick={() => openMenuId && handleDelete(openMenuId)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10"
            >
              <Trash2 className="size-4" />
              Delete
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
