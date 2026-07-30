/**
 * Group A candidates, side by side with what is installed now and with the flow
 * icon each was built from. Nothing here is installed — this is the look-first
 * step that was asked for.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const FLOW = "D:/alexivanov/Desktop/flow-icons-svgs/dawn";
const LIVE = "D:/Projects/claude-code/desktop/src/renderer/public/icons";
const NEW = "D:/Projects/claude-code/desktop/icons-review";
const OUT = "D:/Projects/claude-code/desktop/icons-review.html";

const ROWS = [
  ["astro-config", "astro.config", "astro", "flow's astro + flow's gear (from vue_config), cut in"],
  ["c-header", ".h", "c", "flow's hexagon, a thick round H, blue pushed to indigo"],
  ["cpp-header", ".hpp", "cpp", "same, keeping flow's ++"],
  ["fortran-fixed", ".f77", "fortran", "flow's icon, unchanged"],
  ["go-mod", "go.mod", "go", "module as a puzzle piece, per your screenshot"],
  ["go-sum", "go.sum", "go", "the same, locked — flow's padlock from cargo_lock"],
  ["lua-config", ".luarc.json", "lua", "flow's lua + gear, cut in"],
  ["luau-config", ".luaurc", "luau", "flow's luau + gear, cut in"],
  ["luau-def", ".d.luau", "luau", "flow's luau + flow's tag (from typescript_def), cut in"],
];

let seq = 0;
const iso = (svg) => {
  const t = `n${seq++}`;
  return svg
    .replace(/id="([^"]+)"/g, (_, i) => `id="${t}-${i}"`)
    .replace(/(xlink:href|href)="#([^"]+)"/g, (_, a, i) => `${a}="#${t}-${i}"`)
    .replace(/url\(#([^)]+)\)/g, (_, i) => `url(#${t}-${i})`);
};

const art = (p) => (existsSync(p) ? iso(readFileSync(p, "utf-8")) : '<div class=none>—</div>');

const row = (theme, [name, trig, flowName, note]) => `
<tr>
  <td class=name><b>${name}</b><br><em>${trig}</em></td>
  <td><div class=ico>${art(join(LIVE, theme, `${name}.svg`))}</div><span>now</span></td>
  <td class=arrow>→</td>
  <td><div class=ico>${art(join(NEW, theme, `${name}.svg`))}</div><span class=new>proposed</span></td>
  <td><div class=ico>${art(join(LIVE, theme, `${flowName}.svg`))}</div><span>flow ${flowName}</span></td>
  <td class=note>${note}</td>
</tr>`;

/**
 * The one genuinely open choice: how blue is "bluer".
 *
 * flow's c is blue-300, a light colour, so at 40% it stays vivid. Every indigo
 * that reads clearly BLUER than the purple we have now is darker than that, and
 * loses some of its hue at the same opacity. Worth seeing side by side rather
 * than argued about.
 */
const SHADES = [
  ["#818cf8", "indigo-400", "chosen — clearly bluer than today's purple"],
  ["#a5b4fc", "indigo-300", "flow's own lightness, but the hue goes grey"],
  ["#93c5fd", "blue-300", "identical to flow's c — only the letter tells them apart"],
  ["#60a5fa", "blue-400", "flow's hue, one step deeper"],
];

const shadeCell = (theme, hex, label, note) => {
  const src = readFileSync(join(NEW, theme, "c-header.svg"), "utf-8");
  const light = { "#818cf8": "#4f46e5", "#a5b4fc": "#6366f1", "#93c5fd": "#3b82f6", "#60a5fa": "#2563eb" };
  const painted = theme === "light"
    ? src.replaceAll("#818cf8", hex)
    : src.replaceAll("#4f46e5", light[hex]);
  return `<figure><div class=ico>${iso(painted)}</div><figcaption><b>${label}</b><br><em>${note}</em></figcaption></figure>`;
};

const shades = (theme) => `
<h3>.h / .hpp — which blue?</h3>
<div class=shades>${SHADES.map(([h, l, n]) => shadeCell(theme, h, l, n)).join("")}</div>`;

const board = (theme, label, bg, fg) => `
<h2>${label}</h2>
<div class=board style="background:${bg};color:${fg}">
<table>${ROWS.map((r) => row(theme, r)).join("")}</table>${shades(theme)}
</div>`;

writeFileSync(
  OUT,
  `<!doctype html><meta charset=utf-8><title>Group A — for review</title>
<style>
 body{font:13px/1.45 system-ui,sans-serif;margin:0;padding:22px;background:#0b0d11;color:#e5e7eb}
 h1{font-size:18px;margin:0 0 4px}
 p.lead{margin:0 0 6px;opacity:.72;max-width:78ch}
 p.warn{margin:0 0 16px;font-size:12px;color:#fca5a5}
 h2{font-size:12px;letter-spacing:.05em;text-transform:uppercase;opacity:.5;margin:24px 0 8px}
 .board{padding:6px 14px 14px;border-radius:14px}
 table{border-collapse:collapse;width:100%}
 td{padding:10px 8px;border-bottom:1px solid rgba(128,128,128,.18);vertical-align:middle;text-align:center}
 tr:last-child td{border-bottom:none}
 td.name{text-align:left;width:150px;font-size:12px}
 td.name em{opacity:.6;font-style:normal;font-family:ui-monospace,monospace;font-size:11px}
 td.note{text-align:left;font-size:11px;opacity:.62;line-height:1.4}
 td.arrow{width:20px;opacity:.35}
 .ico{display:flex;justify-content:center}
 .ico svg{width:40px;height:40px}
 td span{display:block;font-size:9px;opacity:.45;margin-top:3px}
 td span.new{opacity:.85;color:#86efac}
 .none{width:40px;height:40px;display:grid;place-items:center;opacity:.3}
 h3{font-size:12px;font-weight:600;margin:16px 0 8px;opacity:.8}
 .shades{display:flex;gap:18px;flex-wrap:wrap;padding-bottom:6px}
 .shades figure{margin:0;text-align:center;max-width:150px}
 .shades figcaption{font-size:10px;margin-top:6px;line-height:1.35}
 .shades em{opacity:.55;font-style:normal}
</style>
<h1>Group A — proposed, not installed</h1>
<p class=lead>Badges are flow's own parts: the gear comes out of its <code>vue_config</code>, the padlock out of its <code>cargo_lock</code>, the tag out of its <code>typescript_def</code>. The gap around each one is cut by the badge's own outline, not by a shape drawn to approximate it.</p>
<p class=warn>go-sum does not exist yet as a name — go.mod and go.sum both resolve to go-mod today. Installing it needs a one-line mapping change as well as the file.</p>
${board("light", "Dark UI", "#0f1115", "#e5e7eb")}
${board("base", "Light UI", "#f8fafc", "#0f172a")}
`,
);
console.log("wrote", OUT);
