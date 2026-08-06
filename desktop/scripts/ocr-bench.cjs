/**
 * The OCR bench: same pages, every candidate, one table.
 *
 * Reading a page with a vision model is slow enough that the choice of model
 * IS the feature. Nothing on the internet answers "which model reads a page
 * of Russian coursework with formulas in under ten seconds on an Intel
 * iGPU" — the benchmarks are quality-per-parameter on somebody's H100. So
 * this runs the candidates on the user's own pages and prints what actually
 * happened.
 *
 * A candidate is a row of data (see CANDIDATES). Adding one is a line, not a
 * refactor, which is the whole point: the answer will change as models ship.
 *
 *   npm run bench:ocr -- <file.pdf> [pages] [candidates]
 *   npm run bench:ocr -- "Иванов ДЗ2.pdf" 1,2 lighton-q4-gpu,smoldocling-q4-gpu
 *
 * Output: a table on stdout, and every candidate's full Markdown next to the
 * PDF in <name>-bench/<candidate>-p<N>.md — speed is half the question and
 * the other half is whether the formulas survived, which only eyes can say.
 */
const { app } = require("electron");
const { existsSync, mkdirSync, writeFileSync } = require("fs");
const { basename, dirname, join, resolve } = require("path");
const { pathToFileURL } = require("url");

/**
 * The field to compare, as data.
 *
 * `engine` picks how it runs:
 *   "transformers" — @huggingface/transformers on onnxruntime-node, the
 *                    engine the app already ships. Weights come from HF.
 *
 * Every candidate names the exact repo and dtype, because "the 1B model"
 * stops meaning anything once there are four quantisations of it and two of
 * them produce garbage.
 */
const CANDIDATES = [
  {
    id: "lighton-q4-gpu",
    label: "LightOnOCR-2 1B q4 · GPU",
    engine: "transformers",
    repo: "onnx-community/LightOnOCR-2-1B-ONNX",
    components: ["embed_tokens", "vision_encoder", "decoder_model_merged"],
    dtype: "q4",
    device: "webgpu",
    prompt: "Convert this page to markdown.",
    note: "What the app ships today — the baseline to beat.",
  },
  {
    id: "smoldocling-q4-gpu",
    label: "SmolDocling 256M q4 · GPU",
    engine: "transformers",
    repo: "ds4sd/SmolDocling-256M-preview",
    components: ["embed_tokens", "vision_encoder", "decoder_model_merged"],
    dtype: "q4",
    device: "webgpu",
    prompt: "Convert this page to docling.",
    note: "A quarter the size, built for documents — DocTags with formulas and tables.",
  },
  {
    id: "smoldocling-q4-cpu",
    label: "SmolDocling 256M q4 · CPU",
    engine: "transformers",
    repo: "ds4sd/SmolDocling-256M-preview",
    components: ["embed_tokens", "vision_encoder", "decoder_model_merged"],
    dtype: "q4",
    device: "cpu",
    prompt: "Convert this page to docling.",
    note: "Small enough that the CPU may beat the iGPU — worth knowing.",
  },
  {
    id: "lighton-q4-cpu",
    label: "LightOnOCR-2 1B q4 · CPU",
    engine: "transformers",
    repo: "onnx-community/LightOnOCR-2-1B-ONNX",
    components: ["embed_tokens", "vision_encoder", "decoder_model_merged"],
    dtype: "q4",
    device: "cpu",
    prompt: "Convert this page to markdown.",
    note: "The floor: no GPU at all.",
  },
];

function parsePages(spec) {
  if (!spec) return [1];
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      for (let n = +range[1]; n <= +range[2]; n++) out.add(n);
      continue;
    }
    const one = Number(part.trim());
    if (Number.isFinite(one) && one >= 1) out.add(one);
  }
  return [...out].sort((a, b) => a - b);
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str.slice(0, n) : str + " ".repeat(n - str.length);
}

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const target = resolve(process.argv[2] ?? "");
  const pages = parsePages(process.argv[3]);
  const only = (process.argv[4] ?? "").split(",").filter(Boolean);
  if (!existsSync(target)) {
    console.log("Usage: npm run bench:ocr -- <file.pdf> [pages] [candidates]");
    console.log("Candidates:", CANDIDATES.map((c) => c.id).join(", "));
    app.exit(1);
    return;
  }
  const bundle = resolve("out/probe/ocr-bench.mjs");
  if (!existsSync(bundle)) {
    console.log("Build first — npm run bench:ocr does it.");
    app.exit(1);
    return;
  }
  const { registerRasteriserIPC, renderPdf, closeRasteriser, benchPage, disposeBench } =
    await import(pathToFileURL(bundle).href);
  registerRasteriserIPC();

  const outDir = join(dirname(target), `${basename(target).replace(/\.[^.]+$/, "")}-bench`);
  mkdirSync(outDir, { recursive: true });

  // Rasterise once and reuse: every candidate must read the SAME pixels, or
  // the comparison is measuring pdf.js.
  const dpi = Number(process.env.BENCH_DPI ?? 150);
  const { dir, pages: images } = await renderPdf(target, { dpi, pages, maxPages: pages.length });
  console.log(
    `\n${basename(target)} — ${images.length} page(s) at ${dpi} DPI (${images[0]?.width}×${images[0]?.height})\n`,
  );

  const run = only.length ? CANDIDATES.filter((c) => only.includes(c.id)) : CANDIDATES;
  const rows = [];

  for (const cand of run) {
    for (const img of images) {
      process.stdout.write(`  ${cand.id} p${img.page} … `);
      const started = Date.now();
      let r;
      try {
        r = await benchPage(cand, img.path);
      } catch (err) {
        r = { error: err && err.message };
      }
      const secs = (Date.now() - started) / 1000;
      if (r.error) {
        console.log(`FAILED: ${r.error}`);
        rows.push({ id: cand.id, page: img.page, secs, tokens: 0, chars: 0, error: r.error });
        continue;
      }
      writeFileSync(join(outDir, `${cand.id}-p${img.page}.md`), r.text, "utf-8");
      console.log(
        `${secs.toFixed(1)}s, ${r.tokens} tokens, ${r.text.length} chars`,
      );
      rows.push({
        id: cand.id,
        page: img.page,
        secs,
        tokens: r.tokens,
        chars: r.text.length,
        load: r.loadSecs,
      });
    }
    disposeBench();
  }

  console.log(
    `\n${pad("candidate", 26)}${pad("page", 6)}${pad("seconds", 10)}${pad("tok/s", 8)}${pad("chars", 8)}`,
  );
  console.log("-".repeat(58));
  for (const r of rows) {
    console.log(
      pad(r.id, 26) +
        pad(r.page, 6) +
        pad(r.error ? "—" : r.secs.toFixed(1), 10) +
        pad(r.error ? "—" : (r.tokens / r.secs).toFixed(1), 8) +
        pad(r.error ? r.error.slice(0, 20) : r.chars, 8),
    );
  }
  console.log(`\nFull text written to ${outDir}`);

  closeRasteriser();
  disposeBench();
  const { rm } = require("fs/promises");
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  app.exit(0);
});
