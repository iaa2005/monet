/**
 * Download the real block finder with the app's own downloadFile and verify.
 *
 * The field failure is "checksum mismatch even after clean re-downloads" on
 * exactly this file, on a link that drops mid-stream. If our resume corrupts
 * bytes at the seams, this reproduces it against the real CDN; the log of
 * absolute progress marks where every seam was.
 *
 *   node scripts/build-ocr-state-probe.mjs && npx electron scripts/ocr-download-repro.cjs
 */

const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { createHash } = require("crypto");

const REPO = "iaa2005/PP-DocLayout_plus-L_onnx";
const FILE = "inference.onnx";

app.whenReady().then(async () => {
  process.env.MONET_PROBE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "monet-dl-repro-"),
  );
  const mod = await import(
    require("url").pathToFileURL(
      path.join(__dirname, "..", "out-probe", "ocr-state.mjs"),
    ).href
  );

  const api = await fetch(`https://huggingface.co/api/models/${REPO}?blobs=true`);
  const json = await api.json();
  const entry = (json.siblings ?? []).find((s) => s.rfilename === FILE);
  console.log(`expect: size=${entry.size} sha=${entry.lfs?.sha256}`);

  const target = path.join(process.env.MONET_PROBE_DIR, "inference.onnx");
  let last = 0;
  const t0 = Date.now();
  try {
    await mod.downloadFile(
      `https://huggingface.co/${REPO}/resolve/main/${FILE}`,
      target,
      { path: FILE, size: entry.size, sha256: entry.lfs?.sha256 },
      new AbortController().signal,
      (b) => {
        // Log walk-backs (a seam) and every ~10 MB.
        if (b < last)
          console.log(`walk-back: ${last} -> ${b} @${Date.now() - t0}ms`);
        else if (Math.floor(b / 10_000_000) !== Math.floor(last / 10_000_000))
          console.log(`  ${(b / 1_000_000).toFixed(0)} MB @${Date.now() - t0}ms`);
        last = b;
      },
    );
    const h = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    console.log(`downloaded ok in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    console.log(`sha ${h === entry.lfs?.sha256 ? "MATCHES" : `MISMATCH: ${h}`}`);
    app.exit(h === entry.lfs?.sha256 ? 0 : 2);
  } catch (e) {
    console.log(`FAILED after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${e.message}`);
    app.exit(1);
  }
});
