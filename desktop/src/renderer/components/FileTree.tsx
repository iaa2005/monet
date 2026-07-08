/**
 * File Tree — recursive directory browser.
 */

import { useState, useEffect } from "react";
import { ChevronRight, ChevronDown, Folder, File } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

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

  const handleToggle = async (): Promise<void> => {
    if (entry.isFile) {
      onSelectFile?.(entry.path);
      return;
    }

    // If expanding and no children loaded yet, fetch them first.
    if (!expanded) {
      if (!children) {
        setLoading(true);
        try {
          const api = (window as unknown as { electronAPI: ElectronAPI })
            .electronAPI;
          const items = await api.files.list(entry.path);
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
        {entry.isDirectory ? (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <File className="size-3.5 shrink-0 text-muted-foreground" />
        )}
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
