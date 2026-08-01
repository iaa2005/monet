/**
 * Does the sandbox get itself running — cold, and after a wedge?
 *
 * Three failure reports, one dead end: RunPython refused over and over, the
 * app blamed the machine ("damaged, rebuild it"), and retrying never helped.
 * Retrying COULDN'T help: once a session had verified the image, ensureImage()
 * returned early and skipped the machine check entirely, so the recovery code
 * was unreachable for the rest of the app's life. The machine was fine; the
 * path to fixing it sat behind a latch.
 *
 * So this drives the REAL RunPython entry point, twice, in one process:
 *
 *   1. cold — machine stopped, as it is after an idle timeout;
 *   2. wedged — WSL distro terminated under a running machine, which is what
 *      an idle timeout actually leaves behind (podman still says "running",
 *      the socket is dead), and deliberately AFTER a successful run, so the
 *      latch is warm and the second run has to heal it anyway.
 *
 * No reset flag is ever passed, so nothing here can delete a machine to make
 * itself pass.
 *
 *   node scripts/build-podman-probe.mjs && electron scripts/podman-wedge-probe.cjs
 */
const { app } = require("electron");
const { join } = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!pass) failures++;
};

const show = (r) =>
  JSON.stringify({
    ok: r.ok,
    error: r.error,
    stdout: (r.stdout || "").slice(0, 80),
    stderr: (r.stderr || "").slice(0, 80),
  }).slice(0, 260);

app.whenReady().then(async () => {
  const { runPodman, podmanInfoOk, ensurePodmanBinary } = await import(
    pathToFileURL(join(__dirname, "..", "out-probe", "podman.mjs")).href
  );
  // The app provisions the portable CLI and puts it on PATH at startup; a
  // probe that skips this measures "podman is not installed".
  await ensurePodmanBinary();

  // ── 1. Cold: the machine is down, as after an idle timeout ───────────
  spawnSync("podman", ["machine", "stop"], { windowsHide: true, timeout: 120_000 });
  await new Promise((r) => setTimeout(r, 2_000));
  check("the machine starts out stopped", !(await podmanInfoOk()));

  let t0 = Date.now();
  const cold = await runPodman("probe-cold", "print('cold', 6*7)");
  check(
    "RunPython starts a stopped machine by itself",
    cold.ok && cold.stdout.includes("cold 42"),
    `${Math.round((Date.now() - t0) / 1000)}s — ${show(cold)}`,
  );

  // ── 2. Wedged, with the image latch already warm ─────────────────────
  // The case that used to be unrecoverable: the run above set imageReady, and
  // the machine check used to sit behind that early return.
  spawnSync("wsl.exe", ["--terminate", "podman-machine-default"], {
    windowsHide: true,
  });
  await new Promise((r) => setTimeout(r, 2_000));
  check("terminating the distro wedges the socket", !(await podmanInfoOk()));

  t0 = Date.now();
  const healed = await runPodman("probe-wedged", "print('healed', 6*7)");
  check(
    "a second RunPython heals it, latch and all",
    healed.ok && healed.stdout.includes("healed 42"),
    `${Math.round((Date.now() - t0) / 1000)}s — ${show(healed)}`,
  );
  check("and the socket is healthy afterwards", await podmanInfoOk());

  console.log(
    failures === 0 ? "\nALL PODMAN WEDGE CHECKS PASSED" : `\n${failures} FAILED`,
  );
  app.exit(failures === 0 ? 0 : 1);
});
