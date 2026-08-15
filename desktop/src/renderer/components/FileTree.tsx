/**
 * File Tree — directory browser, icons from the flow pack.
 *
 * Flat and windowed rather than recursive: see tree-rows.ts for why the rows,
 * and not the icons, were what made a large folder crawl.
 */

import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import {
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  ClipboardPaste,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FilePlus,
  FolderOpen,
  FolderPlus,
  GitBranch,
  RefreshCw,
  Pencil,
  Scissors,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Portal } from "@/components/ui/portal";
import { useIsDark } from "@/components/chat/highlight";
import { fallbackIcon, resolveIcon } from "@/components/icon-resolver";
import { flattenTree, visibleWindow } from "@/components/tree-rows";
import { useChatStore } from "@/stores/chatStore";
import type { ElectronAPI } from "@/types/electron";

const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

interface FileEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string;
  children?: FileEntry[];
}

interface SearchHit {
  name: string;
  path: string;
  isDirectory: boolean;
  rel: string;
}

interface FileTreeProps {
  onSelectFile?: (path: string) => void;
  /** Double click — VS Code's "keep this one open" (the tab stops being italic). */
  onOpenFile?: (path: string) => void;
  /** Root the tree here instead of the Code workspace (e.g. the Home sandbox
   * working folder). When it changes, the tree reloads. */
  rootPath?: string;
  /** Message shown when the root is empty (no files yet). */
  emptyLabel?: string;
  /** Reload the tree. Given, it puts a refresh button beside the hidden-files
   * toggle — the two controls for this view belong on the same row, not one
   * here and one in a caption bar above. */
  onRefresh?: () => void;
}

function LargeFileDialog({
  path,
  size,
  onOpen,
  onExplorer,
  onCancel,
}: {
  path: string;
  size: number;
  onOpen: () => void;
  onExplorer: () => void;
  onCancel: () => void;
}): JSX.Element {
  const name = path.split(/[/\\]/).pop() || path;
  const sizeMB = (size / (1024 * 1024)).toFixed(1);
  const ext = (name.split(".").pop() || "").toLowerCase();
  const BINARY = new Set([
    "exe",
    "dll",
    "so",
    "dylib",
    "bin",
    "dat",
    "db",
    "sqlite",
    "wasm",
    "o",
    "obj",
    "lib",
    "a",
    "zip",
    "tar",
    "gz",
    "7z",
    "rar",
    "pdf",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "ico",
    "mp4",
    "mp3",
    "wav",
    "avi",
    "mov",
    "mkv",
    "ttf",
    "woff",
    "woff2",
    "class",
    "pyc",
    "pyd",
    "node",
  ]);
  const isBinary = BINARY.has(ext);

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="mx-4 w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-xl">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">
              Large file
            </div>
            <div className="mt-1 text-[13px] text-muted-foreground">
              <span className="font-mono text-foreground">{name}</span> is{" "}
              {sizeMB} MB
              {isBinary && " and may be binary"}. Are you sure you want to open
              it?
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onExplorer}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
          >
            <FolderOpen className="size-3.5" />
            Open in folder
          </button>
          <button
            type="button"
            onClick={onOpen}
            className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
          >
            <FileText className="size-3.5" />
            Open here
          </button>
        </div>
      </div>
    </div>
  );
  return <Portal>{dialog}</Portal>;
}

/** Where the context menu is open, and on what. `entry: null` = the empty
 * area below the rows — root-level actions. */
interface MenuState {
  x: number;
  y: number;
  entry: FileEntry | null;
}

/**
 * The in-app file clipboard. Module-level and shared by every tree on
 * purpose: Copy in the Home sandbox, Paste in the workspace is exactly how a
 * generated file graduates into the project. Cut is a promise to move when
 * pasted — nothing happens to the source until then. This is not the OS
 * clipboard: Electron cannot portably write a file list to it, and a
 * clipboard that works only inside the app should not pretend otherwise.
 */
let fileClipboard: { path: string; name: string; cut: boolean } | null = null;

