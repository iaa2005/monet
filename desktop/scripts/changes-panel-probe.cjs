/**
 * The review surface: what Changes shows for a working tree.
 *
 * Structure, not pixels — but structure is where this panel's promises live:
 * one section per file, each carrying its own +/− counts, the diff flush
 * underneath (no nested scroller), long unchanged runs folded behind an
 * "N unmodified lines" toggle, and a diff too large to render eagerly
 * arriving COLLAPSED instead of freezing the UI for seconds.
 *
 * Runs the BUILT renderer with the app's real preload, and answers only the
 * two git IPC calls the panel makes — every other invoke rejects, which the
 * app tolerates. That is the point: this probe is about the panel, and the
 * panel's input is a patch.
 *
 *   electron scripts/changes-panel-probe.cjs
 */
const { app, BrowserWindow, ipcMain } = require("electron");
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

/** A hunk with a long unchanged run, so the fold has something to fold. */
const filler = (n, from) =>
  Array.from({ length: n }, (_, i) => ` context line ${from + i}`).join("\n");

const SMALL_PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,24 +1,25 @@",
  filler(12, 1),
  "-const old = 1;",
  "+const next = 2;",
  "+const extra = 3;",
  filler(10, 14),
  "diff --git a/README.md b/README.md",
  "index 3333333..4444444 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,3 +1,3 @@",
  " # Title",
  "-old line",
  "+new line",
  " tail",
].join("\n");

/** Big enough to cross the auto-collapse threshold (600 rows). */
const BIG_PATCH = [
  "diff --git a/src/huge.ts b/src/huge.ts",
  "index 5555555..6666666 100644",
  "--- a/src/huge.ts",
  "+++ b/src/huge.ts",
  "@@ -1,400 +1,400 @@",
  Array.from({ length: 400 }, (_, i) => `-old line ${i}`).join("\n"),
  Array.from({ length: 400 }, (_, i) => `+new line ${i}`).join("\n"),
].join("\n");

let patch = SMALL_PATCH;
let untracked = ["docs/NOTES.md"];

const watchdog = setTimeout(() => {
  console.log("\nFAIL  the probe itself did not finish");
  app.exit(1);
}, 120_000);
watchdog.unref?.();

