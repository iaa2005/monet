/**
 * Import the flow icon set from its VSCode extension.
 *
 * Dry-run by default. Pass --write to actually touch anything.
 *
 * What the extension looks like, read off the installed 1.3.2 rather than
 * assumed:
 *
 *   <ext>/icons.json          the whole mapping, {files:{}, folders:{}}
 *   <ext>/dawn/*.png          dark-UI art        }  also deep/ and dim/,
 *   <ext>/dawn-light/*.png    light-UI art       }  three packs, same names
 *   <ext>/{dawn,deep,dim}.json  generated themes, not needed by us
 *
 * After a licence key is entered the extension GETs a signed URL, writes
 * <ext>/icons.gz and untars it OVER ITSELF — so the full set appears in exactly
 * these folders, under exactly these names. Nothing about this script changes
 * when the paid icons arrive; only the counts do.
 *
 * Two facts worth knowing before relying on it:
 *
 *  1. The extension ships PNG at 48×48, not SVG — share.js builds every path as
 *     `./${folder}/${key}.png`. Our set is SVG today, so importing from the
 *     extension trades vector for raster. Hence --svg, which lets a directory of
 *     real SVGs win over the PNG of the same name.
 *
 *  2. `<pack>-light` is separate ARTWORK, not a recolour — seven files compared,
 *     seven different. Our light theme is currently a mechanical palette
 *     translation of the dark one; importing gives us the author's own.
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  statSync,
} from "fs";
import { join, basename } from "path";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const WRITE = args.includes("--write");
const FROM = flag(
  "from",
  "C:/Users/alexivanov/.vscode/extensions/thang-nm.flow-icons-1.3.2",
);
const PACK = flag("pack", "dawn");
/** A directory of SVGs that outrank the extension's PNG of the same name. */
const SVG = flag("svg", "D:/alexivanov/Desktop/flow-icons-svgs/dawn");
const ICONS = "D:/Projects/claude-code/desktop/src/renderer/public/icons";
const GENERATED =
  "D:/Projects/claude-code/desktop/src/renderer/components/flow-map.generated.ts";

/** Our folder names are historical: `light/` holds the art the DARK ui shows. */
const DEST = { dark: join(ICONS, "light"), light: join(ICONS, "base") };
const SRC = { dark: join(FROM, PACK), light: join(FROM, `${PACK}-light`) };

const die = (msg) => {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
};

if (!existsSync(FROM)) die(`No extension at ${FROM}`);
const mapPath = join(FROM, "icons.json");
if (!existsSync(mapPath)) die(`No icons.json in ${FROM}`);
for (const [k, d] of Object.entries(SRC))
  if (!existsSync(d)) die(`No ${k}-theme art at ${d}`);

// ── 1. the mapping ────────────────────────────────────────────────────
/** flow's own: {files: {icon: {l?: langIds, n?: fileNames, e?: extensions}},
 *               folders: {icon: {n: folderNames}}} */
const flowMap = JSON.parse(readFileSync(mapPath, "utf-8"));
const fileIcons = Object.entries(flowMap.files ?? {});
const folderIcons = Object.entries(flowMap.folders ?? {});

/** Extensions, whole filenames and folder names, each pointing at one icon.
 * Later keys do not overwrite earlier ones — flow lists them in priority order
 * and a silent overwrite would pick the wrong icon without saying so. */
const ext = new Map();
const names = new Map();
const folders = new Map();
const clashes = [];
const put = (m, key, icon) => {
  const k = key.toLowerCase();
  if (m.has(k) && m.get(k) !== icon) clashes.push(`${k}: ${m.get(k)} vs ${icon}`);
  else m.set(k, icon);
};

for (const [icon, rule] of fileIcons) {
  for (const e of rule.e ?? []) put(ext, e, icon);
  for (const n of rule.n ?? []) put(names, n, icon);
}
// Stored with the prefix the art uses, so the resolver can build a filename
// from the map without knowing this convention.
for (const [icon, rule] of folderIcons)
  for (const n of rule.n ?? []) put(folders, n, `folder_${icon}`);

// ── 2. the art ────────────────────────────────────────────────────────
/** `._name` entries are AppleDouble resource forks: the paid set arrives as a
 * tar built on macOS, and 1342 of them sit beside the 2686 real icons. Copying
 * them would double the folder for nothing and put unreadable files where the
 * resolver expects art. */
const listing = (dir, suffix = null) =>
  new Map(
    readdirSync(dir)
      .filter(
        (f) =>
          !f.startsWith("._") &&
          (suffix ? f.toLowerCase().endsWith(suffix) : /[.](svg|png)$/i.test(f)),
      )
      .map((f) => [basename(f, f.slice(f.lastIndexOf("."))).toLowerCase(), join(dir, f)]),
  );

// 2.0.9 ships SVG; 1.3.2 shipped PNG. Take whatever is there rather than
// insisting on one — the format changed under us once already.
const art = { dark: listing(SRC.dark), light: listing(SRC.light) };
const suffixOf = (p) => p.slice(p.lastIndexOf(".")).toLowerCase();
/** An external SVG stash still outranks the pack, for the case where the pack
 * is the raster one. With 2.0.9 it is redundant and harmless. */
