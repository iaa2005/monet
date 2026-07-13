/**
 * Session artifacts — the files that belong to the visible chat.
 *
 * Two groups:
 *  - Content  : input the user attached to their messages.
 *  - Artifacts: output the sandbox produced (parsed from RunPython tool results,
 *               which carry "[artifact] <mime> <name> :: <path>" lines).
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

const ARTIFACT_RE = /^\[artifact\]\s+(\S+)\s+(.+?)\s+::\s+(.+)$/;

export function kindOfMime(mime: string): ArtifactKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/** Files a single tool result produced (from its [artifact] lines). */
export function sandboxFilesFromOutput(
  output: string,
  ts: number,
): ArtifactItem[] {
  const items: ArtifactItem[] = [];
  for (const line of output.split("\n")) {
    const m = ARTIFACT_RE.exec(line.trim());
    if (m) {
      items.push({
        name: m[2],
        mediaType: m[1],
        kind: kindOfMime(m[1]),
        path: m[3],
        ts,
        source: "output",
      });
    }
  }
  return items;
}

export interface SessionArtifacts {
  content: ArtifactItem[];
  output: ArtifactItem[];
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
      const out = m.toolCall?.output;
    if (out && out.includes("[artifact]"))
      output.push(...sandboxFilesFromOutput(out, m.timestamp));
  }

  return { content, output };
}

export function useSessionArtifacts(): SessionArtifacts {
  const messages = useChatStore((s) => s.messages);
  return useMemo(() => collectArtifacts(messages), [messages]);
}
