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
import { ocrEngineOf, ocrModel } from "./catalog.js";
import { getOcrConfig } from "./settings.js";
import { isOtsl, otslToMarkdown } from "./paddle/otsl.js";
import { trimLoop } from "./loops.js";
import { scanPage } from "./engine.js";
import {
  absorbInline,
  detectBlocks,
  dropDuplicates,
  dropNested,
  readingOrder,
  type LayoutBlock,
} from "./layout.js";
import { cropBlocks, rotatePage, type RenderedPage } from "./render.js";
import {
  bestAngle,
  layoutConfidence,
  rotateSquare,
  type PageAngle,
} from "./orientation.js";
import { detectLines, skewOf, worthDeskewing } from "./lines/detect.js";
import { existsSync } from "fs";
import { detModelPath } from "./lines/detect.js";

/** Blocks that are pictures: kept, never read. */
const PICTURES = new Set(["image", "chart"]);

/** Blocks nobody wants in the text of a document. */
const FURNITURE = new Set(["number", "header", "footer"]);

/**
 * What to ask the model, per kind of block AND per engine.
 *
 * PaddleOCR-VL was trained on a fixed set of task prefixes and answers
 * badly to anything else — asked to "convert this table to markdown" it
 * transcribes the cells as prose, while "Table Recognition:" gets a
 * structured table back. LightOnOCR takes an instruction in English.
 */
function promptFor(label: string, engine: string): string {
  const formula = label === "formula" || label === "formula_number";
  if (engine === "paddle") {
    if (formula) return "Formula Recognition:";
    if (label === "table") return "Table Recognition:";
    if (label === "chart") return "Chart Recognition:";
    return "OCR:";
  }
  if (formula) return "Convert this formula to LaTeX.";
  if (label === "table") return "Convert this table to markdown.";
  // The detector distinguishes twenty kinds of block and it is worth using
  // more than five of them: telling the model it is looking at pseudocode
  // rather than a paragraph is the difference between indentation kept and
  // indentation flattened into prose.
  if (label === "algorithm")
    return "Transcribe this algorithm exactly, keeping its line breaks and indentation.";
  if (label === "reference" || label === "reference_content")
    return "Transcribe this bibliography, one reference per line.";
  if (label === "seal") return "Read the text on this stamp.";
  return "Convert this page to markdown.";
}

/** A formula is short; a paragraph is not. Capping per block keeps one
 * runaway generation from eating the page's whole time budget. */
