/**
 * Bundles src/main/stt-settings.ts for the Electron probe.
 *
 * Two things this step exists to arrange:
 *
 *  - esbuild's synchronous API deadlocks when called from Electron's main
 *    process, so bundling happens in plain Node and the probe only requires
 *    the result;
 *  - data-dir.js is ALIASED to a scratch folder. The probe must not write into
 *    the user's real data dir — the first cut did, and left a fake API key in
 *    <repo>/.monet/stt.json. Repointing Electron's userData after ready was
 *    worse: it wedged the process. Stubbing the dependency is the honest fix;
 *    every claim still lands on the real stt-settings code.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

const out = resolve("out-probe");
mkdirSync(out, { recursive: true });

// The scratch data dir the bundled module will use.
const stub = resolve(out, "probe-data-dir.mjs");
writeFileSync(
  stub,
  `import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
// The probe picks the folder (so it can read the file back) and passes it in;
// the fallback keeps the stub usable on its own.
const dir =
  process.env.MONET_STT_PROBE_DIR ||
  mkdtempSync(join(tmpdir(), "monet-stt-probe-"));
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

await build({
  entryPoints: [resolve("src/main/stt-settings.ts")],
  outfile: resolve(out, "stt-settings.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  // esbuild's `alias` refuses relative names, so the swap is a resolve plugin.
  plugins: [
    {
      name: "stub-data-dir",
      setup(b) {
        b.onResolve({ filter: /(^|\/)data-dir\.js$/ }, () => ({ path: stub }));
      },
    },
  ],
  logLevel: "warning",
});
