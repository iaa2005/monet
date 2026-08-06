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
      cb: (req: RasterRequest & { kind: "count" | "render" }) => void,
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
    const pages = await rasterise(req);
    api.ocr?.rasterised({ id: req.id, pages });
  } catch (err) {
    api.ocr?.rasterised({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
