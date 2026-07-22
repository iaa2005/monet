/**
 * First-page thumbnails for PDF files.
 *
 * pdf.js is loaded on demand — a chat with no PDFs never pays for it — and
 * rendering is serialised through a one-at-a-time queue. Fifteen attachments
 * asking for a canvas at once is how you make opening a chat stutter.
 *
 * Results are cached by the caller's key (artifact path, or the staged file's
 * id) for the life of the window, so scrolling and chat switches re-render
 * nothing.
 */

const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

/** Rendered width in device pixels. The tile is ~144 CSS px wide; 320 keeps it
 * sharp on a HiDPI screen without holding megabyte-sized data URLs. */
const TARGET_WIDTH = 320;

type PdfModule = typeof import("pdfjs-dist");
let pdfjs: Promise<PdfModule> | null = null;

function loadPdfjs(): Promise<PdfModule> {
  if (!pdfjs) {
    pdfjs = (async () => {
      // The LEGACY build, deliberately. The modern one calls
      // Uint8Array.prototype.toHex, which Electron 33's Chromium does not
      // have: every render fails with "a.toHex is not a function" and, since
      // a failed thumbnail is silently cached as "none", PDFs would simply
      // never show a preview and nothing would say why.
      const mod = (await import(
        "pdfjs-dist/legacy/build/pdf.min.mjs"
      )) as unknown as PdfModule;
      // Vite rewrites this to the emitted worker chunk; without it pdf.js
      // falls back to "fake worker" mode and parses on the main thread.
      const workerUrl = (
        await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")
      ).default;
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
      return mod;
    })();
  }
  return pdfjs;
}

/** Serialise renders: pdf.js is fast, but decoding several drawing-heavy pages
 * in parallel competes with the UI for the main thread. */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

async function render(bytes: Uint8Array): Promise<string | null> {
  const mod = await loadPdfjs();
  // pdf.js takes ownership of the buffer it is given and detaches it.
  // Hold the loading task: destroy() lives there, not on the document, and it
  // is what releases the worker's copy of the file.
  const task = mod.getDocument({ data: bytes });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: TARGET_WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // A PDF page is transparent where nothing is drawn; on a dark tile that
    // reads as a blank card. Paper is white.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally {
    void doc.cleanup();
    void task.destroy();
  }
}

/**
 * A data URL for page 1, or null when the file cannot be rendered (encrypted,
 * damaged, not actually a PDF). `load` is only called on a cache miss.
 */
export function pdfThumbnail(
  key: string,
  load: () => Promise<Uint8Array | null>,
): Promise<string | null> {
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = inFlight.get(key);
  if (running) return running;

  const job = enqueue(async () => {
    try {
      const bytes = await load();
      const url = bytes ? await render(bytes) : null;
      cache.set(key, url);
      return url;
    } catch {
      cache.set(key, null); // don't retry a file that already failed
      return null;
    } finally {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, job);
  return job;
}

export function isPdf(name: string, mediaType?: string): boolean {
  return (
    mediaType === "application/pdf" || name.toLowerCase().endsWith(".pdf")
  );
}