app.whenReady().then(async () => {
  ipcMain.handle("git:diff", () => ({ ok: true, patch, untracked }));
  ipcMain.handle("git:info", () => ({ isRepo: true, branch: "feature/dock", root: "D:/repo" }));

  const srv = await serve(join(__dirname, "..", "out", "renderer"));
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    webPreferences: {
      preload: join(__dirname, "..", "out", "preload", "index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadURL(`http://127.0.0.1:${srv.address().port}/`);
  await new Promise((r) => setTimeout(r, 2500));

  const js = (code) => win.webContents.executeJavaScript(code, true);

  // Code mode owns Changes — a git diff has no place in Home's sandbox.
  await js(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Code');
    if (btn) btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 1200));
  // BY ACCESSIBLE NAME, not by `title`.
  //
  // The panel buttons in the title bar stopped carrying a `title` attribute
  // when tooltips became a component (they render a Hint and an aria-label
  // instead), and this selector went on looking for one. It found nothing,
  // the very first check failed, and the probe returns early on that check —
  // so every assertion below about the panel itself has been unreachable ever
  // since, silently. A selector that can go stale without anything failing
  // loudly is worse than no selector; aria-label is the accessible name, which
  // is what a test should be asking for anyway.
  const opened = await js(`(() => {
    const btn = document.querySelector('button[aria-label="Changes"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check("Code mode offers a Changes button", opened);
  if (!opened) return finish(srv, win);
  await new Promise((r) => setTimeout(r, 2500));

  const panel = () =>
    js(`(() => {
      const groups = [...document.querySelectorAll('.dv-groupview')];
      const g = groups.find(x => x.innerText.includes('working tree'));
      if (!g) return null;
      const sections = [...g.querySelectorAll('section')];
      return {
        head: g.innerText.split('\\n').slice(1, 4),
        files: sections.map(s => (s.querySelector('button')?.innerText || '').replace(/\\n/g, ' ').trim()),
        openSections: sections.filter(s => s.children.length > 1).length,
        note: g.innerText.includes('collapsed for large diffs'),
        gaps: [...g.querySelectorAll('button')].filter(b => /unmodified line/.test(b.textContent)).length,
        scrollers: g.querySelectorAll('.overflow-auto, .overflow-y-auto').length,
      };
    })()`);

  // ── 1. A modest diff: every file open, counts on the header ─────────
  {
    const p = await panel();
    check("the panel renders", !!p, JSON.stringify(p));
    if (!p) return finish(srv, win);

    check(
      "the header names the branch and the tree",
      p.head.join(" ").includes("feature/dock") && p.head.join(" ").includes("working tree"),
      JSON.stringify(p.head),
    );
    check(
      "one section per changed file, plus the untracked one",
      p.files.length === 3,
      JSON.stringify(p.files),
    );
    check(
      "each file header carries its own counts",
      p.files.some((f) => f.includes("src/app.ts") && f.includes("+2") && f.includes("-1")),
      JSON.stringify(p.files),
    );
    check(
      "the untracked file is listed by name",
      p.files.some((f) => f.includes("NOTES.md")),
      JSON.stringify(p.files),
    );
    check("a small diff opens expanded", p.openSections >= 2, `${p.openSections} open`);
    check("and says nothing about collapsing", !p.note);
    check(
      "long unchanged runs fold behind a toggle",
      p.gaps >= 1,
      `${p.gaps} gap toggles`,
    );
  }

  // ── 2. Collapsing a file hides its diff, not its header ─────────────
  {
    await js(`(() => {
      const g = [...document.querySelectorAll('.dv-groupview')].find(x => x.innerText.includes('working tree'));
      const s = [...g.querySelectorAll('section')].find(s => s.innerText.includes('app.ts'));
      s.querySelector('button').click();
    })()`);
    await new Promise((r) => setTimeout(r, 600));
    const p = await panel();
    check(
      "clicking a file header collapses just that file",
      p.files.length === 3 && p.openSections >= 1,
      JSON.stringify(p),
    );
  }

  // ── 3. A huge diff arrives collapsed, and says so ───────────────────
  {
    patch = BIG_PATCH;
    untracked = [];
    await js(`(() => {
      const g = [...document.querySelectorAll('.dv-groupview')].find(x => x.innerText.includes('working tree'));
      g.querySelector('button[title="Refresh"]').click();
    })()`);
    await new Promise((r) => setTimeout(r, 2500));
    const p = await panel();
    check("a large diff explains itself", p.note, JSON.stringify(p.head));
    check(
      "and every file starts closed",
      p.files.length === 1 && p.openSections === 0,
      JSON.stringify(p),
    );

    // The nested-scroller rule: the panel scrolls, the diffs do not.
    const inner = await js(`(() => {
      const g = [...document.querySelectorAll('.dv-groupview')].find(x => x.innerText.includes('working tree'));
      const s = [...g.querySelectorAll('section')][0];
      s.querySelector('button').click();
      return true;
    })()`);
    void inner;
    await new Promise((r) => setTimeout(r, 1500));
    const scrolls = await js(`(() => {
      const g = [...document.querySelectorAll('.dv-groupview')].find(x => x.innerText.includes('working tree'));
      const s = [...g.querySelectorAll('section')][0];
      return [...s.querySelectorAll('*')].filter(el => {
        const st = getComputedStyle(el);
        return (st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4;
      }).length;
    })()`);
    check(
      "an expanded diff does not open a scroller inside the panel",
      scrolls === 0,
      `${scrolls} inner scrollers`,
    );
  }

  finish(srv, win);
});

function finish(srv, win) {
  try {
    srv.close();
    win.destroy();
  } catch {
    /* already gone */
  }
  console.log(failures === 0 ? "\nALL CHANGES-PANEL CHECKS PASSED" : `\n${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
}
