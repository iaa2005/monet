/**
 * Suggest hugeicons names for the lucide names the app uses.
 *
 * Not a mapping — a shortlist. The two sets are named by different people
 * (lucide says `Trash2`, hugeicons says `delete-02`), so the choice is a human
 * one; this only puts the plausible ones in front of it.
 *
 *   node scripts/hugeicons-candidates.mjs [Name ...]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const collection = require("@iconify-json/hugeicons/icons.json");
const names = Object.keys(collection.icons);

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory()
      ? walk(p)
      : /\.tsx?$/.test(e)
        ? [p]
        : [];
  });
}

function usedIcons() {
  const set = new Set();
  for (const file of walk(join("src", "renderer"))) {
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(
      /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g,
    ))
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, "").trim();
        if (name && /^[A-Z]/.test(name)) set.add(name);
      }
  }
  return [...set].sort();
}

const tokens = (n) =>
  n
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

function candidates(lucide) {
  const t = tokens(lucide);
  const scored = names.map((n) => {
    const parts = n.split("-");
    let score = 0;
    for (const tok of t) {
      if (parts.includes(tok)) score += 10;
      else if (n.includes(tok)) score += 4;
    }
    if (n.startsWith(t[0])) score += 3;
    if (n === t.join("-")) score += 20;
    score -= n.length * 0.05;
    return { n, score };
  });
  return scored
    .filter((s) => s.score > 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((s) => s.n);
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : usedIcons();
for (const name of wanted) {
  const c = candidates(name);
  console.log(`${name}\t${c.join(" ") || "—"}`);
}
