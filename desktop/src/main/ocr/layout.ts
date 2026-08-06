/**
 * Where things are on the page, before anything reads them.
 *
 * A vision model handed a whole A4 page spends minutes on it; handed a
 * formula-sized crop it answers in two seconds, and measurably faster per
 * token — a short context is cheap in a way a long one never is. So the
 * scanner finds the blocks first and reads them one at a time.
 *
 * Cutting the page into strips was the obvious shortcut and it is wrong: a
 * two-column paper, a figure spanning the full width, a table straddling the
 * fold — a strip cuts through all of them and the reading order is lost. A
 * layout model knows what a block IS, which is also what makes the rest
 * possible: a formula gets asked for LaTeX, a table for a table, and the
 * blocks come back with types and coordinates the caller can hand to a model
 * that cannot see.
 *
 * PP-DocLayout_plus-L, exported to ONNX by PaddlePaddle themselves, on the
 * onnxruntime the app already ships. It is a DETR — no NMS to reimplement,
 * the graph maps boxes back to page coordinates itself — and it costs about
 * a third of a second on the CPU, which is noise next to the reading.
 */

import { createRequire } from "module";
import { join } from "path";
import { ocrModelsDir } from "./settings.js";

const require = createRequire(import.meta.url);

/** The classes the model was trained on, in its own order. */
export const LAYOUT_LABELS = [
  "paragraph_title",
  "image",
  "text",
  "number",
  "abstract",
  "content",
  "figure_title",
  "formula",
  "table",
  "reference",
  "doc_title",
  "footnote",
  "header",
  "algorithm",
  "footer",
  "seal",
  "chart",
  "formula_number",
] as const;

export type LayoutLabel = (typeof LAYOUT_LABELS)[number] | string;

export interface LayoutBlock {
  label: LayoutLabel;
  score: number;
  /** [x1, y1, x2, y2] in the page image's own pixels. */
  box: [number, number, number, number];
}

/** The model's input side is fixed at export time. */
const INPUT_SIZE = 800;

/**
 * Confidence floor.
 *
 * The model's own inference.yml says 0.5 and that is what it was tuned
 * against: on a real page the true blocks land at 0.5–0.99 and the noise
 * sits under 0.05, so this is a wide gap rather than a knife edge.
 */
const SCORE_FLOOR = 0.5;

export const LAYOUT_REPO = "PaddlePaddle/PP-DocLayout_plus-L_onnx";
export const LAYOUT_FILE = "inference.onnx";

export function layoutModelPath(): string {
  return join(ocrModelsDir(), ...LAYOUT_REPO.split("/"), LAYOUT_FILE);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let session: any = null;
let sessionDevice = "";

/**
 * Load the detector, once.
 *
 * `device` follows the OCR setting, but the CPU is not a fallback here — it
 * is a third of a second, and a GPU session costs more to spin up than it
 * saves on one page.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSession(device: string): Promise<any> {
  if (session && sessionDevice === device) return session;
  const ort = require("onnxruntime-node");
  session = await ort.InferenceSession.create(layoutModelPath(), {
    executionProviders: [device === "webgpu" ? "webgpu" : "cpu"],
  });
  sessionDevice = device;
  return session;
}

export function disposeLayout(): void {
  session = null;
  sessionDevice = "";
}

export interface PageImage {
  /** RGB bytes, 3 per pixel, row-major. */
  data: Uint8Array;
  width: number;
  height: number;
  /** The same pixels resized to the model's input, RGB. */
  resized: Uint8Array;
}

/**
 * Find the blocks on one page.
 *
 * Takes pixels rather than a path: the caller already has the page decoded
 * (it drew it), and going back through the filesystem to re-decode a PNG is
 * a tenth of a second spent on nothing.
 */
