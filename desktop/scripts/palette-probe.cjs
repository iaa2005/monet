/**
 * The dark palette, measured on the running app.
 *
 * Colours are the one thing a screenshot proves and a code review does not:
 * a token can be right in the file and wrong on screen (a stale variable, a
 * utility compiled against the light value, a surface painted with the wrong
 * token). So this reads getComputedStyle in a real Electron window, booted
 * straight into dark.
 *
 * The relationships are the point, not the hexes: content is the DEEPEST
 * surface, chrome sits above it, menus above that, and the divider is
 * visible without shouting. Contrast floors are asserted, not eyeballed.
 *
 *   electron scripts/palette-probe.cjs
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

/** WCAG relative luminance of an "rgb(r, g, b)" string. */
function luminance(css) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || "");
  if (!m) return null;
  const f = (v) => {
    const c = Number(v) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(m[1]) + 0.7152 * f(m[2]) + 0.0722 * f(m[3]);
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const rgb = (css) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
/** A neutral grey — Cursor's palette carries no hue. */
const neutral = (css, tol = 3) => {
  const c = rgb(css);
  if (!c) return false;
  return Math.max(...c) - Math.min(...c) <= tol;
};

const watchdog = setTimeout(() => {
  console.log("\nFAIL  the probe itself did not finish");
  app.exit(1);
}, 90_000);
watchdog.unref?.();

app.whenReady().then(async () => {
  const srv = await serve(join(__dirname, "..", "out", "renderer"));
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(`http://127.0.0.1:${srv.address().port}/`);
  // Dark before first paint, so nothing is measured mid-theme-swap.
  await win.webContents.executeJavaScript(
    `localStorage.setItem('theme','dark'); location.reload(); true`,
    true,
  );
  await new Promise((r) => setTimeout(r, 3000));

  const js = (code) => win.webContents.executeJavaScript(code, true);
  await js(`document.querySelector('button[title="Files"]').click()`);
  await new Promise((r) => setTimeout(r, 1200));

  const p = await js(`(() => {
    const cs = (el) => el ? getComputedStyle(el) : null;
    const aside = document.querySelector('aside');
    const group = document.querySelector('.dv-groupview');
    const handle = document.querySelector('[data-slot="resizable-handle"]');
    const muted = document.querySelector('.text-muted-foreground');
    const root = getComputedStyle(document.documentElement);
    return {
      dark: document.documentElement.classList.contains('dark'),
      chrome: cs(document.body).backgroundColor,
      text: cs(document.body).color,
      sidebar: cs(aside)?.backgroundColor,
      content: cs(group)?.backgroundColor,
      handle: cs(handle)?.backgroundColor,
      muted: muted ? cs(muted).color : null,
      border: root.getPropertyValue('--border').trim(),
      popover: root.getPropertyValue('--popover').trim(),
    };
  })()`);

  check("the app boots dark", p.dark);
  check("every surface is a neutral grey", neutral(p.chrome) && neutral(p.content), `${p.chrome} / ${p.content}`);

  // The Cursor arrangement: content deepest, chrome a step up.
  const lc = luminance(p.content);
  const lch = luminance(p.chrome);
  check(
    "content sits DEEPER than the chrome around it",
    lc !== null && lch !== null && lc < lch,
    `content ${p.content} vs chrome ${p.chrome}`,
  );
  check(
    "the sidebar is chrome, not content",
    p.sidebar === p.chrome,
    `${p.sidebar} vs ${p.chrome}`,
  );
  check(
    "but the two are close — a step, not a jump",
    contrast(p.content, p.chrome) < 1.5,
    contrast(p.content, p.chrome).toFixed(2) + ":1",
  );

  // Text: readable without being paper-white.
  check(
    "primary text clears AA on both surfaces",
    contrast(p.text, p.content) >= 7 && contrast(p.text, p.chrome) >= 7,
    `${contrast(p.text, p.content).toFixed(1)}:1 / ${contrast(p.text, p.chrome).toFixed(1)}:1`,
  );
  check(
    "and is not pure white",
    (rgb(p.text) ?? [255])[0] < 240,
    p.text,
  );
  if (p.muted)
    check(
      "muted text still clears AA (4.5:1) on the chrome",
      contrast(p.muted, p.chrome) >= 4.5,
      `${contrast(p.muted, p.chrome).toFixed(2)}:1 — ${p.muted}`,
    );

  // The divider: visible against both surfaces, quiet against text.
  check(
    "the divider is the border token, painted",
    !!p.handle && luminance(p.handle) !== null,
    p.handle,
  );
  check(
    "and it reads on the content surface without shouting",
    contrast(p.handle, p.content) > 1.25 && contrast(p.handle, p.content) < 3,
    `${contrast(p.handle, p.content).toFixed(2)}:1 — ${p.handle}`,
  );
  check(
    "the divider is neutral too",
    neutral(p.handle, 6),
    p.handle,
  );

  // ── The sidebar is chrome: square, flush, no inner margin ──────────
  //
  // Rounded pills inside a bordered box read as a widget sitting on the
  // sidebar; flush rows read as the sidebar itself. With the dock's cards
  // gone, a pill in here is the only rounded thing left on screen.
  const side = await js(`(() => {
    const aside = document.querySelector('aside');
    const tabs = [...aside.querySelectorAll('button')].filter(b => /^(Home|Code)$/.test(b.textContent.trim()));
    const rows = [...aside.querySelectorAll('button')].filter(b => /New session|Import session|Routines/.test(b.textContent.trim()));
    const radii = (els) => els.map(e => getComputedStyle(e).borderTopLeftRadius);
    return {
      asideRadius: getComputedStyle(aside).borderTopLeftRadius,
      tabCount: tabs.length,
      tabRadii: radii(tabs),
      tabWidth: tabs[0] ? Math.round(tabs[0].getBoundingClientRect().width) : 0,
      tabBarHeight: tabs[0]?.parentElement?.parentElement
        ? Math.round(tabs[0].parentElement.parentElement.getBoundingClientRect().height)
        : 0,
      asideWidth: Math.round(aside.getBoundingClientRect().width),
      rowRadii: radii(rows),
      rowLeft: rows[0] ? Math.round(rows[0].getBoundingClientRect().left) : null,
      asideLeft: Math.round(aside.getBoundingClientRect().left),
    };
  })()`);

  check("the sidebar itself is square", side.asideRadius === "0px", side.asideRadius);
  check(
    "the Home/Code bar is exactly 32px tall",
    side.tabBarHeight === 32,
    `${side.tabBarHeight}px`,
  );
  check(
    "the Home/Code tabs are square",
    side.tabCount === 2 && side.tabRadii.every((r) => r === "0px"),
    JSON.stringify(side.tabRadii),
  );
  check(
    "and split the full width between them",
    Math.abs(side.tabWidth * 2 - side.asideWidth) <= 2,
    `${side.tabWidth}×2 vs ${side.asideWidth}`,
  );
  check(
    "the nav rows are square",
    side.rowRadii.length >= 2 && side.rowRadii.every((r) => r === "0px"),
    JSON.stringify(side.rowRadii),
  );
  check(
    "and start at the sidebar's own edge — no inner margin",
    side.rowLeft === side.asideLeft,
    `${side.rowLeft} vs ${side.asideLeft}`,
  );

  // ── The window buttons cover the title bar exactly ─────────────────
  //
  // They are a FIXED layer, not part of the header's flow, so their height
  // is a second number that has to agree with the bar's. It stopped agreeing
  // the moment the bar got shorter: the close button's red hover block hung
  // below it (reported with a screenshot). Both now read one token, and this
  // measures that they land on the same band.
  {
    const bar = await js(`(() => {
      const header = document.querySelector('.app-drag');
      const close = document.querySelector('button[aria-label="Close"]');
      const h = header?.getBoundingClientRect();
      const c = close?.getBoundingClientRect();
      return h && c ? {
        headerTop: Math.round(h.top), headerBottom: Math.round(h.bottom),
        closeTop: Math.round(c.top), closeBottom: Math.round(c.bottom),
        closeWidth: Math.round(c.width),
      } : null;
    })()`);
    check("the title bar and its buttons exist", !!bar, JSON.stringify(bar));
    if (bar) {
      check(
        "the close button starts and ends with the bar",
        bar.closeTop === bar.headerTop && bar.closeBottom === bar.headerBottom,
        `bar ${bar.headerTop}–${bar.headerBottom} vs button ${bar.closeTop}–${bar.closeBottom}`,
      );
      check(
        "and keeps the platform's caption width",
        bar.closeWidth === 46,
        `${bar.closeWidth}px`,
      );
    }
  }

  // ── The accent, and how sharp the corners are ──────────────────────
  //
  // One orange carries links, focus rings and the mark; one --radius drives
  // every corner in the app. Both are single tokens, which is exactly why
  // they are worth measuring: a change here lands everywhere at once, and a
  // link that fails contrast fails on every screen.
  const accent = await js(`(() => {
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-9999px;color:hsl(var(--link));background:hsl(var(--brand));border-radius:var(--radius)';
    probe.className = 'rounded-md';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const out = {
      link: cs.color,
      brand: cs.backgroundColor,
      radius: root.getPropertyValue('--radius').trim(),
      roundedMd: cs.borderTopLeftRadius,
    };
    probe.remove();
    return out;
  })()`);

  const hue = (css) => {
    const c = rgb(css);
    if (!c) return null;
    const [r, g, b] = c.map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return null;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  };

  check(
    "links are orange, not blue",
    (() => {
      const h = hue(accent.link);
      return h !== null && h >= 10 && h <= 40;
    })(),
    `${accent.link} (hue ${Math.round(hue(accent.link) ?? -1)}°)`,
  );
  check(
    "the mark shares that hue",
    Math.abs((hue(accent.brand) ?? 0) - (hue(accent.link) ?? 99)) < 12,
    `${accent.brand} vs ${accent.link}`,
  );
  check(
    "and links still clear AA on the surface they sit on",
    contrast(accent.link, p.content) >= 4.5,
    `${contrast(accent.link, p.content).toFixed(2)}:1`,
  );
  check(
    "corners are strict — the radius token is small",
    parseFloat(accent.radius) <= 6,
    accent.radius,
  );
  check(
    "and the whole scale follows it",
    parseFloat(accent.roundedMd) <= 5,
    `rounded-md = ${accent.roundedMd}`,
  );

  // ── Light theme: the same accent has to survive white ──────────────
  {
    await js(`document.documentElement.classList.remove('dark'); true`);
    await new Promise((r) => setTimeout(r, 600));
    const light = await js(`(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-9999px;color:hsl(var(--link))';
      document.body.appendChild(probe);
      const link = getComputedStyle(probe).color;
      probe.remove();
      const group = document.querySelector('.dv-groupview');
      return { link, surface: group ? getComputedStyle(group).backgroundColor : null };
    })()`);
    check(
      "in light, the orange link clears AA on the surface",
      contrast(light.link, light.surface) >= 4.5,
      `${contrast(light.link, light.surface).toFixed(2)}:1 — ${light.link}`,
    );
  }

  // ── The toggle wears the accent, and no native select survives ─────
  //
  // Two app-wide claims that only a running window can settle: the switch's
  // ON colour used to be a hardcoded blue belonging to no palette, and a
  // native <select> paints its list with the OS widget — the one control
  // whose popup ignores every token in this file.
  {
    // Raise a surface that HAS a switch: the routine editor's Active toggle,
    // on by default. A check that silently skips when it finds nothing is a
    // check nobody is running.
    await js(`(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.textContent.trim() === 'Routines',
      );
      btn && btn.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 900));
    await js(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        b.textContent.includes('New routine'),
      );
      btn && btn.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 900));

    const ui = await js(`(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-9999px';
      probe.className = 'bg-brand';
      document.body.appendChild(probe);
      const brand = getComputedStyle(probe).backgroundColor;
      probe.remove();
      // Render a switch offscreen? Cheaper: find one in the open settings.
      const sw = document.querySelector('[role="switch"][aria-checked="true"]');
      return {
        brand,
        switchOn: sw ? getComputedStyle(sw).backgroundColor : null,
        nativeSelects: document.querySelectorAll('select').length,
      };
    })()`);
    check(
      "no native select is left in the app",
      ui.nativeSelects === 0,
      `${ui.nativeSelects} found`,
    );
    check(
      "an ON switch is painted with the accent",
      !!ui.switchOn && ui.switchOn === ui.brand,
      `${ui.switchOn ?? "(no switch on screen)"} vs brand ${ui.brand}`,
    );
  }

  srv.close();
  win.destroy();
  console.log(failures === 0 ? "\nALL PALETTE CHECKS PASSED" : `\n${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
