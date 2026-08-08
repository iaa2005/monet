/**
 * Settings → Voice, as the shipped app draws it.
 *
 * The data behind this screen is pinned elsewhere (smoke:tts for the
 * catalogue and imports, smoke:voicelang for the languages and the art). What
 * no unit probe can answer is whether the SCREEN is right: the voices used to
 * be a two-column grid of "Female 1"…"Male 5", and two columns is exactly the
 * layout that was reported as crooked once already, on the Advanced tab. So
 * the geometry is measured here, in the real renderer, at the real width.
 *
 * The data folder is a temp one: the model files are created at their exact
 * catalogue sizes and filled with zeros, which is all "installed" means (the
 * check is names and sizes). Nothing here can speak — and nothing here
 * touches the user's own folder.
 *
 *   npm run smoke:voicesettings          (build first — it drives out/)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
const electron = require("electron");
const PORT = 9401;

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The six model files, at the sizes src/main/tts/catalog.ts publishes. If
 * those ever change, this probe fails loudly (no cards at all) rather than
 * quietly testing the wrong screen. */
const MODEL_FILES = [
  ["duration_predictor.onnx", 3_700_147],
  ["text_encoder.onnx", 36_416_150],
  ["vector_estimator.onnx", 256_534_781],
  ["vocoder.onnx", 101_424_195],
  ["tts.json", 8_253],
  ["unicode_indexer.json", 277_676],
  ["F3.json", 290_794],
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "voice-settings-"));
  writeFileSync(
    join(dir, "ui-prefs.json"),
    JSON.stringify({ onboarded: true, composerHeight: null }),
  );
  writeFileSync(
    join(dir, "stt.json"),
    JSON.stringify({ engine: "ondevice", ttsVoice: "F3", ttsLang: "ru" }),
  );
  const model = join(dir, "tts-models", "supertonic-3");
  mkdirSync(model, { recursive: true });
  // Sparse: the size is what counts, and 400 MB of real zeros is 400 MB.
  for (const [name, bytes] of MODEL_FILES) {
    const fd = require("node:fs").openSync(join(model, name), "w");
    require("node:fs").ftruncateSync(fd, bytes);
    require("node:fs").closeSync(fd);
  }
  const custom = join(dir, "tts-models", "custom");
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(custom, "F-марина.json"), "{}");
  writeFileSync(join(custom, "M-гоша.json"), "{}");
  writeFileSync(
    join(custom, "voices.json"),
    JSON.stringify({ "F-марина": { name: "Марина" }, "M-гоша": { name: "Гоша" } }),
  );
  return dir;
}

