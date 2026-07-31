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
  FileText,
  FolderOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
  /** Root the tree here instead of the Code workspace (e.g. the Home sandbox
   * working folder). When it changes, the tree reloads. */
  rootPath?: string;
  /** Message shown when the root is empty (no files yet). */
  emptyLabel?: string;
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

  return (
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
}

/** Directory contents, sorted the way the tree shows them: folders first. */
function sortEntries(items: FileEntry[]): FileEntry[] {
  return items
    .filter((e) => !e.name.startsWith("."))
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
}: {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
  dark: boolean;
  onToggle: (entry: FileEntry) => void;
}): JSX.Element {
  const iconSrc = resolveIcon(entry.name, entry.isDirectory, expanded, dark);
  return (
    <div
      className="flex cursor-pointer items-center gap-0.5 rounded px-1 text-[13px] hover:bg-accent/50"
      style={{ height: ROW_H, paddingLeft: `${depth * 16 + 4}px` }}
      onClick={() => onToggle(entry)}
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
  rootPath,
  emptyLabel,
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
          children: sortEntries(items).filter((e) => e.name !== "node_modules"),
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
  }, [rootPath, workspaceVersion]);

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
          const children = sortEntries(items).filter(
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
            .then((items) => [p, sortEntries(items)] as const)
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
        .files.search(base, q)
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
  }, [search, rootPath, root?.path, refreshKey]);

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
            setChildrenOf((c) => new Map(c).set(path, sortEntries(items)));
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
      <div className="border-b">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search files…"
          className="w-full px-2 py-1 text-xs"
        />
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
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
              />
            ))}
            <div style={{ height: win.padBottom }} />
          </>
        )}
      </div>

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
}: {
  hit: SearchHit;
  dark: boolean;
  onSelectFile?: (path: string) => void;
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
