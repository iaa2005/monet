/**
 * OmniParser v2 icon detector — the fallback eyes for Computer Use.
 *
 * UIA answers for most windows, but not all: canvas-drawn apps, games, and
 * Chromium windows whose accessibility tree never woke up return nothing.
 * For those the screen is parsed visually: this YOLOv8n fine-tune (exported
 * in onnx-lab/scripts/export_omniparser_detect.py, published on the iaa2005
 * mirror) finds the interactive things — icons, buttons, controls — as boxes.
 * Text labels come separately from Windows OCR (winocr.ts) and the merge
 * lives in vision.ts.
 *
 * The reference implementation for the letterbox/decode/NMS below is
 * onnx-lab/scripts/verify_omniparser.py — if they disagree, that one is right.
 *
 * Runs on the app's own onnxruntime via ocr/ort.js (one ORT per process —
 * see that file for why). ~12 MB of weights, fetched on first use with the
 * OCR module's resuming downloader.
 */

import { nativeImage } from "electron";
import { join } from "path";
import { statSync } from "fs";
import { ocrModelsDir } from "../ocr/settings.js";
import { installLayoutModel } from "../ocr/install.js";
import { ort } from "../ocr/ort.js";

export const ICON_REPO = "iaa2005/OmniParser-v2-icon-detect-ONNX";
export const ICON_FILE = "model.onnx";

/** Trained at 1280 (train_args.yaml) — desktop icons are small; 640 loses them. */
const SIZE = 1280;
const CONF = 0.15;
const IOU = 0.45;
const MAX_BOXES = 150;

export interface IconBox {
  /** Box in the SOURCE image's pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

function modelPath(): string {
  return join(ocrModelsDir(), ...ICON_REPO.split("/"), ICON_FILE);
}

export function hasIconDetector(): boolean {
  try {
    return statSync(modelPath()).size > 0;
  } catch {
    return false;
  }
}

/** Fetch the weights if they are not on disk yet (12 MB, resumable). */
export async function ensureIconDetector(): Promise<{ ok: boolean; error?: string }> {
  if (hasIconDetector()) return { ok: true };
  return installLayoutModel(ICON_REPO, ICON_FILE, () => {});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let session: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSession(): Promise<any> {
  if (session) return session;
  session = await ort().InferenceSession.create(modelPath(), {
    executionProviders: ["cpu"],
  });
  return session;
}

function nms(boxes: IconBox[]): IconBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep: IconBox[] = [];
  for (const b of sorted) {
    let dead = false;
    for (const k of keep) {
      const x1 = Math.max(b.x, k.x);
      const y1 = Math.max(b.y, k.y);
      const x2 = Math.min(b.x + b.w, k.x + k.w);
      const y2 = Math.min(b.y + b.h, k.y + k.h);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const iou = inter / (b.w * b.h + k.w * k.h - inter + 1e-9);
      if (iou > IOU) {
        dead = true;
        break;
      }
    }
    if (!dead) keep.push(b);
    if (keep.length >= MAX_BOXES) break;
  }
  return keep;
}

/**
 * Detect interactive elements on a PNG screenshot. Boxes come back in the
 * image's own pixel space — the caller owns any mapping to screen pixels.
 */
export async function detectIcons(png: Buffer): Promise<IconBox[]> {
  const img = nativeImage.createFromBuffer(png);
  const { width: iw, height: ih } = img.getSize();
  if (!iw || !ih) throw new Error("empty image");

  // Letterbox onto a grey SIZE x SIZE canvas, centred — verify_omniparser.py.
  const scale = Math.min(SIZE / iw, SIZE / ih);
  const nw = Math.round(iw * scale);
  const nh = Math.round(ih * scale);
  const dx = Math.floor((SIZE - nw) / 2);
  const dy = Math.floor((SIZE - nh) / 2);
  const bgra = img.resize({ width: nw, height: nh }).toBitmap();

  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane).fill(114 / 255);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const s = (y * nw + x) * 4; // BGRA
      const d = (y + dy) * SIZE + (x + dx);
      input[d] = bgra[s + 2] / 255; // R
      input[plane + d] = bgra[s + 1] / 255; // G
      input[2 * plane + d] = bgra[s] / 255; // B
    }
  }

  const sess = await getSession();
  const runtime = ort();
  const feeds: Record<string, unknown> = {
    [sess.inputNames[0]]: new runtime.Tensor("float32", input, [1, 3, SIZE, SIZE]),
  };
  const results = await sess.run(feeds);
  const out = results[sess.outputNames[0]];
  // (1, 5, N): cx, cy, w, h, conf — single class, already sigmoided.
  const n = out.dims[2] as number;
  const d = out.data as Float32Array;

  const raw: IconBox[] = [];
  for (let i = 0; i < n; i++) {
    const score = d[4 * n + i];
    if (score < CONF) continue;
    const cx = d[i];
    const cy = d[n + i];
    const w = d[2 * n + i];
    const h = d[3 * n + i];
    // Undo the letterbox back into source-image pixels.
    const x1 = Math.max(0, (cx - w / 2 - dx) / scale);
    const y1 = Math.max(0, (cy - h / 2 - dy) / scale);
    const x2 = Math.min(iw, (cx + w / 2 - dx) / scale);
    const y2 = Math.min(ih, (cy + h / 2 - dy) / scale);
    if (x2 - x1 < 2 || y2 - y1 < 2) continue;
    raw.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, score });
  }
  return nms(raw);
}
