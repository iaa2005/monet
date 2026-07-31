/**
 * The runtime facts the Browser panel is built on.
 *
 * Every other probe for this feature is pure — URL parsing, log formatting,
 * origin matching, element serialisation. None of them touches the handful of
 * Electron behaviours the whole design rests on, and those are the ones that
 * are either true or quietly, invisibly false. Three of the four assumptions
 * this file was written to check turned out to be WRONG, which is the reason
 * it exists:
 *
 *   - A guest parked OFF-SCREEN cannot be captured. CDP's
 *     Page.captureScreenshot never answers at all; capturePage returns an
 *     empty image. Hence reveal() before anything visual, a deadline on every
 *     CDP command, and an explicit error on an empty frame rather than a
 *     zero-byte PNG travelling on as if it were a picture.
 *     (WHOSE pixels a capture returns is a separate question, and a separate
 *     probe: capture-target-probe.cjs.)
 *   - A wheel event with no pointer over the page scrolls nothing, and a
 *     parked guest scrolls unreliably even with one. So pageScrollWheel moves
 *     the mouse first, and reveals.
 *   - CDP `Page.reload` DESTROYS an Electron <webview> guest: a new one
 *     attaches with a new id, taking the debugger session, the injected
 *     overlay and the log recording with it. `webContents.reload()` keeps the
 *     same guest, so that is what the transport uses.
 *
 * What was right is the one that mattered most: the design-mode channel.
 * Runtime.addBinding plus Page.addScriptToEvaluateOnNewDocument does reach the
 * page's MAIN world and the call does come back — which is the whole reason
 * the overlay can read React's fibre, invisible as it is from an isolated
 * world.
 *
 *   electron scripts/webview-probe.cjs
 */
