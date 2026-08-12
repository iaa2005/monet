/**
 * How the vendor tree peels — layer by layer, leaves first.
 *
 * Absorbing 1200 files in one commit is not reviewable and not bisectable.
 * The tree does have an order, though: a file whose vendor dependencies have
 * all already moved can move without touching anything else. This computes
 * those layers (a Kahn peel over the vendor-internal import graph), reports
 * how big each is, and names the cycle that never peels.
 *
 *   node scripts/vendor-layers.mjs            # layer sizes + the cycle
 *   node scripts/vendor-layers.mjs --layer 1  # list layer 1
 *   node scripts/vendor-layers.mjs --cycle    # list the largest cycle
 */
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, dirname, resolve, relative } from "path";

const ROOT = resolve(process.cwd());
const VENDOR = join(ROOT, "src/vendor/leaked");

const ALIASES = [
  ["@main", join(ROOT, "src/main")],
  ["@anthropic", join(ROOT, "src/anthropic")],
  ["@vendor", VENDOR],
  ["@shared", join(ROOT, "src/shared")],
  ["@", join(ROOT, "src/renderer")],
  ["src", VENDOR],
];

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
  if (!base) return null;
  const cands = base.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base]
    : base.endsWith(".jsx")
      ? [base.slice(0, -4) + ".tsx", base.slice(0, -4) + ".ts", base]
      : [];
  for (const c of [...cands, ...EXTS.map((e) => base + e)])
    if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

const SPEC = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?[^'"();]*?from\s*["']([^"']+)["']|(?:^|[\s;}])import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file) {
  const src = readFileSync(file, "utf8");
  const out = new Set();
  for (const m of src.matchAll(SPEC)) {
    const spec = m[1] || m[2] || m[3];
    const r = resolveSpec(spec, file);
    if (r && r.startsWith(VENDOR)) out.add(r);
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|jsx)$/.test(e)) acc.push(p);
  }
  return acc;
}

const files = walk(VENDOR);
const deps = new Map(files.map((f) => [f, importsOf(f)]));
const rel = (f) => relative(VENDOR, f).replace(/\\/g, "/");

// Kahn peel: layer N is every file whose vendor deps all sit in layers < N.
const layerOf = new Map();
let remaining = new Set(files);
let layer = 0;
for (;;) {
  const ready = [...remaining].filter((f) =>
    [...deps.get(f)].every((d) => d === f || !remaining.has(d)),
  );
  if (ready.length === 0) break;
  for (const f of ready) {
    layerOf.set(f, layer);
    remaining.delete(f);
  }
  layer++;
}

// Tarjan over what is left — the cycles.
const stuck = [...remaining];
const idx = new Map(), low = new Map(), onStack = new Set();
const stack = [];
const sccs = [];
let counter = 0;
function strongconnect(v) {
  idx.set(v, counter); low.set(v, counter); counter++;
  stack.push(v); onStack.add(v);
  for (const w of deps.get(v)) {
    if (!remaining.has(w)) continue;
    if (!idx.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
  }
  if (low.get(v) === idx.get(v)) {
    const comp = [];
    for (;;) { const w = stack.pop(); onStack.delete(w); comp.push(w); if (w === v) break; }
    sccs.push(comp);
  }
}
const OLD = Error.stackTraceLimit;
for (const v of stuck) if (!idx.has(v)) strongconnect(v);
Error.stackTraceLimit = OLD;
sccs.sort((a, b) => b.length - a.length);

const arg = process.argv[2];
if (arg === "--layer") {
  const n = Number(process.argv[3]);
  for (const f of files.filter((f) => layerOf.get(f) === n).sort()) console.log(rel(f));
} else if (arg === "--cycle") {
  for (const f of sccs[0].map(rel).sort()) console.log(f);
} else if (arg === "--peelable") {
  for (const f of files.filter((f) => layerOf.has(f)).sort()) console.log(rel(f));
} else {
  console.log(`vendor files: ${files.length}`);
  const sizes = [];
  for (let i = 0; i < layer; i++)
    sizes.push(files.filter((f) => layerOf.get(f) === i).length);
  console.log(`peelable:     ${files.length - remaining.size} in ${layer} layers`);
  console.log(`  ${sizes.map((s, i) => `L${i}:${s}`).join("  ")}`);
  console.log(`cyclic:       ${remaining.size} in ${sccs.length} components`);
  for (const c of sccs.slice(0, 6))
    console.log(`  ${String(c.length).padStart(5)}  e.g. ${c.slice(0, 3).map(rel).join(", ")}`);
}
