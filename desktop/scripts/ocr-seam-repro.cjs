/**
 * Does OUR resume corrupt bytes at real-CDN seams?
 *
 * The clean single-stream download verified; the field failures all happened
 * on a link that drops every ~15-25 MB. The synthetic flaky-server probe
 * passes too — but it never exercises Range-through-redirect against the
 * real CDN. This closes that gap: a local proxy streams the REAL file from
 * HuggingFace and cuts the wire every ~15 MB, so the downloader's resume
 * path runs against the real thing, many times, and the sha at the end is
 * the verdict.
 *
 *   node scripts/build-ocr-state-probe.mjs && npx electron scripts/ocr-seam-repro.cjs
 */

const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { createHash } = require("crypto");

const REPO = process.env.SEAM_REPO || "iaa2005/PP-DocLayout_plus-L_onnx";
const FILE = process.env.SEAM_FILE || "inference.onnx";
const CUT_EVERY = Number(process.env.SEAM_CUT || 15_000_000);

app.whenReady().then(async () => {
  process.env.MONET_PROBE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "monet-seam-repro-"),
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

  let seams = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      const headers = {};
      if (req.headers.range) headers.Range = req.headers.range;
      const up = await fetch(
        `https://huggingface.co/${REPO}/resolve/main/${FILE}`,
        { headers },
      );
      const pass = {};
      for (const h of ["content-length", "content-range", "accept-ranges"]) {
        const v = up.headers.get(h);
        if (v) pass[h] = v;
      }
      console.log(
        `proxy: range=${req.headers.range ?? "(none)"} -> ${up.status} ${pass["content-range"] ?? ""}`,
      );
      res.writeHead(up.status, pass);
      let sent = 0;
      const reader = up.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value)))
          await new Promise((r) => res.once("drain", r));
        sent += value.length;
        if (sent >= CUT_EVERY) {
          seams++;
          res.destroy();
          await reader.cancel().catch(() => {});
          return;
        }
      }
      res.end();
    })().catch(() => res.destroy());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const target = path.join(process.env.MONET_PROBE_DIR, "inference.onnx");
  let last = 0;
  const t0 = Date.now();
  try {
    await mod.downloadFile(
      `http://127.0.0.1:${port}/${FILE}`,
      target,
      { size: entry.size, sha256: entry.lfs?.sha256 },
      {
        onBytes: (b) => {
          if (b < last) console.log(`walk-back: ${last} -> ${b}`);
          last = b;
        },
      },
    );
    const h = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    console.log(
      `done in ${((Date.now() - t0) / 1000).toFixed(0)}s across ${seams} forced seams`,
    );
    console.log(`sha ${h === entry.lfs?.sha256 ? "MATCHES" : `MISMATCH: ${h}`}`);
    server.close();
    app.exit(h === entry.lfs?.sha256 ? 0 : 2);
  } catch (e) {
    console.log(`FAILED after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${e.message}`);
    server.close();
    app.exit(1);
  }
});
