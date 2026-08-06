/**
 * Bundles src/main/ocr/render.ts for the Electron rasteriser probe.
 *
 * Same two reasons as build-stt-probe.mjs: esbuild's synchronous API
 * deadlocks inside Electron's main process, so bundling happens in plain
 * Node; and the probe must not touch the user's data dir.
 *
 * ESM, not CommonJS, and that is the whole point. The app's main bundle is
 * ESM, where `__dirname` does not exist — a CommonJS probe bundle has one
 * and therefore passes code that throws ReferenceError in the real app.
 * That exact bug shipped once. The probe imports these dynamically.
 *
 * One extra thing this arranges: the rasteriser finds its HTML and its
 * preload relative to `__dirname` (`../renderer/rasterise.html`), which in
 * the built app means out/main. So the bundle is written to out/probe/,
 * where those same relative paths land on the real built files — which is
 * the point, since resolving them wrongly is one of the failures this probe
 * exists to catch.
 */
import { build } from "esbuild";
import { mkdirSync } from "fs";
import { resolve } from "path";

const out = resolve("out/probe");
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve("src/main/ocr/render.ts")],
  outfile: resolve(out, "ocr-render.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron"],
  logLevel: "warning",
});

// The end-to-end probe drives the whole scanner, so it gets a bundle with
// the engine in it too — plus the model child the engine forks, which it
// looks for beside itself.
await build({
  entryPoints: [resolve("src/main/ocr/ocr.child.ts")],
  outfile: resolve(out, "ocr-child.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron", "@huggingface/transformers"],
  logLevel: "warning",
});

// The bench: candidates the app does not have installed, on devices the
// settings do not offer.
await build({
  entryPoints: [resolve("scripts/ocr-bench-entry.ts")],
  outfile: resolve(out, "ocr-bench.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron", "@huggingface/transformers"],
  logLevel: "warning",
});

await build({
  entryPoints: [resolve("scripts/ocr-scan-entry.ts")],
  outfile: resolve(out, "ocr-scan.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron"],
  logLevel: "warning",
});
