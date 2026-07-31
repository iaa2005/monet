/**
 * WHOSE pixels a capture returns, and WHERE a crop rectangle lands.
 *
 * This exists because a shipped screenshot showed the app instead of the page.
 * `Page.captureScreenshot` with `fromSurface: false` — chosen in the hope it
 * would work for an off-screen guest — returns the pixels of the WINDOW from
 * the window's own origin, so a guest sitting in a side panel comes back as
 * whatever the app draws in its top-left corner.
 *
 * The probe that was supposed to catch this could not: it put the guest at the
 * window origin, where the two coordinate spaces coincide and both captures
 * look identical. Hence the setup here — the guest is deliberately OFFSET, and
 * the two pages are solid colours so the answer is a pixel count rather than a
 * judgement about a byte length.
 *
 * The crop rectangle is checked the same way: a green square at a known spot
 * in the guest must be inside the rectangle that covers it and outside one
 * that does not. That pins the space (viewport CSS pixels) rather than
 * assuming it.
 *
 *   electron scripts/capture-target-probe.cjs
 */
const { app, BrowserWindow, nativeImage } = require("electron");
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
const note = (name, detail) => console.log(`NOTE  ${name} — ${detail}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Guest: solid blue, with a green square at (10,10)–(90,90) in CSS pixels.
const GUEST = `<!doctype html><meta charset="utf-8"><title>guest</title>
<style>
  html,body{margin:0;height:100%;background:#0000ff}
  #mark{position:fixed;left:10px;top:10px;width:80px;height:80px;background:#00ff00}
</style>
<div id="mark"></div>`;

// Host: solid red, guest offset into the bottom-right — the whole point.
const HOST = (url) => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#ff0000}
  #wrap{position:absolute;right:0;bottom:0;width:50%;height:60%}
  webview{width:100%;height:100%}
</style>
<div id="wrap"><webview id="w" src="${url}"></webview></div>`;

/** Percentage of pixels that are near-pure blue, red and green. */
function census(png) {
  const img = nativeImage.createFromBuffer(png);
  const { width, height } = img.getSize();
  if (!width) return { width, height, blue: 0, red: 0, green: 0 };
  const bmp = img.toBitmap(); // BGRA
  let blue = 0;
  let red = 0;
  let green = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    const b = bmp[i];
    const g = bmp[i + 1];
    const r = bmp[i + 2];
    if (b > 200 && r < 60 && g < 60) blue++;
    if (r > 200 && b < 60 && g < 60) red++;
    if (g > 200 && r < 60 && b < 60) green++;
  }
  const total = bmp.length / 4;
  const pct = (n) => Math.round((n / total) * 100);
  return { width, height, blue: pct(blue), red: pct(red), green: pct(green) };
}

app.whenReady().then(async () => {
  const dir = mkdtempSync(join(tmpdir(), "monet-capture-probe-"));
  const gPath = join(dir, "guest.html");
  const hPath = join(dir, "host.html");
  writeFileSync(gPath, GUEST, "utf-8");
  writeFileSync(hPath, HOST(pathToFileURL(gPath).href), "utf-8");

  const win = new BrowserWindow({
    width: 800,
    height: 600,
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
  await win.loadFile(hPath);
  const guest = await attached;
  check("the guest attached", !!guest);
  if (!guest) return finish(win);

  await new Promise((r) => {
    if (!guest.isLoading()) return r();
    guest.once("did-finish-load", r);
    setTimeout(r, 8000);
  });
  await sleep(800);

  // ── 1. A full capture is the PAGE, not the app around it ────────────
  const full = census((await guest.capturePage()).toPNG());
  check(
    "capturePage() returns the guest's pixels",
    full.blue > 80 && full.red === 0,
    JSON.stringify(full),
  );

  // ── 2. The crop rectangle is viewport CSS pixels ────────────────────
  const onMark = census(
    (await guest.capturePage({ x: 0, y: 0, width: 100, height: 100 })).toPNG(),
  );
  check(
    "a rect over the marker contains it",
    onMark.green > 40 && onMark.red === 0,
    JSON.stringify(onMark),
  );

  const offMark = census(
    (await guest.capturePage({ x: 150, y: 150, width: 100, height: 100 })).toPNG(),
  );
  check(
    "a rect away from the marker does not",
    offMark.green === 0 && offMark.blue > 80 && offMark.red === 0,
    JSON.stringify(offMark),
  );

  // The returned image is at the display's scale, which is why anything that
  // crops a captured frame afterwards measures the factor instead of assuming.
  note(
    "capturePage scale",
    `a 100×100 CSS rect came back ${onMark.width}×${onMark.height}`,
  );

  // ── 3. Why the CDP route is not used ────────────────────────────────
  try {
    guest.debugger.attach("1.3");
    await guest.debugger.sendCommand("Page.enable");
    const shot = await Promise.race([
      guest.debugger.sendCommand("Page.captureScreenshot", {
        format: "png",
        fromSurface: false,
        captureBeyondViewport: false,
      }),
      sleep(6000).then(() => null),
    ]);
    if (shot) {
      const c = census(Buffer.from(shot.data, "base64"));
      // Recorded rather than asserted — this is a Chromium behaviour, not a
      // promise we depend on. It is here so the next person reaching for
      // fromSurface:false sees what it actually does.
      note(
        "CDP captureScreenshot fromSurface=false",
        c.red > 50
          ? `returns the HOST window (${c.red}% red) — this was the bug`
          : `returned ${JSON.stringify(c)}`,
      );
    } else {
      note("CDP captureScreenshot fromSurface=false", "timed out");
    }
    guest.debugger.detach();
  } catch (err) {
    note("CDP capture", String(err));
  }

  finish(win);
});

function finish(win) {
  console.log(
    failures === 0 ? "\nALL CAPTURE CHECKS PASSED" : `\n${failures} FAILED`,
  );
  try {
    win?.destroy();
  } catch {
    /* gone */
  }
  app.exit(failures === 0 ? 0 : 1);
}
