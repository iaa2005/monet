/**
 * OCRScan — the agent's eyes.
 *
 * A text-only model cannot look at a scan, a formula or a chart, and the
 * failure mode is worse than an honest refusal: it writes code that opens
 * the file with a library it hopes is installed, then describes a picture it
 * never saw. This tool removes the guesswork — an on-device vision model
 * reads the page and hands back Markdown, with formulas as LaTeX and tables
 * as tables, and the chat model works with the text like any other text.
 *
 * It takes what the user actually has: a PDF, a screenshot, a photo of a
 * page, an image already in the Obsidian vault, or a URL pointing at one. It
 * resolves those the same way VaultAttach resolves a file, so a name that
 * works in Home works in Code.
 *
 * The model runs locally: nothing is uploaded, which is the point for
 * somebody's scanned contracts and somebody else's unpublished paper.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { z } from "zod/v4";
import { buildTool } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import { resolveSource, sourceHint } from "../obsidian/source.js";
import { enabledVaults } from "../obsidian/vaults.js";
import { canScan, scanDocument } from "./scan.js";
import { ocrReadiness } from "./engine.js";
import { getOcrConfig } from "./settings.js";

interface Output {
  text: string;
  isError?: boolean;
}

const asResult = (content: Output, toolUseID: string): ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: toolUseID,
  content: content.text,
  ...(content.isError ? { is_error: true } : {}),
});

/** Pages as people write them: "3", "2-5", "1,4,9-11". Empty = all of them. */
export function parsePages(spec: string | undefined): number[] {
  if (!spec) return [];
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let n = Math.min(from, to); n <= Math.max(from, to); n++) out.add(n);
      continue;
    }
    const one = Number(part.trim());
    if (Number.isFinite(one) && one >= 1) out.add(one);
  }
  return [...out].sort((a, b) => a - b);
}

/** A file inside one of the enabled vaults, by name — pictures live there
 * too, and "OCR that screenshot in my vault" must not need a full path. */
function findInVaults(name: string): string | null {
  const wanted = name.split("\\").join("/").split("/").pop()?.toLowerCase();
  if (!wanted) return null;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 6) return null;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.startsWith(".") || e === "node_modules") continue;
      const abs = join(dir, e);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) dirs.push(abs);
      else if (e.toLowerCase() === wanted) return abs;
    }
    for (const d of dirs) {
      const hit = walk(d, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const v of enabledVaults()) {
    const hit = walk(v.path, 0);
    if (hit) return hit;
  }
  return null;
}

/** A remote document, fetched to a temp file. Size-capped: a scanner is not
 * a downloader, and a 500 MB "PDF" is not what anybody meant. */
async function fetchToTemp(url: string): Promise<{ path: string; error?: string }> {
  const res = await fetch(url);
  if (!res.ok) return { path: "", error: `HTTP ${res.status} fetching ${url}` };
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 100 * 1024 * 1024)
    return { path: "", error: "That file is over 100 MB — download it yourself first." };
  const guess = type.includes("pdf")
    ? ".pdf"
    : type.includes("png")
      ? ".png"
      : type.includes("jpeg") || type.includes("jpg")
        ? ".jpg"
        : type.includes("webp")
          ? ".webp"
          : (new URL(url).pathname.match(/\.[a-z0-9]+$/i)?.[0] ?? ".pdf");
  const dir = mkdtempSync(join(tmpdir(), "monet-ocr-src-"));
  const path = join(dir, `download${guess}`);
  writeFileSync(path, buf);
  return { path };
}

const scanSchema = lazySchema(() =>
  z.strictObject({
    source: z
      .string()
      .describe(
        "What to read: a PDF or image path (absolute, or a name in this chat's files, the workspace, this chat's artifacts, or your Obsidian vault), or an http(s) URL pointing at one.",
      ),
    pages: z
      .string()
      .optional()
      .describe(
        'Which pages of a PDF, 1-based: "3", "2-5", "1,4,9-11". Omit for the whole document (capped by the page limit in settings).',
      ),
  }),
);
type ScanSchema = ReturnType<typeof scanSchema>;

/** Beyond this, the Markdown goes to a file and the model is told where. */
const INLINE_LIMIT = 24_000;

