/**
 * Sandbox files panel (Home) — the chat's sandbox working folder (/work),
 * browsed as a real file TREE with the same component Code uses. It's a real
 * host directory (<dataDir>/sandboxes/<sessionId>), so FileTree can walk it;
 * intermediate files the model wrote but never referenced show up too.
 */
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { FileTree } from "@/components/FileTree";
import { useChatStore } from "@/stores/chatStore";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function SandboxFilesPanel(): JSX.Element {
  const sessionId = useChatStore((s) => s.currentSessionId);
  const openViewer = useChatStore((s) => s.openViewer);
  const [workDir, setWorkDir] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api()
      ?.sandbox.workDir(sessionId ?? "default")
      .then((d) => {
        if (!cancelled) setWorkDir(d);
      })
      .catch(() => {
        if (!cancelled) setWorkDir(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Sandbox files
        </span>
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          title="Refresh"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {workDir ? (
          <FileTree
            key={`${workDir}:${refreshKey}`}
            rootPath={workDir}
            onSelectFile={(p) => {
              const name = p.split(/[/\\]/).pop() || p;
              openViewer({ name, path: p, mediaType: "application/octet-stream", kind: "file", source: "file" });
            }}
            emptyLabel="No files in this chat's sandbox yet. Files you attach and files RunPython/RunCommand write appear here."
          />
        ) : (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}
