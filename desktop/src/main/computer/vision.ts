/**
 * The vision fallback, assembled: screenshot -> OmniParser icon boxes +
 * Windows OCR text lines -> one merged element inventory in SCREEN pixels,
 * shaped exactly like the UIA scan so computer-tools can serve either.
 *
 * The merge is OmniParser's own recipe: an OCR line whose centre falls inside
 * an icon box becomes that box's label; lines claimed by no box are clickable
 * text in their own right (links, menu entries, list rows).
 */

import { app } from "electron";
import { unlink, writeFile } from "fs/promises";
import { join } from "path";
import { captureScreen } from "./screen.js";
import { detectIcons, ensureIconDetector, hasIconDetector } from "./omniparser.js";
import { readImageText } from "./winocr.js";
import type { UiElement } from "./elements.js";

export interface VisionScanResult {
  ok: boolean;
  elements?: UiElement[];
  error?: string;
}

/** Longest label a blind model needs; OCR can run to paragraphs. */
const MAX_LABEL = 80;

export async function visionScreenElements(): Promise<VisionScanResult> {
  if (!hasIconDetector()) {
    const r = await ensureIconDetector();
    if (!r.ok)
      return {
        ok: false,
        error: `icon detector not available: ${r.error ?? "download failed"}`,
      };
  }

  const shot = await captureScreen();
  const tmp = join(app.getPath("temp"), `monet-vision-${process.pid}.png`);
  await writeFile(tmp, shot.png);
  try {
    const [icons, lines] = await Promise.all([
      detectIcons(shot.png),
      readImageText(tmp),
    ]);

    // Assign each OCR line to the smallest icon box containing its centre —
    // the smallest, because a big container box (a card, a dialog) would
    // otherwise swallow every label inside it.
    const claimed = new Set<number>();
    const labels = new Map<number, string[]>();
    lines.forEach((line, li) => {
      const cx = line.x + line.w / 2;
      const cy = line.y + line.h / 2;
      let best = -1;
      let bestArea = Infinity;
      icons.forEach((b, bi) => {
        const area = b.w * b.h;
        if (
          cx >= b.x &&
          cx <= b.x + b.w &&
          cy >= b.y &&
          cy <= b.y + b.h &&
          area < bestArea
        ) {
          best = bi;
          bestArea = area;
        }
      });
      if (best >= 0) {
        claimed.add(li);
        const list = labels.get(best) ?? [];
        list.push(line.t);
        labels.set(best, list);
      }
    });

    // Image pixels -> virtual-desktop pixels, the space clicks act in.
    const toScreen = (x: number, y: number, w: number, h: number) => ({
      x: Math.round(shot.region.x + x * shot.scaleX),
      y: Math.round(shot.region.y + y * shot.scaleY),
      w: Math.round(w * shot.scaleX),
      h: Math.round(h * shot.scaleY),
    });

    const elements: UiElement[] = [];
    icons.forEach((b, bi) => {
      const label = (labels.get(bi) ?? []).join(" ").slice(0, MAX_LABEL);
      elements.push({ n: label, t: label ? "Button" : "Icon", ...toScreen(b.x, b.y, b.w, b.h) });
    });
    lines.forEach((line, li) => {
      if (claimed.has(li)) return;
      elements.push({
        n: line.t.slice(0, MAX_LABEL),
        t: "Text",
        ...toScreen(line.x, line.y, line.w, line.h),
      });
    });
    // Reading order, roughly: by rows, then left to right.
    elements.sort((a, b) => (Math.abs(a.y - b.y) > 20 ? a.y - b.y : a.x - b.x));

    return { ok: true, elements };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    void unlink(tmp).catch(() => {});
  }
}