export const OCRScanTool = buildTool({
  name: "OCRScan",
  searchHint: "read a PDF, scan or screenshot into markdown, formulas included",
  maxResultSizeChars: 30_000,
  get inputSchema(): ScanSchema {
    return scanSchema();
  },
  userFacingName() {
    return "OCRScan";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    // One model, one device. Two scans at once are slower than two in a row.
    return false;
  },
  async prompt() {
    const cfg = getOcrConfig();
    return [
      "Read a document with an on-device OCR model and get Markdown back:",
      "formulas as LaTeX, tables as tables, figures as placeholders, in",
      "reading order. Use it whenever the answer depends on what is INSIDE a",
      "PDF, a scan, a screenshot or a photo of a page — including when you",
      "cannot see images yourself, which is the usual case.",
      "",
      "It takes a PDF, a picture, or a URL to either. Ask for the pages you",
      `need: a page takes real time (currently ${cfg.dpi} DPI, up to`,
      `${cfg.maxPages} pages per scan), so "2-5" beats reading a book.`,
      "",
      "RUN IT IN THE BACKGROUND when it is more than a page or two. This is",
      "MINUTES of work per page on a laptop, and a turn spent waiting is a",
      "conversation that has stopped. Hand the job to Task with",
      "run_in_background: true — tell that agent which file and which pages",
      "to OCRScan and what to do with the text — and carry on talking; its",
      "report arrives when the pages are read. Scan inline only when you need",
      "the text to answer the question you are answering right now.",
      "",
      "It is READ-ONLY: it never writes the result anywhere. To keep it, pass",
      "the Markdown to VaultWrite, or write the file yourself.",
    ].join("\n");
  },
  async description({ source }: z.infer<ScanSchema>) {
    return `Read ${basename(source)} into Markdown`;
  },
  async call({ source, pages }: z.infer<ScanSchema>) {
    try {
      const state = await ocrReadiness();
      if (!state.ready)
        return {
          data: {
            text: `The OCR scanner is not ready: ${state.reason ?? "no model installed"}`,
            isError: true,
          },
        };

      let path = "";
      let origin = "";
      if (/^https?:\/\//i.test(source)) {
        const got = await fetchToTemp(source);
        if (got.error) return { data: { text: got.error, isError: true } };
        path = got.path;
        origin = "the web";
      } else {
        const found = resolveSource(source);
        if (found) {
          path = found.path;
          origin = found.origin;
        } else {
          const inVault = findInVaults(source);
          if (inVault) {
            path = inVault;
            origin = "vault";
          }
        }
      }
      if (!path || !existsSync(path))
        return {
          data: {
            text: `Couldn't find "${source}". ${sourceHint()}`,
            isError: true,
          },
        };
      if (!canScan(path))
        return {
          data: {
            text: `${basename(path)} is not a PDF or an image. Convert it first, or point at the pages you want read.`,
            isError: true,
          },
        };

      const result = await scanDocument(path, { pages: parsePages(pages) });
      if (result.error && !result.markdown)
        return { data: { text: `OCR failed: ${result.error}`, isError: true } };

      const head = [
        `Read ${basename(path)}${origin ? ` (from ${origin})` : ""}: ` +
          `${result.pages.length} page(s) of ${result.pageCount}` +
          ` in ${Math.round(result.seconds)}s on the ${result.device || "cpu"}.`,
        result.skipped > 0
          ? `${result.skipped} more page(s) were not read — the per-scan limit is ${getOcrConfig().maxPages}. Ask for a page range to go further.`
          : "",
        result.error ? `Stopped early: ${result.error}` : "",
      ]
        .filter(Boolean)
        .join(" ");

      if (result.markdown.length <= INLINE_LIMIT)
        return { data: { text: `${head}\n\n${result.markdown}` } };

      // Too long to hand over whole: keep it on disk and say where, so the
      // model can read the parts it needs instead of being force-fed a book.
      const dir = mkdtempSync(join(tmpdir(), "monet-ocr-out-"));
      const out = join(dir, `${basename(path).replace(/\.[^.]+$/, "")}.md`);
      writeFileSync(out, result.markdown, "utf-8");
      return {
        data: {
          text:
            `${head}\n\nThe text is ${result.markdown.length} characters — too long to include here. ` +
            `It is written to ${out}; read it (or the part you need) from there.\n\n` +
            `First page:\n\n${result.pages[0]?.markdown.slice(0, 4000) ?? ""}`,
        },
      };
    } catch (err) {
      return {
        data: {
          text: `OCR failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      };
    }
  },
  mapToolResultToToolResultBlockParam: asResult,
  renderToolUseMessage() {
    return null;
  },
});
