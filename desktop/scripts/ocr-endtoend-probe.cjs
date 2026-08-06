/**
 * The whole scanner, once, on a real page.
 *
 * Not part of the smoke set: this loads a gigabyte of weights and generates
 * for minutes. It is the manual proof that the pieces fit — rasteriser, child
 * process, model, Markdown — on the machine in front of you, and it prints
 * the throughput it got so the number in the catalogue can be checked against
 * reality rather than remembered.
 *
 *   npm run probe:ocr -- <file.pdf|file.png> [page]
 */
const { app } = require("electron");
const { existsSync, mkdirSync } = require("fs");
const { resolve } = require("path");

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const target = resolve(process.argv[2] ?? "");
  const page = Number(process.argv[3] ?? 1);
  if (!existsSync(target)) {
    console.log(`Give it a file: npm run probe:ocr -- <file.pdf> [page]`);
    app.exit(1);
    return;
  }
  const bundle = resolve("out/probe/ocr-scan.mjs");
  if (!existsSync(bundle)) {
    console.log("Build the probe bundle first (npm run probe:ocr does it).");
    app.exit(1);
    return;
  }
  const { registerRasteriserIPC, scanDocument, closeRasteriser, disposeOcrEngine } =
    await import(require("url").pathToFileURL(bundle).href);
  registerRasteriserIPC();

  let last = Date.now();
  const started = Date.now();
  const r = await scanDocument(target, {
    pages: [page],
    // BBOX=1 to see what the tool's bbox:true parameter produces.
    bbox: process.env.BBOX === "1",
    onProgress: (p) => {
      // One line per second, so a five-minute page shows life without
      // scrolling the terminal off the screen.
      if (Date.now() - last < 1000) return;
      last = Date.now();
      const secs = (Date.now() - started) / 1000;
      process.stdout.write(
        `\r  page ${p.page}: ${p.tokens} tokens, ${(p.tokens / secs).toFixed(1)} tok/s   `,
      );
    },
  });
  process.stdout.write("\n");

  if (r.error) console.log(`ERROR: ${r.error}`);
  console.log(r.markdown.slice(0, 4000));
  // The summary goes LAST: a long page scrolls the interesting number off
  // the top of the terminal, and the number is the point.
  console.log(
    `
--- ${r.pages.length} page(s) in ${r.seconds.toFixed(1)}s on the ${r.device || "?"}` +
      ` [mode: ${r.mode ?? "?"}]`,
  );
  if (r.blocks && r.blocks.length) {
    const byLabel = {};
    for (const b of r.blocks) byLabel[b.label] = (byLabel[b.label] ?? 0) + 1;
    console.log(
      "    blocks: " +
        Object.entries(byLabel)
          .map(([k, v]) => `${k}×${v}`)
          .join(", "),
    );
    // In reading order, with the y they were found at: an order that looks
    // wrong in the Markdown is either the detector or this sort, and the
    // two are told apart by looking.
    console.log(
      "    order:  " + r.blocks.map((b) => `${b.label}@${b.box[1]}`).join(" → "),
    );
  }

  closeRasteriser();
  disposeOcrEngine();
  app.exit(r.error ? 1 : 0);
});
