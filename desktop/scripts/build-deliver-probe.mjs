/**
 * Bundles DeliverFilesTool for the Electron probe.
 *
 * Same shape as the terminal probe: data dir redirected to a scratch folder
 * (MONET_PROBE_DIR) so the probe never writes into the user's chats, and
 * treeshaking stays ON only for what esbuild proves unused — the tool module
 * itself is imported as a value, so its code arrives as written.
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

const entry = resolve(out, "deliver-entry.ts");
writeFileSync(
  entry,
  `export { DeliverFilesTool } from "../src/main/agent/deliver-files-tool.js";
export { sandboxWorkDir } from "../src/main/sandbox/podman-engine.js";
export { artifactSessionDir } from "../src/main/ipc/artifacts.js";
`,
  "utf-8",
);

await build({
  entryPoints: [entry],
  outfile: resolve(out, "deliver.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: [
    "electron",
    "better-sqlite3",
    "node:sqlite",
    "@lydell/node-pty",
    "sherpa-onnx-node",
    "onnxruntime-node",
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
