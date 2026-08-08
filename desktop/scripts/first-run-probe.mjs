/**
 * Does the setup actually appear on a fresh data folder?
 *
 * The step list and the verdict are pure and probed elsewhere. This is the
 * question those probes cannot answer: with a brand new MONET_DATA_DIR, does
 * the SHIPPED renderer put the wizard on screen — and does it stay away from
 * a folder that has been used?
 *
 * Reported twice, in opposite directions, which is why it is measured here
 * rather than reasoned about: the flag used to live in localStorage, keyed by
 * origin, and the app is not the browser pane.
 *
 * Spawns the built app with its own data folder and a debugging port, attaches
 * over the DevTools protocol and looks at the real DOM.
 *
 *   node scripts/first-run-probe.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
const electron = require("electron");
const PORT = 9333;

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Attach to the app's window and evaluate an expression in it. */
async function attach() {
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find(
        (t) => t.type === "page" && !/devtools/.test(t.url),
      );
      if (page?.webSocketDebuggerUrl) {
        const ws = new WebSocket(page.webSocketDebuggerUrl, {
          perMessageDeflate: false,
        });
        const pending = new Map();
        let id = 0;
        ws.on("message", (buf) => {
          const m = JSON.parse(buf.toString());
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
          }
        });
        await new Promise((r) => ws.on("open", r));
        const send = (method, params = {}) =>
          new Promise((r) => {
            const mid = ++id;
            pending.set(mid, r);
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        return {
          ws,
          eval: async (expr) => {
            const r = await send("Runtime.evaluate", {
              expression: expr,
              returnByValue: true,
              awaitPromise: true,
            });
            return r.result?.result?.value;
          },
        };
      }
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error("the app never opened a debuggable window");
}

/** Boot the app against a data folder and report what the renderer shows. */
async function look(dataDir) {
  const child = spawn(electron, [resolve("."), `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, MONET_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  try {
    const cdp = await attach();
    // Attaching is not painting: the window exists before React has run, and
    // an empty DOM read as "no wizard" the first time this probe was written.
    // So it waits for the renderer to show SOMETHING, then reads once.
    const marks = `(() => {
      const t = document.body ? document.body.innerText : '';
      return JSON.stringify({
        welcome: /Set it up/i.test(t),
        composer: !!document.querySelector('.composer-input'),
        painted: t.trim().length > 0,
        // The setup is an OVERLAY — the chat stays mounted behind it, which
        // is the point: nothing is torn down and rebuilt when it closes. So
        // "do you see the setup" is not "is the chat absent", it is what the
        // middle of the window actually hits.
        onTop: (() => {
          const hit = document.elementFromPoint(
            Math.floor(innerWidth / 2),
            Math.floor(innerHeight / 2),
          );
          const overlay = [...document.querySelectorAll('div')].find(
            (d) => d.className && String(d.className).includes('z-[100]'),
          );
          return !!(hit && overlay && (overlay === hit || overlay.contains(hit)));
        })(),
      });
    })()`;
    // Waits for the WIZARD, not for "anything at all": the chat mounts first
    // and the setup's gate is an IPC round trip behind it, so breaking on the
    // composer read a race as an absence. Only its appearance ends the wait
    // early; if it never comes, the timeout IS the answer.
    let seen = {};
    const t0 = Date.now();
    while (Date.now() - t0 < 12_000) {
      seen = JSON.parse((await cdp.eval(marks)) ?? "{}");
      if (seen.welcome) break;
      await sleep(400);
    }
    cdp.ws.close();
    return { seen, log };
  } finally {
    child.kill();
    await sleep(600);
  }
}

// ─── A folder nobody has used ───────────────────────────────────────────

const fresh = mkdtempSync(join(tmpdir(), "first-run-fresh-"));
{
  const { seen, log } = await look(fresh);
  check("A FRESH DATA FOLDER SHOWS THE SETUP", seen.welcome === true, JSON.stringify(seen));
  check(
    "…and it is what you are looking at, not the chat behind it",
    seen.onTop === true,
    JSON.stringify(seen),
  );
  if (seen.welcome !== true) console.log(log.slice(-1200));
}

// ─── The same folder, once the setup says it is done ─────────────────────

{
  mkdirSync(fresh, { recursive: true });
  writeFileSync(
    join(fresh, "ui-prefs.json"),
    JSON.stringify({ onboarded: true }, null, 2),
    "utf8",
  );
  const { seen } = await look(fresh);
  check("a folder that says it is done shows the app", seen.welcome === false, JSON.stringify(seen));
  check("…with the composer where it belongs", seen.composer === true, JSON.stringify(seen));
  check("…and no overlay over it", seen.onTop !== true, JSON.stringify(seen));
}

console.log(
  failures ? `\n${failures} FAILED` : "\nTHE SETUP APPEARS EXACTLY ONCE, PER FOLDER",
);
process.exit(failures ? 1 : 0);
