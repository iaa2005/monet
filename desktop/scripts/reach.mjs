/**
 * What the build can reach, and through whom.
 *
 * Two questions come up constantly while cutting a subsystem loose, and
 * grep answers neither. "Is this file still in the bundle?" — grep finds
 * references, not reachability, and a file every live module only `import
 * type`s is referenced but absent. "Why is it in the bundle?" — grep finds
 * one importer, not the chain from an entry point, which is the only thing
 * you can actually cut.
 *
 * Replaces dead-vendor.mjs and vendor-why.mjs, which were hardwired to the
 * folder that no longer exists.
 *
 *   node scripts/reach.mjs --why src/anthropic/api/claude.ts
 *   node scripts/reach.mjs --dead src/anthropic
 *   node scripts/reach.mjs --edges src/anthropic
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, dirname, resolve, relative } from "path";

const ROOT = resolve(process.cwd());
const ALIASES = [
  ["@shared", join(ROOT, "src/shared")],
  ["@main", join(ROOT, "src/main")],
  ["@", join(ROOT, "src/renderer")],
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

function resolveSpec(spec, from) {
  let base = null;
  if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else
    for (const [a, t] of ALIASES)
      if (spec === a || spec.startsWith(a + "/")) {
        base = join(t, spec.slice(a.length));
        break;
      }
  if (!base) return null; // a real package
  const cands = base.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base]
    : base.endsWith(".jsx")
      ? [base.slice(0, -4) + ".tsx", base.slice(0, -4) + ".ts", base]
      : [];
  for (const c of [...cands, ...EXTS.map((e) => base + e)])
    if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** [specifier, typeOnly] for every import/require in a file. */
function importsOf(src) {
  const out = [];
  const push = (spec, typeOnly) => spec && out.push([spec, typeOnly]);
  const re =
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;'"]*?)from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    // `import { type A, type B } from` is type-only in effect too.
    const named = (m[2] || "").trim();
    const allType =
      !!m[1] ||
      (named.startsWith("{") &&
        named
          .slice(1, named.lastIndexOf("}"))
          .split(",")
          .filter((s) => s.trim())
          .every((n) => n.trim().startsWith("type ")));
    push(m[3], allType);
  }
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = bare.exec(src))) push(m[1], false);
  const dyn = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(src))) push(m[1], false);
  return out;
}

const parent = new Map(); // value-reachability, remembering who got there first
const typeRefd = new Set();
{
  const queue = [...ENTRIES.filter((e) => existsSync(e))];
  for (const e of queue) parent.set(e, null);
  while (queue.length) {
    const f = queue.shift();
    let src;
    try {
      src = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const [spec, typeOnly] of importsOf(src)) {
      const t = resolveSpec(spec, f);
      if (!t) continue;
      if (typeOnly) {
        typeRefd.add(t);
        continue;
      }
      if (!parent.has(t)) {
        parent.set(t, f);
        queue.push(t);
      }
    }
  }
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e)) acc.push(p);
  }
  return acc;
}

const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");
const mode = process.argv[2];
const arg = process.argv[3];

if (mode === "--why") {
  const target = resolve(ROOT, arg);
  if (!parent.has(target)) {
    console.log(
      `${rel(target)}: NOT value-reachable` +
        (typeRefd.has(target) ? " (type-referenced only — tsc needs it, the bundle does not)" : ""),
    );
    process.exit(0);
  }
  const chain = [];
  for (let f = target; f; f = parent.get(f)) chain.push(f);
  console.log(chain.reverse().map((f, i) => `${"  ".repeat(i)}${rel(f)}`).join("\n"));
} else if (mode === "--dead") {
  const dir = resolve(ROOT, arg);
  const files = walk(dir);
  const live = files.filter((f) => parent.has(f));
  const typed = files.filter((f) => !parent.has(f) && typeRefd.has(f));
  const dead = files.filter((f) => !parent.has(f) && !typeRefd.has(f));
  const bytes = (fs) => fs.reduce((n, f) => n + statSync(f).size, 0);
  console.log(`${rel(dir)}: ${files.length} files`);
  console.log(`  in the bundle:   ${live.length}`);
  console.log(`  type-only:       ${typed.length}`);
  console.log(`  unreachable:     ${dead.length}  (${(bytes(dead) / 1048576).toFixed(2)} MiB)`);
  if (process.argv.includes("--list")) for (const f of dead) console.log("    " + rel(f));
} else if (mode === "--edges") {
  // Every value import that crosses INTO dir from outside it, grouped by the
  // module being imported — the list of things to own or drop.
  const dir = resolve(ROOT, arg);
  const inside = (f) => f.startsWith(dir + "\\") || f.startsWith(dir + "/");
  const byTarget = new Map();
  for (const f of parent.keys()) {
    if (inside(f)) continue;
    let src;
    try {
      src = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const [spec, typeOnly] of importsOf(src)) {
      if (typeOnly) continue;
      const t = resolveSpec(spec, f);
      if (!t || !inside(t)) continue;
      if (!byTarget.has(t)) byTarget.set(t, new Set());
      byTarget.get(t).add(f);
    }
  }
  const rows = [...byTarget].sort((a, b) => b[1].size - a[1].size);
  const total = rows.reduce((n, [, s]) => n + s.size, 0);
  console.log(`${rows.length} modules under ${rel(dir)} are imported from outside it, by ${total} importers:`);
  for (const [t, importers] of rows)
    console.log(`  ${String(importers.size).padStart(4)}  ${rel(t)}`);
} else {
  console.error("usage: reach.mjs --why <file> | --dead <dir> [--list] | --edges <dir>");
  process.exit(2);
}
