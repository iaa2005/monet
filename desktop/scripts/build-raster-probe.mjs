/**
 * Bundles src/main/ocr/render.ts for the Electron rasteriser probe.
 *
 * Same two reasons as build-stt-probe.mjs: esbuild's synchronous API
 * deadlocks inside Electron's main process, so bundling happens in plain
 * Node; and the probe must not touch the user's data dir.
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
  outfile: resolve(out, "ocr-render.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
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

await build({
  entryPoints: [resolve("scripts/ocr-scan-entry.ts")],
  outfile: resolve(out, "ocr-scan.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  logLevel: "warning",
});
