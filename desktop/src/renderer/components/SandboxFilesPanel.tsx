/**
 * Sandbox files panel (Home) — the full on-disk file set of the chat's sandbox
 * (/work), not just the files surfaced in the transcript. Unlike ArtifactsPanel
 * (which is derived from message markers) this lists the directory directly, so
 * intermediate files the model wrote but never referenced also show up.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { KindIcon, ArtifactThumb, viewArtifact } from "@/components/ArtifactsPanel";
import { kindOfMime } from "@/lib/sessionArtifacts";
import { useChatStore } from "@/stores/chatStore";
import type { ElectronAPI, SandboxFileEntry } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function SandboxFilesPanel(): JSX.Element {
  const sessionId = useChatStore((s) => s.currentSessionId);
  // Re-list when the transcript grows (a tool run likely wrote files).
  const msgCount = useChatStore((s) => s.messages.length);
  const [files, setFiles] = useState<SandboxFileEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api()?.sandbox.listFiles(sessionId ?? "default");
      setFiles(r ?? []);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, msgCount]);

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Sandbox files {files.length > 0 && `· ${files.length}`}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          title="Refresh"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {files.length === 0 ? (
        <div className="flex h-40 items-center justify-center p-6 text-center text-xs text-muted-foreground">
          {loading
            ? "Loading…"
            : "No files in this chat's sandbox yet. Files you attach and files RunPython/RunCommand write appear here."}
        </div>
      ) : (
        <div className="space-y-1.5">
          {files.map((f) => {
            const kind = kindOfMime(f.mediaType);
            const a = {
              name: f.name,
              path: f.path,
              mediaType: f.mediaType,
              kind,
            };
            return (
              <div
                key={f.name}
                className="overflow-hidden rounded-lg border border-border bg-card"
              >
                {kind === "image" && (
                  <ArtifactThumb a={a} onClick={() => viewArtifact(a)} />
                )}
                <button
                  type="button"
                  onClick={() => viewArtifact(a)}
                  title={`View ${f.name}`}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                >
                  <KindIcon kind={kind} />
                  <span
                    className="min-w-0 flex-1 truncate text-[12px]"
                    title={f.name}
                  >
                    {f.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {fmtSize(f.size)}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
