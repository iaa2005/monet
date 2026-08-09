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
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
const electron = require("electron");
// A fresh port per boot. Three app instances run in sequence here, and a
// killed Electron does not release its debugging port immediately — reusing
// one meant attaching to the PREVIOUS instance's targets and reading an empty
// page as "the wizard never appeared".
let portSeq = 9333;
const nextPort = () => ++portSeq;

/** Kill the app AND its children.
 *
 * child.kill() on Windows takes the main process only: Electron's
 * --type=gpu-process, --type=renderer and --type=utility survive it, and the
 * GPU one keeps a graphics context. Ten probe runs in an evening leave ten of
 * those behind, which is how this was noticed — a PID eating the GPU long after
 * the probe said it was done. */
function killTree(child) {
  try {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill();
  } catch {
    /* already gone */
  }
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Attach to the app's window and evaluate an expression in it. */
async function attach(PORT) {
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      // The app opens more than one page: a hidden rasteriser for PDFs, and
      // popout hosts. Taking the first one that is not devtools attached to a
      // blank document and read it as "nothing rendered".
      const page = targets.find(
        (t) =>
          t.type === "page" &&
          !/devtools/.test(t.url) &&
          !/rasterise|popout/.test(t.url) &&
          /index\.html|^https?:\/\/localhost/.test(t.url),
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
  const PORT = nextPort();
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
    const cdp = await attach(PORT);
    // Attaching is not painting: the window exists before React has run, and
    // an empty DOM read as "no wizard" the first time this probe was written.
    // So it waits for the renderer to show SOMETHING, then reads once.
    // textContent, not innerText: innerText needs LAYOUT, and a window that
    // has not been shown yet reports "" for a fully mounted tree. Two of these
    // checks failed that way before anything was wrong with the app.
    const marks = `(() => {
      const t = document.body ? document.body.textContent : '';
      return JSON.stringify({
        welcome: /Set it up/i.test(t),
        composer: !!document.querySelector('.composer-input'),
        painted: t.trim().length > 0,
        // The setup is an OVERLAY — the chat stays mounted behind it, which
        // is the point: nothing is torn down and rebuilt when it closes. So
        // "do you see the setup" is not "is the chat absent", it is what the
        // middle of the window actually hits.
        // Found by what it CONTAINS, not by its z-index class: the layer
        // moved from 100 to 45 (see the stacking check below) and a probe
        // keyed on the number reported the screen as missing when only the
        // number had changed.
        onTop: [...document.querySelectorAll('div')].some(
          (d) =>
            d.className &&
            String(d.className).includes('fixed inset-0') &&
            /Set it up/i.test(d.textContent || ''),
        ),
      });
    })()`;
    // Waits for the WIZARD, not for "anything at all": the chat mounts first
    // and the setup's gate is an IPC round trip behind it, so breaking on the
    // composer read a race as an absence. Only its appearance ends the wait
    // early; if it never comes, the timeout IS the answer.
    let seen = {};
    const t0 = Date.now();
    let paintedAt = 0;
    while (Date.now() - t0 < 45_000) {
      seen = JSON.parse((await cdp.eval(marks)) ?? "{}");
      if (seen.welcome) break;
      // The tree mounts before the setup's gate has answered, so "painted but
      // no wizard" is not yet an answer — give it a few seconds more, then it
      // is. Three app launches in a row on a busy machine made the old flat
      // 12s timeout report an absence that was only slowness.
      if (seen.painted && !paintedAt) paintedAt = Date.now();
      if (paintedAt && Date.now() - paintedAt > 8_000) break;
      await sleep(400);
    }
    cdp.ws.close();
    return { seen, log };
  } finally {
    killTree(child);
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
  if (seen.welcome !== true) console.log(log.slice(-1500));
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

// ─── What the setup opens must land ON TOP of it ────────────────────────
//
// The setup is a full-screen screen, and the controls on it open things that
// are portalled into document.body: the work select, the Monet avatar
// carousel. At z-100 the screen covered both — clicking them appeared to do
// nothing at all. It sits at z-45 now: above every layer the app screen uses,
// below every transient one.
//
// Checked by hit-testing, which is the only thing that can tell "behind" from
// "absent": open the select, then ask what is actually at the middle of the
// menu it drew.

{
  const PORT = nextPort();
  const child = spawn(electron, [resolve("."), `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, MONET_DATA_DIR: mkdtempSync(join(tmpdir(), "layer-")) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const cdp = await attach(PORT);
    const r = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const txt = () => (document.body ? document.body.textContent : '');
      for (let i = 0; i < 120 && !/Set it up/i.test(txt()); i++) await wait(250);
      const press = async (label) => {
        const b = [...document.querySelectorAll('button')].find((x) =>
          x.textContent.trim().startsWith(label),
        );
        if (!b) return false;
        b.click();
        await wait(600);
        return true;
      };
      if (!(await press('Set it up'))) return JSON.stringify({ error: 'no welcome' });
      if (!(await press('Continue'))) return JSON.stringify({ error: 'no continue' });
      if (!/About you/i.test(txt())) return JSON.stringify({ error: 'not on About you' });

      // The work picker is the app's own Select — a button with a listbox.
      const trigger = [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('role') === 'combobox',
      );
      if (!trigger) return JSON.stringify({ error: 'no select' });
      trigger.click();
      await wait(700);
      const menu = document.querySelector('[role="listbox"]');
      if (!menu) return JSON.stringify({ error: 'menu never opened' });
      const m = menu.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.round(m.left + m.width / 2),
        Math.round(m.top + Math.min(20, m.height / 2)),
      );
      return JSON.stringify({
        menuOpen: true,
        onTop: !!(hit && (menu === hit || menu.contains(hit))),
        hit: hit ? hit.tagName + '.' + String(hit.className).slice(0, 40) : null,
      });
    })()`);
    const seen = JSON.parse(r ?? "{}");
    check("the work picker opens on the setup screen", seen.menuOpen === true, JSON.stringify(seen));
    check(
      "AND ITS MENU IS IN FRONT, not behind the screen that opened it",
      seen.onTop === true,
      JSON.stringify(seen),
    );
    cdp.ws.close();
  } finally {
    killTree(child);
    await sleep(600);
  }
}

// ─── What is NOT checked here ───────────────────────────────────────────
//
// Whether a step taller than the window can be scrolled to the top. It was
// attempted — click through to the theme step, scroll to the bottom, scroll
// back — and the walk was too fragile to trust: it failed for a stale
// debugging port, then for a hidden rasteriser window picked as the target,
// then for an `innerText` that is empty until the window is shown, and then
// for a build whose renderer output a concurrent `npm run dev` had emptied.
// Four failures, none of them about the app.
//
// A check that red-flags the harness rather than the code teaches people to
// ignore it, so it is not here. The fix it would have guarded is `m-auto`
// instead of `items-center` on the scrolling body — centring a flex child
// taller than its scroll container puts the overflow off BOTH ends and the
// top becomes unreachable. Confirmed by eye, in the app, by the person who
// reported it.

// ─── Adopting a folder that is already somebody's ───────────────────────
//
// The setup's folder step can point at an EXISTING install, and every screen
// after it is then supposed to show that folder's data — the name, the
// avatar, the provider. That only works if the switch takes effect in the
// RUNNING process: a database handle and a loaded provider list are held, and
// a handle does not care that the path changed.
//
// Measured through the app's own bridge, from the page, the way the wizard's
// steps do it. The native folder dialog cannot be automated, so the pick
// itself is the one part stood in for.

{
  const prodDir = resolve("..", ".monet-prod");
  const PORT = nextPort();
  const child = spawn(electron, [resolve("."), `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, MONET_DATA_DIR: mkdtempSync(join(tmpdir(), "adopt-")) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const cdp = await attach(PORT);
    const before = await cdp.eval(`(async () => {
      try {
        for (let i = 0; i < 60 && !window.electronAPI; i++)
          await new Promise((r) => setTimeout(r, 250));
        if (!window.electronAPI) return JSON.stringify({ error: 'no bridge' });
        const p = await window.electronAPI.profile.get();
        const list = await window.electronAPI.providers.list();
        return JSON.stringify({
          name: p.name,
          keys: list.filter((x) => !!x.apiKey).length,
        });
      } catch (e) {
        return JSON.stringify({ error: String(e && e.message ? e.message : e) });
      }
    })()`);
    const startedWith = JSON.parse(before ?? "{}");
    check("a fresh folder knows nobody", !startedWith.name, JSON.stringify(startedWith));
    check("…and has no provider key", startedWith.keys === 0, JSON.stringify(startedWith));

    const after = await cdp.eval(`(async () => {
      await window.electronAPI.settings.setDataDir(${JSON.stringify(prodDir)});
      const p = await window.electronAPI.profile.get();
      const list = await window.electronAPI.providers.list();
      const seen = await window.electronAPI.settings.inspectDataDir(${JSON.stringify(prodDir)});
      return JSON.stringify({
        name: p.name,
        about: (p.about || "").length,
        avatar: !!p.avatarDataUrl,
        keys: list.filter((x) => !!x.apiKey).length,
        chats: seen.chats,
      });
    })()`);
    const adopted = JSON.parse(after ?? "{}");
    check(
      "CHOOSING AN EXISTING FOLDER BRINGS ITS PROFILE ALONG",
      !!adopted.name,
      JSON.stringify(adopted),
    );
    check("…including what it says about you", adopted.about > 0, JSON.stringify(adopted));
    check("…and the avatar", adopted.avatar === true, JSON.stringify(adopted));
    check(
      "…AND ITS PROVIDER, so the last screen has nothing to ask",
      adopted.keys > 0,
      JSON.stringify(adopted),
    );
    // The count is a nicety — a locked WAL file or an older schema leaves it
    // unknown (-1), which the setup then simply does not mention. What must
    // NEVER happen is a confident zero for a folder full of chats.
    check(
      "…and its chats are counted, or honestly unknown",
      adopted.chats > 0 || adopted.chats === -1,
      JSON.stringify(adopted),
    );
    cdp.ws.close();
  } finally {
    killTree(child);
    await sleep(600);
  }
}

console.log(
  failures ? `\n${failures} FAILED` : "\nTHE SETUP APPEARS EXACTLY ONCE, PER FOLDER",
);
process.exit(failures ? 1 : 0);
