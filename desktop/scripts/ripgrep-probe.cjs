/**
 * Does the search use the ripgrep we ship?
 *
 * The build has been copying rg into out/main/vendor/ripgrep/<arch>-<os>/
 * since forever, and nothing looked for it: the resolver only probed PATH.
 * On a machine without ripgrep installed, every search fell back to a manual
 * recursive walk that READS every file — measured on one ordinary workspace
 * at ~12 000 files and a gigabyte, unfinished after eight seconds, blocking
 * the main process throughout. Picking one element in the browser fires up
 * to nine of those.
 *
 * Runs under Electron because the resolver's path is relative to the bundle.
 */
const { app } = require("electron");
const { join } = require("path");
const { existsSync } = require("fs");
const { spawnSync } = require("child_process");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

app.whenReady().then(() => {
  const folder =
    process.platform === "win32"
      ? `${process.arch}-win32`
      : `${process.arch}-${process.platform}`;
  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  const bundled = join(__dirname, "..", "out", "main", "vendor", "ripgrep", folder, binary);

  check("the build ships a ripgrep", existsSync(bundled), bundled);
  if (existsSync(bundled)) {
    const v = spawnSync(bundled, ["--version"], { encoding: "utf-8", windowsHide: true });
    check("and it runs", (v.stdout || "").includes("ripgrep"), (v.stdout || "").split("\n")[0]);

    // The property that matters: a search over a real tree finishes fast.
    const t0 = Date.now();
    const r = spawnSync(
      bundled,
      ["--files-with-matches", "--max-count", "5", "getSessionStore", join(__dirname, "..", "src")],
      { encoding: "utf-8", windowsHide: true, timeout: 20_000 },
    );
    const ms = Date.now() - t0;
    const hits = (r.stdout || "").trim().split("\n").filter(Boolean).length;
    check("a real search finds real files", hits > 0, `${hits} files`);
    check("in well under a second", ms < 1_000, `${ms}ms`);
  }

  console.log(failures === 0 ? "\nALL RIPGREP CHECKS PASSED" : `\n${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
