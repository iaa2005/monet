/**
 * File Tree — recursive directory browser with charmed-icons.
 */

import { useState, useEffect } from "react";
import {
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  FileText,
  FolderOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsDark } from "@/components/chat/CodeBlock";
import { resolveIcon } from "@/components/icon-resolver";
import type { ElectronAPI } from "@/types/electron";

const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

interface FileEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string;
  children?: FileEntry[];
}

interface FileTreeProps {
  onSelectFile?: (path: string) => void;
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

function TreeNode({
  entry,
  depth,
  onSelectFile,
}: {
  entry: FileEntry;
  depth: number;
  onSelectFile?: (path: string) => void;
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
          const items = await api().files.list(entry.path);
          setChildren(
            items
              .filter((e) => !e.name.startsWith("."))
              .sort((a, b) => {
                if (a.isDirectory !== b.isDirectory)
                  return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name);
              }),
          );
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
        <img src={iconSrc} className="size-4 shrink-0" alt="" />
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
        children?.map((child, i) => (
          <TreeNode
            key={child.path + i}
            entry={child}
            depth={depth + 1}
            onSelectFile={onSelectFile}
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

export function FileTree({ onSelectFile }: FileTreeProps): JSX.Element {
  const [root, setRoot] = useState<FileEntry | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI;
    api.workspace.get().then(async (ws) => {
      try {
        const items = await api.files.list(ws);
        setRoot({
          name: ws.split(/[/\\]/).pop() || ws,
          isDirectory: true,
          isFile: false,
          path: ws,
          children: items
            .filter(
              (e) =>
                !e.name.startsWith(".") && !e.name.startsWith("node_modules"),
            )
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory)
                return a.isDirectory ? -1 : 1;
              return a.name.localeCompare(b.name);
            }),
        });
      } catch {
        setRoot(null);
      }
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter files..."
          className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
        />
      </div>

      <div className="flex-1 overflow-auto">
        {root?.children?.map((child, i) => (
          <TreeNode
            key={child.path + i}
            entry={child}
            depth={0}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    </div>
  );
}
