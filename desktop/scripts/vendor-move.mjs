/**
 * Move files out of src/vendor/leaked and fix every specifier that pointed at
 * them — the mechanical half of absorbing the tree.
 *
 * Rewriting imports by regex is how the wrong file gets repointed: the leak
 * writes `./foo.js` for `foo.ts`, `src/utils/x.js` for a root-relative
 * sibling, and `@vendor/...` from our side, all naming the same module. So
 * this resolves every specifier to a REAL FILE under the old layout first,
 * looks up where that file lands under the new one, and only then writes a
 * specifier. A specifier whose resolution did not change is left byte-for-byte
 * alone, which keeps the diff to what actually moved.
 *
 * Destination rules come from a plan file (see vendor-plan.mjs): a list of
 * [prefix, destination] pairs, longest prefix wins. Files under a moved
 * subtree keep their shape, so relative imports between them survive
 * untouched.
 *
 *   node scripts/vendor-move.mjs --plan <file>          # report only
 *   node scripts/vendor-move.mjs --plan <file> --apply  # git mv + rewrite
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from "fs";
import { join, dirname, resolve, relative, posix } from "path";
import { execFileSync } from "child_process";

const ROOT = resolve(process.cwd());
const VENDOR = join(ROOT, "src/vendor/leaked");

// Roots that own an alias. Longest match wins, so src/vendor/leaked beats src.
const ROOTS = [
  ["@vendor", join(ROOT, "src/vendor/leaked")],
  ["@anthropic", join(ROOT, "src/anthropic")],
  ["@shared", join(ROOT, "src/shared")],
  ["@main", join(ROOT, "src/main")],
  ["@", join(ROOT, "src/renderer")],
];
// The leak's own root-relative form: `src/utils/x.js` means vendor's utils/x.
const LEGACY_SRC = join(ROOT, "src/vendor/leaked");

const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];

function resolveSpec(spec, fromFile) {
  let base = null;
  if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else {
    for (const [alias, target] of ROOTS)
      if (spec === alias || spec.startsWith(alias + "/")) {
        base = join(target, spec.slice(alias.length));
        break;
      }
    if (!base && (spec === "src" || spec.startsWith("src/")))
      base = join(LEGACY_SRC, spec.slice(3));
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

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|mts|cts)$/.test(e)) acc.push(p);
  }
  return acc;
}

const planPath = process.argv[process.argv.indexOf("--plan") + 1];
if (!planPath || planPath.startsWith("--")) {
  console.error("usage: vendor-move.mjs --plan <file.mjs> [--apply]");
  process.exit(2);
}
const { PLAN } = await import("file://" + resolve(planPath));
const APPLY = process.argv.includes("--apply");

// Longest prefix wins, so "utils/permissions" can land elsewhere than "utils".
const rules = [...PLAN].sort((a, b) => b[0].length - a[0].length);
const vendorFiles = walk(VENDOR);
const rel = (f) => relative(VENDOR, f).replace(/\\/g, "/");

/** Where a vendor file lands, or null if it stays. */
const destination = new Map();
for (const f of vendorFiles) {
  const r = rel(f);
  const hit = rules.find(([prefix]) => r === prefix || r.startsWith(prefix + "/"));
  if (!hit) continue;
  const [prefix, dest] = hit;
  const tail = r === prefix ? posix.basename(r) : r.slice(prefix.length + 1);
  destination.set(f, join(ROOT, "src", dest, tail));
}
if (destination.size === 0) {
  console.log("plan moves nothing");
  process.exit(0);
}

// Two sources landing on one path is silent data loss: the second write wins
// and the first file is simply gone. It happened on the first run — oauth/
// types.ts and policyLimits/types.ts both flattened into account/types.ts —
// and nothing failed to say so. Checked before anything moves.
{
  const seen = new Map();
  const clashes = [];
  for (const [from, to] of destination) {
    const key = to.toLowerCase(); // Windows paths are case-insensitive
    if (seen.has(key)) clashes.push([seen.get(key), from, to]);
    else seen.set(key, from);
  }
  if (clashes.length) {
    console.error(`plan has ${clashes.length} colliding destination(s):`);
    for (const [a, b, to] of clashes)
      console.error(
        `  ${rel(a)}\n  ${rel(b)}\n    both -> src/${relative(join(ROOT, "src"), to).replace(/\\/g, "/")}`,
      );
    process.exit(1);
  }
}

const moved = (f) => destination.get(f) ?? f;