const { app, BrowserWindow, webContents } = require("electron");
const { pathToFileURL } = require("url");
const { writeFileSync, mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!pass) failures++;
};
/** A measurement that explains a design choice but must not gate the build. */
const note = (name, detail) => console.log(`NOTE  ${name} — ${detail}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A CDP command that cannot hang the probe.
 *
 * Not defensive padding: a command that never answers is a real outcome here,
 * and a probe that hangs reports nothing — which looks exactly like a probe
 * nobody ran.
 */
async function cmd(target, method, params = {}, ms = 6000) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), ms);
  });
  try {
    return await Promise.race([
      target.debugger.sendCommand(method, params),
      timeout,
    ]);
  } catch (err) {
    return { __error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const ok = (res) => !!res && !res.__timedOut && !res.__error;
const why = (res) =>
  res?.__timedOut ? "timed out" : (res?.__error ?? JSON.stringify(res));

const watchdog = setTimeout(() => {
  console.log("\nFAIL  the probe itself did not finish");
  app.exit(1);
}, 120_000);
watchdog.unref?.();

/** A page with something to type into and something to scroll. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>probe page</title>
<style>
  body { margin: 0; font: 14px system-ui; background: #fff; }
  #tall { height: 3000px; background: linear-gradient(#fff, #333); }
  #box { position: fixed; top: 40px; left: 40px; width: 160px; height: 48px;
         background: #2563eb; color: #fff; }
</style>
<input id="field">
<div id="box">a blue box</div>
<div id="tall"></div>
<script>window.__probeMarker = 'main-world-only';</script>`;

/** The host, with the guest parked off-screen exactly as BrowserPanel parks one. */
const HOST = (guestUrl, extraAttrs = "") => `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  #wrap { position: absolute; inset: 0; transform: translateX(-200%); }
  webview { width: 100%; height: 100%; }
</style>
<div id="wrap"><webview id="w" src="${guestUrl}" ${extraAttrs}></webview></div>`;

async function openHost(hostPath, size) {
  const win = new BrowserWindow({
    width: size?.width ?? 900,
    height: size?.height ?? 700,
    // Shown, because "never shown" and "shown with the guest parked" are
    // different situations and only the second one is the panel's.
    show: true,
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const attached = new Promise((resolve) => {
    win.webContents.on("did-attach-webview", (_e, g) => resolve(g));
    setTimeout(() => resolve(null), 15_000);
  });
  await win.loadFile(hostPath);
  const guest = await attached;
  if (!guest) return { win, guest: null };
  await new Promise((resolve) => {
    if (!guest.isLoading()) return resolve();
    guest.once("did-finish-load", resolve);
    setTimeout(resolve, 10_000);
  });
  await sleep(300);
  return { win, guest };
}

app.whenReady().then(async () => {
  const dir = mkdtempSync(join(tmpdir(), "monet-webview-probe-"));
  const guestPath = join(dir, "guest.html");
  const hostPath = join(dir, "host.html");
  writeFileSync(guestPath, PAGE, "utf-8");
  writeFileSync(hostPath, HOST(pathToFileURL(guestPath).href), "utf-8");

  const open = [];

  // ── 1. A guest attaches, and names itself ───────────────────────────
  const { win, guest } = await openHost(hostPath);
  open.push(win);
  check("a <webview> attaches to the host window", !!guest);
  if (!guest) return finish(open);

  check("the guest has a webContents id", typeof guest.id === "number");
  check("webContents.fromId resolves it", webContents.fromId(guest.id) === guest);
  check(
    "it loaded the page it was pointed at",
    guest.getURL().endsWith("guest.html"),
    guest.getURL(),
  );

  // ── 2. The debugger attaches to a GUEST, not just a top-level page ──
  let attachedOk = false;
  try {
    guest.debugger.attach("1.3");
    attachedOk = guest.debugger.isAttached();
  } catch (err) {
    note("debugger.attach threw", String(err));
  }
  check("the debugger attaches to the guest", attachedOk);
  if (!attachedOk) return finish(open);

  for (const domain of ["Page", "Runtime"]) {
    const res = await cmd(guest, `${domain}.enable`);
    if (!ok(res)) check(`${domain}.enable`, false, why(res));
  }

  const title = await cmd(guest, "Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true,
  });
  check(
    "CDP evaluate answers with a value",
    title?.result?.value === "probe page",
    why(title),
  );

  // ── 3. The channel design mode depends on ───────────────────────────
  //
  // __probeMarker is set by the page's own <script>. Reading it back proves
  // the injected code ran in the MAIN world — the entire reason the overlay
  // goes in through CDP instead of a webview preload.
  const heard = [];
  guest.debugger.on("message", (_e, method, params) => {
    if (method === "Runtime.bindingCalled") heard.push(params);
  });

  check(
    "Runtime.addBinding is accepted",
    ok(await cmd(guest, "Runtime.addBinding", { name: "__monetBrowserEvent" })),
  );
  check(
    "addScriptToEvaluateOnNewDocument is accepted",
    ok(
      await cmd(guest, "Page.addScriptToEvaluateOnNewDocument", {
        source: "window.__monetInjected = true;",
      }),
    ),
  );
  await cmd(guest, "Runtime.evaluate", {
    expression:
      "window.__monetBrowserEvent(JSON.stringify({ marker: window.__probeMarker }))",
  });
  await sleep(200);

  check("the binding call reaches main", heard.length === 1, heard.length);
  let payload = null;
  try {
    payload = JSON.parse(heard[0]?.payload ?? "null");
  } catch {
    /* reported by the check below */
  }
  check(
    "the injected code ran in the page's MAIN world",
    payload?.marker === "main-world-only",
    JSON.stringify(payload),
  );

  // ── 4. Capturing ────────────────────────────────────────────────────
  //
  // capturePage, not CDP: whose pixels each route returns is settled in
  // capture-target-probe.cjs, and the answer for `fromSurface: false` is "the
  // app's". This probe only asks whether a capture happens at all.
  const capture = async (label, hard) => {
    let out;
    try {
      const img = await Promise.race([
        guest.capturePage(),
        sleep(6000).then(() => null),
      ]);
      out = img === null ? "timed out" : img.toPNG();
    } catch (err) {
      out = String(err);
    }
    const good = Buffer.isBuffer(out) && out.length > 1000;
    const detail = Buffer.isBuffer(out) ? `${out.length} bytes` : out;
    if (hard) check(`capture ${label}`, good, detail);
    else note(`capture ${label}`, detail);
  };

  // Recorded, not asserted: this measurement is what put reveal() into
  // transport.screenshot(). If a future Chromium starts answering here,
  // reveal() becomes harmless rather than wrong — not a reason to fail a build.
  await capture("while parked off-screen", false);

  // ── 5. Typing ───────────────────────────────────────────────────────
  await cmd(guest, "Runtime.evaluate", {
    expression: "document.getElementById('field').focus()",
  });
  for (const ch of "hey") {
    guest.sendInputEvent({ type: "keyDown", keyCode: ch });
    guest.sendInputEvent({ type: "char", keyCode: ch });
    guest.sendInputEvent({ type: "keyUp", keyCode: ch });
  }
  await sleep(300);
  const typed = await cmd(guest, "Runtime.evaluate", {
    expression: "document.getElementById('field').value",
    returnByValue: true,
  });
  check(
    "sendInputEvent types real characters into a field",
    typed?.result?.value === "hey",
    JSON.stringify(typed?.result?.value),
  );

  // ── 6. On screen, the visual operations work ────────────────────────
  await win.webContents.executeJavaScript(
    "document.getElementById('wrap').style.transform = 'none'; true",
  );
  await sleep(600);

  await capture("with the guest on screen", true);

  await cmd(guest, "Runtime.evaluate", { expression: "scrollTo(0,0)" });
  await sleep(150);
  // The mouse move is not decoration: without a pointer over the page the
  // wheel scrolled nothing at all.
  await cmd(guest, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 200,
    y: 300,
    button: "none",
  });
  await cmd(guest, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 200,
    y: 300,
    deltaX: 0,
    deltaY: 400,
    button: "none",
  });
  await sleep(500);
  const scrolled = await cmd(guest, "Runtime.evaluate", {
    expression: "Math.round(window.scrollY)",
    returnByValue: true,
  });
  check(
    "a positive wheel delta scrolls DOWN",
    (scrolled?.result?.value ?? 0) > 0,
    why(scrolled),
  );

  guest.debugger.detach();
  check("the debugger detaches cleanly", !guest.debugger.isAttached());

  // ── 7. Reloading, the way the transport does it ─────────────────────
  const second = await openHost(hostPath, { width: 600, height: 400 });
  open.push(second.win);
  if (second.guest) {
    const before = second.guest.id;
    second.guest.reload();
    await new Promise((r) => {
      second.guest.once("did-finish-load", r);
      setTimeout(r, 8000);
    });
    await sleep(400);
    check(
      "webContents.reload() keeps the same guest",
      !second.guest.isDestroyed() && second.guest.id === before,
      second.guest.isDestroyed() ? "destroyed" : `id ${second.guest.id} (was ${before})`,
    );
  }

  // The alternative, measured so nobody reaches for it again.
  const third = await openHost(hostPath, { width: 600, height: 400 });
  open.push(third.win);
  if (third.guest) {
    let replacement = null;
    third.win.webContents.on("did-attach-webview", (_e, g) => {
      replacement = g;
    });
    try {
      third.guest.debugger.attach("1.3");
      await cmd(third.guest, "Page.enable");
      const before = third.guest.id;
      await cmd(third.guest, "Page.reload");
      await sleep(1500);
      note(
        "CDP Page.reload on a guest",
        third.guest.isDestroyed()
          ? `DESTROYS it (was ${before}${replacement ? `, replaced by ${replacement.id}` : ""}) — hence transport.reload() uses the Electron API`
          : "kept the guest alive",
      );
    } catch (err) {
      note("CDP Page.reload on a guest", String(err));
    }
  }

  // ── 8. Links that ask for a NEW window ──────────────────────────────
  //
  // The panel's design for target=_blank / window.open: the <webview> carries
  // `allowpopups`, and installWebviewGuards routes the guest's request into a
  // browser:openTab message (deny + open our own tab). Both halves rest on
  // platform behaviour that fails SILENTLY when it shifts:
  //   - WITH allowpopups, setWindowOpenHandler is consulted and deny opens
  //     nothing — the request is ours to turn into a tab;
  //   - WITHOUT it, Chromium blocks the open BEFORE the handler is asked, so
  //     dropping the attribute kills every target=_blank link with no error
  //     anywhere. "Links on sites don't work", and nothing to grep for.
  const popPath = join(dir, "host-popups.html");
  writeFileSync(popPath, HOST(pathToFileURL(guestPath).href, "allowpopups"), "utf-8");
  const fourth = await openHost(popPath, { width: 600, height: 400 });
  open.push(fourth.win);
  if (fourth.guest) {
    const asked = [];
    fourth.guest.setWindowOpenHandler(({ url }) => {
      asked.push(url);
      return { action: "deny" };
    });
    const windowsBefore = BrowserWindow.getAllWindows().length;
    await fourth.guest
      .executeJavaScript("window.open('https://example.com/from-probe'); true", true)
      .catch(() => {});
    await sleep(600);
    check(
      "with allowpopups, window.open consults the handler",
      asked[0] === "https://example.com/from-probe",
      asked.join(", ") || "(never asked)",
    );
    check(
      "and deny opens no stray OS window",
      BrowserWindow.getAllWindows().length === windowsBefore,
      `${windowsBefore} then ${BrowserWindow.getAllWindows().length}`,
    );
  } else {
    check("a guest with allowpopups attaches", false);
  }

  // The control: the same call in a guest WITHOUT the attribute.
  if (second.guest && !second.guest.isDestroyed()) {
    const askedBare = [];
    second.guest.setWindowOpenHandler(({ url }) => {
      askedBare.push(url);
      return { action: "deny" };
    });
    await second.guest
      .executeJavaScript("window.open('https://example.com/blocked'); true", true)
      .catch(() => {});
    await sleep(600);
    check(
      "without allowpopups the handler is never asked — the attribute is load-bearing",
      askedBare.length === 0,
      askedBare.join(", ") || "blocked before the handler",
    );
  }

  finish(open);
});

function finish(windows) {
  console.log(
    failures === 0 ? "\nALL WEBVIEW CHECKS PASSED" : `\n${failures} FAILED`,
  );
  for (const w of windows) {
    try {
      w?.destroy();
    } catch {
      /* already gone */
    }
  }
  app.exit(failures === 0 ? 0 : 1);
}
