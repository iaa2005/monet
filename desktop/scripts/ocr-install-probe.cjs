/**
 * Install a model the way a user installs it, then read a page with it.
 *
 * The end-to-end question this answers is not "does the model work" — the
 * suite covers that — but "is what somebody PUBLISHED what this installer
 * expects": the file names a variant asks for, the config files it needs,
 * the sizes the manifest promises. A repo that is one filename off
 * installs to 99% and then fails at load with a message about the model.
 *
 *   npm run probe:ocr-install -- <model-id> [page.png]
 */
const { app } = require("electron");
const { existsSync, rmSync } = require("fs");
const { resolve } = require("path");
const { pathToFileURL } = require("url");

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const modelId = process.argv[2];
  const page = process.argv[3];
  if (!modelId) {
    console.log("Usage: npm run probe:ocr-install -- <model-id> [page.png]");
    app.exit(1);
    return;
  }
  const bundle = resolve("out/probe/ocr-scan.mjs");
  if (!existsSync(bundle)) {
    check("the probe bundle exists", false, "run the npm script, it builds first");
    app.exit(1);
    return;
  }
  const {
    ALL_MODELS,
    installOcrModel,
    isInstalled,
    setOcrConfig,
    getOcrConfig,
    registerRasteriserIPC,
    scanDocument,
    closeRasteriser,
    disposeOcrEngine,
  } = await import(pathToFileURL(bundle).href);

  const model = ALL_MODELS.find((m) => m.id === modelId);
  check(`the catalogue knows ${modelId}`, !!model);
  if (!model) {
    app.exit(1);
    return;
  }
  model.enabled = true;
  const dtype = model.variants[0].dtype;

  const before = getOcrConfig();
  console.log(`\n${model.label} ${dtype} from ${model.repo}\n`);

  let lastPercent = -1;
  const started = Date.now();
  const result = await installOcrModel(modelId, dtype, (p) => {
    if (p.percent === lastPercent) return;
    lastPercent = p.percent;
    process.stdout.write(
      `\r  ${String(p.percent).padStart(3)}%  ${(p.loaded / 1024 / 1024).toFixed(0)} of ${(p.total / 1024 / 1024).toFixed(0)} MB  ${p.file ?? ""}          `,
    );
  });
  process.stdout.write("\n\n");

  check("the download finished", result.ok, result.error);
  check(
    "…and the installer agrees it is installed",
    await isInstalled(model, dtype),
  );
  console.log(`  ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

  if (result.ok && page && existsSync(page)) {
    registerRasteriserIPC();
    // "auto", the way it arrives out of the box — so this also checks that
    // Automatic resolves to the device the catalogue measured as best,
    // which for this model is the PROCESSOR.
    setOcrConfig({ modelId, dtype, device: "auto" });
    disposeOcrEngine();
    const scanStarted = Date.now();
    const r = await scanDocument(page, {});
    const text = r.markdown ?? "";
    check("a page downloaded weights can read a page", text.length > 200, {
      error: r.error,
      chars: text.length,
    });
    check(
      `Automatic chose the device the catalogue asks for (${model.variants[0].devices[0]})`,
      r.device === model.variants[0].devices[0],
      { asked: model.variants[0].devices, used: r.device },
    );
    console.log(
      `\n  ${((Date.now() - scanStarted) / 1000).toFixed(1)}s, ${text.length} chars\n`,
    );
    console.log(text.slice(0, 400));
    disposeOcrEngine();
    await closeRasteriser();
  }

  setOcrConfig({ modelId: before.modelId, dtype: before.dtype, device: before.device });
  console.log(failures ? `\n${failures} FAILED` : "\nINSTALL PROBE PASSED");
  app.exit(failures ? 1 : 0);
});
