/**
 * Reading a page the way a person does: find the parts, then read each one.
 *
 * The whole-page approach asks a vision model to hold an entire A4 in its
 * context and narrate it, which on this class of hardware is minutes. The
 * same model on a formula-sized crop answers in about two seconds and runs
 * four to six times faster per token, because a short context is cheap. So
 * the layout detector finds the blocks (a third of a second) and each block
 * is read on its own.
 *
 * Three things fall out of knowing what a block IS, and they are the reason
 * this beats cutting the page into strips:
 *
 *   - a picture is never read at all. OCR on a photograph is a minute spent
 *     inventing a caption; the crop is kept and referenced instead;
 *   - a formula is asked for LaTeX and a table for a table, so inline
 *     mathematics inside a paragraph survives as mathematics;
 *   - the blocks carry coordinates, so a model that cannot see gets told
 *     where things are.
 *
 * Reading order is layout's job too — two-column pages exist, and strips cut
 * straight through them.
 */

import { basename } from "path";
import { scanPage } from "./engine.js";
import {
  absorbInline,
  detectBlocks,
  dropDuplicates,
  dropNested,
  readingOrder,
  type LayoutBlock,
} from "./layout.js";
import { cropBlocks, type RenderedPage } from "./render.js";

/** Blocks that are pictures: kept, never read. */
const PICTURES = new Set(["image", "chart", "seal"]);

/** Blocks nobody wants in the text of a document. */
const FURNITURE = new Set(["number", "header", "footer"]);

/** What to ask the model, per kind of block. */
function promptFor(label: string): string {
  if (label === "formula" || label === "formula_number")
    return "Convert this formula to LaTeX.";
  if (label === "table") return "Convert this table to markdown.";
  return "Convert this page to markdown.";
}

/** A formula is short; a paragraph is not. Capping per block keeps one
 * runaway generation from eating the page's whole time budget. */
function tokensFor(label: string): number {
  if (label === "formula" || label === "formula_number") return 256;
  if (label === "table") return 1024;
  if (label === "paragraph_title" || label === "doc_title" || label === "figure_title")
    return 128;
  return 768;
}

/**
 * How much paper to keep around a block.
 *
 * A formula box is drawn tight around the glyphs, and a tight box clips the
 * bar of a fraction or the tail of an integral — the model then reads a
 * symbol that is not there, or stops mid-expression. Inline mathematics is
 * the worst case, being one line tall, so it gets the most room.
 */
function padFor(label: string): number {
  if (label === "formula" || label === "formula_number") return 14;
  if (label === "table") return 8;
  return 6;
}

/**
 * Strip the question out of the answer.
 *
 * Asked to convert a formula, the model sometimes replies with the
 * instruction followed by the formula. It is not a refusal and the answer
 * below it is fine, so the instruction is removed rather than the block
 * being failed.
 */
function stripEcho(text: string, prompt: string): string {
  // Compared with whitespace collapsed and case folded: the echo comes back
  // with a doubled gap or a non-breaking space often enough that an exact
  // match misses it — and then the instruction is printed as if it were
  // content, which is what the first two runs did. It can land anywhere in
  // the answer, not only at the top.
  const flat = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
  const want = flat(prompt);
  return text
    .split("\n")
    .filter((line) => flat(line) !== want)
    .join("\n")
    .trim();
}

/** Markdown shape for a block's text, by what the block is. */
function render(label: string, text: string): string {
  const t = text.trim();
  if (!t) return "";
  if (label === "doc_title") return `# ${t.replace(/^#+\s*/, "")}`;
  if (label === "paragraph_title") return `## ${t.replace(/^#+\s*/, "")}`;
  if (label === "figure_title") return `*${t}*`;
  if (label === "footnote") return `> ${t}`;
  return t;
}

export interface SmartBlock {
  label: string;
  score: number;
  box: [number, number, number, number];
  /** Absent for pictures, which are not read. */
  text?: string;
  /** Where the crop was written, for pictures and for debugging. */
  cropPath?: string;
  seconds: number;
}

export interface SmartPageResult {
  page: number;
  markdown: string;
  blocks: SmartBlock[];
  layoutSeconds: number;
  seconds: number;
  device: string;
  error?: string;
}

export interface SmartOptions {
  /** Include coordinates and types in the Markdown. */
  bbox?: boolean;
  /** Compute device for the layout detector — the reader has its own. */
  layoutDevice?: string;
  onProgress?: (p: {
    page: number;
    block: number;
    blockCount: number;
    label: string;
    text: string;
  }) => void;
}

