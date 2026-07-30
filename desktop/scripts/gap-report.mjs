/**
 * The gap, as a page you can look at.
 *
 * Group A gets both icons side by side — ours and flow's near-namesake — because
 * the question there is whether flow's word means the same thing, and for eight
 * of them it does not: giving `.h` flow's `c` merges two types into one picture.
 * That is a judgement about pictures, so it needs the pictures.
 *
 * Group B gets ours alone, since flow has nothing to put beside it.
 *
 * Every SVG is inlined, so ids must be namespaced: flow declares its glyph as
 * <defs id="a"> and calls it with <use href="#a">, and 100 of those in one
 * document all resolve to the first one — which is how an earlier version of
 * this page showed a wall of identical icons that were fine on disk.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const FLOW = "D:/alexivanov/Desktop/flow-icons-svgs/dawn";
const OURS = "D:/Projects/claude-code/desktop/src/renderer/public/icons";
const OUT = "D:/Projects/claude-code/desktop/icons-gap.html";

/**
 * Still open. The fourteen that were plain renames have been adopted — the live
 * set now carries flow's drawing for them, so they are no longer a gap.
 *
 * What is left is the awkward half: flow's word is NARROWER than ours. Taking
 * it would not restyle an icon, it would merge two types into one picture — a
 * header and a source file, a module manifest and the language it is written
 * in. That is a decision about information, not about looks, which is why these
 * were not swept along with the rest.
 */
const RENAME = [
  ["astro-config", "astro", "astro.config", false],
  ["c-header", "c", ".h", true],
  ["cpp-header", "cpp", ".hpp", true],
  ["fortran-fixed", "fortran", ".f77", true],
  ["go-mod", "go", "go.mod, go.sum", true],
  ["lua-config", "lua", ".luarc.json", true],
  ["luau-config", "luau", ".luaurc", true],
  ["luau-def", "luau", ".d.luau", true],
];

const ABSENT_FILES = [
  ["binary", ".exe .dll .so .dylib .bin"],
  ["key", ".pem .crt .cer .pub"],
  ["lock", ".lock"],
  ["assembly", ".asm .s"],
  ["hcl", ".hcl"],
  ["odin", ".odin"],
  ["just", "justfile"],
  ["todo", ".todo"],
  ["security", "SECURITY.md"],
  ["code-of-conduct", "CODE_OF_CONDUCT.md"],
  ["visual-studio", ".sln"],
  ["vite", "vite.config"],
  ["next", "next.config"],
  ["nuxt", "nuxt.config"],
  ["drizzle-orm", "drizzle.config"],
  ["wally", "wally.toml"],
  ["wally-lock", "wally.lock"],
  ["roblox", ".rbxl .rbxlx"],
  ["roblox-model", ".rbxm .rbxmx"],
  ["roblox-config", "default.project.json"],
  ["_file", "anything unmapped (now: flow document)"],
];

const ABSENT_FOLDERS = [
  ["folder_assets", "assets"],
  ["folder_auth", "auth"],
  ["folder_bin", "bin"],
  ["folder_builder", "builder"],
  ["folder_camera", "camera"],
  ["folder_effects", "effects, effect"],
  ["folder_lune", "lune"],
  ["folder_marketing", "marketing"],
  ["folder_model", "models, model"],
  ["folder_module", "modules, module"],
  ["folder_page", "pages, page"],
  ["folder_provider", "providers, provider"],
  ["folder_roblox", "roblox"],
  ["folder_service", "services, service"],
  ["_folder", "any unmapped folder"],
];

let seq = 0;
const iso = (svg) => {
  const tag = `i${seq++}`;
  return svg
    .replace(/id="([^"]+)"/g, (_, id) => `id="${tag}-${id}"`)
    .replace(/(xlink:href|href)="#([^"]+)"/g, (_, a, id) => `${a}="#${tag}-${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${tag}-${id})`);
};

const art = (dir, theme, name) => {
  const p = join(dir, theme, `${name}.svg`);
  return existsSync(p) ? iso(readFileSync(p, "utf-8")) : '<div class="missing">—</div>';
};

