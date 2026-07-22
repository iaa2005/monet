/**
 * The legacy pdf.js build ships no declarations of its own. We use it instead
 * of the modern entry point because that one calls Uint8Array.prototype.toHex,
 * which Electron 33's Chromium lacks — see src/renderer/lib/pdfThumb.ts.
 *
 * The two builds expose the same API, so borrow the typed one's declarations.
 */
declare module "pdfjs-dist/legacy/build/pdf.min.mjs" {
  export * from "pdfjs-dist";
}

declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url" {
  const url: string;
  export default url;
}
