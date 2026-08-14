/**
 * PP-OCR for the vision fallback — the words, done properly.
 *
 * Windows.Media.Ocr was the free first cut and it mangled Cyrillic UI text
 * badly enough to mislead a blind model. This is the classic PaddleOCR
 * pipeline on the app's own onnxruntime: PP-OCRv3 mobile DB detection
 * (2.4 MB, script-agnostic) + eslav_PP-OCRv5_mobile recognition (7.9 MB,
 * Russian/Ukrainian/Belarusian + Latin + digits) with CTC over dict.txt.
 * ~2 s for a full 2560-class screenshot, ~100 lines.
 *
 * The reference implementation is onnx-lab/scripts/verify_ppocr.py — same
 * contract as the icon detector: if the two disagree, the Python is right.
 * The DB postprocess is deliberately simplified for SCREEN text: axis-aligned
 * connected components padded by the unclip heuristic. Screen text is never
 * rotated; min-area rectangles and polygon clipping earn nothing here.
 */

import { nativeImage } from "electron";
import { join } from "path";
import { readFileSync, statSync } from "fs";
import { ocrModelsDir } from "../ocr/settings.js";
import { installLayoutModel } from "../ocr/install.js";
import { ort } from "../ocr/ort.js";
import type { OcrLine } from "./winocr.js";

export const SCREEN_OCR_REPO = "iaa2005/PP-OCR-screen-eslav-ONNX";
export const SCREEN_OCR_FILES = ["det.onnx", "rec.onnx", "dict.txt"] as const;

const DET_LIMIT = 1920; // limit_side_len for a desktop screenshot
const DET_THRESH = 0.3;
const BOX_THRESH = 0.5;
const UNCLIP = 1.8;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const REC_H = 48;
// The rec graph's width is dynamic; this only bounds worst-case cost. A wide
// paragraph line needs ~2.4x its pixel width at h=48 — a small cap squeezes
// it and CTC returns single letters (measured in verify_ppocr.py).
const REC_MAX_W = 2048;

function filePath(name: string): string {
  return join(ocrModelsDir(), ...SCREEN_OCR_REPO.split("/"), name);
}

export function hasScreenOcr(): boolean {
  try {
    return SCREEN_OCR_FILES.every((f) => statSync(filePath(f)).size > 0);
  } catch {
    return false;
  }
}