const stash = SVG && existsSync(SVG) ? listing(SVG, ".svg") : new Map();

/** Every icon name the extension knows about, art or not. */
const wanted = new Set([
  ...art.dark.keys(),
  ...fileIcons.map(([n]) => n.toLowerCase()),
  // A folder rule is keyed by the bare word — `admin` — while its art is
  // `folder_admin.svg` and `folder_admin_open.svg`. Taking the key at face
  // value reported 498 icons as missing art that were sitting right there.
  ...folderIcons.flatMap(([n]) => [
    `folder_${n.toLowerCase()}`,
    `folder_${n.toLowerCase()}_open`,
  ]),
]);

const have = {
  base: new Set(
    readdirSync(DEST.light).map((f) => basename(f, ".svg").toLowerCase()),
  ),
};

const plan = { svg: [], png: [], missing: [] };
for (const name of [...wanted].sort()) {
  const inPack = art.dark.has(name) && art.light.has(name);
  if (!inPack && !stash.has(name)) plan.missing.push(name);
  else if (inPack ? suffixOf(art.dark.get(name)) === ".svg" : true) plan.svg.push(name);
  else plan.png.push(name);
}

const newNames = [...wanted].filter((n) => !have.base.has(n));
const oursKept = [...have.base].filter((n) => !wanted.has(n));

// ── 3. report ─────────────────────────────────────────────────────────
const n = (x) => String(x).padStart(5);
console.log(`\nSOURCE  ${FROM}`);
console.log(`PACK    ${PACK}   (dark: ${SRC.dark}, light: ${SRC.light})`);
console.log(`STASH   ${stash.size ? `${SVG} — ${stash.size} files` : "(none)"}`);
console.log(`MODE    ${WRITE ? "WRITE" : "dry run — nothing will be touched"}`);

console.log(`\nMAPPING (flow's own icons.json)`);
console.log(`${n(fileIcons.length)}  file icons`);
console.log(`${n(folderIcons.length)}  folder icons`);
console.log(`${n(ext.size)}  extensions`);
console.log(`${n(names.size)}  whole filenames`);
console.log(`${n(folders.size)}  folder names`);
if (clashes.length)
  console.log(`${n(clashes.length)}  clashes, first: ${clashes.slice(0, 3).join("; ")}`);

console.log(`\nART`);
console.log(`${n(plan.svg.length)}  from SVG   (vector, preferred)`);
console.log(`${n(plan.png.length)}  from PNG   48x48 raster`);
console.log(`${n(plan.missing.length)}  named but no art in either place`);

console.log(`\nAGAINST OUR SET (${have.base.size} names today)`);
console.log(`${n(newNames.length)}  names flow adds that we do not have`);
console.log(`${n(wanted.size - newNames.length)}  names that would be replaced`);
console.log(`${n(oursKept.length)}  of ours flow does not cover — kept as they are`);
if (oursKept.length)
  console.log(
    args.includes("--all")
      ? oursKept.map((x) => `        ${x}`).join("\n")
      : `        ${oursKept.slice(0, 14).join(" ")}${oursKept.length > 14 ? " …  (--all for the rest)" : ""}`,
  );

if (!WRITE) {
  console.log(`\nNothing written. Re-run with --write to apply.\n`);
  process.exit(0);
}

// ── 4. apply ──────────────────────────────────────────────────────────
for (const d of Object.values(DEST)) mkdirSync(d, { recursive: true });

let copied = 0;
for (const name of [...plan.svg, ...plan.png]) {
  // The pack's own light art wins over anything derived. The stash is consulted
  // only when the pack has no art for that name at all.
  const dark = art.dark.get(name) ?? stash.get(name);
  const light = art.light.get(name) ?? stash.get(name);
  copyFileSync(dark, join(DEST.dark, name + suffixOf(dark)));
  copyFileSync(light, join(DEST.light, name + suffixOf(light)));
  copied++;
}

/** Names whose art is a PNG rather than an SVG. The resolver builds a URL from
 * a name, so with a mixed set it has to be told which is which — there is no
 * asking the filesystem from the renderer. */
const pngNames = new Set(plan.png);

const asRecord = (m) =>
  `{\n${[...m.entries()]
    .sort()
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join("\n")}\n}`;

writeFileSync(
  GENERATED,
  `/**
 * Generated by scripts/import-flow.mjs from the flow extension's icons.json.
 * Do not edit — re-run the importer instead.
 *
 * Source: ${basename(FROM)}, pack ${PACK}
 * ${fileIcons.length} file icons, ${folderIcons.length} folder icons
 */

/** File extension (no dot) to icon name. */
export const FLOW_EXT: Record<string, string> = ${asRecord(ext)};

/** Whole filename to icon name. */
export const FLOW_NAMES: Record<string, string> = ${asRecord(names)};

/** Folder name to icon name; the open variant is that name plus "_open". */
export const FLOW_FOLDERS: Record<string, string> = ${asRecord(folders)};

/** Icons whose file is .png. Everything else is .svg. */
export const PNG_ICONS: ReadonlySet<string> = new Set(${JSON.stringify([...pngNames].sort())});
`,
);

console.log(`\nwrote ${copied} icons and ${basename(GENERATED)}\n`);
