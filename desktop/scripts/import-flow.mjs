/**
 * Import the flow icon set from its VSCode extension.
 *
 * Dry-run by default. Pass --write to actually touch anything.
 *
 *   <ext>/icons.json          the whole mapping, {files:{}, folders:{}}
 *   <ext>/dawn/*.svg          dark-UI art     }  also deep/, dim/, you/ —
 *   <ext>/dawn-light/*.svg    light-UI art    }  four packs, same names
 *
 * After a licence key is entered the extension fetches a signed URL, writes
 * <ext>/icons.gz — brotli despite the name — and untars it OVER ITSELF, so the
 * full set appears in these folders under these names.
 *
 * Two things this had to learn the hard way:
 *
 *  1. A folder rule is keyed by the bare word — `admin` — while its art is
 *     `folder_admin.svg` and `folder_admin_open.svg`. Taking the key at face
 *     value reported 498 icons as having no art while they sat in the folder.
 *
 *  2. `opentofu` lists an empty string among its filenames, and an empty key is
 *     what a file with no extension looks up. Left in, every extensionless file
 *     in the tree resolves to opentofu.
 *
 * 1.3.2 shipped 48x48 PNG; 2.0.9 ships SVG. If a future pack goes back to
 * raster this refuses to run rather than quietly filling the set with names the
 * resolver will ask for as .svg.
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
  "C:/Users/alexivanov/.vscode/extensions/thang-nm.flow-icons-2.0.9",
);
const PACK = flag("pack", "dawn");
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
const blanks = [];
const put = (m, key, icon) => {
  const k = String(key ?? "").trim().toLowerCase();
  // flow's own icons.json carries a blank filename in opentofu's list. Left in,
  // it becomes the answer for every extensionless file in the tree, because a
  // file with no extension looks up the empty string.
  if (!k) {
    blanks.push(icon);
    return;
  }
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

const art = { dark: listing(SRC.dark, ".svg"), light: listing(SRC.light, ".svg") };
if (art.dark.size === 0)
  die(
    `No SVG in ${SRC.dark}. 1.3.2 shipped PNG; if this pack has gone back to ` +
      `raster, the resolver's .svg URLs need addressing before importing.`,
  );

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

const plan = { present: [], missing: [] };
for (const name of [...wanted].sort())
  (art.dark.has(name) && art.light.has(name) ? plan.present : plan.missing).push(name);

const newNames = [...wanted].filter((n) => !have.base.has(n));
const oursKept = [...have.base].filter((n) => !wanted.has(n));

// ── 3. report ─────────────────────────────────────────────────────────
const n = (x) => String(x).padStart(5);
console.log(`\nSOURCE  ${FROM}`);
console.log(`PACK    ${PACK}   (dark: ${SRC.dark}, light: ${SRC.light})`);
console.log(`MODE    ${WRITE ? "WRITE" : "dry run — nothing will be touched"}`);

console.log(`\nMAPPING (flow's own icons.json)`);
console.log(`${n(fileIcons.length)}  file icons`);
console.log(`${n(folderIcons.length)}  folder icons`);
console.log(`${n(ext.size)}  extensions`);
console.log(`${n(names.size)}  whole filenames`);
console.log(`${n(folders.size)}  folder names`);
if (clashes.length)
  console.log(`${n(clashes.length)}  clashes, first: ${clashes.slice(0, 3).join("; ")}`);
if (blanks.length)
  console.log(`${n(blanks.length)}  blank keys dropped (${[...new Set(blanks)].join(", ")})`);

console.log(`\nART`);
console.log(`${n(plan.present.length)}  icons with art in both themes`);
console.log(`${n(plan.missing.length)}  named but no art`);

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
for (const name of plan.present) {
  copyFileSync(art.dark.get(name), join(DEST.dark, `${name}.svg`));
  copyFileSync(art.light.get(name), join(DEST.light, `${name}.svg`));
  copied++;
}

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

`,
);

console.log(`\nwrote ${copied} icons and ${basename(GENERATED)}\n`);
