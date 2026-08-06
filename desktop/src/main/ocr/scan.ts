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
import {
  disposePages,
  isImagePath,
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
export async function scanDocument(
  path: string,
  opts: {
    pages?: number[];
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

  // A picture is already a page.
  if (isImagePath(path)) {
    const r = await scanPage(path, (text, tokens) =>
      opts.onProgress?.({ page: 1, pageCount: 1, text, tokens }),
    );
    if (r.error) return { ...empty, error: r.error };
    return {
      markdown: r.text,
      pages: [{ page: 1, markdown: r.text, tokens: r.tokens }],
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

  try {
    const out: ScanResult["pages"] = [];
    let device = "";
    for (const p of pages) {
      const r = await scanPage(p.path, (text, tokens) =>
        opts.onProgress?.({ page: p.page, pageCount: pages.length, text, tokens }),
      );
      if (r.error)
        return {
          markdown: out.map((x) => x.markdown).join("\n\n"),
          pages: out,
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
      pageCount: total,
      skipped,
      seconds: (Date.now() - started) / 1000,
      device,
    };
  } finally {
    await disposePages(dir);
  }
}
