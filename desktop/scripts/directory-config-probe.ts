/**
 * Merging the catalog repo's tuning over the built-in defaults.
 *
 * The rule is "anything that can change without a code change lives in the
 * repo", which puts a hand-edited network-fetched file in charge of the
 * Directory's page size, its per-repo cap and its category list. That is fine
 * as long as a bad edit cannot break the app, and these checks are about
 * exactly that:
 *
 *   - a partial config must not blank the fields it omits. Setting only
 *     skillCategories and losing the page size would leave the Directory
 *     requesting zero rows.
 *   - every number is bounded. A 0 is an empty Directory; a 100000 is a
 *     download nobody asked for; skillsdirectory clamps at 100 anyway.
 *   - an empty category list must not silently remove the filter.
 */

import {
  DEFAULT_CONFIG,
  mergeConfig,
} from "../src/main/directory-config";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── 1. The file as published ──────────────────────────────────────────
{
  const c = mergeConfig({
    skillCategories: ["development", "research"],
    registryPageSize: 50,
    maxPerRepo: 5,
  });
  check("categories are taken", c.skillCategories.length === 2, JSON.stringify(c.skillCategories));
  check("page size is taken", c.registryPageSize === 50);
  check("the per-repo cap is taken", c.maxPerRepo === 5);
}

// ── 2. A partial config keeps the rest ────────────────────────────────
{
  const c = mergeConfig({ skillCategories: ["tools"] });
  check("an omitted page size falls back", c.registryPageSize === DEFAULT_CONFIG.registryPageSize, c.registryPageSize);
  check("an omitted cap falls back", c.maxPerRepo === DEFAULT_CONFIG.maxPerRepo);
  check("while the given field is applied", c.skillCategories.join() === "tools");
}

// ── 3. Numbers are bounded ────────────────────────────────────────────
{
  // 0 rows is an empty Directory that looks like a network failure.
  check("zero page size is clamped up", mergeConfig({ registryPageSize: 0 }).registryPageSize >= 1);
  check("a negative one too", mergeConfig({ registryPageSize: -5 }).registryPageSize >= 1);
  // skillsdirectory clamps at 100 regardless; asking for more just misleads.
  check("an absurd page size is clamped down", mergeConfig({ registryPageSize: 100000 }).registryPageSize === 100);
  check("a fractional value is truncated", Number.isInteger(mergeConfig({ registryPageSize: 42.7 }).registryPageSize));
  check("zero cap is clamped up", mergeConfig({ maxPerRepo: 0 }).maxPerRepo >= 1);
  check("an absurd cap is clamped down", mergeConfig({ maxPerRepo: 9999 }).maxPerRepo <= 50);
  check("a string where a number belongs is ignored", mergeConfig({ registryPageSize: "50" }).registryPageSize === DEFAULT_CONFIG.registryPageSize);
}

// ── 4. Categories ─────────────────────────────────────────────────────
{
  // An empty array would remove the filter without saying so.
  check(
    "an empty category list falls back to the defaults",
    mergeConfig({ skillCategories: [] }).skillCategories.length === DEFAULT_CONFIG.skillCategories.length,
  );
  const c = mergeConfig({ skillCategories: ["  Development ", "TOOLS", "development", "bad slug!", 7] });
  check("slugs are normalised", c.skillCategories.includes("development") && c.skillCategories.includes("tools"), JSON.stringify(c.skillCategories));
  check("duplicates collapse", c.skillCategories.filter((x) => x === "development").length === 1);
  check("junk is dropped", !c.skillCategories.some((x) => x.includes(" ") || x.includes("!")), JSON.stringify(c.skillCategories));
  check("and the result is sorted", [...c.skillCategories].sort().join() === c.skillCategories.join());
}

// ── 5. A broken file is a normal state ────────────────────────────────
{
  for (const [label, raw] of [
    ["null", null],
    ["a string", "nope"],
    ["an array", [1, 2]],
    ["a number", 42],
    ["an empty object", {}],
  ] as [string, unknown][]) {
    const c = mergeConfig(raw);
    check(
      `${label} yields the defaults untouched`,
      c.registryPageSize === DEFAULT_CONFIG.registryPageSize &&
        c.maxPerRepo === DEFAULT_CONFIG.maxPerRepo &&
        c.skillCategories.length === DEFAULT_CONFIG.skillCategories.length,
      JSON.stringify(c.registryPageSize),
    );
  }
  // Unknown fields are ignored rather than fatal — the app may be older than
  // the file.
  const c = mergeConfig({ registryPageSize: 20, somethingNew: true });
  check("an unknown field does not discard the known ones", c.registryPageSize === 20);
}

// ── 6. The defaults are themselves sane ───────────────────────────────
{
  check("the built-in page size is within its own bounds", DEFAULT_CONFIG.registryPageSize >= 1 && DEFAULT_CONFIG.registryPageSize <= 100);
  check("so is the cap", DEFAULT_CONFIG.maxPerRepo >= 1 && DEFAULT_CONFIG.maxPerRepo <= 50);
  check("and the category seed is not empty", DEFAULT_CONFIG.skillCategories.length > 0);
  check(
    "the defaults survive their own merge unchanged",
    JSON.stringify(mergeConfig(DEFAULT_CONFIG)) === JSON.stringify({
      ...DEFAULT_CONFIG,
      skillCategories: [...DEFAULT_CONFIG.skillCategories].sort(),
    }),
  );
}

console.log(failures ? `\n${failures} FAILED` : "\nALL DIRECTORY-CONFIG CHECKS PASSED");
process.exit(failures ? 1 : 0);