function tokensFor(label: string): number {
  if (label === "formula" || label === "formula_number") return 256;
  if (label === "table" || label === "algorithm") return 1024;
  // A bibliography block is a whole page of names on a references page.
  if (label === "reference" || label === "reference_content") return 1024;
  if (label === "paragraph_title" || label === "doc_title" || label === "figure_title")
    return 128;
  if (label === "seal" || label === "number") return 64;
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

/**
 * Markdown shape for a block's text, by what the block is.
 *
 * The detector knows twenty kinds of block; using them is free accuracy.
 * An algorithm fenced as code keeps its indentation, a title becomes a
 * heading rather than a sentence in bold, and an abstract stays visibly an
 * abstract instead of merging into the first paragraph of the paper.
 */
function render(label: string, text: string): string {
  const t = text.trim();
  if (!t) return "";
  if (label === "doc_title") return `# ${t.replace(/^#+\s*/, "")}`;
  if (label === "paragraph_title") return `## ${t.replace(/^#+\s*/, "")}`;
  if (label === "figure_title") return `*${t}*`;
  // Marginalia and footnotes are asides, not part of the sentence they
  // happen to sit beside.
  if (label === "footnote" || label === "aside_text") return `> ${t}`;
  if (label === "abstract") return `> **Abstract.** ${t.replace(/^abstract[.:]?\s*/i, "")}`;
  // Pseudocode survives only if the fence does; the model is asked to keep
  // the line breaks and this is what preserves them.
  if (label === "algorithm") return t.includes("```") ? t : `\`\`\`
${t}
\`\`\``;
  if (label === "seal") return `*[stamp: ${t}]*`;
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
 * How far off level a page is, or zero when it does not matter.
 *
 * Returns zero when the line detector is not installed: it is a 4.6 MB
 * extra, and a page that is slightly crooked still reads fine — this is an
 * improvement, not a prerequisite.
 */
async function pageSkewOf(page: RenderedPage, device: string): Promise<number> {
  if (!page.detRgb || !page.detWidth || !page.detHeight) return 0;
  if (!existsSync(detModelPath())) return 0;
  try {
    const lines = await detectLines(
      page.detRgb,
      page.detWidth,
      page.detHeight,
      page.width,
      page.height,
      device,
    );
    const skew = skewOf(lines);
    return worthDeskewing(skew) ? skew : 0;
  } catch {
    // A missing or broken detector must cost the page nothing.
    return 0;
  }
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
  const engine = ocrEngineOf(
    ocrModel(getOcrConfig().modelId) ?? { engine: "transformers" } as never,
  );
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
  const layoutDevice = opts.layoutDevice ?? "cpu";
  let sheet = page;
  let found: LayoutBlock[];
  try {
    // Which way up? A page fed in sideways or upside down does not fail —
    // it comes back WRONG in a way that looks like the app's fault: the
    // reading model transcribes rotated text perfectly well, while the
    // layout detector ignores rotation, so the blocks arrive in the wrong
    // order. The detector is its own test: it is measurably less sure
    // about a page that is not upright. Four detections cost about a
    // second; a page read backwards costs the user the document.
    const LAYOUT_SIDE = 800;
    const angles: PageAngle[] = [0, 90, 180, 270];
    const tried: { angle: PageAngle; confidence: number; blocks: LayoutBlock[] }[] = [];
    for (const angle of angles) {
      const blocks = await detectBlocks(
        {
          data: new Uint8Array(0),
          width: page.width,
          height: page.height,
          resized: rotateSquare(page.layoutRgb, LAYOUT_SIDE, angle),
        },
        layoutDevice,
      );
      tried.push({ angle, confidence: layoutConfidence(blocks), blocks });
    }
    const angle = bestAngle(tried);

    // Right angles settled, the page may still be a degree or three off —
    // a photograph of a page, a sheet fed slightly crooked. The line
    // detector measures that from the text itself, and a straightened page
    // gives the layout model clean rectangles instead of boxes that each
    // contain a slice of their neighbours.
    let straightened: RenderedPage | null = null;
    if (angle === 0) {
      const skew = await pageSkewOf(page, layoutDevice);
      if (skew !== 0) {
        straightened = await rotatePage(page.path, -skew);
        sheet = straightened;
      }
    }

    if (angle === 0 && !straightened) {
      found = tried[0].blocks;
    } else if (angle === 0 && straightened) {
      found = straightened.layoutRgb
        ? await detectBlocks(
            {
              data: new Uint8Array(0),
              width: straightened.width,
              height: straightened.height,
              resized: straightened.layoutRgb,
            },
            layoutDevice,
          )
        : tried[0].blocks;
    } else {
      // Turn the page ONCE and start again on it, rather than carrying an
      // angle through the crops, the boxes and the reading order.
      sheet = await rotatePage(page.path, angle);
      found = sheet.layoutRgb
        ? await detectBlocks(
            {
              data: new Uint8Array(0),
              width: sheet.width,
              height: sheet.height,
              resized: sheet.layoutRgb,
            },
            layoutDevice,
          )
        : tried.find((t) => t.angle === angle)!.blocks;
    }
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
    sheet.width,
  ).filter((b) => !FURNITURE.has(b.label));
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
      sheet.path,
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
    const prompt = promptFor(b.label, engine);
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
    // Paddle answers a table in OTSL; nobody wants those tags in a note.
    const stripped = stripEcho(r.text, prompt);
    const asMarkdown = isOtsl(stripped) ? otslToMarkdown(stripped) : stripped;
    // A block that started repeating itself is cut where it began, and says
    // so — half a paragraph beats a paragraph followed by fifty copies of
    // its last line.
    const trimmed = trimLoop(asMarkdown);
    const clean = trimmed.looped
      ? `${trimmed.text}

<!-- the model started repeating itself here; the rest was dropped -->`
      : trimmed.text;
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
