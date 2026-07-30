/**
 * claudemarketplaces.com — local search over a cached snapshot.
 *
 * Their API returns the WHOLE list on every request: 23 472 rows, 12.7 MB, and
 * every paging parameter ignored. Measured against the live endpoint, not
 * inferred: limit, q, search, page and offset each came back with the same
 * 12.7 MB and the same 23 472 rows. So searching and paging happen here, which
 * is the opposite of skillsdirectory (96 920 rows, server-side).
 *
 * The payoff is that their rows carry `path` — where in the repo the skill
 * lives. skillsdirectory does not, which is why installing from THAT one has to
 * resolve a display name against a repo's tree and refuse when several folders
 * match. Nothing to guess here, so the checks below are about not losing that
 * property: a row without a repo or a path is unusable and must be dropped
 * rather than turned into a card that fails on click.
 */

import {
  matchMarketplace,
  sortMarketplace,
  type MarketplaceSkill,
} from "../src/main/skills-marketplace";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const s = (
  name: string,
  description: string,
  repo: string,
  path: string,
  installs?: number,
): MarketplaceSkill => ({ id: `${repo}/${path}`, name, description, repo, path, installs });

const SAMPLE: MarketplaceSkill[] = [
  s("find-skills", "Discover and install specialized agent skills", "vercel-labs/skills", "find-skills", 2_500_000),
  s("git-commit", "Write better git commit messages", "someone/tools", "git/commit", 40),
  s("docx", "Create and edit Word documents", "anthropics/skills", "docx", 900),
  s("pdf-filler", "Fill in PDF forms", "other/pack", "pdf-filler", 12),
];

// ── 1. Search is word-wise, over name and description ─────────────────
{
  check("a name term matches", matchMarketplace(SAMPLE, "docx").length === 1);
  check(
    "a description term matches too",
    matchMarketplace(SAMPLE, "word documents").some((x) => x.name === "docx"),
  );
  check("the repo is searchable", matchMarketplace(SAMPLE, "vercel-labs").length === 1);
  check("case is ignored", matchMarketplace(SAMPLE, "DOCX").length === 1);
  // Every term must appear, or a two-word query returns everything about the
  // first word — which is what makes a local search feel broken.
  check(
    "all terms must match, not just one",
    matchMarketplace(SAMPLE, "git nonexistent").length === 0,
    JSON.stringify(matchMarketplace(SAMPLE, "git nonexistent").map((x) => x.name)),
  );
  check("an empty query returns everything", matchMarketplace(SAMPLE, "").length === SAMPLE.length);
  check("whitespace is not a query", matchMarketplace(SAMPLE, "   ").length === SAMPLE.length);
  check("no match is an empty list, not everything", matchMarketplace(SAMPLE, "zzzz").length === 0);
}

// ── 2. Browsing order ─────────────────────────────────────────────────
{
  const sorted = sortMarketplace(SAMPLE);
  check("most-installed first", sorted[0]?.name === "find-skills", sorted[0]?.name);
  check("least last", sorted[sorted.length - 1]?.name === "pdf-filler");
  // `installs` is per skill here. skillsdirectory's `stars` is the REPO's,
  // repeated on every skill in it, which is why sorting by it clumped.
  check(
    "the order is by installs, not by repo",
    sorted.map((x) => x.installs ?? 0).every((v, i, a) => i === 0 || a[i - 1]! >= v),
    JSON.stringify(sorted.map((x) => [x.name, x.installs])),
  );
  check("sorting does not mutate the input", SAMPLE[0]?.name === "find-skills");
  check("a missing installs count sorts last, not first", sortMarketplace([
    s("no-count", "", "a/b", "no-count"),
    s("counted", "", "c/d", "counted", 5),
  ])[0]?.name === "counted");
}

// ── 3. Nested paths survive ───────────────────────────────────────────
{
  // 389 of their 23 472 rows have a nested path. Flattening one to its last
  // segment would download the wrong folder — or nothing.
  const hit = matchMarketplace(SAMPLE, "git-commit")[0];
  check("a nested path is kept whole", hit?.path === "git/commit", hit?.path);
  check("and the repo is separate from it", hit?.repo === "someone/tools");
}

console.log(failures ? `\n${failures} FAILED` : "\nALL MARKETPLACE CHECKS PASSED");
process.exit(failures ? 1 : 0);
