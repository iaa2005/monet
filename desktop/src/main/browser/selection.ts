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
import { getBrowserConfig } from "./config.js";
import { getWorkspacePath } from "../ipc/workspace.js";
import { getTransport } from "./transport.js";
import type { BrowserTransport } from "./transport.js";
import { clearDesignOn, setToneBase, type InspectMessage } from "./inspect.js";

/** What the renderer receives — one chip in the composer. */
export interface BrowserSelection {
  id: string;
  /** Chip label, e.g. "<SaveButton>". */
  label: string;
  /** How many elements it covers, for a "+2" badge. */
  count: number;
  /**
   * Which colour this element wears — the SAME number the box on the page is
   * drawn with, so the chip and the outline are recognisably one thing. See
   * shared/selection-tones.ts.
   */
  tone: number;
  /** Restored by a rewind: its ⟨token⟩ is already in the text. */
  pretokenised?: boolean;
  /** The block appended to the user's message. */
  context: string;
  /** PNG data URL of the crop, shown on the chip and attached on send. */
  imageDataUrl?: string;
  url: string;
}

/** The last full-viewport frame, taken when a shift-drag began. */
const frozen = new Map<string, Buffer>();

let seq = 0;
/**
 * Where the palette stands.
 *
 * Colour is per SELECTION, not per selection-event: click three elements one
 * after another and you want three different chips, which means the counter has
 * to outlive the payload that produced it.
 */
let toneCursor = 0;

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
/** How long the whole candidate hunt may take before the chip goes without. */
const CANDIDATE_BUDGET_MS = 1_200;

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
        // The hint is worth a moment, not a minute: honouring ignore files
        // and skipping dependency folders took one search from 20 SECONDS to
        // well under one on the same workspace. Nine of them run per pick.
        respect_ignore: true,
        timeout_ms: 900,
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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A viewport-relative box with padding, kept inside the viewport. */
function padded(
  rect: { x: number; y: number; w: number; h: number },
  viewport: { w: number; h: number },
  pad = 16,
): Box {
  // An element cropped to its own edges loses the spacing and the neighbours
  // that usually make it worth pointing at.
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  return {
    x,
    y,
    width: Math.max(1, Math.min(rect.w + pad * 2, viewport.w - x)),
    height: Math.max(1, Math.min(rect.h + pad * 2, viewport.h - y)),
  };
}

/**
 * Cut a region out of a frame that was captured earlier.
 *
 * The scale is measured from the image rather than taken from
 * devicePixelRatio: the two agree right up until they don't (a window dragged
 * between monitors, a zoom level), and a wrong factor here crops a plausible
 * picture of the wrong thing — the kind of error that looks like a feature
 * working badly rather than a bug.
 */
function cropFrame(png: Buffer, box: Box, viewportWidth: number): string | undefined {
  try {
    const img = nativeImage.createFromBuffer(png);
    const size = img.getSize();
    if (size.width === 0 || viewportWidth === 0) return undefined;
    const scale = size.width / viewportWidth;
    const x = Math.max(0, Math.min(Math.round(box.x * scale), size.width - 1));
    const y = Math.max(0, Math.min(Math.round(box.y * scale), size.height - 1));
    return img
      .crop({
        x,
        y,
        width: Math.max(1, Math.min(Math.round(box.width * scale), size.width - x)),
        height: Math.max(1, Math.min(Math.round(box.height * scale), size.height - y)),
      })
      .toDataURL();
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

  const viewport = {
    w: payload.viewport?.w || 1280,
    h: payload.viewport?.h || 800,
  };

  // Candidates for the first few elements only: three ripgreps per element
  // adds up, and a selection of eight is about relationships anyway.
  const candidatesByIndex: Record<number, string[]> = {};
  // Bounded, because this is a nicety: the chip is about the element the user
  // clicked, and "which file might define it" is a hint on top. Without the
  // cap a slow search — or a workspace with no ripgrep, where the fallback
  // reads the whole tree in the main process — held the chip for as long as
  // it took. Reported as "selecting an element takes forever, or never
  // finishes at all".
  await Promise.race([
    Promise.all(
      payload.elements.slice(0, 3).map(async (el, i) => {
        const files = await candidateFiles(el);
        if (files.length) candidatesByIndex[i] = files;
      }),
    ),
    new Promise((r) => setTimeout(r, CANDIDATE_BUDGET_MS)),
  ]);

  const context = formatSelection(payload, candidatesByIndex, {
    browserToolsEnabled: getBrowserConfig().enabled,
    // The same slot the box on the page is drawn with — see selection-tones.
    tone: toneCursor,
  });

  // The picture: the marked region if there is one, else the first element.
  let imageDataUrl: string | undefined;
  const held = frozen.get(t.targetId);
  try {
    if (payload.region) {
      const box = {
        x: payload.region.x,
        y: payload.region.y,
        width: payload.region.w,
        height: payload.region.h,
      };
      // A region has a frame held from the moment the drag began — that is the
      // state the user was annotating. Only fall back to a fresh capture if
      // holding it failed.
      imageDataUrl = held
        ? cropFrame(held, box, viewport.w)
        : `data:image/png;base64,${(await t.screenshot(box)).toString("base64")}`;
    } else if (payload.elements[0]) {
      const box = padded(payload.elements[0].rect, viewport);
      const png = await t.screenshot(box);
      imageDataUrl = `data:image/png;base64,${png.toString("base64")}`;
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
    tone: toneCursor,
    context,
    imageDataUrl,
    url: payload.url,
  };
  // Each selection takes the next colour, and the page is told where the
  // palette now stands so the box it draws next matches the chip it becomes.
  toneCursor += Math.max(1, payload.elements.length);
  void setToneBase(t, toneCursor);

  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send("browser:selection", selection);
}

/** Route one message from the page's overlay. */
export async function onInspectMessage(msg: InspectMessage): Promise<void> {
  const t = await getTransport();
  if (msg.type === "freeze") return freezeFrame(t);
  if (msg.type === "selection") return handleSelection(t, msg.data);
  if (msg.type === "exit") {
    // Main's flag too — not just the renderer's. Leaving it set re-arms the
    // overlay on the next navigation, which then swallows every click.
    clearDesignOn(t.targetId);
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send("browser:designMode", false);
  }
}
