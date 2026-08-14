/**
 * Bundles the purge module (and the stores it round-trips through) for the
 * Electron probe.
 *
 * Same two reasons as the stt probe: esbuild's sync API deadlocks inside
 * Electron's main process, and the data dir is redirected to a scratch folder
 * so a probe can never write into the user's real chats.
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

const sandboxIndex = resolve(out, "probe-sandbox-index.mjs");
writeFileSync(
  sandboxIndex,
  `export function mediaTypeOf(name) {
  return name.endsWith(".png") ? "image/png" : "application/octet-stream";
}
`,
  "utf-8",
);
const sandboxFiles = resolve(out, "probe-sandbox-files.mjs");
writeFileSync(
  sandboxFiles,
  `export function listSandboxFiles() { return []; }
export function copyBufferIntoSandbox() {}
`,
  "utf-8",
);

// One entry re-exporting everything the probe drives, so the bundle shares a
// single module instance of each store (two bundles = two DB handles).
const entry = resolve(out, "purge-entry.ts");
writeFileSync(
  entry,
  `export { getSessionStore } from "../src/main/session/store.js";
export {
  replaceTranscript,
  loadTranscriptWithMeta,
  recordContextEvent,
  listContextEvents,
} from "../src/main/session/transcript.js";
export { setUiState, getUiState } from "../src/main/session/ui-state.js";
export { saveGoal, loadGoal } from "../src/main/agent/goal/store.js";
export { purgeSessionData, sweepOrphans } from "../src/main/session/purge.js";
export { getDataSubdir } from "../src/main/data-dir.js";
export * as planStore from "../src/main/plan/store.js";
`,
  "utf-8",
);

await build({
  entryPoints: [entry],
  // ESM: session-store uses createRequire(import.meta.url), which a CJS
  // bundle cannot express. The probe dynamic-imports the result.
  outfile: resolve(out, "purge.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  // Electron and the native bindings come from the runtime. node-pty arrived
  // here through purge → terminal/sessions (deleting a chat kills its shell);
  // bundling a .node binding is not something esbuild can do.
  external: [
    "electron",
    "better-sqlite3",
    "node:sqlite",
    "@lydell/node-pty",
  ],
  plugins: [
    {
      name: "probe-stubs",
      setup(b) {
        b.onResolve({ filter: /(^|\/)data-dir\.js$/ }, () => ({ path: stub }));
        // The sandbox stack drags Pyodide (and an import.meta worker URL that
        // cannot be expressed in CJS). The probe drives artifacts, not the
        // sandbox, so those two functions are stubbed — stated in its header.
        b.onResolve({ filter: /(^|\/)sandbox\/(index|files)\.js$/ }, (a) => ({
          path: a.path.includes("files") ? sandboxFiles : sandboxIndex,
        }));
      },
    },
  ],
  logLevel: "warning",
});
