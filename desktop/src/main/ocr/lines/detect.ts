/**
 * Where the LINES are, as polygons rather than boxes.
 *
 * The layout detector answers "this rectangle is a paragraph". That is the
 * right unit for reading a page, and the wrong one for two questions it
 * cannot answer: how crooked is this scan, and what shape exactly is this
 * figure. A rectangle around a line of text tilted five degrees contains
 * most of the lines above and below it.
 *
 * PP-OCRv5's mobile text detector — 4.6 MB — answers both. It is a DB
 * model: it outputs a probability map, and the polygons come from
 * thresholding it, finding the islands, and fitting a minimum-area
 * rectangle to each (see geometry.ts, which is the OpenCV part written
 * out). What comes back is a quadrilateral per line, at whatever angle the
 * line actually sits.
 *
 * Two uses, both cheap once the polygons exist:
 *   - the median line angle is the page's skew, which is how a scan that is
 *     three degrees off can be straightened before anything reads it;
 *   - a figure's polygon crops with a mask instead of a box, so a diagram
 *     does not arrive with its neighbours' text in the corners.
 */

import { join } from "path";
import { ocrModelsDir } from "../settings.js";
import { ort } from "../ort.js";
import {
  boundingBox,
  connectedComponents,
  minAreaRect,
  pageSkew,
  unclip,
  type Quad,
} from "./geometry.js";

export const DET_REPO = "iaa2005/PP-OCRv5_mobile_det_onnx";
export const DET_FILE = "inference.onnx";

export function detModelPath(): string {
  return join(ocrModelsDir(), ...DET_REPO.split("/"), DET_FILE);
}

/** From the model's own inference.yml — changing these is changing the
 * model, not tuning it. */
const LONG_SIDE = 960;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const MAP_THRESHOLD = 0.3;
const BOX_THRESHOLD = 0.6;
const UNCLIP_RATIO = 1.5;

export interface TextLine {
  quad: Quad;
  box: [number, number, number, number];
  /** Degrees, positive clockwise, folded into ±90. */
  angle: number;
  score: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let session: any = null;
let sessionDevice = "";

export function disposeLineDetector(): void {
  session = null;
  sessionDevice = "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSession(device: string): Promise<any> {
  if (session && sessionDevice === device) return session;
  session = await ort().InferenceSession.create(detModelPath(), {
    executionProviders: [device === "webgpu" ? "webgpu" : "cpu"],
  });
  sessionDevice = device;
  return session;
}

/** Both sides rounded to a multiple of 32, long side capped — what the
 * model's DetResizeForTest does. */
export function detInputSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(1, LONG_SIDE / Math.max(width, height));
  const round32 = (n: number): number => Math.max(32, Math.round(n / 32) * 32);
  return { width: round32(width * scale), height: round32(height * scale) };
}

/**
 * Lines on a page, as polygons.
 *
 * `rgb` must already be at `width × height`; the caller resizes, because it
 * is the one with a canvas.
 */
export async function detectLines(
  rgb: Uint8Array,
  width: number,
  height: number,
  pageWidth: number,
  pageHeight: number,
  device = "cpu",
): Promise<TextLine[]> {
  const runtime = ort();
  const s = await getSession(device);

  const area = width * height;
  const data = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    // The config says BGR, and it means it: fed RGB, the map is weaker
    // everywhere and short lines disappear from it entirely.
    data[i] = (rgb[i * 3 + 2] / 255 - MEAN[0]) / STD[0];
    data[area + i] = (rgb[i * 3 + 1] / 255 - MEAN[1]) / STD[1];
    data[2 * area + i] = (rgb[i * 3] / 255 - MEAN[2]) / STD[2];
  }

  const out = await s.run({
    [s.inputNames[0]]: new runtime.Tensor("float32", data, [1, 3, height, width]),
  });
  const map = out[s.outputNames[0]].data as Float32Array;

  // Threshold, then find the islands. The map is [1, 1, H, W].
  const mask = new Uint8Array(area);
  for (let i = 0; i < area; i++) mask[i] = map[i] > MAP_THRESHOLD ? 1 : 0;

  const scaleX = pageWidth / width;
  const scaleY = pageHeight / height;
  const lines: TextLine[] = [];

  for (const pixels of connectedComponents(mask, width, height, 12)) {
    // The region's own confidence: how strong the map is inside it. A blob
    // of barely-lit pixels is a smudge, not a line.
    let sum = 0;
    for (const [x, y] of pixels) sum += map[y * width + x];
    const score = sum / pixels.length;
    if (score < BOX_THRESHOLD) continue;

    const { quad, angle } = minAreaRect(pixels);
    const grown = unclip(quad, UNCLIP_RATIO).map(([x, y]) => [
      x * scaleX,
      y * scaleY,
    ]) as Quad;
    lines.push({
      quad: grown,
      box: boundingBox(grown),
      angle,
      score: Math.round(score * 100) / 100,
    });
  }

  return lines;
}

/** How far off level the page is, in degrees, from its own lines. */
export function skewOf(lines: TextLine[]): number {
  return pageSkew(lines);
}

/**
 * Is this page crooked enough to be worth straightening?
 *
 * Below a degree, rotating costs a resample and buys nothing — the reading
 * model is not troubled by a scan that is slightly off. Above about fifteen
 * the median is more likely to be measuring something other than body text,
 * and a right-angle rotation is the thing that was needed.
 */
export function worthDeskewing(degrees: number): boolean {
  const magnitude = Math.abs(degrees);
  return magnitude >= 1 && magnitude <= 15;
}
