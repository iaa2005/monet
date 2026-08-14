/**
 * A model whose weights never arrived is not installed.
 *
 * The bug this locks down: the settings page said "installed" for a download
 * that stopped at 8%, because the check looked at the ONNX graphs (small,
 * downloaded first) and never at the `.onnx_data` sidecars (the gigabyte,
 * downloaded last). Scanning then died inside onnxruntime with
 * `file_size: The system cannot find the file specified`.
 *
 * Run it against a scratch copy of the real broken folder when there is one:
 *   MONET_OCR_BROKEN=D:\tmp\monet-fresh node scripts/build-ocr-state-probe.mjs
 *   && npx electron scripts/ocr-state-probe.cjs
 */

const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

app.whenReady().then(async () => {
  let failures = 0;
  const check = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monet-ocr-probe-"));
  process.env.MONET_PROBE_DIR = root;

  const mod = await import(
    require("url").pathToFileURL(
      path.join(__dirname, "..", "out-probe", "ocr-state.mjs"),
    ).href
  );

  const model = mod.ocrModel("glm-ocr");
  check("the catalogue knows glm-ocr", !!model, model?.repo);
  if (!model) {
    app.exit(1);
    return;
  }
  const dtype = "q4";
  const dir = mod.modelDir(model);
  const { required, optional } = mod.variantFiles(model, dtype);
  const write = (rel, bytes) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(bytes, 1));
  };

  check("nothing on disk → missing", mod.installState(model, dtype) === "missing");

  // ── The exact shape of the reported failure ──────────────────────────
  //
  // Graphs present (they are small and come first), sidecars absent, one of
  // them a half-downloaded `.part` — this is the folder the user showed.
  for (const p of required) write(p, 400_000);
  write("config.json", 900);
  write("tokenizer.json", 5_200_000);
  write(`${optional[0]}.part`, 55_700_000);
  check(
    "graphs without their weight sidecars → partial, NOT installed",
    mod.installState(model, dtype) === "partial",
    mod.installState(model, dtype),
  );
  check("…so the agent's OCR tool stays off", !mod.isInstalledSync(model, dtype));

  // ── The receipt is what makes "installed" true ───────────────────────
  fs.rmSync(path.join(dir, `${optional[0]}.part`), { force: true });
  for (const p of optional) write(p, 55_700_000);
  const files = [
    ...required.map((p) => ({ path: p, size: 400_000 })),
    ...optional.map((p) => ({ path: p, size: 55_700_000 })),
    { path: "config.json", size: 900 },
    { path: "tokenizer.json", size: 5_200_000 },
  ];
  fs.writeFileSync(
    path.join(dir, ".monet-install.json"),
    JSON.stringify({ variants: { [dtype]: files } }),
  );
  check(
    "a receipt whose files all match → installed",
    mod.installState(model, dtype) === "installed",
  );

  // ── A receipt that no longer matches the disk ────────────────────────
  fs.rmSync(path.join(dir, optional[0]), { force: true });
  check(
    "delete a sidecar behind its back → partial again",
    mod.installState(model, dtype) === "partial",
    mod.installState(model, dtype),
  );

  // ── The pre-receipt install that IS complete keeps working ───────────
  fs.rmSync(path.join(dir, ".monet-install.json"), { force: true });
  write(optional[0], 55_700_000);
  check(
    "no receipt but every file present and no .part → installed",
    mod.installState(model, dtype) === "installed",
  );

  // ── The real folder, when one was named ──────────────────────────────
  const broken = process.env.MONET_OCR_BROKEN;
  if (broken && fs.existsSync(broken)) {
    process.env.MONET_PROBE_DIR = broken;
    // The stub caches the dir at import time, so re-import under a fresh
    // query string to read the other tree.
    const live = await import(
      `${require("url").pathToFileURL(path.join(__dirname, "..", "out-probe", "ocr-state.mjs")).href}?real`
    );
    const m2 = live.ocrModel("glm-ocr");
    const state = live.installState(m2, dtype);
    check(
      `the real half-downloaded folder reads as partial (${broken})`,
      state === "partial",
      state,
    );
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(
    failures === 0
      ? "\nA MODEL WHOSE WEIGHTS NEVER ARRIVED IS NOT INSTALLED"
      : `\n${failures} FAILURES`,
  );
  app.exit(failures ? 1 : 0);
});
