/**
 * The terminal is a process that stays.
 *
 * The old one ran a command per container and waited for it to exit, so `cd`
 * was forgotten by the next line, a server showed nothing until the timeout
 * killed it, and Ctrl+C killed nothing. Each of those is a claim about a live
 * pty, and each is checked here against a real one — the arithmetic can be
 * unit-tested, but "does SIGINT reach the process" cannot.
 *
 * Runs on the host shell (space: "code"). The sandbox path is the same code
 * with podman in front of it, and needs a machine running.
 *
 *   node scripts/build-terminal-probe.mjs && npx electron scripts/terminal-probe.cjs
 */

const { app } = require("electron");
const path = require("path");

app.whenReady().then(async () => {
  let failures = 0;
  const check = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const term = await import(
    require("url").pathToFileURL(
      path.join(__dirname, "..", "out-probe", "terminal.mjs"),
    ).href
  );

  const SID = "probe-terminal";
  let seen = "";
  const off = term.onTerminalData((id, data) => {
    if (id === SID) seen += data;
  });
  const waitFor = async (re, ms = 20000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (re.test(seen)) return true;
      await sleep(100);
    }
    return false;
  };

  // ── It opens ────────────────────────────────────────────────────────
  const opened = await term.openTerminal(SID, "code", 80, 24);
  check("a shell opens", opened.ok, opened.error);
  if (!opened.ok) {
    off();
    app.exit(1);
    return;
  }
  check("and it is live", term.hasTerminal(SID));

  const isWin = process.platform === "win32";
  const nl = "\r";

  // ── Output streams, rather than arriving at exit ────────────────────
  seen = "";
  term.writeTerminal(SID, `echo probe-one${nl}`);
  check("output comes back", await waitFor(/probe-one/), `${seen.length} chars`);

  // ── State persists between commands — the `cd` that used to be lost ──
  seen = "";
  term.writeTerminal(SID, isWin ? `cd ..${nl}` : `cd /${nl}`);
  await sleep(1200);
  seen = "";
  term.writeTerminal(SID, isWin ? `(Get-Location).Path${nl}` : `pwd${nl}`);
  const moved = await waitFor(isWin ? /claude-code(?!\\desktop)/ : /^\/\s*$/m);
  check("THE SHELL REMEMBERS ITS DIRECTORY between commands", moved, seen.trim().slice(-80));

  // ── A long-running process keeps printing, and Ctrl+C ends it ────────
  seen = "";
  term.writeTerminal(
    SID,
    isWin
      ? `while ($true) { Write-Output tick; Start-Sleep -Milliseconds 300 }${nl}`
      : `while true; do echo tick; sleep 0.3; done${nl}`,
  );
  const ticking = await waitFor(/tick[\s\S]*tick/);
  check("A LONG COMMAND STREAMS while it runs", ticking);

  seen = "";
  // \x03 is what Ctrl+C sends. The old terminal printed "^C" and let the
  // process run; a pty delivers SIGINT.
  term.writeTerminal(SID, "\x03");
  await sleep(1500);
  const before = seen.length;
  await sleep(1500);
  const after = seen.length;
  check("CTRL+C STOPS IT — output stops growing", after - before < 20, `${after - before} chars in 1.5s`);

  // ── The buffer, which is what redraws a reattached panel ─────────────
  const buf = term.terminalBuffer(SID);
  check("main keeps the scrollback", buf.length > 0, `${buf.length} chars`);
  check("…including what was printed earlier", /probe-one/.test(buf));

  // Reopening is a REATTACH, not a second shell: same session, and it hands
  // back the screen so the panel can redraw it.
  const again = await term.openTerminal(SID, "code", 100, 30);
  check("reopening reattaches", again.ok && (again.buffer ?? "").length > 0);
  check("…to the same shell, not a new one", term.hasTerminal(SID));

  // ── Resizing, which full-screen programs read ────────────────────────
  check("it resizes", term.resizeTerminal(SID, 120, 40));
  check("a nonsense size is refused", !term.resizeTerminal(SID, 0, 0));

  // ── Closing ─────────────────────────────────────────────────────────
  term.closeTerminal(SID);
  await sleep(500);
  check("closing ends the session", !term.hasTerminal(SID));
  check("writing to a dead session is a no-op", !term.writeTerminal(SID, "x"));

  // ── The sandbox's shell asks podman for a TTY ────────────────────────
  //
  // Not run here (it needs a machine), but the arguments are what decide
  // whether the container gets a terminal — and without -t every program in
  // it turns its colours off, which was the old behaviour.
  const args = term.sandboxShellArgs("probe-args");
  check("the sandbox shell asks for a TTY", args.includes("-it"), args.slice(0, 3).join(" "));
  check("…mounts this chat's folder at /work", args.some((a) => a.endsWith(":/work")));
  check("…and starts a real shell", args[args.length - 2] === "bash");
  check(
    "…with nothing else from the host mounted",
    args.filter((a) => /^([A-Za-z]:[\\/]|\/)/.test(a) && a.includes(":/")).length === 1,
    args.filter((a) => a.includes(":/")).join(" "),
  );

  off();
  console.log(failures === 0 ? "\nTHE SHELL STAYS, AND CTRL+C REACHES IT" : `\n${failures} FAILURES`);
  app.exit(failures ? 1 : 0);
});
