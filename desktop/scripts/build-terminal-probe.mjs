/**
 * Bundles the terminal sessions module for the Electron probe.
 *
 * Same shape as the transfer probe: esbuild's sync API deadlocks inside
 * Electron's main process, and the data dir is redirected to a scratch folder
 * so a probe never writes into the user's chats.
 *
 * node-pty stays EXTERNAL — it is the native module under test, and bundling a
 * .node binding is not a thing esbuild can do. Electron resolves it from
 * node_modules at run time, which is also how the app loads it.
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

// The host-shell path is what the probe drives, and it only needs a cwd. The
// real one reads the workspace out of the agent's state module, which drags the
// whole tool pipeline in behind it.
const stateStub = resolve(out, "probe-state.mjs");
writeFileSync(
  stateStub,
  `export function getProjectRoot() { return process.cwd(); }
export function getAppState() { return {}; }
export function setAppState() {}
`,
  "utf-8",
);

const entry = resolve(out, "terminal-entry.ts");
writeFileSync(
  entry,
  `export {
  openTerminal,
  writeTerminal,
  resizeTerminal,
  closeTerminal,
  closeSessionTerminals,
  closeAllTerminals,
  listTerminals,
  hasTerminal,
  terminalBuffer,
  onTerminalData,
  onTerminalExit,
  sandboxShellArgs,
  podmanExecutable,
} from "../src/main/terminal/sessions.js";
`,
  "utf-8",
);

await build({
  entryPoints: [entry],
  outfile: resolve(out, "terminal.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
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
        b.onResolve({ filter: /engine\/state\/state\.js$/ }, () => ({
          path: stateStub,
        }));
      },
    },
  ],
  logLevel: "warning",
});
