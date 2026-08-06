/**
 * Documents in, page images out.
 *
 * An OCR model reads pictures, so everything the scanner accepts has to
 * become one first. PDFs are drawn by pdf.js in a hidden window (see
 * rasterise.ts for why a window and not a native canvas); pictures are
 * already pictures and pass straight through.
 *
 * The window is created on demand and closed when the work stops — it holds
 * a pdf.js worker and a canvas the size of a page, and there is no reason for
 * that to exist while nobody is scanning.
 */

import { BrowserWindow, ipcMain } from "electron";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { moduleDir } from "./module-dir.js";

/** Extensions the model can look at as they are. */
const IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".avif",
]);

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXT.has(path.slice(dot).toLowerCase());
}

export function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

interface RasterReply {
  id: number;
  pages?: {
    page: number;
    png: ArrayBuffer;
    width: number;
    height: number;
    layoutRgb?: ArrayBuffer;
  }[];
  pageCount?: number;
  error?: string;
}

let win: BrowserWindow | null = null;
let ready: Promise<BrowserWindow> | null = null;
let nextId = 1;
const waiting = new Map<number, (r: RasterReply) => void>();
let idleTimer: NodeJS.Timeout | null = null;

/** Close the rasteriser once nothing has used it for a while. */
function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeRasteriser(), 60_000);
}

export function closeRasteriser(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  ready = null;
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

function rendererEntry(): { url?: string; file?: string } {
  const dev = process.env["ELECTRON_RENDERER_URL"];
  if (dev) return { url: `${dev}/rasterise.html` };
  return { file: join(moduleDir, "../renderer/rasterise.html") };
}

function openRasteriser(): Promise<BrowserWindow> {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    const w = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: {
        preload: join(moduleDir, "../preload/index.mjs"),
        sandbox: false,
        // Nothing here is user content and nothing is displayed; this window
        // renders the app's own bundled script and talks only to main.
        backgroundThrottling: false,
      },
    });
    w.on("closed", () => {
      win = null;
      ready = null;
    });
    w.webContents.once("did-finish-load", () => {
      win = w;
      resolve(w);
    });
    w.webContents.once("did-fail-load", (_e, code, desc) => {
      w.destroy();
      ready = null;
      reject(new Error(`rasteriser failed to load (${code}): ${desc}`));
    });
    const entry = rendererEntry();
    if (entry.url) void w.loadURL(entry.url);
    else void w.loadFile(entry.file!);
  });
  return ready;
}

/** Wired once at startup: the hidden window's replies land here. */
export function registerRasteriserIPC(): void {
  ipcMain.on("ocr:rasterised", (_e, reply: RasterReply) => {
    const resolve = waiting.get(reply.id);
    if (!resolve) return;
    waiting.delete(reply.id);
    resolve(reply);
  });
}

async function askRasteriser(
  payload: Record<string, unknown>,
): Promise<RasterReply> {
  const w = await openRasteriser();
  const id = nextId++;
  touchIdle();
  return new Promise((resolve, reject) => {
    // A page that never comes back must not hang a whole scan; pdf.js can
    // take a while on a heavy page, so this is generous rather than tight.
    const timer = setTimeout(() => {
      if (!waiting.delete(id)) return;
      reject(new Error("rasteriser timed out"));
    }, 120_000);
    waiting.set(id, (r: RasterReply) => {
      clearTimeout(timer);
      resolve(r);
    });
    w.webContents.send("ocr:rasterise", { ...payload, id });
  });
}

/** How many pages a PDF has. */
export async function pdfPageCount(pdfPath: string): Promise<number> {
  const bytes = readFileSync(pdfPath);
  const reply = await askRasteriser({
    kind: "count",
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  });
  if (reply.error) throw new Error(reply.error);
  return reply.pageCount ?? 0;
}

export interface RenderedPage {
  page: number;
  path: string;
  width: number;
  height: number;
  /** The page at the layout detector's input size, RGB. */
  layoutRgb?: Uint8Array;
}

/**
 * Draw a PDF's pages into a temporary folder.
 *
 * The caller owns the folder and is expected to delete it (`disposePages`) —
 * page images of a 40-page paper are a hundred megabytes, and leaving them
 * behind is how a temp directory becomes a disk-space bug months later.
 */
export async function renderPdf(
  pdfPath: string,
  opts: { dpi: number; pages?: number[]; maxPages: number },
): Promise<{ dir: string; pages: RenderedPage[] }> {
  const bytes = readFileSync(pdfPath);
  const reply = await askRasteriser({
    kind: "render",
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    dpi: opts.dpi,
    pages: opts.pages ?? [],
    maxPages: opts.maxPages,
  });
  if (reply.error) throw new Error(reply.error);
  const dir = mkdtempSync(join(tmpdir(), "monet-ocr-"));
  const pages: RenderedPage[] = [];
  for (const p of reply.pages ?? []) {
    const path = join(dir, `page-${String(p.page).padStart(3, "0")}.png`);
    writeFileSync(path, Buffer.from(p.png));
    pages.push({
      page: p.page,
      path,
      width: p.width,
      height: p.height,
      layoutRgb: p.layoutRgb ? new Uint8Array(p.layoutRgb) : undefined,
    });
  }
  return { dir, pages };
}

/**
 * A picture, described the way a rendered page is.
 *
 * The block-by-block path needs a page's size and the detector's input; for
 * a PDF those come from drawing it, for an image from measuring it. Same
 * shape out, so everything downstream stops caring which it was.
 */
export async function measureImage(imagePath: string): Promise<RenderedPage> {
  const bytes = readFileSync(imagePath);
  const reply = await askRasteriser({
    kind: "image",
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  });
  if (reply.error) throw new Error(reply.error);
  const p = reply.pages?.[0];
  if (!p) throw new Error("the rasteriser returned nothing for that image");
  return {
    page: 1,
    path: imagePath,
    width: p.width,
    height: p.height,
    layoutRgb: p.layoutRgb ? new Uint8Array(p.layoutRgb) : undefined,
  };
}

/**
 * Cut a rendered page into the blocks a detector found.
 *
 * The crops land beside the page they came from, named for their index, so a
 * failed scan leaves something a human can look at instead of a temp file
 * nobody can match to a box.
 */
let cropRun = 0;

export async function cropBlocks(
  pagePath: string,
  boxes: [number, number, number, number][],
  pad = 6,
): Promise<{ path: string; width: number; height: number }[]> {
  if (boxes.length === 0) return [];
  const bytes = readFileSync(pagePath);
  const reply = await askRasteriser({
    kind: "crop",
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    boxes,
    pad,
  });
  if (reply.error) throw new Error(reply.error);
  const base = pagePath.replace(/\.png$/i, "");
  // Every CALL gets its own prefix. Blocks are cut in groups (a formula is
  // padded more than a paragraph), and numbering within the group meant the
  // second group's block-000 overwrote the first group's — so a heading was
  // read from a formula's picture and printed as a heading. The mismatch was
  // invisible until the boxes were printed next to the text.
  const run = ++cropRun;
  const out: { path: string; width: number; height: number }[] = [];
  for (const p of reply.pages ?? []) {
    const path = `${base}-b${run}-${String(p.page).padStart(3, "0")}.png`;
    writeFileSync(path, Buffer.from(p.png));
    out.push({ path, width: p.width, height: p.height });
  }
  return out;
}

export async function disposePages(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
