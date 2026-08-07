/**
 * Nothing on screen is still the old brand colour.
 *
 * Changing the app from orange to blue meant changing `--brand`, and the
 * links stayed orange, and a chart in Settings stayed orange, and three
 * windows kept opening cream. Every one of those was a colour written
 * down somewhere that did not know it was the brand. Grep cannot find
 * them all — a hex in a class name, a token that was copied rather than
 * referenced, an SVG fill — so this asks the running app instead.
 *
 * It boots the real renderer, walks every element in both themes, and
 * reads the colours the browser actually computed. Anything sitting in
 * the OLD brand's hue band is a leftover.
 *
 * The band is deliberately narrow. Amber warnings live at hue 32-45 and
 * are supposed to; the terracotta this app used to wear was 18-20. So
 * 8..28 catches the brand and leaves the warnings alone.
 *
 *   npm run smoke:hue            # pass/fail
 *   npm run smoke:hue -- --report  # list every offender with its selector
 */
const { app, BrowserWindow } = require("electron");
const http = require("http");
const { readFile } = require("fs");
const { join, extname } = require("path");

const REPORT = process.argv.includes("--report");

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
        res.writeHead(200, {
          "Content-Type": TYPES[extname(p)] || "application/octet-stream",
        });
        res.end(data);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

/** Runs INSIDE the page: every painted colour, with where it came from. */
const SCAN = `(() => {
  const hueOf = (css) => {
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?/.exec(css || "");
    if (!m) return null;
    const a = m[4] === undefined ? 1 : Number(m[4]);
    if (a < 0.06) return null;              // invisible; not a colour anybody sees
    const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return null;               // grey has no hue
    const l = (max + min) / 2;
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
    return { h, s: Math.round(s * 100), l: Math.round(l * 100), css };
  };

  const where = (el) => {
    const cls = typeof el.className === "string" ? el.className : "";
    return el.tagName.toLowerCase() +
      (el.id ? "#" + el.id : "") +
      (cls ? "." + cls.trim().split(/\\s+/).slice(0, 4).join(".") : "");
  };

  const out = [];
  out.scanned = document.querySelectorAll("*").length;
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    for (const prop of ["color", "backgroundColor", "borderTopColor",
                        "borderLeftColor", "outlineColor", "fill", "stroke"]) {
      const hit = hueOf(cs[prop]);
      // 8..28 is the old brand. Amber warnings start around 32.
      if (hit && hit.h >= 8 && hit.h <= 28 && hit.s >= 25) {
        out.push({ prop, ...hit, at: where(el) });
      }
    }
  }
  const root = getComputedStyle(document.documentElement);
  return {
    hits: out,
    // Coverage, so "found nothing" can be told apart from "looked at
    // nothing" — an empty window passes any search.
    scanned: out.scanned,
    brand: root.getPropertyValue("--brand").trim(),
    link: root.getPropertyValue("--link").trim(),
    hue: root.getPropertyValue("--brand-hue").trim(),
  };
})()`;

const watchdog = setTimeout(() => {
  console.log("\\nFAIL  the probe itself did not finish");
  app.exit(1);
}, 120_000);
watchdog.unref?.();

