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

  // ── 2. The dock IS the content area: the chat anchors it at boot ────
  const boot = await js(`(() => {
    const el = document.querySelector('.dv-dockview');
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    return { present: true, w: Math.round(r.width), h: Math.round(r.height),
             tabs: [...document.querySelectorAll('.dv-tab')].map(t => t.textContent.trim()) };
  })()`);
  check("the dock is present at boot", boot.present, JSON.stringify(boot));
  if (boot.present) {
    // Pixels, not presence — the original bug WAS a dock at 0px tall.
    check("with real size", boot.h > 300 && boot.w > 300, `${boot.w}×${boot.h}`);
    check("anchored by the Chat tab", boot.tabs.some((t) => t.includes("Chat")), boot.tabs.join(", "));
    check(
      "the chat tab carries no close button",
      await js(`(() => {
        const tab = [...document.querySelectorAll('.dv-tab')].find(t => t.textContent.includes('Chat'));
        return tab ? !tab.querySelector('button') : false;
      })()`),
    );
  }

  // ── 3. Files opens BESIDE the chat, not over it ─────────────────────
  const hasBtn = await js(`!!document.querySelector('button[title="Files"]')`);
  check("the header has a Files button", hasBtn);
  if (hasBtn) {
    await js(`document.querySelector('button[title="Files"]').click()`);
    await new Promise((r) => setTimeout(r, 1200));
    const after = await js(`(() => ({
      groups: document.querySelectorAll('.dv-groupview').length,
      tabs: [...document.querySelectorAll('.dv-tab')].map(t => t.textContent.trim()),
    }))()`);
    check(
      "Files lands in its own group beside the chat",
      after.groups >= 2 && after.tabs.some((t) => t.includes("Files")),
      JSON.stringify(after),
    );
    check(
      "no renderer errors after the click",
      errors.length === 0,
      errors.slice(0, 3).join(" | ") || "clean",
    );

    // ── 4. The toggle removes the panel but never the chat ────────────
    await js(`document.querySelector('button[title="Files"]').click()`);
    await new Promise((r) => setTimeout(r, 800));
    const closed = await js(`(() => ({
      dock: !!document.querySelector('.dv-dockview'),
      tabs: [...document.querySelectorAll('.dv-tab')].map(t => t.textContent.trim()),
    }))()`);
    check(
      "a second click closes Files, and the chat stays",
      closed.dock &&
        !closed.tabs.some((t) => t.includes("Files")) &&
        closed.tabs.some((t) => t.includes("Chat")),
      JSON.stringify(closed),
    );
  }

  // ── 5. Detach opens a REAL window, dressed in the app's theme ───────
  //
  // The probe window has no window-open handler, so window.open is allowed —
  // which stands in for the app's allowlist (that path is main-process code
  // reviewed separately). What THIS holds is the renderer side: the popout
  // opens, the group's DOM survives adoption, and dressPopout mirrors the
  // root classes — the exact half-dark-half-light bug reported from use.
  {
    await js(`document.documentElement.classList.add('dark')`);
    await js(`document.querySelector('button[title="Files"]').click()`);
    await new Promise((r) => setTimeout(r, 1000));
    const clicked = await js(`(() => {
      const btn = [...document.querySelectorAll('button[title="Detach into its own window"]')][0];
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    check("a non-chat group offers Detach", clicked);
    if (clicked) {
      await new Promise((r) => setTimeout(r, 3000));
      const child = BrowserWindow.getAllWindows().find((w) => w !== win);
      check("an OS window actually opens", !!child);
      if (child) {
        const childState = await child.webContents.executeJavaScript(
          `JSON.stringify({
            cls: document.documentElement.className,
            groups: document.querySelectorAll('.dv-groupview').length,
            files: [...document.querySelectorAll('.dv-tab')].some(t => t.textContent.includes('Files')),
          })`,
          true,
        );
        const c = JSON.parse(childState);
        check("the adopted group lives in it", c.groups >= 1 && c.files, childState);
        check(
          "and wears the app's root classes",
          c.cls.split(/\s+/).includes("dark"),
          c.cls || "(none)",
        );

        // The theme toggled in the main window re-dresses the popout.
        await js(`document.documentElement.classList.remove('dark')`);
        await new Promise((r) => setTimeout(r, 400));
        const cls2 = await child.webContents.executeJavaScript(
          "document.documentElement.className",
          true,
        );
        check(
          "a theme change reaches the open popout",
          !cls2.split(/\s+/).includes("dark"),
          cls2 || "(none)",
        );

        // Closing the window returns the panel to the grid, not to nowhere.
        child.close();
        await new Promise((r) => setTimeout(r, 1500));
        const back = await js(
          `[...document.querySelectorAll('.dv-tab')].some(t => t.textContent.includes('Files'))`,
        );
        check("closing the popout returns the panel to the grid", back);
      }
    }
  }

  srv.close();
  console.log(failures === 0 ? "\nALL DOCK-CLICK CHECKS PASSED" : `\n${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
