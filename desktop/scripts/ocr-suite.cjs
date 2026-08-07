/**
 * Every page in a folder, through every model, into one report.
 *
 * `bench:ocr` compares candidates on ONE page; this runs the whole set —
 * the awkward documents a real user actually has: two columns, a rotated
 * scan, code, tables, formulas with Cyrillic subscripts. That mix is what
 * decides which model ships, and no benchmark on the internet covers it.
 *
 * It runs the real pipeline (layout → blocks → model), not a whole-page
 * pass, because that is what the app does.
 *
 *   npm run suite:ocr -- <folder> [model-ids]
 *   npm run suite:ocr -- benchmark-scan lightonocr-2-1b,glm-ocr
 *
 * Output: <folder>/_report/<model>/<page>.md for reading with eyes, and
 * <folder>/_report/summary.json for the table.
 */
const { app } = require("electron");
const {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} = require("fs");
const { basename, join, resolve } = require("path");
const { pathToFileURL } = require("url");

const IMAGE = /\.(png|jpe?g|webp|bmp|avif)$/i;

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const folder = resolve(process.argv[2] ?? "");
  if (!existsSync(folder)) {
    console.log("Usage: npm run suite:ocr -- <folder> [model-ids]");
    app.exit(1);
    return;
  }
  const bundle = resolve("out/probe/ocr-scan.mjs");
  if (!existsSync(bundle)) {
    console.log("Build the probe bundle first (npm run suite:ocr does it).");
    app.exit(1);
    return;
  }
  const {
    registerRasteriserIPC,
    scanDocument,
    closeRasteriser,
    disposeOcrEngine,
    setOcrConfig,
    getOcrConfig,
    ALL_MODELS,
  } = await import(pathToFileURL(bundle).href);
  registerRasteriserIPC();

  const wanted = (process.argv[3] ?? "").split(",").filter(Boolean);
  const models = ALL_MODELS.filter((m) =>
    wanted.length ? wanted.includes(m.id) : m.enabled,
  );
  // Naming a model on the command line IS the decision to run it, shelved
  // or not — measuring a candidate is how it stops being one. The app
  // refuses shelved models on purpose (see ocrReadiness), and this bench
  // is the one caller that means it.
  for (const model of models) model.enabled = true;
  const pages = readdirSync(folder)
    .filter((f) => IMAGE.test(f))
    .sort();

  const outRoot = join(folder, "_report");
  mkdirSync(outRoot, { recursive: true });
  const before = getOcrConfig();
  const results = [];

  console.log(
    `\n${pages.length} page(s) × ${models.length} model(s): ${models.map((m) => m.id).join(", ")}\n`,
  );

  for (const model of models) {
    // Every model gets the same settings apart from which model it is —
    // and the device its own entry recommends. `devices` is ordered
    // best-first and is not a preference: one of these models is FASTER
    // ON THE PROCESSOR, by a factor of five, because its int8 graphs fall
    // back node by node on the GPU. Measuring it on the GPU measures the
    // fallback.
    const variant = model.variants[0];
    setOcrConfig({
      modelId: model.id,
      dtype: variant.dtype,
      device: variant.devices[0],
    });
    disposeOcrEngine();
    const dir = join(outRoot, model.id);
    mkdirSync(dir, { recursive: true });

    for (const page of pages) {
      process.stdout.write(`  ${model.id.padEnd(18)} ${page.slice(0, 42).padEnd(44)}`);
      const started = Date.now();
      let r;
      try {
        r = await scanDocument(join(folder, page), {});
      } catch (err) {
        r = { markdown: "", error: err && err.message, blocks: [] };
      }
      const secs = (Date.now() - started) / 1000;
      const md = r.markdown ?? "";
      writeFileSync(
        join(dir, `${basename(page, page.slice(page.lastIndexOf(".")))}.md`),
        md || `<!-- ${r.error ?? "no text"} -->`,
        "utf-8",
      );
      const labels = {};
      for (const b of r.blocks ?? []) labels[b.label] = (labels[b.label] ?? 0) + 1;
      results.push({
        model: model.id,
        page,
        seconds: Math.round(secs * 10) / 10,
        chars: md.length,
        blocks: labels,
        device: r.device ?? "",
        error: r.error ?? null,
      });
      console.log(
        `${secs.toFixed(1).padStart(6)}s  ${String(md.length).padStart(6)} chars` +
          (r.error ? `  ERROR: ${String(r.error).slice(0, 40)}` : ""),
      );
    }
    disposeOcrEngine();
  }

  setOcrConfig({
    modelId: before.modelId,
    dtype: before.dtype,
    device: before.device,
  });
  writeFileSync(
    join(outRoot, "summary.json"),
    JSON.stringify(results, null, 2),
    "utf-8",
  );

  console.log(`\n${"model".padEnd(18)}${"pages".padEnd(7)}${"total".padEnd(9)}${"per page"}`);
  for (const model of models) {
    const mine = results.filter((r) => r.model === model.id);
    const total = mine.reduce((n, r) => n + r.seconds, 0);
    console.log(
      model.id.padEnd(18) +
        String(mine.length).padEnd(7) +
        `${Math.round(total)}s`.padEnd(9) +
        `${(total / Math.max(1, mine.length)).toFixed(1)}s`,
    );
  }
  console.log(`\nText written to ${outRoot}`);

  closeRasteriser();
  disposeOcrEngine();
  app.exit(0);
});