/** The inline name prompt: what it's for decides the wording and the action. */
interface NamePrompt {
  kind: "new-file" | "new-folder" | "rename";
  /** Directory the new entry lands in (create), or the entry itself (rename). */
  entry: FileEntry | null;
}

const PROMPT_TITLES: Record<NamePrompt["kind"], string> = {
  "new-file": "New file",
  "new-folder": "New folder",
  rename: "Rename",
};

function NamePromptDialog({
  prompt,
  initial,
  onSubmit,
  onCancel,
}: {
  prompt: NamePrompt;
  initial: string;
  onSubmit: (name: string) => Promise<string | null>;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Rename selects the stem, like every file manager — the extension is
    // usually the part being kept.
    const dot = prompt.kind === "rename" ? initial.lastIndexOf(".") : -1;
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [prompt.kind, initial]);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const err = await onSubmit(value);
    setBusy(false);
    if (err) setError(err);
  };

  const dialog = (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[20vh]"
      onMouseDown={onCancel}
    >
      <div
        className="mx-4 w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium">{PROMPT_TITLES[prompt.kind]}</div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onCancel();
          }}
          spellCheck={false}
          className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-[13px] outline-none focus:ring-1 focus:ring-foreground/20"
        />
        {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !value.trim()}
            onClick={() => void submit()}
            className="rounded-md bg-foreground px-3 py-1.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {prompt.kind === "rename" ? "Rename" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
  return <Portal>{dialog}</Portal>;
}

function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: JSX.Element;
  label: string;
  danger?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors",
        danger
          ? "text-destructive hover:bg-destructive/10"
          : "hover:bg-black/[0.05] dark:hover:bg-white/[0.06]",
      )}
    >
      <span className={cn("shrink-0", danger ? "" : "text-muted-foreground")}>{icon}</span>
      {label}
    </button>
  );
}

const MenuSep = (): JSX.Element => <div className="my-1 h-px bg-border" />;

/**
 * Where "show hidden files" is remembered.
 *
 * A view preference, so it lives with the view: localStorage rather than the
 * session database. It is also read at module load by every tree at once,
 * which is the point — the sandbox tree and the workspace tree showing
 * different halves of the same disk would be a puzzle, not a feature.
 */
const HIDDEN_KEY = "monet.files.showHidden";

export function readShowHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeShowHidden(v: boolean): void {
  try {
    localStorage.setItem(HIDDEN_KEY, v ? "1" : "0");
  } catch {
    /* a preference that cannot be saved still applies to this session */
  }
}

