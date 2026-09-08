/**
 * Rebuild `better-sqlite3` for Electron's ABI. Runs after every install.
 *
 * better-sqlite3 is a V8-ABI module, not an N-API one, so a binary built for
 * the system Node cannot be loaded by Electron. `npm install` fetches the
 * prebuild for whatever Node is running the install — Node 24 is ABI 137,
 * Electron 33 wants 130 — and the mismatch does not surface until the app
 * asks for a session and dies with ERR_DLOPEN_FAILED from four IPC handlers
 * at once. Nothing about that message says "run a rebuild".
 *
 * This used to be a manual step documented for macOS only, which is why it
 * kept being missed on Windows: the ABI has nothing to do with the platform.
 *
 * Never fails the install. A broken rebuild leaves the app in exactly the
 * state it would have been in anyway, and blocking `npm install` on a
 * transient network error helps no one — so it says plainly what to run and
 * gets out of the way.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MODULE = "better-sqlite3";

// Optional dependency: a machine that never installed it has nothing to fix.
try {
  require.resolve(`${MODULE}/package.json`);
} catch {
  console.log(`[rebuild-native] ${MODULE} is not installed — nothing to do.`);
  process.exit(0);
}

const result = spawnSync(
  `npx electron-rebuild --only ${MODULE}`,
  { shell: true, stdio: "inherit" },
);

if (result.status !== 0) {
  console.warn(
    `\n[rebuild-native] Could not rebuild ${MODULE} for Electron.\n` +
      `The app will start, but anything touching sessions, settings or\n` +
      `lessons will fail with ERR_DLOPEN_FAILED. To retry:\n\n` +
      `    npm run rebuild:native\n`,
  );
}
