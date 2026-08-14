/**
 * Bundles the OCR install-state check for the Electron probe.
 *
 * The data dir is whatever MONET_PROBE_DIR says, so the probe can point at a
 * REAL half-installed model folder and ask what the app would conclude about
 * it — which is the whole question.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

const out = resolve("out-probe");
mkdirSync(out, { recursive: true });

const stub = resolve(out, "probe-data-dir.mjs");
writeFileSync(
  stub,
  `import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
const dir =
  process.env.MONET_PROBE_DIR || mkdtempSync(join(tmpdir(), "monet-probe-"));
export function getDataDir() { return dir; }
export function getDataSubdir(name) {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  return d;
}
export function setDataDir() {}
export function isDefaultDataDir() { return true; }
export function applyDataDirEnv() {}
`,
  "utf-8",
);

const entry = resolve(out, "ocr-state-entry.ts");
writeFileSync(
  entry,
  `export {
  installState,
  isInstalledSync,
  modelDir,
} from "../src/main/ocr/install.js";
export { ocrModel, variantFiles } from "../src/main/ocr/catalog.js";
`,
  "utf-8",
);

await build({
  entryPoints: [entry],
  outfile: resolve(out, "ocr-state.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: [
    "electron",
    "better-sqlite3",
    "node:sqlite",
    "onnxruntime-node",
    "@huggingface/transformers",
    "sharp",
  ],
  plugins: [
    {
      name: "probe-stubs",
      setup(b) {
        b.onResolve({ filter: /(^|\/)data-dir\.js$/ }, () => ({ path: stub }));
      },
    },
  ],
  logLevel: "warning",
});
