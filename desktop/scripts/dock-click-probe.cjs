/**
 * The reported flow, replayed in a real Chromium: click "Files" in the
 * header → the wing must appear WITH SIZE.
 *
 * Exists because of two field reports in a row. First the wing mounted as a
 * 0px sliver (dockview ships no height of its own; a flex-col parent gives
 * an unsized child nothing), then "ваще не открывается". A DOM assertion
 * that the dock is present is not enough — the bug WAS present-but-zero, so
 * the probe measures pixels.
 *
 * The renderer runs without a preload here, so electronAPI is undefined —
 * which is itself part of the check: the app must render its shell (and the
 * dock must work) even when every bridge call no-ops.
 *
 *   electron scripts/dock-click-probe.cjs
 */
const { app, BrowserWindow } = require("electron");
const http = require("http");
const { readFile } = require("fs");
const { join, extname } = require("path");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!pass) failures++;
};

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json",
  ".wasm": "application/wasm",
};

function serve(root) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/") p = "/index.html";
      readFile(join(root, p), (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("nf");
          return;
        }
        res.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream" });
        res.end(data);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const watchdog = setTimeout(() => {
  console.log("\nFAIL  the probe itself did not finish");
  app.exit(1);
}, 90_000);
watchdog.unref?.();

app.whenReady().then(async () => {
  const srv = await serve(join(__dirname, "..", "out", "renderer"));
  const port = srv.address().port;

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 3) errors.push(message);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    errors.push(`renderer gone: ${details.reason}`);
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);
  await new Promise((r) => setTimeout(r, 2500));

  const js = (code) => win.webContents.executeJavaScript(code, true);

  // ── 1. The app renders at all ───────────────────────────────────────
  const bodyChildren = await js("document.body.children.length");
  const rootText = await js("(document.getElementById('root')||{}).childElementCount ?? -1");
  check("the renderer mounts a React tree", rootText > 0, `root children: ${rootText}, body: ${bodyChildren}`);
  check(
    "no renderer errors on boot",
    errors.length === 0,
    errors.slice(0, 3).join(" | ") || "clean",
  );

  // ── 2. The header's Files button exists and a click opens the wing ──
  const hasBtn = await js(`!!document.querySelector('button[title="Files"]')`);
  check("the header has a Files button", hasBtn);
  if (hasBtn) {
    await js(`document.querySelector('button[title="Files"]').click()`);
    await new Promise((r) => setTimeout(r, 1200));

    const dock = await js(`(() => {
      const el = document.querySelector('.dv-dockview');
      if (!el) return { present: false };
      const r = el.getBoundingClientRect();
      return { present: true, w: Math.round(r.width), h: Math.round(r.height),
               tabs: document.querySelectorAll('.dv-tab').length };
    })()`);
    check("the dock appears after the click", dock.present, JSON.stringify(dock));
    if (dock.present) {
      // Pixels, not presence — the bug this probe exists for WAS a dock that
      // existed at 0px tall.
      check("and it has real height", dock.h > 150, `${dock.w}×${dock.h}`);
      check("and real width", dock.w > 150, `${dock.w}×${dock.h}`);
      check("with the Files tab in it", dock.tabs >= 1, `${dock.tabs} tabs`);
    }
    check(
      "no renderer errors after the click",
      errors.length === 0,
      errors.slice(0, 3).join(" | ") || "clean",
    );

    // ── 3. The toggle closes it again ─────────────────────────────────
    await js(`document.querySelector('button[title="Files"]').click()`);
    await new Promise((r) => setTimeout(r, 800));
    const gone = await js(`!document.querySelector('.dv-dockview')`);
    check("a second click closes the wing", gone);
  }

  srv.close();
  console.log(failures === 0 ? "\nALL DOCK-CLICK CHECKS PASSED" : `\n${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
