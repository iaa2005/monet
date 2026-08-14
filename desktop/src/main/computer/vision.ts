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
import { captureScreen, type Screenshot } from "./screen.js";
import { detectIcons, ensureIconDetector, hasIconDetector } from "./omniparser.js";
import { ensureScreenOcr, hasScreenOcr, ppocrImageText } from "./ppocr.js";
import { readImageText, type OcrLine } from "./winocr.js";
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

  // Full resolution: the detector letterboxes down to 1280 regardless, but
  // OCR reads small UI text at half quality from a downscaled capture.
  const shot = await captureScreen(undefined, Number.MAX_SAFE_INTEGER);
  try {
    const [icons, lines] = await Promise.all([
      detectIcons(shot.png),
      readScreenLines(shot),
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
  }
}

/**
 * The words on the screen. PP-OCR (det + eslav rec, ppocr.ts) is the primary —
 * it reads Cyrillic UI text properly. Windows.Media.Ocr stays as the fallback
 * for a machine where the models could not be fetched: worse text is still
 * better than none.
 */
async function readScreenLines(shot: Screenshot): Promise<OcrLine[]> {
  if (!hasScreenOcr()) await ensureScreenOcr();
  if (hasScreenOcr()) {
    try {
      return await ppocrImageText(shot.png);
    } catch {
      /* fall through to the OS engine */
    }
  }
  const tmp = join(app.getPath("temp"), `monet-vision-${process.pid}.png`);
  await writeFile(tmp, shot.png);
  try {
    return await readImageText(tmp);
  } finally {
    void unlink(tmp).catch(() => {});
  }
}