export async function detectBlocks(
  page: PageImage,
  device = "cpu",
): Promise<LayoutBlock[]> {
  const ort = require("onnxruntime-node");
  const s = await getSession(device);

  // CHW float32, scaled to 0..1. The exported graph's NormalizeImage says
  // mean 0 / std 1, which reads as "leave the values alone" and is a trap:
  // feeding it raw 0..255 produces a page where the best block scores 0.049
  // and nothing crosses the threshold. Nothing errors — the page simply
  // comes back empty.
  const px = page.resized;
  const area = INPUT_SIZE * INPUT_SIZE;
  const data = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    data[i] = px[i * 3] / 255;
    data[area + i] = px[i * 3 + 1] / 255;
    data[2 * area + i] = px[i * 3 + 2] / 255;
  }

  const feeds: Record<string, unknown> = {};
  for (const name of s.inputNames as string[]) {
    if (name === "image" || name === "x")
      feeds[name] = new ort.Tensor("float32", data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    else if (name === "scale_factor")
      // How the graph scales its boxes back onto the original page.
      feeds[name] = new ort.Tensor(
        "float32",
        new Float32Array([INPUT_SIZE / page.height, INPUT_SIZE / page.width]),
        [1, 2],
      );
    else if (name === "im_shape")
      feeds[name] = new ort.Tensor(
        "float32",
        new Float32Array([INPUT_SIZE, INPUT_SIZE]),
        [1, 2],
      );
  }

  const out = await s.run(feeds);
  // The detections are the [N, 6] output: class, score, x1, y1, x2, y2.
  const key =
    (s.outputNames as string[]).find(
      (n) => out[n].dims.length === 2 && out[n].dims[1] === 6,
    ) ?? (s.outputNames as string[])[0];
  const arr = out[key].data as Float32Array;
  const rows = out[key].dims[0] as number;

  const blocks: LayoutBlock[] = [];
  for (let i = 0; i < rows; i++) {
    const score = arr[i * 6 + 1];
    if (score < SCORE_FLOOR) continue;
    const cls = arr[i * 6];
    const box: [number, number, number, number] = [
      Math.max(0, Math.round(arr[i * 6 + 2])),
      Math.max(0, Math.round(arr[i * 6 + 3])),
      Math.min(page.width, Math.round(arr[i * 6 + 4])),
      Math.min(page.height, Math.round(arr[i * 6 + 5])),
    ];
    if (box[2] - box[0] < 4 || box[3] - box[1] < 4) continue;
    blocks.push({
      label: LAYOUT_LABELS[cls] ?? `class${cls}`,
      score: Math.round(score * 100) / 100,
      box,
    });
  }
  return blocks;
}

function intersection(a: LayoutBlock["box"], b: LayoutBlock["box"]): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

function areaOf(b: LayoutBlock["box"]): number {
  return (b[2] - b[0]) * (b[3] - b[1]);
}

/** How much of the SMALLER box the larger one covers, 0..1 — the question
 * "is this thing inside that thing". */
function containedRatio(a: LayoutBlock["box"], b: LayoutBlock["box"]): number {
  const inter = intersection(a, b);
  return inter === 0 ? 0 : inter / Math.min(areaOf(a), areaOf(b));
}

/**
 * How much the two boxes are the SAME box, 0..1 (intersection over union).
 *
 * The distinction matters and getting it wrong cost a page: an inline
 * formula sits entirely inside its paragraph, so "how much of the smaller
 * one is covered" is 1.0 for a pair that is not remotely the same region.
 * Deduplicating on that number deleted the paragraphs — a page of dense
 * text came back as eighteen formulas and three sentences.
 */
function sameRegion(a: LayoutBlock["box"], b: LayoutBlock["box"]): number {
  const inter = intersection(a, b);
  if (inter === 0) return 0;
  return inter / (areaOf(a) + areaOf(b) - inter);
}

/**
 * One patch of paper, one block.
 *
 * The detector happily returns the same region twice under different labels
 * — a figure caption comes back as `figure_title` AND `text` on identical
 * coordinates. Reading both costs a second call and prints the sentence
 * twice, which is exactly what the first run of this pipeline did.
 *
 * The more specific label wins: `figure_title` says more than `text`.
 */
const LABEL_RANK: Record<string, number> = {
  formula: 5,
  table: 5,
  doc_title: 4,
  paragraph_title: 4,
  figure_title: 4,
  footnote: 3,
  abstract: 3,
  reference: 3,
  text: 1,
  content: 1,
};

export function dropDuplicates(blocks: LayoutBlock[]): LayoutBlock[] {
  const keep: LayoutBlock[] = [];
  for (const b of [...blocks].sort(
    (x, y) => (LABEL_RANK[y.label] ?? 2) - (LABEL_RANK[x.label] ?? 2) || y.score - x.score,
  )) {
    if (keep.some((k) => sameRegion(k.box, b.box) > 0.7)) continue;
    keep.push(b);
  }
  return keep;
}

