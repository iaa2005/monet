/**
 * A clicked element becomes something the model can act on.
 *
 * The page sends what it can see (identity, styles, props). Main adds the two
 * things only it can: a picture of the element, and — the part that actually
 * saves the model a search — candidate source files, found by grepping the
 * workspace for the element's own visible text and component name.
 *
 * Without that last step the model gets a perfect description of a button and
 * still has to guess which of forty files draws it.
 */

import { BrowserWindow, nativeImage } from "electron";
import {
  formatSelection,
  summarizeElement,
  searchTermsFor,
  type RawElement,
  type SelectionPayload,
} from "./element-context.js";
import { ripGrep } from "../agent/ripgrep.js";
import { getWorkspacePath } from "../ipc/workspace.js";
import { getTransport } from "./transport.js";
import type { BrowserTransport } from "./transport.js";
import type { InspectMessage } from "./inspect.js";

/** What the renderer receives — one chip in the composer. */
export interface BrowserSelection {
  id: string;
  /** Chip label, e.g. "<SaveButton>". */
  label: string;
  /** How many elements it covers, for a "+2" badge. */
  count: number;
  /** The block appended to the user's message. */
  context: string;
  /** PNG data URL of the crop, shown on the chip and attached on send. */
  imageDataUrl?: string;
  url: string;
}

/** The last full-viewport frame, taken when a shift-drag began. */
const frozen = new Map<string, Buffer>();

let seq = 0;

/** Keep a frame from the moment the user started annotating. */
export async function freezeFrame(t: BrowserTransport): Promise<void> {
  try {
    frozen.set(t.targetId, await t.screenshot());
  } catch {
    /* a crop from a live capture is still better than nothing */
  }
}

/**
 * Up to `max` files that plausibly contain this element.
 *
 * Terms are tried in order of how distinctive they are (see searchTermsFor)
 * and the search stops at the first that finds something: a component name
 * that matches forty files is worse than the text that matches one.
 */
async function candidateFiles(el: RawElement, max = 3): Promise<string[]> {
  const workspace = getWorkspacePath();
  if (!workspace) return [];
  for (const term of searchTermsFor(el).slice(0, 3)) {
    try {
      const res = await ripGrep({
        pattern: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        path: workspace,
        output_mode: "files_with_matches",
        head_limit: max + 2,
        "-i": false,
      });
      const files = res.lines
        .map((l) => l.trim())
        .filter(Boolean)
        // A term that matches everywhere is not a lead.
        .slice(0, max);
      if (files.length > 0 && files.length <= max)
        return files.map((f) =>
          f.startsWith(workspace) ? f.slice(workspace.length + 1) : f,
        );
    } catch {
      /* no ripgrep, or a pattern it disliked — try the next term */
    }
  }
  return [];
}

/** Crop a PNG to a document-relative rect, with a little breathing room. */
function crop(
  png: Buffer,
  rect: { x: number; y: number; w: number; h: number },
  scrollOffset: { x: number; y: number },
  dpr: number,
  pad = 16,
): string | undefined {
  try {
    const img = nativeImage.createFromBuffer(png);
    const size = img.getSize();
    if (size.width === 0) return undefined;
    // The capture is in device pixels; the page measures in CSS pixels.
    const x = Math.round((rect.x - scrollOffset.x - pad) * dpr);
    const y = Math.round((rect.y - scrollOffset.y - pad) * dpr);
    const w = Math.round((rect.w + pad * 2) * dpr);
    const h = Math.round((rect.h + pad * 2) * dpr);
    const clamped = {
      x: Math.max(0, Math.min(x, size.width - 1)),
      y: Math.max(0, Math.min(y, size.height - 1)),
      width: Math.max(1, Math.min(w, size.width)),
      height: Math.max(1, Math.min(h, size.height)),
    };
    clamped.width = Math.min(clamped.width, size.width - clamped.x);
    clamped.height = Math.min(clamped.height, size.height - clamped.y);
    return img.crop(clamped).toDataURL();
  } catch {
    return undefined;
  }
}

/** Build the chip for what the user just selected, and send it to the composer. */
export async function handleSelection(
  t: BrowserTransport,
  data: Record<string, unknown>,
): Promise<void> {
  const payload = data as unknown as SelectionPayload;
  if (!payload?.elements) return;

  const dpr = payload.viewport?.dpr || 1;

  // Candidates for the first few elements only: three ripgreps per element
  // adds up, and a selection of eight is about relationships anyway.
  const candidatesByIndex: Record<number, string[]> = {};
  await Promise.all(
    payload.elements.slice(0, 3).map(async (el, i) => {
      const files = await candidateFiles(el);
      if (files.length) candidatesByIndex[i] = files;
    }),
  );

  const context = formatSelection(payload, candidatesByIndex);

  // The picture: the marked region if there is one, else the first element.
  let imageDataUrl: string | undefined;
  const held = frozen.get(t.targetId);
  const scrollOffset = scrollFrom(payload);
  try {
    if (payload.region) {
      const png = held ?? (await t.screenshot());
      imageDataUrl = crop(png, payload.region, scrollOffset, dpr, 0);
    } else if (payload.elements[0]) {
      const first = payload.elements[0];
      const png = await t.screenshot();
      imageDataUrl = crop(
        png,
        first.pageRect ?? { ...first.rect },
        first.pageRect ? scrollOffset : { x: 0, y: 0 },
        dpr,
      );
    }
  } catch {
    /* a selection without a picture is still worth sending */
  }
  frozen.delete(t.targetId);

  const first = payload.elements[0];
  const selection: BrowserSelection = {
    id: `sel-${Date.now().toString(36)}-${++seq}`,
    label: payload.region && !first ? "marked region" : first ? summarizeElement(first) : "page",
    count: payload.elements.length,
    context,
    imageDataUrl,
    url: payload.url,
  };

  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send("browser:selection", selection);
}

/**
 * How far the page is scrolled, derived from an element's two rects.
 *
 * The page sends both viewport- and document-relative boxes, so the difference
 * IS the scroll offset — no extra round trip to ask for it, and no chance of
 * asking after the page has scrolled again.
 */
function scrollFrom(payload: SelectionPayload): { x: number; y: number } {
  const el = payload.elements[0];
  if (!el?.pageRect) return { x: 0, y: 0 };
  return { x: el.pageRect.x - el.rect.x, y: el.pageRect.y - el.rect.y };
}

/** Route one message from the page's overlay. */
export async function onInspectMessage(msg: InspectMessage): Promise<void> {
  const t = await getTransport();
  if (msg.type === "freeze") return freezeFrame(t);
  if (msg.type === "selection") return handleSelection(t, msg.data);
  if (msg.type === "exit")
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send("browser:designMode", false);
}
