/**
 * Session artifacts — the files that belong to the visible chat.
 *
 * Two groups:
 *  - Content  : input the user attached to their messages.
 *  - Artifacts: output the sandbox produced (parsed from RunPython tool results,
 *               which carry "[sandbox-file] <mime> <name> :: <path>" lines).
 *
 * `byName` lets the markdown renderer resolve an image the model embedded by
 * filename (e.g. ![chart](chart.png)) to the real on-disk artifact.
 */

import { useMemo } from "react";
import { useChatStore } from "@/stores/chatStore";
import type { ChatMessage } from "@/types/chat";

export type ArtifactKind = "text" | "image" | "audio" | "video" | "file";

export interface ArtifactItem {
  name: string;
  mediaType: string;
  kind: ArtifactKind;
  path?: string;
  dataUrl?: string;
  ts: number;
  source: "content" | "output";
}

const SANDBOX_FILE_RE = /^\[sandbox-file\]\s+(\S+)\s+(.+?)\s+::\s+(.+)$/;

export function kindOfMime(mime: string): ArtifactKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function baseName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

export interface SessionArtifacts {
  content: ArtifactItem[];
  output: ArtifactItem[];
  byName: Map<string, ArtifactItem>;
}

export function collectArtifacts(messages: ChatMessage[]): SessionArtifacts {
  const content: ArtifactItem[] = [];
  const output: ArtifactItem[] = [];

  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      content.push({
        name: a.name,
        mediaType: a.mediaType,
        kind: a.kind,
        path: a.path,
        dataUrl: a.dataUrl,
        ts: m.timestamp,
        source: "content",
      });
    }
    const out = m.toolCall?.name === "RunPython" ? m.toolCall.output : undefined;
    if (out) {
      for (const line of out.split("\n")) {
        const mm = SANDBOX_FILE_RE.exec(line.trim());
        if (mm) {
          output.push({
            name: mm[2],
            mediaType: mm[1],
            kind: kindOfMime(mm[1]),
            path: mm[3],
            ts: m.timestamp,
            source: "output",
          });
        }
      }
    }
  }

  // Newest of each name wins; output registered last so a generated file
  // shadows a same-named input when the model references it.
  const byName = new Map<string, ArtifactItem>();
  for (const it of [...content, ...output]) byName.set(baseName(it.name), it);

  return { content, output, byName };
}

export function useSessionArtifacts(): SessionArtifacts {
  const messages = useChatStore((s) => s.messages);
  return useMemo(() => collectArtifacts(messages), [messages]);
}
