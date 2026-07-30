/**
 * File Tree — recursive directory browser with charmed-icons.
 */

import { useState, useEffect, useRef } from "react";
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

function TreeNode({
  entry,
  depth,
  onSelectFile,
  refreshKey,
}: {
  entry: FileEntry;
  depth: number;
  onSelectFile?: (path: string) => void;
  /** Bumped when the folder changed on disk. An expanded node refetches; a
   * collapsed one does not, since it will load fresh when opened. */
  refreshKey: number;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(
    entry.children ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [largeFileDialog, setLargeFileDialog] = useState<{
    path: string;
    size: number;
  } | null>(null);
  const dark = useIsDark();

  const api = (): ElectronAPI =>
    (window as unknown as { electronAPI: ElectronAPI }).electronAPI;

  const openFile = (path: string): void => {
    onSelectFile?.(path);
  };

  const handleFileClick = async (): Promise<void> => {
    if (!entry.isFile) return;

    try {
      const stat = await api().files.stat(entry.path);
      if (stat.size > LARGE_FILE_THRESHOLD) {
        setLargeFileDialog({ path: entry.path, size: stat.size });
        return;
      }
    } catch {
      // stat failed — proceed anyway
    }
    openFile(entry.path);
  };

  const handleToggle = async (): Promise<void> => {
    if (entry.isFile) {
      await handleFileClick();
      return;
    }

    if (!expanded) {
      if (!children) {
        setLoading(true);
        try {
          setChildren(sortEntries(await api().files.list(entry.path)));
        } catch {
          setChildren([]);
        } finally {
          setLoading(false);
        }
      }
      setExpanded(true);
    } else {
      setExpanded(false);
    }
  };

  // Refresh in place: the rows are replaced but this node stays open and so do
  // its open descendants, because their React keys are paths and survive.
  // Reloading the whole tree instead would collapse everything the user opened.
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    if (!expanded || !entry.isDirectory) return;
    let cancelled = false;
    void api()
      .files.list(entry.path)
      .then((items) => {
        if (!cancelled) setChildren(sortEntries(items));
      })
      .catch(() => {
        // The folder itself may have just been deleted — leave the last known
        // contents rather than blanking the subtree.
      });
    return () => {
      cancelled = true;
    };
    // `expanded` is deliberately not a dependency: opening a node already
    // loads it, and re-running here would fetch the same folder twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, entry.path, entry.isDirectory]);

  const iconSrc = resolveIcon(entry.name, entry.isDirectory, expanded, dark);

  return (
    <div>
      <div
        className={cn(
          "flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-[13px] hover:bg-accent/50",
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={handleToggle}
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
      </div>

      {expanded && loading && (
        <div
          style={{ paddingLeft: `${(depth + 1) * 16 + 4}px` }}
          className="py-0.5 text-xs text-muted-foreground"
        >
          Loading...
        </div>
      )}

      {expanded &&
        children?.map((child) => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            onSelectFile={onSelectFile}
            refreshKey={refreshKey}
          />
        ))}

      {largeFileDialog && (
        <LargeFileDialog
          path={largeFileDialog.path}
          size={largeFileDialog.size}
          onOpen={() => {
            openFile(largeFileDialog.path);
            setLargeFileDialog(null);
          }}
          onExplorer={() => {
            api().shell.openPath(largeFileDialog.path);
            setLargeFileDialog(null);
          }}
          onCancel={() => setLargeFileDialog(null)}
        />
      )}
    </div>
  );
}

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
  // Bumped by the disk watcher. Passed down so open folders refetch in place
  // instead of the whole tree being rebuilt under the user.
  const [refreshKey, setRefreshKey] = useState(0);
  const dark = useIsDark();
  // The picker bumps this when the folder changes — including the restore that
  // happens when you open a chat that remembers its own folder.
  const workspaceVersion = useChatStore((s) => s.workspaceVersion);

  useEffect(() => {
    let cancelled = false;
    const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI;
    const load = async (ws: string): Promise<void> => {
      try {
        const items = await api.files.list(ws);
        if (cancelled) return;
        setRoot({
          name: ws.split(/[/\\]/).pop() || ws,
          isDirectory: true,
          isFile: false,
          path: ws,
          children: sortEntries(items).filter(
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
    if (rootPath) void load(rootPath);
    else void api.workspace.get().then((ws) => load(ws));
    return () => {
      cancelled = true;
    };
  }, [rootPath, workspaceVersion]);

  // Reload the root's own listing when the folder changes on disk, without the
  // reset above: a new file at the top level must appear, but blanking the tree
  // on every write would be worse than not refreshing at all.
  useEffect(() => {
    if (refreshKey === 0 || !root) return;
    let cancelled = false;
    const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI;
    void api.files
      .list(root.path)
      .then((items) => {
        if (cancelled) return;
        const children = sortEntries(items).filter(
          (e) => e.name !== "node_modules",
        );
        setRoot((cur) => (cur ? { ...cur, children } : cur));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // `root` is not a dependency: it is what this effect writes to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: ElectronAPI })
      .electronAPI;
    return api?.files.onChanged(() => setRefreshKey((k) => k + 1));
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
      const api = (window as unknown as { electronAPI: ElectronAPI })
        .electronAPI;
      void api.files
        .search(base, q)
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

  const isEmpty = loaded && (!root || (root.children?.length ?? 0) === 0);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search files…"
          className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
        />
      </div>

      <div className="flex-1 overflow-auto">
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
          root?.children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={0}
              onSelectFile={onSelectFile}
              refreshKey={refreshKey}
            />
          ))
        )}
      </div>
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
