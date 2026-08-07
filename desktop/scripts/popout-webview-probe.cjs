/**
 * A <webview> cannot be moved to another window. It can only be rebuilt there.
 *
 * The Browser panel embeds pages as <webview> elements in the renderer's own
 * DOM, and popping the panel out is dockview ADOPTING that DOM into a second
 * window — the same nodes, a different document. The report was "the page is
 * there and I cannot click anything in it".
 *
 * Measured here, with no app in the way:
 *
 *   - in the window that created it, a real mouse event (sendInputEvent on
 *     the guest's own webContents, not a synthetic DOM event — a synthetic
 *     one would pass whether or not input routing survived) reaches the page;
 *   - move the element into a second window and the element reports a
 *     DIFFERENT webContents id. The guest it was attached to is gone; what is
 *     there now was never wired to either window's input. Delivering a real
 *     mouse event to it takes the whole process down with exit code 3, so
 *     this probe deliberately does not — the changed id is the evidence, and
 *     it is the same evidence either way;
 *   - a webview CREATED in the second window works there, which is what the
 *     panel now does on a location change (see DockArea's browser panel).
 *
 *   electron scripts/popout-webview-probe.cjs
 */
const { app, BrowserWindow, webContents } = require("electron");
const http = require("http");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!pass) failures++;
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>ready</title>
<body style="margin:0;height:100vh;background:#eee">
<script>
  let n = 0;
  addEventListener("click", () => { n++; document.title = "clicked-" + n; });
</script>`;

const HOST = `<!doctype html><meta charset="utf-8"><title>host</title>
<body style="margin:0"><div id="slot" style="width:600px;height:400px"></div>`;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.url.startsWith("/host") ? HOST : PAGE);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => {
  console.log("\nFAIL  the probe itself did not finish");
  app.exit(1);
}, 60_000);
watchdog.unref?.();

/** A real mouse click delivered to a guest's own webContents. */
async function clickGuest(id) {
  let wc;
  try {
    wc = webContents.fromId(id);
  } catch (e) {
    return `fromId threw: ${e.message}`;
  }
  if (!wc || wc.isDestroyed?.()) return "no live guest";
  wc.focus?.();
  wc.sendInputEvent({ type: "mouseDown", x: 50, y: 50, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: 50, y: 50, button: "left", clickCount: 1 });
  await sleep(500);
  return wc.getTitle();
}

/** Build a webview inside a document and wait for its guest. */
const MAKE_WEBVIEW = (doc, src, id) => `(() => {
  const d = ${doc};
  const v = d.createElement('webview');
  v.id = ${JSON.stringify(id)};
  v.setAttribute('src', ${JSON.stringify(src)});
  v.style.cssText = 'width:600px;height:400px;display:flex';
  d.getElementById('slot').appendChild(v);
})()`;

app.whenReady().then(async () => {
  const srv = await serve();
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;

  const win = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, webviewTag: true },
  });
  // The app's own rule: its popout host page may become a real window.
  win.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
      },
    },
  }));

  await win.loadURL(`${base}/host`);
  const js = (code) => win.webContents.executeJavaScript(code, true);

  // ── Where it was born ───────────────────────────────────────────────
  await js(MAKE_WEBVIEW("document", `${base}/page`, "guest"));
  await sleep(2500);

  const firstId = await js(`document.getElementById('guest').getWebContentsId()`).catch(
    () => -1,
  );
  check("the guest attaches in its own window", firstId > 0, `id ${firstId}`);
  const titleBefore = await clickGuest(firstId);
  check("and a real click reaches the page", /clicked-1/.test(titleBefore), titleBefore);

  // ── Adopted into a second window ────────────────────────────────────
  await js(
    `(() => { window.__popout = window.open(${JSON.stringify(`${base}/host`)}, 'pop', 'width=800,height=600') })()`,
  );
  await sleep(1500);
  const popouts = BrowserWindow.getAllWindows().filter((w) => w !== win);
  check("a second window opened", popouts.length === 1, `${popouts.length} windows`);
  if (popouts.length) popouts[0].showInactive();

  const moved = await js(`(() => {
    const w = window.__popout;
    const el = document.getElementById('guest');
    const slot = w.document.getElementById('slot');
    if (!slot) return 'no slot in the popout';
    slot.appendChild(el);           // the adoption dockview performs
    return el.ownerDocument === w.document ? 'moved' : 'still here';
  })()`);
  check("the element can be adopted by the second window", moved === "moved", moved);
  await sleep(2500);

  const secondId = await js(`(() => {
    const el = window.__popout.document.getElementById('guest');
    if (!el) return -1;
    try { return el.getWebContentsId() } catch { return -2 }
  })()`);
  check(
    "…but the guest it was attached to is GONE — a new id, a new guest",
    secondId > 0 && secondId !== firstId,
    `${firstId} → ${secondId}`,
  );
  // Deliberately NOT clicked: a real mouse event to this one crashes the
  // process. That is the bug, and the id above is the same evidence.

  // ── Built in the window it lives in ─────────────────────────────────
  await js(`(() => {
    const w = window.__popout;
    w.document.getElementById('guest')?.remove();
    return true;
  })()`);
  await js(`(() => {
    const w = window.__popout;
    const v = w.document.createElement('webview');
    v.id = 'fresh';
    v.setAttribute('src', ${JSON.stringify(`${base}/page`)});
    v.style.cssText = 'width:600px;height:400px;display:flex';
    w.document.getElementById('slot').appendChild(v);
  })()`);
  await sleep(2500);

  const freshId = await js(`(() => {
    const el = window.__popout.document.getElementById('fresh');
    try { return el ? el.getWebContentsId() : -1 } catch { return -2 }
  })()`);
  check("a webview BUILT in the second window attaches", freshId > 0, `id ${freshId}`);
  const titleFresh = freshId > 0 ? await clickGuest(freshId) : "no guest";
  check(
    "AND A REAL CLICK REACHES IT — which is why the panel remounts",
    /clicked-1/.test(titleFresh),
    titleFresh,
  );

  console.log(
    failures
      ? `\n${failures} FAILED`
      : "\nA WEBVIEW BELONGS TO THE WINDOW THAT BUILT IT",
  );
  clearTimeout(watchdog);
  app.exit(failures ? 1 : 0);
});
