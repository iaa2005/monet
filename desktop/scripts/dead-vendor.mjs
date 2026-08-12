/**
 * Which files under src/vendor/leaked no build entry point can reach.
 *
 * Deleting by hand from a list someone read out is how the wrong file goes:
 * this recomputes reachability from the entry points, the same way the build
 * resolves modules, and prints what is unreachable. Run it again after the
 * deletion and the answer must be "nothing" — that is the check.
 *
 * TYPE-ONLY IMPORTS ARE NOT REACHABILITY, but they are still references: a
 * file every live module only `import type`s vanishes from the bundle and is
 * still needed by tsc. Those are reported separately and kept.
 *
 *   node scripts/dead-vendor.mjs           # report
 *   node scripts/dead-vendor.mjs --delete  # report, then delete the safe set
 */
import { readFileSync, readdirSync, statSync, existsSync, rmSync } from "fs";
import { join, dirname, resolve, relative } from "path";

const ROOT = resolve(process.cwd());
const VENDOR = join(ROOT, "src/vendor/leaked");

const ALIASES = [
  ["@main", join(ROOT, "src/main")],
  ["@vendor", join(ROOT, "src/vendor/leaked")],
  ["@shared", join(ROOT, "src/shared")],
  ["@", join(ROOT, "src/renderer")],
  ["src", join(ROOT, "src/vendor/leaked")],
];

const ENTRIES = [
  "src/main/index.ts",
  "src/main/sandbox/pyodide.worker.ts",
  "src/main/stt/gigaam.child.ts",
  "src/main/tts/supertonic.child.ts",
  "src/main/ocr/ocr.child.ts",
  "src/preload/index.ts",
  "src/renderer/main.tsx",
  "src/renderer/popout.tsx",
  "src/renderer/rasterise.tsx",
].map((p) => join(ROOT, p));

const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];

function resolveSpec(spec, fromFile) {
  let base = null;
  if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else
    for (const [alias, target] of ALIASES)
      if (spec === alias || spec.startsWith(alias + "/")) {
        base = join(target, spec.slice(alias.length));
        break;
      }
  if (!base) return null; // a real package
  // The vendor writes ".js"/".jsx" for TypeScript sources. Missing the .jsx
  // case cost one file on the first run — the build caught it, which is why
  // the build is the arbiter and not this script.
  const cands = base.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base]
    : base.endsWith(".jsx")
      ? [base.slice(0, -4) + ".tsx", base.slice(0, -4) + ".ts", base]
      : [];
  for (const c of [...cands, ...EXTS.map((e) => base + e)])
    if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** [specifier, typeOnly] for every import in a file. */
function importsOf(src) {
  const out = [];
  const push = (spec, typeOnly) => spec && out.push([spec, typeOnly]);
  // import ... from "x" / export ... from "x", with the `type` marker
  const re =
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) push(m[2], !!m[1]);
  // bare side-effect import
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = bare.exec(src))) push(m[1], false);
  // require() and dynamic import() with a literal
  const dyn = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(src))) push(m[1], false);
  return out;
}

const reachable = new Set();
const typeRefd = new Set();

function walk(file) {
  if (reachable.has(file)) return;
  reachable.add(file);
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const [spec, typeOnly] of importsOf(src)) {
    const target = resolveSpec(spec, file);
    if (!target) continue;
    if (typeOnly) typeRefd.add(target);
    else walk(target);
  }
}

for (const e of ENTRIES) if (existsSync(e)) walk(e);

function allFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) allFiles(full, out);
    else out.push(full);
  }
  return out;
}

const every = allFiles(VENDOR);
const unreachable = every.filter((f) => !reachable.has(f));
// Keep anything a REACHABLE file still names in a type position — deleting it
// breaks tsc even though it never reaches the bundle.
const keep = unreachable.filter((f) => typeRefd.has(f));
const deletable = unreachable.filter((f) => !typeRefd.has(f));
const bytes = (fs) => fs.reduce((n, f) => n + statSync(f).size, 0);

console.log(`vendor files:      ${every.length}`);
console.log(`reachable:         ${reachable.size - (reachable.size - every.filter((f) => reachable.has(f)).length)}`);
console.log(`unreachable:       ${unreachable.length}  (${(bytes(unreachable) / 1048576).toFixed(2)} MiB)`);
console.log(`  kept (type-only): ${keep.length}`);
console.log(`  deletable:        ${deletable.length}  (${(bytes(deletable) / 1048576).toFixed(2)} MiB)`);

if (process.argv.includes("--list"))
  for (const f of deletable) console.log("  " + relative(ROOT, f).replace(/\\/g, "/"));

if (process.argv.includes("--delete")) {
  for (const f of deletable) rmSync(f, { force: true });
  console.log(`\ndeleted ${deletable.length} files`);
}
