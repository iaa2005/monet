/**
 * Builders for the non-browser references — code selections, @-mentioned
 * files and chats.
 *
 * Each produces the same shape the browser's element picks use
 * (pendingContext), so the whole existing pipeline — chip in the composer,
 * ⟨token⟩ in the sentence, context block appended on send, chip again in the
 * transcript — carries them without learning anything new. The block format
 * is what selection-marks.ts parses back: tag, label/tone attributes, body
 * for the model.
 */

import type { BrowserSelection } from "@/types/electron";
import { TONE_HUES, toneForLabel } from "@shared/selection-tones";

let seq = 0;
const nextId = (): string => `ref-${Date.now()}-${++seq}`;

/** toneForLabel is a raw hash; the block attribute carries the palette SLOT
 * (small, stable, greppable) like the browser's own tone attribute does. */
const slotFor = (label: string): number => toneForLabel(label) % TONE_HUES.length;

/** Labels live inside ⟨…⟩ tokens: no angle quotes, no newlines, bounded. */
function cleanLabel(label: string): string {
  return label.replace(/[⟨⟩\n]/g, " ").trim().slice(0, 60) || "reference";
}

function attr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

/** A block body must not be able to end its own envelope early. */
function escapeBody(text: string, tag: string): string {
  return text.replace(new RegExp(`</${tag}>`, "gi"), (m) =>
    m.replace(/</g, "&lt;"),
  );
}

/** Lines start–end of a file, selected in the viewer. */
export function codeRef(opts: {
  path: string;
  name: string;
  startLine: number;
  endLine: number;
  snippet: string;
}): BrowserSelection {
  const range =
    opts.endLine > opts.startLine
      ? `${opts.startLine}-${opts.endLine}`
      : String(opts.startLine);
  const label = cleanLabel(`${opts.name}:${range}`);
  const tone = slotFor(label);
  return {
    id: nextId(),
    label,
    count: 1,
    tone,
    url: "",
    context: [
      `<referenced-code label="${attr(label)}" file="${attr(opts.path)}" lines="${range}" tone="${tone}">`,
      escapeBody(opts.snippet, "referenced-code"),
      `</referenced-code>`,
    ].join("\n"),
  };
}

/** A workspace file, @-mentioned in the composer. */
export function fileRef(path: string, name: string): BrowserSelection {
  const label = cleanLabel(name);
  const tone = slotFor(label);
  return {
    id: nextId(),
    label,
    count: 1,
    tone,
    url: "",
    // The path is the payload — the model reads the file itself.
    context: [
      `<referenced-file label="${attr(label)}" path="${attr(path)}" tone="${tone}">`,
      `The user referenced this workspace file: ${escapeBody(path, "referenced-file")}`,
      `</referenced-file>`,
    ].join("\n"),
    pretokenised: true,
  };
}

/** Another chat session, @-mentioned in the composer. */
export function chatRef(id: string, title: string): BrowserSelection {
  const label = cleanLabel(title || "chat");
  const tone = slotFor(label);
  return {
    id: nextId(),
    label,
    count: 1,
    tone,
    url: "",
    context: [
      `<referenced-chat label="${attr(label)}" id="${attr(id)}" tone="${tone}">`,
      `The user referenced another chat in this app titled "${escapeBody(title, "referenced-chat")}" (session id ${id}).`,
      `</referenced-chat>`,
    ].join("\n"),
    pretokenised: true,
  };
}

/**
 * Which source lines a DOM selection covers, by the data-ln attributes
 * HighlightedCode stamps on its rows. Null when the selection is collapsed
 * or reaches outside `host`. Shared by the viewer's "Add to chat" and its
 * probe — the probe must test the code the button runs.
 */
export function selectionLineRange(
  host: HTMLElement,
  sel: Selection | null,
): { start: number; end: number } | null {
  if (!sel || sel.isCollapsed) return null;
  if (!host.contains(sel.anchorNode) || !host.contains(sel.focusNode))
    return null;
  const lnOf = (n: Node | null): number | null => {
    const el = n instanceof Element ? n : n?.parentElement;
    const row = el?.closest("[data-ln]");
    return row ? Number((row as HTMLElement).dataset.ln) : null;
  };
  const a = lnOf(sel.anchorNode);
  const f = lnOf(sel.focusNode);
  if (a == null || f == null) return null;
  return { start: Math.min(a, f), end: Math.max(a, f) };
}
