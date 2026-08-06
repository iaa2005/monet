/**
 * The hidden window that turns PDF pages into pictures.
 *
 * This is the half of the OCR scanner that cannot be checked without
 * Electron: main has no canvas, so pages are drawn by pdf.js inside a
 * BrowserWindow nobody sees. Everything about that arrangement is easy to
 * get subtly wrong and hard to notice — the window loads the wrong entry,
 * the preload bridge is not on it, the reply comes back on a channel nobody
 * listens to, the page renders at 1x instead of 150 DPI — and every one of
 * those failures looks the same from outside: "OCR is stuck".
 *
 * So: a real PDF in, real PNG bytes out, at the size the DPI implies.
 *
 * Runs against the BUILT renderer (out/renderer + out/preload):
 *   npm run smoke:raster
 */
const { app } = require("electron");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const { join, resolve } = require("path");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** A two-page PDF, written by hand: no fixture file, no network, and small
 * enough to read in the diff. */
function makePdf() {
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>";
  const pageObj = (contents) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${contents} 0 R >>`;
  objs[3] = pageObj(5);
  objs[4] = pageObj(6);
  const c1 = "BT /F1 36 Tf 72 700 Td (PAGE ONE) Tj ET";
  const c2 = "BT /F1 36 Tf 72 700 Td (PAGE TWO) Tj ET";
  objs[5] = `<< /Length ${c1.length} >>\nstream\n${c1}\nendstream`;
  objs[6] = `<< /Length ${c2.length} >>\nstream\n${c2}\nendstream`;
  objs[7] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++)
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// A hidden window that gets destroyed must not end the probe: Electron
// quits by default once the last window closes, which would look like a
// pass that simply stopped printing.
app.on("window-all-closed", () => {});
process.on("unhandledRejection", (err) => {
  check("no unhandled rejection", false, err && (err.message || String(err)));
});

app.whenReady().then(async () => {
  const bundle = resolve("out/probe/ocr-render.cjs");
  if (!existsSync(bundle)) {
    check("the probe bundle exists", false, "run npm run smoke:raster (it builds first)");
    app.exit(1);
    return;
  }
  const {
    registerRasteriserIPC,
    renderPdf,
    pdfPageCount,
    closeRasteriser,
    isPdfPath,
    isImagePath,
  } = require(bundle);

  check("a PDF is recognised as one", isPdfPath("x.PDF") && !isPdfPath("x.png"));
  check("pictures are recognised too", isImagePath("shot.JPG") && !isImagePath("a.txt"));

  const dir = mkdtempSync(join(tmpdir(), "ocr-raster-probe-"));
  const pdf = join(dir, "two-pages.pdf");
  writeFileSync(pdf, makePdf());

  registerRasteriserIPC();

  try {
    check("the rasteriser counts the pages", (await pdfPageCount(pdf)) === 2);

    const one = await renderPdf(pdf, { dpi: 150, pages: [2], maxPages: 10 });
    check(
      "it renders exactly the page asked for",
      one.pages.length === 1 && one.pages[0].page === 2,
      one.pages.map((p) => p.page).join(),
    );
    // 612 pt at 150 DPI is 1275 px. A window that quietly rendered at 1x
    // would hand the model a 612 px page and OCR would be bad forever
    // without anything failing.
    check("at the resolution asked for", one.pages[0]?.width === 1275, one.pages[0]?.width);
    check("the picture is on disk", existsSync(one.pages[0]?.path ?? ""));
    const bytes = readFileSync(one.pages[0].path);
    check(
      "and it is a real PNG, not an empty canvas",
      bytes.length > 2000 && bytes.subarray(1, 4).toString() === "PNG",
      `${bytes.length} bytes`,
    );

    const all = await renderPdf(pdf, { dpi: 100, maxPages: 10 });
    check("no page list means every page", all.pages.length === 2, all.pages.length);
    check("a lower DPI is a smaller picture", all.pages[0].width === 850, all.pages[0].width);

    const capped = await renderPdf(pdf, { dpi: 100, maxPages: 1 });
    check("the page cap is obeyed", capped.pages.length === 1, capped.pages.length);

    for (const d of [one.dir, all.dir, capped.dir])
      rmSync(d, { recursive: true, force: true });
  } catch (err) {
    check("the rasteriser answers at all", false, err && err.message);
  }

  closeRasteriser();
  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? "\nALL RASTERISER CHECKS PASSED" : `\n${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