/**
 * One page, block by block.
 *
 * Every block that fails is reported in place rather than failing the page:
 * a formula the model choked on should cost that formula, not the chapter
 * around it.
 */
export async function scanPageSmart(
  page: RenderedPage,
  opts: SmartOptions = {},
): Promise<SmartPageResult> {
  const started = Date.now();
  if (!page.layoutRgb)
    return {
      page: page.page,
      markdown: "",
      blocks: [],
      layoutSeconds: 0,
      seconds: 0,
      device: "",
      error: "the page was rendered without layout pixels",
    };

  const t0 = Date.now();
  let found: LayoutBlock[];
  try {
    found = await detectBlocks(
      {
        data: new Uint8Array(0),
        width: page.width,
        height: page.height,
        resized: page.layoutRgb,
      },
      opts.layoutDevice ?? "cpu",
    );
  } catch (err) {
    return {
      page: page.page,
      markdown: "",
      blocks: [],
      layoutSeconds: (Date.now() - t0) / 1000,
      seconds: (Date.now() - started) / 1000,
      device: "",
      error: `layout failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const layoutSeconds = (Date.now() - t0) / 1000;

  const ordered = readingOrder(
    absorbInline(dropDuplicates(dropNested(found))),
    page.width,
  ).filter(
    (b) => !FURNITURE.has(b.label),
  );
  if (ordered.length === 0)
    return {
      page: page.page,
      markdown: "",
      blocks: [],
      layoutSeconds,
      seconds: (Date.now() - started) / 1000,
      device: "",
      error: "the layout model found nothing on this page",
    };

  // Crops are padded per label, so they are cut one group at a time.
  const crops: ({ path: string; width: number; height: number } | undefined)[] =
    new Array(ordered.length);
  const byPad = new Map<number, number[]>();
  ordered.forEach((b, i) => {
    const pad = padFor(b.label);
    byPad.set(pad, [...(byPad.get(pad) ?? []), i]);
  });
  for (const [pad, indices] of byPad) {
    const cut = await cropBlocks(
      page.path,
      indices.map((i) => ordered[i].box),
      pad,
    );
    indices.forEach((i, k) => {
      crops[i] = cut[k];
    });
  }

  const out: SmartBlock[] = [];
  const parts: string[] = [];
  let device = "";

  for (let i = 0; i < ordered.length; i++) {
    const b = ordered[i];
    const crop = crops[i];
    const blockStarted = Date.now();

    if (PICTURES.has(b.label)) {
      // Not read: a picture's content is the picture. The crop stays on
      // disk so the caller can attach it somewhere that shows pictures.
      out.push({
        label: b.label,
        score: b.score,
        box: b.box,
        cropPath: crop?.path,
        seconds: 0,
      });
      parts.push(
        `![${b.label}](${crop ? basename(crop.path) : `${b.label}-${i}`})`,
      );
      continue;
    }

    if (!crop) continue;
    const prompt = promptFor(b.label);
    const r = await scanPage(
      crop.path,
      (text) =>
        opts.onProgress?.({
          page: page.page,
          block: i + 1,
          blockCount: ordered.length,
          label: b.label,
          text,
        }),
      { prompt, maxTokens: tokensFor(b.label) },
    );
    const seconds = (Date.now() - blockStarted) / 1000;
    if (r.device) device = r.device;

    if (r.error) {
      out.push({ label: b.label, score: b.score, box: b.box, cropPath: crop.path, seconds });
      parts.push(`<!-- ${b.label} at ${b.box.join(",")}: ${r.error} -->`);
      continue;
    }
    const clean = stripEcho(r.text, prompt);
    out.push({
      label: b.label,
      score: b.score,
      box: b.box,
      text: clean,
      cropPath: crop.path,
      seconds,
    });
    const body = render(b.label, clean);
    if (body) parts.push(body);
  }

  const markdown = opts.bbox
    ? out
        .map((b) => {
          const head = `<!-- ${b.label} [${b.box.join(", ")}] -->`;
          const body = b.text ? render(b.label, b.text) : `![${b.label}]()`;
          return `${head}\n${body}`;
        })
        .filter(Boolean)
        .join("\n\n")
    : parts.filter(Boolean).join("\n\n");

  return {
    page: page.page,
    markdown,
    blocks: out,
    layoutSeconds,
    seconds: (Date.now() - started) / 1000,
    device,
  };
}
