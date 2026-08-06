/**
 * A document, read.
 *
 * Ties the two halves together: pictures come from render.ts, Markdown comes
 * from engine.ts, and this decides what a "document" means — a PDF is many
 * pages, a screenshot is one, and anything else has to become one of those
 * before it gets here.
 *
 * Progress is reported per page and per token because it has to be: a page
 * takes minutes on a laptop, and a caller with nothing to show would look
 * broken.
 */

import { statSync } from "fs";
import { basename } from "path";
import { scanPage } from "./engine.js";
import { hasLayoutFile } from "./install.js";
import { LAYOUT_FILE, LAYOUT_REPO } from "./layout.js";
import { scanPageSmart } from "./smart.js";
import {
  disposePages,
  isImagePath,
  measureImage,
  isPdfPath,
  pdfPageCount,
  renderPdf,
} from "./render.js";
import { getOcrConfig } from "./settings.js";

export interface ScanProgress {
  page: number;
  pageCount: number;
  /** Text so far for THIS page. */
  text: string;
  tokens: number;
}

export interface ScanResult {
  markdown: string;
  pages: { page: number; markdown: string; tokens: number }[];
  /** Which path actually ran — the caller reports honest timings. */
  mode?: "smart" | "full";
  /** Present in smart mode: what was found and where. */
  blocks?: {
    page: number;
    label: string;
    box: [number, number, number, number];
  }[];
  pageCount: number;
  /** Pages the caller asked for beyond the cap, left unread. */
  skipped: number;
  seconds: number;
  device: string;
  error?: string;
}

export function canScan(path: string): boolean {
  return isPdfPath(path) || isImagePath(path);
}

/**
 * Read a file and hand back Markdown.
 *
 * `pages` is 1-based and only means anything for a PDF. The page cap comes
 * from settings and is enforced here rather than in the tool, so every
 * caller — the agent, the Settings test button — obeys the same limit.
 */
/** Can the fast path run at all? */
export function hasLayoutModel(): boolean {
  return hasLayoutFile(LAYOUT_REPO, LAYOUT_FILE);
}

export async function scanDocument(
  path: string,
  opts: {
    pages?: number[];
    /**
     * "smart" finds the blocks and reads each one — minutes become tens of
     * seconds, and pictures are skipped rather than hallucinated over.
     * "full" hands the whole page to the model, which is what to do when the
     * layout detector is not installed or a page defeats it.
     */
    mode?: "smart" | "full";
    bbox?: boolean;
    onProgress?: (p: ScanProgress) => void;
  } = {},
): Promise<ScanResult> {
  const cfg = getOcrConfig();
  const started = Date.now();
  const empty: ScanResult = {
    markdown: "",
    pages: [],
    pageCount: 0,
    skipped: 0,
    seconds: 0,
    device: "",
  };

  try {
    statSync(path);
  } catch {
    return { ...empty, error: `No such file: ${path}` };
  }

  // A picture is already a page — including for the block-by-block path,
  // which is the whole point: a screenshot is the commonest thing anyone
  // hands a scanner, and reading one whole costs the same minutes a PDF
  // page does.
  if (isImagePath(path)) {
    const smart = opts.mode !== "full" && hasLayoutModel();
    if (smart) {
      const page = await measureImage(path);
      const r = await scanPageSmart(page, {
        bbox: opts.bbox,
        onProgress: (b) =>
          opts.onProgress?.({
            page: 1,
            pageCount: 1,
            text: `${b.label} ${b.block}/${b.blockCount}: ${b.text}`,
            tokens: b.block,
          }),
      });
      if (!r.error || r.markdown)
        return {
          markdown: r.markdown,
          pages: [{ page: 1, markdown: r.markdown, tokens: r.blocks.length }],
          mode: "smart",
          blocks: r.blocks.map((b) => ({ page: 1, label: b.label, box: b.box })),
          pageCount: 1,
          skipped: 0,
          seconds: (Date.now() - started) / 1000,
          device: r.device,
          error: r.error,
        };
      // A page the detector made nothing of still deserves reading; fall
      // through to the whole-page pass rather than returning an empty note.
    }
    const r = await scanPage(path, (text, tokens) =>
      opts.onProgress?.({ page: 1, pageCount: 1, text, tokens }),
    );
    if (r.error) return { ...empty, error: r.error };
    return {
      markdown: r.text,
      pages: [{ page: 1, markdown: r.text, tokens: r.tokens }],
      mode: "full",
      pageCount: 1,
      skipped: 0,
      seconds: (Date.now() - started) / 1000,
      device: r.device,
    };
  }

  if (!isPdfPath(path))
    return {
      ...empty,
      error: `${basename(path)} is not something the scanner can rasterise. Give it a PDF or an image.`,
    };

  const total = await pdfPageCount(path);
  const wanted = (opts.pages ?? []).filter((n) => n >= 1 && n <= total);
  const requested = wanted.length > 0 ? wanted : Array.from({ length: total }, (_, i) => i + 1);
  const scanning = requested.slice(0, cfg.maxPages);
  const skipped = requested.length - scanning.length;

  const { dir, pages } = await renderPdf(path, {
    dpi: cfg.dpi,
    pages: scanning,
    maxPages: cfg.maxPages,
  });

  // Smart unless told otherwise, and only when the detector is installed:
  // silently reading pages the slow way for ten minutes because a 124 MB
  // file is missing is the kind of "graceful" degradation nobody wants.
  const mode: "smart" | "full" =
    opts.mode === "full" ? "full" : hasLayoutModel() ? "smart" : "full";

  try {
    const out: ScanResult["pages"] = [];
    const blocks: NonNullable<ScanResult["blocks"]> = [];
    let device = "";

    for (const p of pages) {
      if (mode === "smart") {
        const r = await scanPageSmart(p, {
          bbox: opts.bbox,
          onProgress: (b) =>
            opts.onProgress?.({
              page: b.page,
              pageCount: pages.length,
              text: `${b.label} ${b.block}/${b.blockCount}: ${b.text}`,
              tokens: b.block,
            }),
        });
        if (r.device) device = r.device;
        for (const b of r.blocks)
          blocks.push({ page: p.page, label: b.label, box: b.box });
        if (r.error && !r.markdown)
          return {
            markdown: out.map((x) => x.markdown).join("\n\n"),
            pages: out,
            mode,
            blocks,
            pageCount: total,
            skipped,
            seconds: (Date.now() - started) / 1000,
            device,
            error: `page ${p.page}: ${r.error}`,
          };
        out.push({ page: p.page, markdown: r.markdown, tokens: r.blocks.length });
        continue;
      }

      const r = await scanPage(p.path, (text, tokens) =>
        opts.onProgress?.({ page: p.page, pageCount: pages.length, text, tokens }),
      );
      if (r.error)
        return {
          markdown: out.map((x) => x.markdown).join("\n\n"),
          pages: out,
          mode,
          pageCount: total,
          skipped,
          seconds: (Date.now() - started) / 1000,
          device: r.device,
          error: `page ${p.page}: ${r.error}`,
        };
      device = r.device;
      out.push({ page: p.page, markdown: r.text, tokens: r.tokens });
    }

    return {
      markdown: out.map((x) => x.markdown).join("\n\n"),
      pages: out,
      mode,
      blocks: mode === "smart" ? blocks : undefined,
      pageCount: total,
      skipped,
      seconds: (Date.now() - started) / 1000,
      device,
    };
  } finally {
    await disposePages(dir);
  }
}
