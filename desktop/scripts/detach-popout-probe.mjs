/**
 * Detach really opens a window — in the BUILT app, which is the only place it
 * was ever broken.
 *
 * dockview refuses a popout URL that is not http(s). Dev serves the renderer
 * from vite over http, so Detach worked here and did nothing at all in the
 * packaged app: `dockview: popout URL must be same-origin http(s); got:
 * file:///…/popout.html`, an error printed to a console nobody has open. A
 * build-time patch (electron.vite.config.ts) allows our own file:// popout;
 * this is the check that the button ends in a window.
 *
 * It drives the real app over the Chrome DevTools Protocol — Node 24 has a
 * global WebSocket, so nothing is installed for it — in its OWN data dir, so
 * the user's chats and desk layouts are untouched.
 *
 *   npm run smoke:detach
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9333;
let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

const dataDir = mkdtempSync(join(tmpdir(), "monet-detach-"));
const electron = process.platform === "win32" ? "electron.cmd" : "electron";
const app = spawn(join("node_modules", ".bin", electron), [
  `--remote-debugging-port=${PORT}`,
  ".",
], {
  env: { ...process.env, MONET_DATA_DIR: dataDir },
  stdio: "ignore",
  shell: process.platform === "win32",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = async () => {
  const all = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return all.filter((t) => t.type === "page");
};

async function waitForRenderer(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const page = (await pages()).find((t) => /index\.html/.test(t.url));
      if (page) return page;
    } catch {
      /* the app is still booting */
    }
    await sleep(1000);
  }
  return null;
}

function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      errors.push(
        m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300),
      );
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const n = ++id;
      pending.set(n, r);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const ready = new Promise((r) => ws.addEventListener("open", r)).then(() =>
    send("Runtime.enable"),
  );
  const evaluate = async (expression) => {
    await ready;
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    return (
      r.result?.result?.value ??
      r.result?.exceptionDetails?.text ??
      JSON.stringify(r.result)
    );
  };
  return { evaluate, errors, close: () => ws.close() };
}

try {
  const page = await waitForRenderer();
  check("the built app starts and exposes its renderer", !!page);
  if (!page) throw new Error("no renderer");

  const cdp = connect(page);
  // A second group to detach: the chat's own group is the anchor and has no
  // detach button by design.
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b => /files/i.test(b.title || b.getAttribute('aria-label') || ''))?.click()`,
  );
  await sleep(1500);
  const groups = await cdp.evaluate(`document.querySelectorAll('.dv-groupview').length`);
  check("opening Files gives the dock a second group", groups >= 2, `groups: ${groups}`);

  const clicked = await cdp.evaluate(
    `(() => {
       const b = [...document.querySelectorAll('button[title="Detach into its own window"]')];
       if (!b.length) return 'no detach button';
       b[b.length - 1].click();
       return 'clicked';
     })()`,
  );
  check("the group offers Detach", clicked === "clicked", String(clicked));
  await sleep(3500);

  const popout = (await pages()).find((t) => /popout\.html/.test(t.url));
  check("…and it opens a real second window", !!popout, popout?.title);
  check(
    "with no error from dockview",
    !cdp.errors.some((e) => /popout/i.test(e)),
    cdp.errors.filter((e) => /popout/i.test(e))[0],
  );
  cdp.close();
} catch (err) {
  check("the probe ran", false, err instanceof Error ? err.message : String(err));
} finally {
  app.kill();
  // Windows: electron.cmd spawns the real binary as a child.
  if (process.platform === "win32")
    spawn("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  await sleep(1500);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* a locked sqlite file is not a test failure */
  }
}

console.log(
  failures === 0 ? "\nDETACH ENDS IN A WINDOW" : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