/**
 * A formula inside a paragraph belongs to the paragraph.
 *
 * The detector marks inline mathematics — `ΔV = ΔV₁ · 1,05` in the middle of
 * a sentence — as its own `formula` block. Cutting it out is wrong twice
 * over: the crop is a slice of a text line and gets clipped mid-expression
 * (the first run produced `w(x, t) = \varphi(x) \, c`), and the sentence it
 * came from is left with a hole where the mathematics was.
 *
 * So a formula that sits inside a text block is dropped, and the text block
 * is read whole — the model writes the mathematics in place, which is what
 * inline mathematics is. A display formula stands on its own line, overlaps
 * no paragraph, and survives this untouched.
 */
export function absorbInline(blocks: LayoutBlock[]): LayoutBlock[] {
  const TEXTUAL = new Set(["text", "content", "abstract", "footnote", "reference"]);
  const hosts = blocks.filter((b) => TEXTUAL.has(b.label));
  return blocks.filter((b) => {
    if (b.label !== "formula" && b.label !== "formula_number") return true;
    return !hosts.some((h) => containedRatio(h.box, b.box) > 0.6);
  });
}

/** Does one box sit inside another (allowing a few pixels of slop)? */
function contains(outer: LayoutBlock["box"], inner: LayoutBlock["box"]): boolean {
  const pad = 4;
  return (
    inner[0] >= outer[0] - pad &&
    inner[1] >= outer[1] - pad &&
    inner[2] <= outer[2] + pad &&
    inner[3] <= outer[3] + pad
  );
}

/**
 * Drop blocks that live inside another block.
 *
 * A table full of formulas comes back as the table AND every formula in it;
 * reading both means paying twice and printing the contents twice. The
 * container wins — a table read as a table keeps its rows, which is the
 * whole point of knowing it is a table.
 */
export function dropNested(blocks: LayoutBlock[]): LayoutBlock[] {
  const CONTAINERS = new Set(["table", "image", "chart", "algorithm"]);
  return blocks.filter(
    (b) =>
      !blocks.some(
        (other) =>
          other !== b &&
          CONTAINERS.has(other.label) &&
          contains(other.box, b.box) &&
          // A container inside a container keeps the bigger one.
          !(CONTAINERS.has(b.label) && contains(b.box, other.box)),
      ),
  );
}

/**
 * Reading order, columns included.
 *
 * Top-to-bottom is right for one column and wrong for two: a paper read that
 * way alternates between the columns line by line. So the page is split
 * where a gutter would be — a vertical band no block crosses — and each
 * column is read top-to-bottom before the next one starts. Blocks that span
 * the gutter (a full-width figure, a title) belong to neither column and are
 * placed by their own vertical position.
 */
export function readingOrder(
  blocks: LayoutBlock[],
  pageWidth: number,
): LayoutBlock[] {
  const mid = pageWidth / 2;
  const spanning = blocks.filter((b) => b.box[0] < mid && b.box[2] > mid);
  const left = blocks.filter((b) => b.box[2] <= mid);
  const right = blocks.filter((b) => b.box[0] >= mid);

  // One column: anything else is a two-column page, and a page where most
  // blocks cross the middle is one column with wide paragraphs.
  const isTwoColumn =
    left.length >= 2 && right.length >= 2 && spanning.length <= left.length;
  const byTop = (a: LayoutBlock, b: LayoutBlock): number => a.box[1] - b.box[1];
  if (!isTwoColumn) return [...blocks].sort(byTop);

  // Full-width blocks cut the page into bands; each band is read
  // left-column-then-right before the block below it.
  const out: LayoutBlock[] = [];
  const bands = [...spanning].sort(byTop);
  let fromY = 0;
  const emitBand = (toY: number): void => {
    const inBand = (b: LayoutBlock): boolean =>
      b.box[1] >= fromY && b.box[1] < toY;
    out.push(...left.filter(inBand).sort(byTop));
    out.push(...right.filter(inBand).sort(byTop));
  };
  for (const b of bands) {
    emitBand(b.box[1]);
    out.push(b);
    fromY = b.box[1];
  }
  emitBand(Number.POSITIVE_INFINITY);
  return out;
}
