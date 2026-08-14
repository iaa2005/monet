/**
 * Session artifacts — the files that belong to the visible chat.
 *
 * Two groups:
 *  - Content  : input the user attached to their messages.
 *  - Artifacts: output the sandbox produced (parsed from tool results).
 *
 * Output files carry one of two marker lines, and the difference is WHO chose
 * to show them. "[file] <mime> <name> :: <path>" is a working file — something
 * a script happened to write; it exists and is reachable, but nobody presents
 * it. "[artifact] <mime> <name> :: <path>" is a delivery — the model explicitly
 * handed the file to the user (DeliverFiles, a screenshot, a connector
 * download). A LaTeX run producing csv → png → tex → pdf writes a dozen
 * working files and delivers one, and the chat should look like that.
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
  /** True when the model explicitly handed this file to the user ([artifact]);
   * false for working files ([file]). Optional so ad-hoc items (attachments,
   * viewer stubs) don't have to answer a question that isn't theirs. */
  delivered?: boolean;
}

const MARKER_RE = /^\[(artifact|file)\]\s+(\S+)\s+(.+?)\s+::\s+(.+)$/;

/** Does this tool output carry file marker lines at all? The cheap gate the
 * collectors use before paying for a line-by-line parse. */
export function hasFileMarkers(output: string): boolean {
  return output.includes("[artifact]") || output.includes("[file]");
}

export function kindOfMime(mime: string): ArtifactKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/** Files a single tool result produced (from its [artifact]/[file] lines). */
export function sandboxFilesFromOutput(
  output: string,
  ts: number,
): ArtifactItem[] {
  const items: ArtifactItem[] = [];
  for (const line of output.split("\n")) {
    const m = MARKER_RE.exec(line.trim());
    if (m) {
      items.push({
        name: m[3],
        mediaType: m[2],
        kind: kindOfMime(m[2]),
        path: m[4],
        ts,
        source: "output",
        delivered: m[1] === "artifact",
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
    if (out && hasFileMarkers(out))
      output.push(...sandboxFilesFromOutput(out, m.timestamp));
  }

  return { content, output };
}

export function useSessionArtifacts(): SessionArtifacts {
  const messages = useChatStore((s) => s.messages);
  return useMemo(() => collectArtifacts(messages), [messages]);
}

/** One file, plus the earlier copies of it this chat produced. */
export interface ArtifactVersions {
  /** Newest copy — the one that represents the file. */
  latest: ArtifactItem;
  /** Earlier copies, newest first. Empty for a file written only once. */
  older: ArtifactItem[];
}

/**
 * Collapse repeated writes of the same file into one entry.
 *
 * Every sandbox run reports the files it changed, so a model that writes
 * report.docx, checks it, and fixes it produces three artifacts — three
 * separate files on disk, all called report.docx. Keeping them is right: they
 * are the version history, and an earlier draft is sometimes the one you want.
 * Listing them as three peers is not — the panel fills with copies and none of
 * them says which is current.
 *
 * Groups by the sandbox-relative name, so site/index.html and docs/index.html
 * stay distinct. Groups are ordered by their newest member.
 */
export function groupVersions(items: ArtifactItem[]): ArtifactVersions[] {
  const byName = new Map<string, ArtifactItem[]>();
  for (const item of items) {
    const list = byName.get(item.name);
    if (list) list.push(item);
    else byName.set(item.name, [item]);
  }
  const groups: ArtifactVersions[] = [];
  for (const list of byName.values()) {
    // `items` arrives oldest-first; a stable sort keeps that order for the
    // equal timestamps you get when one run writes several files at once.
    const ordered = [...list].reverse();
    groups.push({ latest: ordered[0], older: ordered.slice(1) });
  }
  groups.sort((a, b) => b.latest.ts - a.latest.ts);
  return groups;
}

/**
 * Which copy of its name a given artifact is: 1 is the first the chat wrote,
 * `total` is the newest.
 *
 * The number is a POSITION, not a stored field — a "version" here is simply
 * how many times this chat wrote a file of that name, which is what the
 * Artifacts panel already counts when it collapses them into one card. Keeping
 * it derived means the tab, the card and the panel can never disagree.
 *
 * Matched on path when there is one: two writes of report.docx are two files
 * on disk with different paths, and the name alone cannot tell them apart.
 */
export function versionOf(
  items: ArtifactItem[],
  target: { name?: string; path?: string },
): { n: number; total: number } | null {
  if (!target.name) return null;
  const sameName = items.filter((i) => i.name === target.name);
  if (sameName.length === 0) return null;
  // `items` arrives oldest-first, so the index IS the version, 1-based.
  const index = target.path
    ? sameName.findIndex((i) => i.path === target.path)
    : sameName.length - 1;
  if (index < 0) return null;
  return { n: index + 1, total: sameName.length };
}
