/**
 * The hidden rasteriser window's only script.
 *
 * Main sends it a PDF (as bytes, over IPC), it draws pages onto a canvas and
 * sends PNGs back. It knows nothing about OCR — this is a document-to-picture
 * service, and the app has exactly one place that can draw: Chromium.
 *
 * The pdf.js build is the LEGACY one, for the same reason the thumbnail code
 * gives: the modern build calls Uint8Array.prototype.toHex, which this
 * Chromium does not have, and every render fails with "a.toHex is not a
 * function".
 */

type PdfModule = typeof import("pdfjs-dist");

interface RasterRequest {
  id: number;
  bytes: ArrayBuffer;
  /** Rendering resolution. A PDF point is 1/72 inch, so scale = dpi / 72. */
  dpi: number;
  /** 1-based page numbers; empty means every page up to `maxPages`. */
  pages: number[];
  maxPages: number;
}

interface RasterPage {
  page: number;
  /** PNG bytes. Lossless on purpose: JPEG artefacts around thin glyphs are
   * exactly what turns a subscript into a smudge for an OCR model. */
  png: ArrayBuffer;
  width: number;
  height: number;
  /**
   * The same page squashed to the layout detector's fixed input, as RGB
   * bytes. Done here because this window already has the pixels and a
   * resampler; doing it in main would mean decoding the PNG again with a
   * library main does not have.
   */
  layoutRgb?: ArrayBuffer;
}

/** The layout model's input side — see main/ocr/layout.ts. */
const LAYOUT_SIZE = 800;

interface CropRequest {
  id: number;
  kind: "crop";
  /** PNG of the page to cut up. */
  bytes: ArrayBuffer;
  /** [x1, y1, x2, y2] in that PNG's own pixels. */
  boxes: [number, number, number, number][];
  /** Grown by this many pixels on every side — see the note in cropPage. */
  pad: number;
}

let pdfjs: Promise<PdfModule> | null = null;

function loadPdfjs(): Promise<PdfModule> {
  if (!pdfjs) {
    pdfjs = (async () => {
      const mod = (await import(
        "pdfjs-dist/legacy/build/pdf.min.mjs"
      )) as unknown as PdfModule;
      const workerUrl = (
        await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")
      ).default;
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
      return mod;
    })();
  }
  return pdfjs;
}

async function toPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("canvas produced no image");
  return blob.arrayBuffer();
}

/** The page at the detector's input size, as RGB triples. */
function toLayoutRgb(source: HTMLCanvasElement): ArrayBuffer {
  const small = document.createElement("canvas");
  small.width = LAYOUT_SIZE;
  small.height = LAYOUT_SIZE;
  const ctx = small.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  // The model was exported with keep_ratio:false — it expects the page
  // squashed to a square, not letterboxed, and its boxes come back mapped
  // to the original aspect. Preserving the ratio here would silently skew
  // every coordinate.
  ctx.drawImage(source, 0, 0, LAYOUT_SIZE, LAYOUT_SIZE);
  const { data } = ctx.getImageData(0, 0, LAYOUT_SIZE, LAYOUT_SIZE);
  const rgb = new Uint8Array(LAYOUT_SIZE * LAYOUT_SIZE * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return rgb.buffer;
}

/**
 * Cut the page into the blocks the detector found.
 *
 * Each crop is grown slightly: a box drawn tight around a formula clips the
 * descender of an integral sign or the bar of a fraction, and the model then
 * reads a symbol that is not there. A few pixels of paper cost nothing.
 */
async function cropPage(req: CropRequest): Promise<RasterPage[]> {
  const blob = new Blob([req.bytes], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const out: RasterPage[] = [];
  for (let i = 0; i < req.boxes.length; i++) {
    const [x1, y1, x2, y2] = req.boxes[i];
    const left = Math.max(0, x1 - req.pad);
    const top = Math.max(0, y1 - req.pad);
    const right = Math.min(bitmap.width, x2 + req.pad);
    const bottom = Math.min(bitmap.height, y2 + req.pad);
    const w = Math.max(1, right - left);
    const h = Math.max(1, bottom - top);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, left, top, w, h, 0, 0, w, h);
    out.push({ page: i, png: await toPng(canvas), width: w, height: h });
  }
  bitmap.close();
  return out;
}

async function rasterise(req: RasterRequest): Promise<RasterPage[]> {
  const mod = await loadPdfjs();
  const task = mod.getDocument({ data: new Uint8Array(req.bytes) });
  const doc = await task.promise;
  const out: RasterPage[] = [];
  try {
    const wanted =
      req.pages.length > 0
        ? req.pages.filter((n) => n >= 1 && n <= doc.numPages)
        : Array.from({ length: doc.numPages }, (_, i) => i + 1);
    for (const n of wanted.slice(0, req.maxPages)) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: req.dpi / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      // A PDF page is transparent where nothing is drawn. To an OCR model
      // that reads as black paper.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      out.push({
        page: n,
        png: await toPng(canvas),
        width: canvas.width,
        height: canvas.height,
        layoutRgb: toLayoutRgb(canvas),
      });
      page.cleanup();
    }
    return out;
  } finally {
    void doc.cleanup();
    void task.destroy();
  }
}

/** How many pages the document has — asked before deciding what to scan. */
async function count(bytes: ArrayBuffer): Promise<number> {
  const mod = await loadPdfjs();
  const task = mod.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const n = doc.numPages;
  void task.destroy();
  return n;
}

const api = window.electronAPI as unknown as {
  ocr?: {
    onRasterise: (
      cb: (req: RasterRequest & { kind: "count" | "render" | "crop" }) => void,
    ) => void;
    rasterised: (payload: unknown) => void;
  };
};

api.ocr?.onRasterise(async (req) => {
  try {
    if (req.kind === "count") {
      api.ocr?.rasterised({ id: req.id, pageCount: await count(req.bytes) });
      return;
    }
    if (req.kind === "crop") {
      const crops = await cropPage(req as unknown as CropRequest);
      api.ocr?.rasterised({ id: req.id, pages: crops });
      return;
    }
    const pages = await rasterise(req);
    api.ocr?.rasterised({ id: req.id, pages });
  } catch (err) {
    api.ocr?.rasterised({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
