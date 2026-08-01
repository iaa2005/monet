/**
 * A wedged Podman machine, and whether the sandbox comes back on its own.
 *
 * The state a user hit twice: `machine list` says the machine is running (the
 * WSL distro IS up), but its ssh tunnel is dead, so `podman info` refuses and
 * every RunPython fails with "could not start api proxy since expected pipe
 * is not available" / "machine did not transition into running state". The
 * app then told them to rebuild a perfectly healthy machine.
 *
 * This probe CREATES that state (kills win-sshproxy under a running machine)
 * and then calls the real RunPython path — no reset flag, so nothing here can
 * destroy a machine — asserting the recovery brings Python back by itself.
 *
 *   node scripts/build-podman-probe.mjs && electron scripts/podman-wedge-probe.cjs
 */
const { app } = require("electron");
const { join } = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

app.whenReady().then(async () => {
  const { runPodman, podmanInfoOk, ensurePodmanBinary } = await import(
    pathToFileURL(join(__dirname, "..", "out-probe", "podman.mjs")).href
  );
  // The app provisions the portable CLI and puts it on PATH at startup; a
  // probe that skips this measures "podman is not installed".
  await ensurePodmanBinary();

  const healthy = await podmanInfoOk();
  check("the machine answers before we break it", healthy);
  if (!healthy) {
    console.log("\n(skipped: no healthy machine to wedge)");
    return app.exit(0);
  }

  // ── Wedge it exactly the way it wedges in the field ──────────────────
  // Terminating the WSL distro under a running machine leaves podman's view
  // ("running") and reality (socket dead) disagreeing — which is precisely
  // what an idle-timed-out machine looks like, and what every failure report
  // showed. Killing win-sshproxy was tried first and is NOT the mechanism:
  // this install has no such process, and podman prints the "expected pipe"
  // line on healthy starts too.
  spawnSync("wsl.exe", ["--terminate", "podman-machine-default"], {
    windowsHide: true,
  });
  await new Promise((r) => setTimeout(r, 2_000));
  const wedged = !(await podmanInfoOk());
  check("terminating the distro wedges the socket", wedged);

  // ── The real RunPython path recovers, or it does not ─────────────────
  const t0 = Date.now();
  const r = await runPodman("probe-wedge", "print('recovered', 6*7)");
  const secs = Math.round((Date.now() - t0) / 1000);
  check(
    "RunPython recovers the wedged machine by itself",
    r.ok && r.stdout.includes("recovered 42"),
    `${secs}s — ${(r.error || r.stdout || "").slice(0, 120)}`,
  );
  check("and the socket is healthy afterwards", await podmanInfoOk());

  console.log(failures === 0 ? "\nALL PODMAN WEDGE CHECKS PASSED" : `\n${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
