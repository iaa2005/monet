/**
 * Artifacts panel — everything attached in the current chat, newest first.
 *
 * Derived straight from the visible session's messages: image thumbnails when
 * the preview data is still in memory (current session), name chips otherwise
 * (reloaded chats persist only attachment metadata).
 */

import { useMemo } from "react";
import {
  AudioLines,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Video,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";
import type { ChatAttachmentMeta } from "@/types/chat";

function KindIcon({ kind }: { kind: ChatAttachmentMeta["kind"] }): JSX.Element {
  if (kind === "audio")
    return <AudioLines className="size-3.5 shrink-0 text-violet-500" />;
  if (kind === "video")
    return <Video className="size-3.5 shrink-0 text-orange-500" />;
  if (kind === "file")
    return <Paperclip className="size-3.5 shrink-0 text-rose-500" />;
  if (kind === "image")
    return <ImageIcon className="size-3.5 shrink-0 text-emerald-500" />;
  return <FileText className="size-3.5 shrink-0 text-muted-foreground" />;
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
          {a.kind === "image" && a.dataUrl && (
            <img
              src={a.dataUrl}
              alt={a.name}
              className="max-h-40 w-full object-cover"
            />
          )}
          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <KindIcon kind={a.kind} />
            <span
              className="min-w-0 flex-1 truncate text-[12px]"
              title={a.name}
            >
              {a.name}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {new Date(a.ts).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
