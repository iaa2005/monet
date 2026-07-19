/**
 * Cross-platform beta build: `npm run build:beta -- 2026-09-01`.
 *
 * Exists because the bash-style `MONET_BETA_EXPIRES=… npm run build` is a
 * syntax error in PowerShell, and setting $env: by hand leaves the variable
 * in the session — the NEXT build would silently be a beta too. This wrapper
 * scopes the variable to one child process and validates the date first.
 */

import { spawnSync } from "node:child_process";

const date = process.argv[2]?.trim();
if (!date || Number.isNaN(Date.parse(date))) {
  console.error(
    "Usage: npm run build:beta -- <expiry>\n" +
      "  e.g. npm run build:beta -- 2026-09-01   (valid THROUGH that day)\n" +
      "       npm run build:beta -- 2026-09-01T18:00:00Z",
  );
  process.exit(1);
}

console.log(`Building a beta that expires ${date}…`);
const r = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  shell: true, // npm is npm.cmd on Windows
  env: { ...process.env, MONET_BETA_EXPIRES: date },
});
process.exit(r.status ?? 1);
