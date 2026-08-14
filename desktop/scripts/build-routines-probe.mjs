/**
 * Bundles the routines store for the Electron probe (data dir → scratch).
 * Same shape as the other probes; treeshake stays on, the store is imported
 * as a value so its code arrives as written.
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

const entry = resolve(out, "routines-entry.ts");
writeFileSync(
  entry,
  `export {
  createRoutine,
  getRoutine,
  updateRoutine,
  deleteRoutine,
  listRoutines,
  recordRun,
  countRuns,
} from "../src/main/routines/store.js";
`,
  "utf-8",
);

await build({
  entryPoints: [entry],
  outfile: resolve(out, "routines.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron", "better-sqlite3", "node:sqlite"],
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
