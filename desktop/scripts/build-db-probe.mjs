/**
 * Bundles a probe that talks to the session database, for Electron.
 *
 * better-sqlite3 is a NATIVE module built against Electron's ABI, so a
 * probe that opens the DB cannot run under plain node — it fails at
 * dlopen, which is what `smoke-agent.mjs` does to anything touching
 * session storage. Same arrangement as the rasteriser probe: bundle in
 * node (esbuild's sync API deadlocks inside Electron), run in Electron.
 *
 *   node scripts/build-db-probe.mjs <probe.ts>
 *   electron out/probe/<name>.mjs
 */
import { build } from "esbuild";
import { mkdirSync } from "fs";
import { basename, resolve } from "path";

const entry = process.argv[2];
if (!entry) {
  console.error("usage: node scripts/build-db-probe.mjs <probe.ts>");
  process.exit(2);
}

const out = resolve("out/probe");
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(entry)],
  outfile: resolve(out, `${basename(entry, ".ts")}.mjs`),
  bundle: true,
  platform: "node",
  format: "esm",
  // Both stay outside the bundle: electron because it is the host, and the
  // native binding because bundling a .node file is not a thing.
  external: ["electron", "better-sqlite3"],
  alias: { "@shared": resolve("src/shared"), "@": resolve("src/renderer") },
  logLevel: "warning",
});