/** Fetch det+rec+dict if missing (10 MB total, resumable). */
export async function ensureScreenOcr(): Promise<{ ok: boolean; error?: string }> {
  for (const f of SCREEN_OCR_FILES) {
    try {
      if (statSync(filePath(f)).size > 0) continue;
    } catch {
      /* missing — install below */
    }
    const r = await installLayoutModel(SCREEN_OCR_REPO, f, () => {});
    if (!r.ok) return r;
  }
  return { ok: true };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let detSession: any = null;
let recSession: any = null;
let charset: string[] | null = null;

async function sessions(): Promise<{ det: any; rec: any; chars: string[] }> {
  if (!detSession)
    detSession = await ort().InferenceSession.create(filePath("det.onnx"), {
      executionProviders: ["cpu"],
    });
  if (!recSession)
    recSession = await ort().InferenceSession.create(filePath("rec.onnx"), {
      executionProviders: ["cpu"],
    });
  if (!charset) {
    charset = readFileSync(filePath("dict.txt"), "utf-8").split(/\r?\n/);
    if (!charset.includes(" ")) charset.push(" "); // use_space_char
  }
  return { det: detSession, rec: recSession, chars: charset };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** BGRA bitmap of an image resized to exactly w x h. */
function bitmapAt(img: Electron.NativeImage, w: number, h: number): Buffer {
  return img.resize({ width: w, height: h }).toBitmap();
}

/** Normalized CHW float input from BGRA, (x/255 - mean) / std per channel. */
function detTensor(bgra: Buffer, w: number, h: number): Float32Array {
  const plane = w * h;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const s = i * 4;
    out[i] = (bgra[s + 2] / 255 - MEAN[0]) / STD[0];
    out[plane + i] = (bgra[s + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * plane + i] = (bgra[s] / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Axis-aligned boxes of connected components over the binarised probability
 * map, DB-style unclip padding. Mirrors verify_ppocr.py's connected_boxes. */
function connectedBoxes(probs: Float32Array, w: number, h: number): Box[] {
  const labels = new Int32Array(w * h);
  const boxes: Box[] = [];
  const stack: number[] = [];
  let next = 0;
  for (let start = 0; start < w * h; start++) {
    if (probs[start] <= DET_THRESH || labels[start]) continue;
    next++;
    labels[start] = next;
    stack.push(start);
    let x1 = start % w;
    let x2 = x1;
    let y1 = (start / w) | 0;
    let y2 = y1;
    let count = 0;
    let score = 0;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p / w) | 0;
      count++;
      score += probs[p];
      if (px < x1) x1 = px;
      if (px > x2) x2 = px;
      if (py < y1) y1 = py;
      if (py > y2) y2 = py;
      // 4-neighbourhood
      if (px > 0 && probs[p - 1] > DET_THRESH && !labels[p - 1]) {
        labels[p - 1] = next;
        stack.push(p - 1);
      }
      if (px + 1 < w && probs[p + 1] > DET_THRESH && !labels[p + 1]) {
        labels[p + 1] = next;
        stack.push(p + 1);
      }
      if (py > 0 && probs[p - w] > DET_THRESH && !labels[p - w]) {
        labels[p - w] = next;
        stack.push(p - w);
      }
      if (py + 1 < h && probs[p + w] > DET_THRESH && !labels[p + w]) {
        labels[p + w] = next;
        stack.push(p + w);
      }
    }
    if (count < 12 || score / count < BOX_THRESH) continue;
    const bw = x2 - x1 + 1;
    const bh = y2 - y1 + 1;
    const pad = Math.round((bw * bh * UNCLIP) / (2 * (bw + bh)));
    boxes.push({ x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad });
  }
  return boxes;
}

function ctcDecode(logits: Float32Array, steps: number, classes: number, chars: string[]): string {
  let out = "";
  let prev = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bestV = -Infinity;
    const base = t * classes;
    for (let c = 0; c < classes; c++) {
      const v = logits[base + c];
      if (v > bestV) {
        bestV = v;
        best = c;
      }
    }
    if (best !== 0 && best !== prev && best - 1 < chars.length) out += chars[best - 1];
    prev = best;
  }
  return out;
}

/** Read every text line on a PNG screenshot. Coordinates in the image's own
 * pixels — the same contract as winocr's readImageText. */
export async function ppocrImageText(png: Buffer): Promise<OcrLine[]> {
  const { det, rec, chars } = await sessions();
  const runtime = ort();
  const img = nativeImage.createFromBuffer(png);
  const { width: iw, height: ih } = img.getSize();
  if (!iw || !ih) return [];

  // Detection at a bounded, /32-aligned size.
  const ratio = Math.min(1, DET_LIMIT / Math.max(iw, ih));
  const nw = Math.max(32, Math.round((iw * ratio) / 32) * 32);
  const nh = Math.max(32, Math.round((ih * ratio) / 32) * 32);
  const input = detTensor(bitmapAt(img, nw, nh), nw, nh);
  const detOut = await det.run({
    [det.inputNames[0]]: new runtime.Tensor("float32", input, [1, 3, nh, nw]),
  });
  const probs = detOut[det.outputNames[0]].data as Float32Array;
  const boxes = connectedBoxes(probs, nw, nh);

  const rx = iw / nw;
  const ry = ih / nh;
  const lines: OcrLine[] = [];
  for (const b of boxes) {
    // Back to source pixels; crop there — full resolution for recognition.
    const sx = Math.max(0, Math.round(b.x1 * rx));
    const sy = Math.max(0, Math.round(b.y1 * ry));
    const sw = Math.min(iw - sx, Math.round((b.x2 - b.x1 + 1) * rx));
    const sh = Math.min(ih - sy, Math.round((b.y2 - b.y1 + 1) * ry));
    if (sw < 4 || sh < 4) continue;
    const cw = Math.min(REC_MAX_W, Math.max(16, Math.round((sw * REC_H) / sh)));
    const crop = img.crop({ x: sx, y: sy, width: sw, height: sh });
    const bgra = bitmapAt(crop, cw, REC_H);
    const plane = cw * REC_H;
    const recIn = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      const s = i * 4;
      recIn[i] = (bgra[s + 2] / 255 - 0.5) / 0.5;
      recIn[plane + i] = (bgra[s + 1] / 255 - 0.5) / 0.5;
      recIn[2 * plane + i] = (bgra[s] / 255 - 0.5) / 0.5;
    }
    const recOut = await rec.run({
      [rec.inputNames[0]]: new runtime.Tensor("float32", recIn, [1, 3, REC_H, cw]),
    });
    const t = recOut[rec.outputNames[0]];
    const [, steps, classes] = t.dims as number[];
    const text = ctcDecode(t.data as Float32Array, steps, classes, chars).trim();
    if (text) lines.push({ t: text, x: sx, y: sy, w: sw, h: sh });
  }
  return lines;
}
