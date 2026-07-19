/**
 * Artifacts panel — the current chat's files, in two groups:
 *   Artifacts — output the sandbox produced (charts, docs, data).
 *   Content   — input the user attached to their messages.
 *
 * Files live on disk (<dataDir>/artifacts/<sessionId>/…); image previews are
 * re-read lazily from the artifact path, so they survive chat switches and
 * restarts. Clicking an item opens it with the OS default app.
 */

import { useEffect, useState } from "react";
import {
  AudioLines,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Video,
} from "lucide-react";
import {
  useSessionArtifacts,
  type ArtifactItem,
} from "@/lib/sessionArtifacts";
import { useChatStore } from "@/stores/chatStore";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function openArtifact(path?: string): void {
  if (path) void api()?.artifacts.open(path);
}

/** Open a file in the in-app viewer drawer. */
export function viewArtifact(a: {
  name: string;
  path?: string;
  mediaType: string;
  kind: string;
  dataUrl?: string;
}): void {
  useChatStore.getState().openArtifactViewer(a);
}

export function KindIcon({
  kind,
  className = "size-3.5",
}: {
  kind: ArtifactItem["kind"];
  className?: string;
}): JSX.Element {
  if (kind === "audio")
    return <AudioLines className={`${className} shrink-0 text-violet-500`} />;
  if (kind === "video")
    return <Video className={`${className} shrink-0 text-orange-500`} />;
  if (kind === "file")
    return <Paperclip className={`${className} shrink-0 text-red-text`} />;
  if (kind === "image")
    return <ImageIcon className={`${className} shrink-0 text-green-text`} />;
  return <FileText className={`${className} shrink-0 text-muted-foreground`} />;
}

/** Image preview that falls back to re-reading the on-disk artifact when the
 * in-memory data URL is gone (chat switch / reload). */
export function ArtifactThumb({
  a,
  className,
  onClick,
}: {
  a: { dataUrl?: string; path?: string; name: string; mediaType: string };
  className?: string;
  /** Click handler. Nothing opens in the OS unless the caller asks for it —
   * clicking a preview should open the in-app viewer, not the OS app. */
  onClick?: () => void;
}): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(a.dataUrl ?? null);

  useEffect(() => {
    if (url || !a.path) return;
    let alive = true;
    void api()
      ?.artifacts.readImage(a.path, a.mediaType)
      .then((r) => {
        if (alive && r.ok && r.dataUrl) setUrl(r.dataUrl);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.path]);

  if (!url) return null;
  return (
    <img
      src={url}
      alt={a.name}
      title={a.name}
      onClick={onClick}
      className={cn(className ?? "max-h-40 w-full object-cover", onClick && "cursor-pointer")}
    />
  );
}

function ArtifactRow({ a }: { a: ArtifactItem }): JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {a.kind === "image" && (a.dataUrl || a.path) && (
        <ArtifactThumb a={a} onClick={() => viewArtifact(a)} />
      )}
      <button
        type="button"
        onClick={() => viewArtifact(a)}
        title={`View ${a.name}`}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <KindIcon kind={a.kind} />
        <span className="min-w-0 flex-1 truncate text-[12px]" title={a.name}>
          {a.name}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {new Date(a.ts).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </button>
    </div>
  );
}

/** Compact strip of the artifacts ONE turn produced — rendered right after
 * the model reply that created them (click → viewer). */
export function ArtifactsStrip({
  items,
}: {
  items: ArtifactItem[];
}): JSX.Element | null {
  const output = items;
  if (output.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-card/50 p-2.5">
      <div className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Artifacts · {output.length}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {output.map((a, i) => (
          <button
            key={`${a.ts}-${i}-${a.name}`}
            type="button"
            onClick={() => viewArtifact(a)}
            title={`View ${a.name}`}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 text-[12px] transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            <KindIcon kind={a.kind} className="size-3.5" />
            <span className="max-w-52 truncate">{a.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Group({
  label,
  items,
}: {
  label: string;
  items: ArtifactItem[];
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label} · {items.length}
      </div>
      <div className="space-y-1.5">
        {items.map((a, i) => (
          <ArtifactRow key={`${a.source}-${a.ts}-${i}-${a.name}`} a={a} />
        ))}
      </div>
    </div>
  );
}

export function ArtifactsPanel(): JSX.Element {
  const { content, output } = useSessionArtifacts();
  const outputNewest = [...output].reverse();
  const contentNewest = [...content].reverse();

  if (content.length === 0 && output.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        Files the sandbox produces (Artifacts) and files you attach (Content)
        appear here.
      </div>
    );
  }

  return (
    <div className="space-y-4 p-3">
      <Group label="Artifacts" items={outputNewest} />
      <Group label="Content" items={contentNewest} />
    </div>
  );
}
