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
  const variantBytes = model.variants.find((v) => v.dtype === dtype)?.bytes ?? 0;
  check("the catalogue publishes the variant's weight", variantBytes > 100_000_000);
  // The weight sidecars carry (almost) all of the published mass.
  const sidecarBytes = Math.ceil(variantBytes / Math.max(1, optional.length));
  // Sized files without writing the gigabyte: truncate extends with zeros.
  const write = (rel, bytes) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(Math.min(bytes, 1024), 1));
    fs.truncateSync(full, bytes);
  };

  check("nothing on disk → missing", mod.installState(model, dtype) === "missing");

  // ── The first reported shape ─────────────────────────────────────────
  //
  // Graphs present (they are small and come first), sidecars absent, one of
  // them a half-downloaded `.part` — the folder as the user first showed it.
  for (const p of required) write(p, 400_000);
  write("config.json", 900);
  write("tokenizer.json", 5_200_000);
  write(`${optional[0]}.part`, 25_700_000);
  check(
    "graphs without their weight sidecars → partial, NOT installed",
    mod.installState(model, dtype) === "partial",
    mod.installState(model, dtype),
  );
  check("…so the agent's OCR tool stays off", !mod.isInstalledSync(model, dtype));

  // ── The second reported shape ────────────────────────────────────────
  //
  // The install died exactly BETWEEN files: every graph renamed, no .part
  // anywhere, the big sidecars simply absent. Roll-call passes; only the
  // mass check knows better — and this is the state that let a scan reach
  // onnxruntime and die on decoder_model_merged_q4.onnx_data.
  fs.rmSync(path.join(dir, `${optional[0]}.part`), { force: true });
  check(
    "all names present but most bytes absent → partial, not installed",
    mod.installState(model, dtype) === "partial",
    mod.installState(model, dtype),
  );

  // ── The receipt is what makes "installed" true ───────────────────────
  for (const p of optional) write(p, sidecarBytes);
  const files = [
    ...required.map((p) => ({ path: p, size: 400_000 })),
    ...optional.map((p) => ({ path: p, size: sidecarBytes })),
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
  write(optional[0], sidecarBytes);
  check(
    "no receipt, every file present, full weight on disk → installed",
    mod.installState(model, dtype) === "installed",
    mod.installState(model, dtype),
  );

  // ── A corrupt .part self-heals instead of failing forever ────────────
  //
  // The reported bug's exact shape: the part sits at EXACTLY its published
  // size with the wrong bytes, so the old code skipped the download, flew
  // to the checksum, failed, and left the same bytes for the next attempt.
  {
    const http = require("http");
    const { createHash } = require("crypto");
    const good = Buffer.alloc(1_000_000, 7);
    const sha = createHash("sha256").update(good).digest("hex");
    let served = 0;
    const server = http.createServer((req, res) => {
      served++;
      // Range or not, serve the whole good file — a 200 tells the client
      // its resume was ignored, which the wipe path makes irrelevant.
      res.writeHead(200, { "content-length": String(good.length) });
      res.end(good);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const dl = path.join(root, "dl", "weights.onnx_data");
    fs.mkdirSync(path.dirname(dl), { recursive: true });
    // Full size, wrong bytes — the poisoned resume.
    fs.writeFileSync(`${dl}.part`, Buffer.alloc(1_000_000, 9));

    let progress = 0;
    let threw = null;
    try {
      await mod.downloadFile(
        `http://127.0.0.1:${port}/weights`,
        dl,
        { path: "weights", size: good.length, sha256: sha },
        new AbortController().signal,
        (d) => (progress += d),
      );
    } catch (e) {
      threw = e;
    }
    server.close();

    check("a size-complete corrupt part does not error", threw === null, threw?.message);
    check("…the file was re-fetched clean", served === 1 && fs.existsSync(dl));
    check(
      "…and its bytes now verify",
      fs.existsSync(dl) &&
        createHash("sha256").update(fs.readFileSync(dl)).digest("hex") === sha,
    );
    check("…with no stale .part left behind", !fs.existsSync(`${dl}.part`));
    check(
      "…and the progress accounting nets to one file",
      progress === good.length,
      String(progress),
    );
  }

  // ── A link that drops every ~50 KB still finishes the file ───────────
  //
  // The user's connection to the CDN drops mid-stream, repeatedly. With a
  // flat six-attempt budget a 373 MB file could never come down; attempts
  // that MOVE the file forward now reset the counter, so only a genuine
  // stall (six tries, zero new bytes) is fatal.
  {
    const http = require("http");
    const { createHash } = require("crypto");
    const good = Buffer.alloc(1_000_000, 5);
    const sha = createHash("sha256").update(good).digest("hex");
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests++;
      const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
      const from = m ? Number(m[1]) : 0;
      const slice = good.subarray(from, from + 50_000);
      res.writeHead(m ? 206 : 200, {
        "content-length": String(good.length - from),
        ...(m ? { "content-range": `bytes ${from}-${good.length - 1}/${good.length}` } : {}),
      });
      // Send one chunk of what was promised, then cut the wire.
      res.write(slice);
      setTimeout(() => res.destroy(), 10);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const dl = path.join(root, "dl", "flaky.onnx_data");
    let threw = null;
    try {
      await mod.downloadFile(
        `http://127.0.0.1:${port}/flaky`,
        dl,
        { path: "flaky", size: good.length, sha256: sha },
        new AbortController().signal,
        () => {},
        3, // an even tighter stall budget than the app's
      );
    } catch (e) {
      threw = e;
    }
    server.close();
    check(
      "twenty drops with progress each time still complete the file",
      threw === null && fs.existsSync(dl),
      threw ? threw.message : `${requests} requests`,
    );
    check(
      "…and the bytes verify",
      fs.existsSync(dl) &&
        createHash("sha256").update(fs.readFileSync(dl)).digest("hex") === sha,
    );
    check("…which took more requests than any flat budget", requests > 10, String(requests));
  }

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
