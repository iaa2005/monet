/** A page to judge the experimental icons on. Not shipped — written to the
 * scratchpad and opened. Shows both themes, and puts a real flow icon next to
 * the drawn ones so the family resemblance can be checked rather than claimed. */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
const EXP = "D:/Projects/claude-code/desktop/icons-experimental";
const LIVE = "D:/Projects/claude-code/desktop/src/renderer/public/icons";
const out = process.argv[2] ?? join(EXP, "preview.html");

const names = readdirSync(join(EXP, "base")).filter(f => f.endsWith(".svg")).map(f => f.slice(0, -4)).sort();

// Every flow icon declares its glyph as <defs><path id="a"> and calls it with
// <use href="#a">. Inlining 87 of them into ONE document makes all those ids
// collide, so every <use> resolves to the FIRST #a on the page and the whole
// grid wears one glyph. The app never sees this — each icon is its own <img>
// document — but the preview has to namespace them or it lies about the art.
const isolate = (svg, n) => {
  const tag = n.replace(/[^a-z0-9]/gi, "");
  return svg
    .replace(/id="([^"]+)"/g, (_, id) => `id="${tag}-${id}"`)
    .replace(/(xlink:href|href)="#([^"]+)"/g, (_, a, id) => `${a}="#${tag}-${id}"`);
};

const cell = (theme, n) => {
  const p = join(EXP, theme, `${n}.svg`);
  let svg; try { svg = readFileSync(p, "utf-8"); } catch { return ""; }
  return `<figure><div class=ico>${isolate(svg, theme + n)}</div><figcaption>${n}</figcaption></figure>`;
};
const ref = (theme, n) => {
  try { return `<figure><div class=ico>${isolate(readFileSync(join(LIVE, theme, `${n}.svg`), "utf-8"), "ref" + theme + n)}</div><figcaption>${n}<br><small>flow</small></figcaption></figure>`; }
  catch { return ""; }
};

const section = (theme, label, bg, fg) => `
<h2>${label}</h2>
<div class=grid style="background:${bg};color:${fg}">
  ${["folder_src","document","typescript","folder_docs"].map(n => ref(theme, n)).join("")}
  <div class=sep></div>
  ${names.map(n => cell(theme, n)).join("")}
</div>`;

writeFileSync(out, `<!doctype html><meta charset=utf-8><title>Experimental icons</title>
<style>
 body{font:13px system-ui;margin:0;padding:24px;background:#111;color:#eee}
 h2{font-size:14px;font-weight:600;margin:28px 0 10px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:4px;padding:14px;border-radius:12px}
 figure{margin:0;text-align:center;padding:8px 2px;border-radius:8px}
 figure:hover{background:rgba(128,128,128,.18)}
 .ico{display:flex;justify-content:center}
 .ico svg{width:56px;height:56px}
 figcaption{font-size:10px;opacity:.75;margin-top:6px;word-break:break-all;line-height:1.25}
 .sep{grid-column:1/-1;height:1px;background:currentColor;opacity:.25;margin:8px 0}
 small{opacity:.6}
</style>
<p><b>${names.length} experimental icons.</b> Above the line: real flow icons, for comparison.</p>
${section("light", "Dark UI — flow's own dawn palette", "#0f1115", "#e5e7eb")}
${section("base", "Light UI — the softened palette", "#f8fafc", "#0f172a")}
`);
console.log("wrote", out, "with", names.length, "icons");
