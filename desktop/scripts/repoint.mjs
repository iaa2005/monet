/**
 * Repoint every importer of one module at another, outside a given root.
 *
 * Cutting an edge into the quarantine means a hundred files stop importing
 * @anthropic/x and start importing ours. Doing that with sed writes the same
 * specifier into files at different depths, which is wrong for relative
 * paths; this computes the specifier per importer, the way vendor-move.mjs
 * does, and matches the convention around it — relative inside a root,
 * aliased across roots.
 *
 *   node scripts/repoint.mjs --from src/anthropic/analytics/index.ts \
 *                            --to   src/main/engine/analytics.ts \
 *                            --skip src/anthropic            # leave these alone
 *                            [--apply]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, dirname, resolve, relative } from "path";

const ROOT = resolve(process.cwd());
const ALIASES = [
  ["@shared", join(ROOT, "src/shared")],
  ["@anthropic", join(ROOT, "src/anthropic")],
  ["@main", join(ROOT, "src/main")],
  ["@", join(ROOT, "src/renderer")],
];
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

const argv = process.argv;
const opt = (name) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? null : argv[i + 1];
};
const FROM = resolve(ROOT, opt("from") ?? "");
const TO = resolve(ROOT, opt("to") ?? "");
const SKIP = opt("skip") ? resolve(ROOT, opt("skip")) : null;
const APPLY = argv.includes("--apply");
if (!existsSync(FROM) || !existsSync(TO)) {
  console.error("--from and --to must both exist");
  process.exit(2);
}

function specFor(target, from) {
  const rootOf = (p) => {
    for (const [alias, dir] of ALIASES)
      if (p === dir || p.startsWith(dir + "\\") || p.startsWith(dir + "/"))
        return [alias, dir];
    return null;
  };
  const a = rootOf(target);
  const b = rootOf(from);
  let spec;
  if (a && b && a[1] === b[1]) {
    spec = relative(dirname(from), target).replace(/\\/g, "/");
    if (!spec.startsWith(".")) spec = "./" + spec;
  } else if (a) {
    spec = a[0] + "/" + relative(a[1], target).replace(/\\/g, "/");
  } else {
    spec = relative(dirname(from), target).replace(/\\/g, "/");
    if (!spec.startsWith(".")) spec = "./" + spec;
  }
  return spec.replace(/\.tsx$/, ".jsx").replace(/\.ts$/, ".js");
}

const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;
const inside = (f, dir) => f === dir || f.startsWith(dir + "\\") || f.startsWith(dir + "/");

let files = 0;
let sites = 0;
for (const file of walk(join(ROOT, "src"))) {
  if (file === FROM) continue;
  if (SKIP && inside(file, SKIP)) continue;
  const src = readFileSync(file, "utf8");
  let n = 0;
  const out = src.replace(SPEC_RE, (whole, head, q, spec) => {
    if (resolveSpec(spec, file) !== FROM) return whole;
    n++;
    return head + q + specFor(TO, file) + q;
  });
  if (n) {
    files++;
    sites += n;
    if (APPLY) writeFileSync(file, out);
  }
}
console.log(
  `${sites} import site(s) in ${files} file(s): ` +
    `${relative(ROOT, FROM).replace(/\\/g, "/")} -> ${relative(ROOT, TO).replace(/\\/g, "/")}` +
    (APPLY ? "" : "   (dry run — pass --apply)"),
);
