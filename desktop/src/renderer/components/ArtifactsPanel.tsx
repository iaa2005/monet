/**
 * Artifacts panel — everything attached in the current chat, newest first.
 *
 * Attachments are saved on disk (<dataDir>/artifacts/<sessionId>/…) when a
 * message is sent; image previews are re-read lazily from the artifact path,
 * so they survive chat switches and app restarts. Clicking an item opens the
 * file with the OS default app.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AudioLines,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Video,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import type { ChatAttachmentMeta } from "@/types/chat";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function openArtifact(path?: string): void {
  if (path) void api()?.artifacts.open(path);
}

export function KindIcon({
  kind,
  className = "size-3.5",
}: {
  kind: ChatAttachmentMeta["kind"];
  className?: string;
}): JSX.Element {
  if (kind === "audio")
    return <AudioLines className={`${className} shrink-0 text-violet-500`} />;
  if (kind === "video")
    return <Video className={`${className} shrink-0 text-orange-500`} />;
  if (kind === "file")
    return <Paperclip className={`${className} shrink-0 text-rose-500`} />;
  if (kind === "image")
    return <ImageIcon className={`${className} shrink-0 text-emerald-500`} />;
  return <FileText className={`${className} shrink-0 text-muted-foreground`} />;
}

/** Image preview that falls back to re-reading the on-disk artifact when the
 * in-memory data URL is gone (chat switch / reload). */
export function ArtifactThumb({
  a,
  className,
}: {
  a: ChatAttachmentMeta;
  className?: string;
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
      onClick={() => openArtifact(a.path)}
      className={className ?? "max-h-40 w-full cursor-pointer object-cover"}
    />
  );
}

export function ArtifactsPanel(): JSX.Element {
  const messages = useChatStore((s) => s.messages);

  const items = useMemo(
    () =>
      messages
        .flatMap((m) =>
          (m.attachments ?? []).map((a) => ({ ...a, ts: m.timestamp })),
        )
        .reverse(),
    [messages],
  );

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        Files, images, audio and video attached in this chat appear here.
      </div>
    );
  }

  return (
    <div className="space-y-1.5 p-3">
      {items.map((a, i) => (
        <div
          key={`${a.ts}-${i}-${a.name}`}
          className="overflow-hidden rounded-lg border border-border bg-card"
        >
          {a.kind === "image" && <ArtifactThumb a={a} />}
          <button
            type="button"
            onClick={() => openArtifact(a.path)}
            disabled={!a.path}
            title={a.path ? "Open file" : a.name}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors enabled:hover:bg-black/[0.03] disabled:cursor-default dark:enabled:hover:bg-white/[0.04]"
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
      ))}
    </div>
  );
}