/** Directory contents, sorted the way the tree shows them: folders first. */
function sortEntries(items: FileEntry[], showHidden: boolean): FileEntry[] {
  return items
    .filter((e) => showHidden || !e.name.startsWith("."))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/** Row height in px. Fixed on purpose: the window arithmetic needs to know
 * where row N sits without measuring it, and measuring a thousand rows to
 * avoid rendering a thousand rows would defeat the exercise. */
const ROW_H = 22;

/** One row. Memoised — a scroll changes which rows exist, not what the
 * surviving ones look like, and re-rendering the whole window on every wheel
 * tick is the jank this is meant to remove. */
const Row = memo(function Row({
  entry,
  depth,
  expanded,
  loading,
  dark,
  onToggle,
  onOpen,
  onMenu,
}: {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
  dark: boolean;
  onToggle: (entry: FileEntry) => void;
  onOpen: (entry: FileEntry) => void;
  onMenu: (entry: FileEntry, x: number, y: number) => void;
}): JSX.Element {
  const iconSrc = resolveIcon(entry.name, entry.isDirectory, expanded, dark);
  return (
    <div
      className="flex cursor-pointer items-center gap-0.5 rounded px-1 text-[13px] hover:bg-accent/50"
      style={{ height: ROW_H, paddingLeft: `${depth * 16 + 4}px` }}
      onClick={() => onToggle(entry)}
      onDoubleClick={() => {
        if (!entry.isDirectory) onOpen(entry);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(entry, e.clientX, e.clientY);
      }}
    >
      {entry.isDirectory ? (
        expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      {/* A name that has no icon file must fall back to the generic one.
          Without this a mapping typo renders the browser's broken-image
          glyph — which is how `.svg` and `.ico` (and six other types) sat
          broken: the map pointed at "vector" and "favicon", names that were
          never in the icon set. */}
      <img
        src={iconSrc}
        className="size-4 shrink-0"
        alt=""
        onError={(e) => {
          const img = e.currentTarget;
          const fallback = fallbackIcon(entry.isDirectory, expanded, dark);
          if (!img.src.endsWith(fallback)) img.src = fallback;
        }}
      />
      <span className="truncate">{entry.name}</span>
      {loading && (
        <span className="ml-1 shrink-0 text-[11px] text-muted-foreground">
          …
        </span>
      )}
    </div>
  );
});

export function FileTree({
  onSelectFile,
  onOpenFile,
  rootPath,
  emptyLabel,
  onRefresh,
}: FileTreeProps): JSX.Element {
  const [root, setRoot] = useState<FileEntry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  // Expansion and loaded children live here, not in the rows: the rows are a
  // flat array so only the visible ones need to exist, and a component that is
  // not rendered cannot hold the fact that its folder is open.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [childrenOf, setChildrenOf] = useState<
    ReadonlyMap<string, FileEntry[]>
  >(new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [largeFileDialog, setLargeFileDialog] = useState<{
    path: string;
    size: number;
  } | null>(null);
  // The context menu and the name prompt it opens. The sandbox tree (an
  // explicit rootPath) gets the REDUCED menu: those files belong to the
  // agent's working area — open, reveal, copy, trash; authoring happens in
  // the workspace tree.
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<NamePrompt | null>(null);
  const [opNotice, setOpNotice] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(readShowHidden);
  // Bumped by the disk watcher. Only open folders refetch — a collapsed one
  // will read fresh from disk whenever it is opened.
  const [refreshKey, setRefreshKey] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dark = useIsDark();
  // The picker bumps this when the folder changes — including the restore that
  // happens when you open a chat that remembers its own folder.
  const workspaceVersion = useChatStore((s) => s.workspaceVersion);

  const api = (): ElectronAPI =>
    (window as unknown as { electronAPI: ElectronAPI }).electronAPI;

  useEffect(() => {
    let cancelled = false;
    const load = async (ws: string): Promise<void> => {
      try {
        const items = await api().files.list(ws);
        if (cancelled) return;
        setRoot({
          name: ws.split(/[/\\]/).pop() || ws,
          isDirectory: true,
          isFile: false,
          path: ws,
          children: sortEntries(items, showHidden).filter(
            (e) => e.name !== "node_modules",
          ),
        });
      } catch {
        if (!cancelled) setRoot(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    setLoaded(false);
    setRoot(null);
    // A different folder shares no paths with the old one; keeping the open set
    // would leave stale entries that never match anything again.
    setExpanded(new Set());
    setChildrenOf(new Map());
    if (rootPath) void load(rootPath);
    else
      void api()
        .workspace.get()
        .then((ws) => load(ws));
    return () => {
      cancelled = true;
    };
  }, [rootPath, workspaceVersion, showHidden]);

  // The folder changed on disk: re-list the root and every open folder. Bounded
  // by what is open, not by what exists — a project with 40k files and three
  // folders open costs three calls.
  useEffect(() => {
    if (refreshKey === 0 || !root) return;
    let cancelled = false;
    void (async () => {
      try {
        const items = await api().files.list(root.path);
        if (!cancelled) {
          const children = sortEntries(items, showHidden).filter(
            (e) => e.name !== "node_modules",
          );
          setRoot((cur) => (cur ? { ...cur, children } : cur));
        }
      } catch {
        // The root may have just been removed; keep the last known contents.
      }
      const listed = await Promise.all(
        [...expanded].map((p) =>
          api()
            .files.list(p)
            .then((items) => [p, sortEntries(items, showHidden)] as const)
            .catch(() => null),
        ),
      );
      if (cancelled) return;
      setChildrenOf((cur) => {
        const next = new Map(cur);
        for (const r of listed) if (r) next.set(r[0], r[1]);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // `root` and `expanded` are read at fire time, not triggers: this must run
    // when the disk changed, not when a folder is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    const electron = (window as unknown as { electronAPI?: ElectronAPI })
      .electronAPI;
    return electron?.files.onChanged(() => setRefreshKey((k) => k + 1));
  }, []);

  // Search runs in the main process over the real folder. Debounced, because
  // typing "component" would otherwise start eight walks of the project.
  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setHits(null);
      setSearching(false);
      return;
    }
    const base = rootPath ?? root?.path;
    if (!base) return;
    setSearching(true);
    let cancelled = false;
    const id = setTimeout(() => {
      void api()
        .files.search(base, q, showHidden)
        .then((r) => {
          if (cancelled) return;
          setHits(r.hits);
          setTruncated(r.truncated);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [search, rootPath, root?.path, refreshKey, showHidden]);

  const toggle = useCallback(
    (entry: FileEntry): void => {
      if (!entry.isDirectory) {
        void (async () => {
          try {
            const stat = await api().files.stat(entry.path);
            if (stat.size > LARGE_FILE_THRESHOLD) {
              setLargeFileDialog({ path: entry.path, size: stat.size });
              return;
            }
          } catch {
            // stat failed — proceed anyway
          }
          onSelectFile?.(entry.path);
        })();
        return;
      }
      const path = entry.path;
      setExpanded((cur) => {
        const next = new Set(cur);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      // Load once; a reopened folder shows what it had, and the watcher
      // corrects it if the disk moved on.
      setChildrenOf((cur) => {
        if (cur.has(path)) return cur;
        setPending((p) => new Set(p).add(path));
        void api()
          .files.list(path)
          .then((items) => {
            setChildrenOf((c) => new Map(c).set(path, sortEntries(items, showHidden)));
          })
          .catch(() => {
            setChildrenOf((c) => new Map(c).set(path, []));
          })
          .finally(() => {
            setPending((p) => {
              const n = new Set(p);
              n.delete(path);
              return n;
            });
          });
        return cur;
      });
    },
    [onSelectFile],
  );

  // Stable, or every scroll would re-render every memoized row.
  const openEntry = useCallback(
    (entry: FileEntry) => onOpenFile?.(entry.path),
    [onOpenFile],
  );

  // ── Context-menu machinery ────────────────────────────────────────────
  const rootDir = rootPath ?? root?.path;
  // An explicit rootPath is the sandbox tree — reduced menu (see MenuState).
  const lite = !!rootPath;

  const openMenu = useCallback(
    (entry: FileEntry | null, x: number, y: number) =>
      setMenu({ x, y, entry }),
    [],
  );

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const notice = (text: string): void => {
    setOpNotice(text);
    window.setTimeout(() => setOpNotice((cur) => (cur === text ? null : cur)), 4000);
  };

  const parentOf = (p: string): string => p.replace(/[\\/][^\\/]*$/, "");
  const relOf = (p: string): string => {
    const r = (rootDir ?? "").replace(/\\/g, "/");
    const q = p.replace(/\\/g, "/");
    return r && q.startsWith(`${r}/`) ? q.slice(r.length + 1) : q;
  };

  /** Paste the in-app clipboard into an entry's folder (or the root). */
  const pasteInto = async (
    entry: FileEntry | null,
  ): Promise<{ ok: boolean; error?: string } | void> => {
    const clip = fileClipboard;
    if (!clip) return;
    const target = entry
      ? entry.isDirectory
        ? entry.path
        : parentOf(entry.path)
      : rootDir;
    if (!target) return;
    const r = await api().files.pasteInto(target, clip.path, clip.cut);
    if (r.ok) {
      // A cut is spent by its paste; a copy can be pasted again.
      if (clip.cut) fileClipboard = null;
      notice(clip.cut ? `Moved ${clip.name}.` : `Pasted ${clip.name}.`);
      setRefreshKey((k) => k + 1);
    }
    return r;
  };

  /** Close the menu, run the action, surface its failure as a notice. */
  const act =
    (fn: () => void | Promise<{ ok: boolean; error?: string } | void>) =>
    (): void => {
      setMenu(null);
      void (async () => {
        const r = await fn();
        if (r && "ok" in r && !r.ok) notice(r.error ?? "The operation failed.");
      })();
    };

  const submitPrompt = async (name: string): Promise<string | null> => {
    if (!prompt) return null;
    const a = api();
    if (prompt.kind === "rename") {
      if (!prompt.entry) return "Nothing to rename.";
      const r = await a.files.rename(prompt.entry.path, name);
      if (!r.ok) return r.error ?? "Rename failed.";
    } else {
      const base = prompt.entry
        ? prompt.entry.isDirectory
          ? prompt.entry.path
          : parentOf(prompt.entry.path)
        : rootDir;
      if (!base) return "No folder to create in.";
      const r = await a.files.create(base, name, prompt.kind === "new-folder");
      if (!r.ok) return r.error ?? "Create failed.";
      // A folder you just created into should be open to show the result.
      if (prompt.entry?.isDirectory) {
        const dir = prompt.entry.path;
        setExpanded((cur) => new Set(cur).add(dir));
      }
      if (prompt.kind === "new-file" && r.path) onSelectFile?.(r.path);
    }
    setPrompt(null);
    setRefreshKey((k) => k + 1);
    return null;
  };

  const rows = useMemo(
    () => flattenTree(root?.children ?? [], expanded, childrenOf),
    [root, expanded, childrenOf],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = (): void => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hits === null]);

  const win = visibleWindow(rows.length, ROW_H, scrollTop, viewportH);
  const isEmpty = loaded && (!root || (root.children?.length ?? 0) === 0);

  return (
    <div className="flex h-full flex-col">
      {/* Search is a field, not a strip: a bordered pill with the view's two
          toggles beside it. It used to be a bare input divided from the tree
          by a rule, which read as a header rather than as something to type
          in — and the rule was the only line left on a panel that no longer
          draws any. */}
      <div className="flex items-center gap-1.5 p-1.5">
        <div className="flex h-[26px] min-w-0 flex-1 items-center rounded-md border border-input px-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files…"
            className="min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none placeholder:text-muted-foreground"
          />
        </div>
        {/* Dot-files are hidden by default because a project root is mostly
            tooling; the toggle is here rather than in Settings because it is
            a property of THIS view, and it is remembered. */}
        <button
          type="button"
          onClick={() => {
            const next = !showHidden;
            setShowHidden(next);
            writeShowHidden(next);
          }}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
          aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
          aria-pressed={showHidden}
          className={cn(
            "flex size-[26px] shrink-0 items-center justify-center rounded-md transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.08]",
            showHidden ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {showHidden ? (
            <Eye className="size-3.5" />
          ) : (
            <EyeOff className="size-3.5" />
          )}
        </button>
        {/* The folder these rows ARE. A tree is a view of a real directory,
            and "let me look at it myself" should not need a path typed out. */}
        {root && (
          <button
            type="button"
            onClick={() => void api().shell.openFolder(root.path)}
            title="Open this folder in the file manager"
            aria-label="Open this folder in the file manager"
            className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <FolderOpen className="size-3.5" />
          </button>
        )}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            title="Refresh"
            aria-label="Refresh"
            className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <RefreshCw className="size-3.5" />
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto px-1.5"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onContextMenu={(e) => {
          // Rows stopPropagation, so reaching here means the empty area —
          // root-level actions.
          e.preventDefault();
          openMenu(null, e.clientX, e.clientY);
        }}
      >
        {hits !== null ? (
          hits.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {searching ? "Searching…" : "No files match."}
            </div>
          ) : (
            <>
              {hits.map((h) => (
                <SearchRow
                  key={h.path}
                  hit={h}
                  dark={dark}
                  onSelectFile={onSelectFile}
                  onMenu={openMenu}
                />
              ))}
              {truncated && (
                <div className="px-3 py-2 text-center text-[11px] text-muted-foreground">
                  Showing the first {hits.length}. Narrow the search to see
                  more.
                </div>
              )}
            </>
          )
        ) : isEmpty ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {emptyLabel ?? "No files yet."}
          </div>
        ) : (
          <>
            {/* Spacers stand in for the rows that are not in the document, so
                the scrollbar reports the real length of the list. */}
            <div style={{ height: win.padTop }} />
            {rows.slice(win.start, win.end).map((r) => (
              <Row
                key={r.entry.path}
                entry={r.entry}
                depth={r.depth}
                expanded={expanded.has(r.entry.path)}
                loading={pending.has(r.entry.path)}
                dark={dark}
                onToggle={toggle}
                onOpen={openEntry}
                onMenu={openMenu}
              />
            ))}
            <div style={{ height: win.padBottom }} />
          </>
        )}
      </div>

      {opNotice && (
        <div className="border-t border-border px-2 py-1 text-[11px] text-muted-foreground">
          {opNotice}
        </div>
      )}

      {menu &&
        (() => {
          const entry = menu.entry;
          return (
            <Portal>
              <div
                className="fixed inset-0 z-40"
                onMouseDown={() => setMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu(null);
                }}
              />
              <div
                className="fixed z-50 w-56 rounded-lg border border-border bg-card p-1 shadow-xl"
                style={{
                  left: Math.min(menu.x, window.innerWidth - 236),
                  top: Math.min(menu.y, window.innerHeight - 380),
                }}
              >
                {entry && !entry.isDirectory && (
                  <>
                    <MenuItem
                      icon={<FileText className="size-4" />}
                      label="Open"
                      onClick={act(() => onSelectFile?.(entry.path))}
                    />
                    <MenuItem
                      icon={<ExternalLink className="size-4" />}
                      label="Open in Default App"
                      onClick={act(() => void api().shell.openPath(entry.path))}
                    />
                  </>
                )}
                {!lite && (
                  <>
                    <MenuItem
                      icon={<FilePlus className="size-4" />}
                      label="New File…"
                      onClick={act(() => setPrompt({ kind: "new-file", entry }))}
                    />
                    <MenuItem
                      icon={<FolderPlus className="size-4" />}
                      label="New Folder…"
                      onClick={act(() => setPrompt({ kind: "new-folder", entry }))}
                    />
                    {fileClipboard && !entry && (
                      <MenuItem
                        icon={<ClipboardPaste className="size-4" />}
                        label={`Paste "${fileClipboard.name}"`}
                        onClick={act(() => pasteInto(null))}
                      />
                    )}
                  </>
                )}
                <MenuSep />
                <MenuItem
                  icon={<FolderOpen className="size-4" />}
                  label="Reveal in File Explorer"
                  onClick={act(() => {
                    const p = entry?.path ?? rootDir;
                    if (p) void api().files.reveal(p);
                  })}
                />
                {entry && (
                  <>
                    <MenuSep />
                    <MenuItem
                      icon={<Scissors className="size-4" />}
                      label="Cut"
                      onClick={act(() => {
                        fileClipboard = { path: entry.path, name: entry.name, cut: true };
                        notice(`Cut ${entry.name} — paste it where it belongs.`);
                      })}
                    />
                    <MenuItem
                      icon={<Copy className="size-4" />}
                      label="Copy"
                      onClick={act(() => {
                        fileClipboard = { path: entry.path, name: entry.name, cut: false };
                        notice(`Copied ${entry.name}.`);
                      })}
                    />
                    {!lite && (
                      <MenuItem
                        icon={<Copy className="size-4" />}
                        label="Duplicate"
                        onClick={act(async () => {
                          const r = await api().files.duplicate(entry.path);
                          if (r.ok) setRefreshKey((k) => k + 1);
                          return r;
                        })}
                      />
                    )}
                    {!lite && fileClipboard && (
                      <MenuItem
                        icon={<ClipboardPaste className="size-4" />}
                        label={`Paste "${fileClipboard.name}"`}
                        onClick={act(() => pasteInto(entry))}
                      />
                    )}
                    <MenuSep />
                    <MenuItem
                      icon={<Copy className="size-4" />}
                      label="Copy Path"
                      onClick={act(() => {
                        void navigator.clipboard.writeText(entry.path);
                        notice("Path copied.");
                      })}
                    />
                    {!lite && (
                      <MenuItem
                        icon={<Copy className="size-4" />}
                        label="Copy Relative Path"
                        onClick={act(() => {
                          void navigator.clipboard.writeText(relOf(entry.path));
                          notice("Relative path copied.");
                        })}
                      />
                    )}
                    {!lite && (
                      <>
                        <MenuSep />
                        <MenuItem
                          icon={<GitBranch className="size-4" />}
                          label="Add to .gitignore"
                          onClick={act(async () => {
                            if (!rootDir) return;
                            const r = await api().files.addToGitignore(
                              rootDir,
                              entry.path,
                            );
                            if (r.ok) notice(`Added ${r.line} to .gitignore.`);
                            return r;
                          })}
                        />
                      </>
                    )}
                    <MenuSep />
                    {!lite && (
                      <MenuItem
                        icon={<Pencil className="size-4" />}
                        label="Rename…"
                        onClick={act(() => setPrompt({ kind: "rename", entry }))}
                      />
                    )}
                    {/* Trash, never unlink — a right-click must be recoverable. */}
                    <MenuItem
                      icon={<Trash2 className="size-4" />}
                      label="Move to Trash"
                      danger
                      onClick={act(async () => {
                        const r = await api().files.trash(entry.path);
                        if (r.ok) setRefreshKey((k) => k + 1);
                        return r;
                      })}
                    />
                  </>
                )}
              </div>
            </Portal>
          );
        })()}

      {prompt && (
        <NamePromptDialog
          prompt={prompt}
          initial={prompt.kind === "rename" ? (prompt.entry?.name ?? "") : ""}
          onSubmit={submitPrompt}
          onCancel={() => setPrompt(null)}
        />
      )}

      {largeFileDialog && (
        <LargeFileDialog
          path={largeFileDialog.path}
          size={largeFileDialog.size}
          onOpen={() => {
            onSelectFile?.(largeFileDialog.path);
            setLargeFileDialog(null);
          }}
          onExplorer={() => {
            void api().shell.openPath(largeFileDialog.path);
            setLargeFileDialog(null);
          }}
          onCancel={() => setLargeFileDialog(null)}
        />
      )}
    </div>
  );
}
/**
 * One search result: the name, and under it where it lives. A flat list of
 * bare filenames is unusable in a project with four `index.ts`.
 */
function SearchRow({
  hit,
  dark,
  onSelectFile,
  onMenu,
}: {
  hit: SearchHit;
  dark: boolean;
  onSelectFile?: (path: string) => void;
  onMenu?: (entry: FileEntry, x: number, y: number) => void;
}): JSX.Element {
  const iconSrc = resolveIcon(hit.name, hit.isDirectory, false, dark);
  const dir = hit.rel.slice(0, hit.rel.length - hit.name.length - 1);
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 text-[13px]",
        hit.isDirectory ? "opacity-70" : "cursor-pointer hover:bg-accent/50",
      )}
      onClick={() => {
        if (!hit.isDirectory) onSelectFile?.(hit.path);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu?.(
          {
            name: hit.name,
            path: hit.path,
            isDirectory: hit.isDirectory,
            isFile: !hit.isDirectory,
          },
          e.clientX,
          e.clientY,
        );
      }}
    >
      <img
        src={iconSrc}
        className="size-4 shrink-0"
        alt=""
        onError={(e) => {
          const img = e.currentTarget;
          const fallback = fallbackIcon(hit.isDirectory, false, dark);
          if (!img.src.endsWith(fallback)) img.src = fallback;
        }}
      />
      <span className="truncate">{hit.name}</span>
      {dir && (
        <span className="ml-auto shrink-0 truncate pl-2 text-[11px] text-muted-foreground">
          {dir}
        </span>
      )}
    </div>
  );
}
