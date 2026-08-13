/**
 * Does node-pty load and run under THIS Electron?
 *
 * A prebuilt native module is built against a Node ABI, and Electron carries
 * its own — the failure is a hard "NODE_MODULE_VERSION nnn" at require() time,
 * on the user's machine, at the moment they open a terminal. Cheaper to find
 * out here.
 *
 *   npx electron scripts/pty-load-probe.cjs
 */

const { app } = require("electron");

app.whenReady().then(async () => {
  let failures = 0;
  const check = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  let pty;
  try {
    pty = require("@homebridge/node-pty-prebuilt-multiarch");
    check("node-pty loads under Electron", true, `electron ${process.versions.electron}, modules ${process.versions.modules}`);
  } catch (err) {
    check("node-pty loads under Electron", false, String(err).slice(0, 300));
    app.exit(1);
    return;
  }

  const shell = process.platform === "win32" ? "powershell.exe" : "bash";
  let term;
  try {
    term = pty.spawn(shell, [], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    check("a shell spawns in a pty", !!term.pid, `pid ${term.pid}`);
  } catch (err) {
    check("a shell spawns in a pty", false, String(err).slice(0, 300));
    app.exit(1);
    return;
  }

  // The whole point of a pty: output arrives as it happens, not at exit.
  let out = "";
  term.onData((d) => {
    out += d;
  });
  term.write("echo monet-pty-ok\r");

  const seen = await new Promise((resolve) => {
    const t = setInterval(() => {
      if (/monet-pty-ok/.test(out.replace(/echo monet-pty-ok/g, ""))) {
        clearInterval(t);
        resolve(true);
      }
    }, 100);
    setTimeout(() => {
      clearInterval(t);
      resolve(false);
    }, 15000);
  });
  check("it echoes back through the pty", seen, `${out.length} chars`);

  // Resizing is what makes a full-screen program (vim, htop) usable.
  try {
    term.resize(100, 30);
    check("the pty resizes", true);
  } catch (err) {
    check("the pty resizes", false, String(err).slice(0, 200));
  }

  try {
    term.kill();
    check("and it can be killed", true);
  } catch (err) {
    check("and it can be killed", false, String(err).slice(0, 200));
  }

  console.log(failures === 0 ? "\nPTY WORKS UNDER ELECTRON" : `\n${failures} FAILURES`);
  app.exit(failures ? 1 : 0);
});