async function attach() {
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find(
        (t) =>
          t.type === "page" &&
          !/devtools/.test(t.url) &&
          !/rasterise|popout/.test(t.url) &&
          /index\.html/.test(t.url),
      );
      if (page?.webSocketDebuggerUrl) {
        const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
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
          send,
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

const dataDir = fixture();
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
  // The window exists before React has run: wait for the app, not the paint.
  const t0 = Date.now();
  while (Date.now() - t0 < 40_000) {
    if (await cdp.eval(`!!document.querySelector('textarea, [contenteditable]')`)) break;
    await sleep(400);
  }

  // Ctrl+, — the app's own shortcut, dispatched as real input rather than a
  // synthetic event, so nothing here depends on how the handler is bound.
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      modifiers: 2,
      key: ",",
      code: "Comma",
      windowsVirtualKeyCode: 188,
      text: type === "keyDown" ? "," : undefined,
    });
  }
  await sleep(800);
  const opened = await cdp.eval(`/Providers|General/.test(document.body.textContent||'')`);
  check("Ctrl+, opens Settings", !!opened);

  const clicked = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent || '').trim() === 'Voice',
    );
    if (!el) return false;
    el.click();
    return true;
  })()`);
  check("the Voice section is one click away", !!clicked);
  await sleep(1200);

  const seen = await cdp.eval(`JSON.stringify((() => {
    const cards = [...document.querySelectorAll('div.rounded-xl')].filter(
      (d) => d.querySelector('svg[viewBox="0 0 12 12"]'),
    );
    const rect = (e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    };
    const rows = cards.map((c) => ({
      text: (c.textContent || '').trim().replace(/\\s+/g, ' '),
      ...rect(c),
      ink: c.querySelectorAll('svg[viewBox="0 0 12 12"] rect').length,
      clipped: c.scrollWidth > c.clientWidth + 1,
    }));
    const trigger = document.querySelector('[aria-label="Speech language"]');
    return {
      rows,
      lang: trigger ? (trigger.textContent || '').trim() : null,
      builder: /voice builder/i.test(document.body.textContent || ''),
      closing: /31 August 2026/.test(document.body.textContent || ''),
      paid: /\\$49/.test(document.body.textContent || '') &&
        /Purchases Unavailable/.test(document.body.textContent || ''),
      importer: document.querySelectorAll('input[placeholder="Name it"]').length,
      cloner: /Clone your voice/.test(document.body.textContent || '') &&
        [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Record'),
      clonerHonest: /gradients through the model/.test(document.body.textContent || ''),
      // The whole tab used to be capped at max-w-md — half the panel, with the
      // other half empty. Measured against the section it lives in.
      sectionWidth: (() => {
        const h = [...document.querySelectorAll('h3')].find(
          (x) => (x.textContent || '').trim() === 'Voice',
        );
        return h?.parentElement ? Math.round(h.parentElement.getBoundingClientRect().width) : 0;
      })(),
      bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })())`);
  const ui = JSON.parse(seen ?? "{}");
  const rows = ui.rows ?? [];

  const NAMES = ["Sarah", "Lily", "Jessica", "Olivia", "Emily", "Alex", "James", "Robert", "Sam", "Daniel"];
  check(
    "all ten presets are on screen, BY NAME",
    NAMES.every((n) => rows.some((r) => r.text.startsWith(n))),
    rows.map((r) => r.text.slice(0, 12)),
  );
  check(
    "each carries a line about how it sounds",
    NAMES.every((n) => (rows.find((r) => r.text.startsWith(n))?.text.length ?? 0) > n.length + 20),
  );
  check(
    "and a picture of its own — computed, not shipped",
    rows.every((r) => r.ink > 8),
    rows.map((r) => r.ink),
  );
  check(
    "the two imported voices are there, marked as yours",
    rows.filter((r) => /yours/.test(r.text)).length === 2,
    rows.filter((r) => /yours/.test(r.text)).map((r) => r.text),
  );
  check(
    "ONE COLUMN: same left edge, same width, each on its own line",
    rows.length >= 12 &&
      new Set(rows.map((r) => r.x)).size === 1 &&
      new Set(rows.map((r) => r.w)).size === 1 &&
      new Set(rows.map((r) => r.y)).size === rows.length,
    { x: [...new Set(rows.map((r) => r.x))], w: [...new Set(rows.map((r) => r.w))], n: rows.length },
  );
  check("nothing is clipped inside a card", rows.every((r) => !r.clipped));
  check(
    "AND THE CARDS FILL THE PANEL — no max-w-md leaving half of it empty",
    rows.length > 0 && rows[0].w >= (ui.sectionWidth ?? 0) - 4,
    { card: rows[0]?.w, section: ui.sectionWidth },
  );
  check("and the page itself does not scroll sideways", (ui.bodyOverflow ?? 0) <= 0, ui.bodyOverflow);
  check("the saved language shows as a language, with its flag", /Russian/.test(ui.lang ?? ""), ui.lang);
  check("importing a file is offered, with two name boxes (cloner + import)", ui.importer === 2, ui.importer);
  check("CLONING FROM A RECORDING IS OFFERED, with a Record button", !!ui.cloner);
  check("…and it says why it is a separate program", !!ui.clonerHonest);
  check("the official builder is linked", !!ui.builder);
  check(
    "and what it costs is not hidden — $49, currently selling none",
    !!ui.paid && !!ui.closing,
    { paid: ui.paid, closing: ui.closing },
  );

  // ── Every settings title, in the shipped app ─────────────────────────
  //
  // There were three spellings across 27 headings, in Inter while the rest of
  // the app's headings are Bounded. "The same" is a claim about computed
  // style, so it is read from the DOM rather than from the source.
  const titles = [];
  for (const tab of ["General", "Editor", "Voice", "Memory", "Advanced", "Automation", "Skills"]) {
    const clicked = await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('button')].find(
        (b) => (b.textContent || '').trim() === ${JSON.stringify(tab)},
      );
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clicked) continue;
    await sleep(600);
    const seenHere = await cdp.eval(`JSON.stringify(
      [...document.querySelectorAll('h3')].map((h) => {
        const s = getComputedStyle(h);
        return {
          text: (h.textContent || '').trim().slice(0, 24),
          family: s.fontFamily.split(',')[0].replace(/['"]/g, ''),
          size: s.fontSize,
          weight: s.fontWeight,
        };
      }),
    )`);
    for (const t of JSON.parse(seenHere ?? "[]")) titles.push({ tab, ...t });
  }
  check("settings titles were found across the tabs", titles.length >= 10, titles.length);
  const shapes = [...new Set(titles.map((t) => `${t.family}/${t.size}/${t.weight}`))];
  check(
    "EVERY MAIN TITLE IS THE SAME FACE, SIZE AND WEIGHT",
    shapes.length === 1,
    { shapes, examples: titles.slice(0, 3) },
  );
  check(
    "…and that face is Bounded, not the UI font",
    shapes[0]?.startsWith("Bounded"),
    shapes[0],
  );

  // Automation lost its card-in-card wrappers and its coloured icons; its
  // sections are separated by lines now, so it gets a picture of its own.
  await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent || '').trim() === 'Automation',
    );
    el?.click();
    return true;
  })()`);
  await sleep(900);
  {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const data = shot?.result?.data;
    if (data) {
      const out = resolve(process.env.VOICE_SHOT ?? join(tmpdir(), "voice-settings.png")).replace(
        /\.png$/,
        "-automation.png",
      );
      writeFileSync(out, Buffer.from(data, "base64"));
      console.log(`      screenshot: ${out}`);
    }
  }

  // Back to Voice for the screenshots below.
  await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent || '').trim() === 'Voice',
    );
    el?.click();
    return true;
  })()`);
  await sleep(800);

  // Both halves are below the fold on this window, and a screenshot of the
  // part that did not change proves nothing. Two shots, two scroll positions.
  const base = resolve(process.env.VOICE_SHOT ?? join(tmpdir(), "voice-settings.png"));
  for (const [suffix, selector] of [
    ["dictation", `h3`],
    ["cards", `svg[viewBox="0 0 12 12"]`],
    ["own", `input[placeholder="Name it"]`],
  ]) {
    await cdp.eval(
      `(document.querySelector('${selector}')?.closest('div.rounded-xl'))?.scrollIntoView({ block: 'center' }), true`,
    );
    await sleep(600);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const data = shot?.result?.data;
    if (!data) continue;
    const out = base.replace(/\.png$/, `-${suffix}.png`);
    writeFileSync(out, Buffer.from(data, "base64"));
    console.log(`      screenshot: ${out}`);
  }
} catch (err) {
  check(`the probe ran (${err.message})`, false, log.slice(-600));
} finally {
  child.kill();
}

console.log(failures ? `\n${failures} FAILED` : "\nthe voices have names, and one column each");
process.exit(failures ? 1 : 0);