app.whenReady().then(async () => {
  const srv = await serve(join(__dirname, "..", "out", "renderer"));
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  for (const theme of ["light", "dark"]) {
    await win.loadURL(`http://127.0.0.1:${srv.address().port}/`);
    await js(`localStorage.setItem('theme','${theme}'); location.reload(); true`);
    await new Promise((r) => setTimeout(r, 3000));

    // Open a few panels so the scan sees more than the empty state.
    for (const title of ["Files", "Settings"]) {
      await js(
        `(document.querySelector('button[title="${title}"]')||{click(){}}).click(); true`,
      );
      await new Promise((r) => setTimeout(r, 900));
    }

    const scan = await js(SCAN);
    const unique = new Map();
    for (const f of scan.hits) unique.set(`${f.at}|${f.prop}|${f.css}`, f);
    const list = [...unique.values()];

    // Both roles must come off the one knob. This is the check that would
    // have caught the original complaint: `--brand` was changed to blue
    // and `--link` was left orange, in the same file, twelve lines apart.
    check(
      `${theme}: brand and link are the same hue`,
      !!scan.hue &&
        scan.brand.startsWith(scan.hue) &&
        scan.link.startsWith(scan.hue),
      `hue ${scan.hue || "unset"}, brand "${scan.brand}", link "${scan.link}"`,
    );
    check(
      `${theme}: nothing paints the old brand hue`,
      list.length === 0,
      list.length
        ? `${list.length} element(s) of ${scan.scanned}`
        : `${scan.scanned} elements scanned`,
    );
    if (REPORT || list.length) {
      for (const f of list.slice(0, 40))
        console.log(`        hsl(${f.h} ${f.s}% ${f.l}%)  ${f.prop}  ${f.at}`);
      if (list.length > 40) console.log(`        …and ${list.length - 40} more`);
    }

    // The colour main paints a window with has to be the colour the
    // renderer paints the canvas with, or every window opens with a flash
    // of something else. Two files, one number, checked rather than
    // commented.
    // The colour main paints a window with has to be the colour the
    // renderer paints the canvas with, or every window opens with a flash
    // of something else. Two files, one number, checked rather than
    // commented — the expected value is read out of the shared source
    // rather than copied here, so a copy cannot go stale.
    const painted = await js(`(() => {
      const d = document.createElement('div');
      d.style.backgroundColor = 'hsl(' +
        getComputedStyle(document.documentElement).getPropertyValue('--bg-100') + ')';
      document.body.appendChild(d);
      const c = getComputedStyle(d).backgroundColor;
      d.remove();
      return c;
    })()`);
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(painted);
    const hex = m
      ? "#" +
        [m[1], m[2], m[3]]
          .map((v) => Number(v).toString(16).padStart(2, "0"))
          .join("")
      : "?";
    const source = require("fs").readFileSync(
      join(__dirname, "..", "src", "shared", "canvas-colour.ts"),
      "utf-8",
    );
    const declared = new RegExp(`${theme}:\\s*"(#[0-9a-fA-F]{6})"`).exec(source);
    check(
      `${theme}: the window's background matches the canvas`,
      !!declared && hex.toLowerCase() === declared[1].toLowerCase(),
      `canvas ${hex}, window ${declared ? declared[1] : "not declared"}`,
    );
  }

  // A colour painted onto a CANVAS never appears in a computed style, so
  // the scan above cannot see the vault graph at all — and the vault graph
  // was drawing its first vault in hue 18, the old brand, from a literal.
  // This reads the source instead: no hand-written hue may sit in the
  // band, in either syntax.
  {
    const { readdirSync, statSync, readFileSync } = require("fs");
    const roots = ["src/renderer", "src/main", "src/shared"];
    const skip = /node_modules|vendor[\\/]leaked|code-theme|Terminal\.tsx|ansi\.ts/;
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (skip.test(p)) continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|css)$/.test(p)) files.push(p);
      }
    };
    for (const r of roots) walk(join(__dirname, "..", r));

    const literals = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      const name = file.split(/[\\/]/).pop();
      for (const m of text.matchAll(/hsl\(\s*(\d{1,3})[\s,]/g)) {
        const h = Number(m[1]);
        if (h >= 8 && h <= 28) literals.push(`${name}: hsl(${h}…)`);
      }
      // …and a hue written as a bare number, which is how the vault graph
      // held on to the old brand: a table of hues with 18 at the front,
      // drawn onto a canvas where no computed style can see it. A bare 18
      // is far too common to grep for, so the rule is: a list of three or
      // more numbers that could all be hues, with the word "hue" nearby.
      // Whether it is written `const HUES = [...]` or `return [...]` does
      // not matter, which is the point — the first version of this check
      // only knew the first spelling and missed the bug it was written for.
      for (const m of text.matchAll(/\[([\d\s,]+)\]/g)) {
        const nums = m[1]
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n));
        if (nums.length < 3 || nums.some((n) => n < 0 || n > 360)) continue;
        const around = text
          .slice(Math.max(0, m.index - 200), m.index + 40)
          .toLowerCase();
        if (!around.includes("hue")) continue;
        for (const h of nums)
          if (h >= 8 && h <= 28)
            literals.push(`${name}: hue ${h} in a hue table`);
      }
    }
    check(
      "no source file hardcodes a hue in the old brand band",
      literals.length === 0,
      literals.length ? literals.join(", ") : undefined,
    );
  }

  clearTimeout(watchdog);
  console.log(failures ? `\n${failures} FAILED` : "\nNO OLD BRAND COLOUR LEFT");
  app.exit(failures ? 1 : 0);
});