/** The specifier that reaches `target` from `fromNew`, under the NEW layout. */
function specFor(target, fromNew) {
  const t = moved(target);
  // Same top-level root as the importer? Keep it relative, like the code
  // around it. Crossing roots gets an alias — a ../../../.. chain between
  // src/main and src/anthropic is unreadable and breaks on the next move.
  const rootOf = (p) => {
    for (const [alias, dir] of ROOTS)
      if (p === dir || p.startsWith(dir + "\\") || p.startsWith(dir + "/"))
        return [alias, dir];
    return null;
  };
  const a = rootOf(t);
  const b = rootOf(fromNew);
  let spec;
  if (a && b && a[1] === b[1]) {
    spec = relative(dirname(fromNew), t).replace(/\\/g, "/");
    if (!spec.startsWith(".")) spec = "./" + spec;
  } else if (a) {
    spec = a[0] + "/" + relative(a[1], t).replace(/\\/g, "/");
  } else {
    spec = relative(dirname(fromNew), t).replace(/\\/g, "/");
    if (!spec.startsWith(".")) spec = "./" + spec;
  }
  // TypeScript sources are imported with the .js/.jsx extension here.
  return spec.replace(/\.tsx$/, ".jsx").replace(/\.ts$/, ".js");
}

// Every specifier occurrence, whatever the syntax.
const SPEC_RE =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;

const sourceFiles = [
  ...walk(join(ROOT, "src")),
  ...walk(join(ROOT, "scripts")),
];

let rewritten = 0;
let touchedFiles = 0;
const edits = [];
for (const file of sourceFiles) {
  const src = readFileSync(file, "utf8");
  const fromNew = moved(file);
  let changed = 0;
  const out = src.replace(SPEC_RE, (whole, head, q, spec) => {
    const target = resolveSpec(spec, file);
    if (!target) return whole;
    // Nothing to do unless the target moved, or we did (relative specifiers
    // and same-root ones are computed from the importer's new home).
    if (!destination.has(target) && fromNew === file) return whole;
    const next = specFor(target, fromNew);
    if (next === spec) return whole;
    changed++;
    return head + q + next + q;
  });
  if (changed) {
    edits.push([file, fromNew, out]);
    rewritten += changed;
    touchedFiles++;
  } else if (fromNew !== file) {
    edits.push([file, fromNew, null]);
  }
}

console.log(`moving:    ${destination.size} files`);
console.log(`rewriting: ${rewritten} specifiers in ${touchedFiles} files`);
const byDest = new Map();
for (const [, d] of destination) {
  const k = relative(join(ROOT, "src"), dirname(d)).replace(/\\/g, "/");
  byDest.set(k, (byDest.get(k) ?? 0) + 1);
}
for (const [k, n] of [...byDest].sort((a, b) => b[1] - a[1]).slice(0, 25))
  console.log(`  ${String(n).padStart(4)}  src/${k}`);
if (byDest.size > 25) console.log(`  … ${byDest.size - 25} more directories`);

if (!APPLY) {
  console.log("\n(dry run — pass --apply to move)");
  process.exit(0);
}

// git mv first so history follows, then write the rewritten contents to the
// NEW paths. Doing it the other way round loses the rename detection.
for (const [from, to] of destination) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    execFileSync("git", ["mv", "-f", relative(ROOT, from), relative(ROOT, to)], {
      cwd: ROOT,
      stdio: "pipe",
    });
  } catch {
    // Untracked or already staged elsewhere — fall back to a plain move.
    writeFileSync(to, readFileSync(from));
    execFileSync("git", ["rm", "-f", "--quiet", relative(ROOT, from)], {
      cwd: ROOT,
      stdio: "pipe",
    }).toString?.();
  }
}
for (const [from, to, content] of edits)
  if (content !== null) writeFileSync(to, content);

// The typecheck debt is keyed by path, so a move that leaves it behind reads
// as "146 files cleaned themselves and 146 new ones broke" — the gate would
// fail on every moved file at once and the real count would be lost. Carry
// the entries across; the totals must be identical afterwards.
{
  const DEBT = join(ROOT, "scripts/typecheck-debt.json");
  if (existsSync(DEBT)) {
    const debt = JSON.parse(readFileSync(DEBT, "utf8"));
    const key = (p) => relative(ROOT, p).replace(/\\/g, "/");
    const next = {};
    let carried = 0;
    for (const [k, v] of Object.entries(debt)) {
      const abs = join(ROOT, k);
      const dest = destination.get(abs);
      if (dest) carried++;
      next[key(dest ?? abs)] = v;
    }
    const sorted = Object.fromEntries(Object.entries(next).sort());
    writeFileSync(DEBT, JSON.stringify(sorted, null, 2) + "\n");
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    console.log(
      `debt: ${carried} of ${Object.keys(debt).length} entries repathed, ` +
        `total ${sum(debt)} -> ${sum(sorted)}`,
    );
  }
}

console.log(`\nmoved ${destination.size} files, rewrote ${rewritten} specifiers`);