const pairCell = (theme, [ours, theirs, trig, lossy]) => `
<figure class="${lossy ? "lossy" : ""}">
  <div class=pair>
    <div class=one><div class=ico>${art(OURS, theme, ours)}</div><span>ours</span></div>
    <div class=arrow>→</div>
    <!-- flow's side comes from OUR set, not the raw dawn folder: we already ship
         flow's art translated per theme, so this shows what it would actually
         look like in the app rather than light ink on a light board. -->
    <div class=one><div class=ico>${art(OURS, theme, theirs)}</div><span>flow</span></div>
  </div>
  <figcaption><b>${ours}</b><br>${theirs}<br><em>${trig}</em>${lossy ? "<br><mark>merges two types</mark>" : ""}</figcaption>
</figure>`;

const soloCell = (theme, [name, trig]) => `
<figure>
  <div class=ico>${art(OURS, theme, name)}</div>
  <figcaption><b>${name}</b><br><em>${trig}</em></figcaption>
</figure>`;

const themeBlock = (theme, label, bg, fg) => `
<h2>${label}</h2>
<div class=board style="background:${bg};color:${fg}">
  <h3>A · flow's word is narrower than ours — 8 <small>a swap would merge types</small></h3>
  <div class="grid wide">${RENAME.map((r) => pairCell(theme, r)).join("")}</div>
  <h3>B · flow has nothing — 20 file types <small>+ the generic <code>_file</code></small></h3>
  <div class=grid>${ABSENT_FILES.map((r) => soloCell(theme, r)).join("")}</div>
  <h3>B · flow has nothing — 14 folder types <small>each also needs an _open twin</small></h3>
  <div class=grid>${ABSENT_FOLDERS.map((r) => soloCell(theme, r)).join("")}</div>
</div>`;

writeFileSync(
  OUT,
  `<!doctype html><meta charset=utf-8><title>Icons flow does not have</title>
<style>
 body{font:13px/1.45 system-ui,sans-serif;margin:0;padding:22px;background:#0b0d11;color:#e5e7eb}
 h1{font-size:18px;margin:0 0 4px} p.lead{margin:0 0 18px;opacity:.7;max-width:70ch}
 h2{font-size:13px;letter-spacing:.04em;text-transform:uppercase;opacity:.55;margin:26px 0 8px}
 h3{font-size:13px;font-weight:600;margin:18px 0 10px;opacity:.85}
 h3 small{font-weight:400;opacity:.6;margin-left:6px}
 .board{padding:16px 18px 22px;border-radius:14px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(126px,1fr));gap:6px}
 .grid.wide{grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}
 figure{margin:0;padding:10px 6px;text-align:center;border-radius:10px}
 figure:hover{background:rgba(128,128,128,.16)}
 figure.lossy{background:rgba(239,68,68,.10);outline:1px solid rgba(239,68,68,.3)}
 .ico{display:flex;justify-content:center}
 .ico svg{width:44px;height:44px}
 .pair{display:flex;align-items:center;justify-content:center;gap:8px}
 .one span{display:block;font-size:9px;opacity:.5;margin-top:2px}
 .arrow{opacity:.4}
 figcaption{font-size:10px;margin-top:8px;word-break:break-word;line-height:1.35}
 figcaption b{font-weight:600}
 figcaption em{opacity:.6;font-style:normal}
 mark{background:rgba(239,68,68,.25);color:inherit;border-radius:3px;padding:0 3px;font-size:9px}
 .missing{width:44px;height:44px;display:grid;place-items:center;opacity:.3}
 code{font-family:ui-monospace,monospace;font-size:11px}
</style>
<h1>Icons flow does not have — what is left</h1>
<p class=lead>Ours as they look today. The fourteen plain renames have been adopted and are gone from this page. Group A is what remains of them: flow's word is narrower than ours, so a swap would merge two types into one picture — red marks where that costs real information. Group B is what would have to be drawn.</p>
${themeBlock("light", "Dark UI", "#0f1115", "#e5e7eb")}
${themeBlock("base", "Light UI", "#f8fafc", "#0f172a")}
`,
);
console.log("wrote", OUT);
