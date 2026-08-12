/**
 * Why is this vendor file in the bundle?
 *
 * Reachability alone says "yes it is"; it never says through whom. This walks
 * the same graph the build resolves, VALUE imports only, and prints the
 * shortest chain from an entry point to the file you name — which is the only
 * thing you can actually cut.
 *
 *   node scripts/vendor-why.mjs commands.ts
 *   node scripts/vendor-why.mjs utils/messages.ts
 */
import { readFileSync, existsSync, statSync } from "fs";
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

// Value imports only: `import type` and `export type` never enter the bundle.
const VALUE =
  /(?:^|[\s;}])import\s+(?!type\s)([^'"();]*?)\s*from\s*["']([^"']+)["']|(?:^|[\s;}])import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[\s;}])export\s+(?!type\s)(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function valueImports(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  for (const m of src.matchAll(VALUE)) {
    // `import { type A, type B } from` is still type-only in effect.
    if (m[1] !== undefined && m[1].trim().startsWith("{")) {
      const names = m[1].trim().slice(1, -1).split(",").map((s) => s.trim());
      if (names.length && names.every((n) => !n || n.startsWith("type "))) continue;
    }
    const spec = m[2] || m[3] || m[4] || m[5] || m[6];
    const r = resolveSpec(spec, file);
    if (r) out.push(r);
  }
  return out;
}

const target = join(VENDOR, process.argv[2] || "commands.ts");
const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");

// BFS from the entries, remembering who first reached each file.
const parent = new Map();
const queue = [...ENTRIES];
for (const e of ENTRIES) parent.set(e, null);
while (queue.length) {
  const f = queue.shift();
  let deps;
  try {
    deps = valueImports(f);
  } catch {
    continue;
  }
  for (const d of deps)
    if (!parent.has(d)) {
      parent.set(d, f);
      queue.push(d);
    }
}

if (!parent.has(target)) {
  console.log(`${rel(target)}: NOT value-reachable from any entry point.`);
  process.exit(0);
}
const chain = [];
for (let f = target; f; f = parent.get(f)) chain.push(f);
chain.reverse();
console.log(chain.map((f, i) => `${"  ".repeat(i)}${rel(f)}`).join("\n"));
