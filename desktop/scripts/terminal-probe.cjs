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
  let TID = null;
  let seen = "";
  const off = term.onTerminalData((id, data) => {
    if (id === TID) seen += data;
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
  TID = opened.id;
  check("and it is live", term.hasTerminal(TID));
  check("it is named after the shell", !!opened.title, opened.title);

  const isWin = process.platform === "win32";
  const nl = "\r";

  // ── Output streams, rather than arriving at exit ────────────────────
  seen = "";
  term.writeTerminal(TID, `echo probe-one${nl}`);
  check("output comes back", await waitFor(/probe-one/), `${seen.length} chars`);

  // ── State persists between commands — the `cd` that used to be lost ──
  seen = "";
  term.writeTerminal(TID, isWin ? `cd ..${nl}` : `cd /${nl}`);
  await sleep(1200);
  seen = "";
  term.writeTerminal(TID, isWin ? `(Get-Location).Path${nl}` : `pwd${nl}`);
  const moved = await waitFor(isWin ? /claude-code(?!\\desktop)/ : /^\/\s*$/m);
  check("THE SHELL REMEMBERS ITS DIRECTORY between commands", moved, seen.trim().slice(-80));

  // ── A long-running process keeps printing, and Ctrl+C ends it ────────
  seen = "";
  term.writeTerminal(
    TID,
    isWin
      ? `while ($true) { Write-Output tick; Start-Sleep -Milliseconds 300 }${nl}`
      : `while true; do echo tick; sleep 0.3; done${nl}`,
  );
  const ticking = await waitFor(/tick[\s\S]*tick/);
  check("A LONG COMMAND STREAMS while it runs", ticking);

  seen = "";
  // \x03 is what Ctrl+C sends. The old terminal printed "^C" and let the
  // process run; a pty delivers SIGINT.
  term.writeTerminal(TID, "\x03");
  await sleep(1500);
  const before = seen.length;
  await sleep(1500);
  const after = seen.length;
  check("CTRL+C STOPS IT — output stops growing", after - before < 20, `${after - before} chars in 1.5s`);

  // ── The buffer, which is what redraws a reattached panel ─────────────
  const buf = term.terminalBuffer(TID);
  check("main keeps the scrollback", buf.length > 0, `${buf.length} chars`);
  check("…including what was printed earlier", /probe-one/.test(buf));

  // Reopening is a REATTACH, not a second shell: same session, and it hands
  // back the screen so the panel can redraw it.
  const again = await term.openTerminal(SID, "code", 100, 30, TID);
  check("reopening reattaches", again.ok && (again.buffer ?? "").length > 0);
  check("…to the same shell, not a new one", term.hasTerminal(TID));

  // ── Resizing, which full-screen programs read ────────────────────────
  check("it resizes", term.resizeTerminal(TID, 120, 40));
  check("a nonsense size is refused", !term.resizeTerminal(TID, 0, 0));

  // ── Several at once, and `exit` closing exactly one ──────────────────
  //
  // The chat used to BE the key, so there could only ever be one shell and
  // `exit` had nothing to distinguish. Now the id is the terminal's, and the
  // panel's tab list is this list.
  {
    const second = await term.openTerminal(SID, "code", 80, 24);
    check("a second shell opens in the same chat", second.ok && second.id !== TID, second.id);

    const list = term.listTerminals(SID);
    check("both are listed for the chat", list.length === 2, list.map((t) => t.id).join(", "));
    check("…each with a title for its tab", list.every((t) => t.title));

    // The exit event is what the panel closes a tab on, so it has to name the
    // terminal that ended and no other.
    let exited = null;
    const offExit = term.onTerminalExit((id) => {
      exited = id;
    });
    term.writeTerminal(second.id, `exit${nl}`);
    const until = Date.now() + 10000;
    while (Date.now() < until && exited === null) await sleep(100);
    offExit();

    check("typing `exit` ends that shell", exited === second.id, String(exited));
    check("…and it alone — the other is still live", term.hasTerminal(TID));
    check(
      "…so the chat is left with one tab",
      term.listTerminals(SID).length === 1,
      term.listTerminals(SID).map((t) => t.title).join(", "),
    );
  }

  // ── Closing ─────────────────────────────────────────────────────────
  term.closeTerminal(TID);
  await sleep(500);
  check("closing ends the session", !term.hasTerminal(TID));
  check("writing to a dead session is a no-op", !term.writeTerminal(TID, "x"));

  // Deleting a chat takes every shell it owns, however many.
  {
    const a = await term.openTerminal(SID, "code", 80, 24);
    const b = await term.openTerminal(SID, "code", 80, 24);
    check("two more open", a.ok && b.ok && term.listTerminals(SID).length === 2);
    term.closeSessionTerminals(SID);
    check("deleting the chat closes all of them", term.listTerminals(SID).length === 0);
  }

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

  // ── Finding podman at all ───────────────────────────────────────────
  //
  // child_process.spawn("podman") works because it searches PATH; conpty hands
  // the name to CreateProcess, which does not look in the app's data dir where
  // the portable CLI lives. It failed with node-pty's own message — the string
  // "File not found: " with the name left off — so the terminal reported that
  // nothing in particular was missing.
  {
    const pty = require("@lydell/node-pty");
    let bareWorks = true;
    try {
      const t = pty.spawn("definitely-not-a-real-binary-xyz", [], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env,
      });
      t.kill();
    } catch (err) {
      bareWorks = false;
      check(
        "node-pty still omits the name from 'File not found'",
        /file not found:\s*$/i.test(String(err.message)),
        JSON.stringify(String(err.message)),
      );
    }
    check("a missing executable does throw", !bareWorks);

    const exe = term.podmanExecutable();
    check(
      "podman resolves to an absolute path, or to nothing at all",
      exe === null || path.isAbsolute(exe),
      String(exe),
    );
    if (exe)
      check("…and that path exists", require("fs").existsSync(exe), exe);
  }

  off();
  console.log(failures === 0 ? "\nTHE SHELL STAYS, AND CTRL+C REACHES IT" : `\n${failures} FAILURES`);
  app.exit(failures ? 1 : 0);
});
