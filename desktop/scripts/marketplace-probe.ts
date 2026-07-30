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

import { pickSkillDir, usefulDescription } from "../src/main/skills-registry";
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

// ── 2. Browsing order, by the chosen key ──────────────────────────────
{
  // Sorting happens over the WHOLE snapshot before paging, not over the hundred
  // rows on screen: "the most-installed of an arbitrary hundred" is a different
  // question, and the gap is 23 472 against 100.
  const byInstalls = sortMarketplace(SAMPLE, "installs");
  check("installs: most first", byInstalls[0]?.name === "find-skills", byInstalls[0]?.name);
  check("installs: least last", byInstalls[byInstalls.length - 1]?.name === "pdf-filler");
  check(
    "installs: monotonic",
    byInstalls.map((x) => x.installs ?? 0).every((v, i, a) => i === 0 || a[i - 1]! >= v),
    JSON.stringify(byInstalls.map((x) => [x.name, x.installs])),
  );

  const starred: MarketplaceSkill[] = [
    { ...s("low-stars", "", "a/b", "low-stars", 9_000), stars: 10 },
    { ...s("high-stars", "", "c/d", "high-stars", 5), stars: 90_000 },
  ];
  const byStars = sortMarketplace(starred, "stars");
  check("stars: most first", byStars[0]?.name === "high-stars", byStars[0]?.name);
  // The two keys must genuinely differ, or one of them is decoration: stars
  // belong to the REPOSITORY and installs to the skill, so the popular skill in
  // an obscure repo and the obscure skill in a famous repo swap places.
  check(
    "stars and installs disagree, as they should",
    sortMarketplace(starred, "installs")[0]?.name === "low-stars",
    sortMarketplace(starred, "installs")[0]?.name,
  );

  const byName = sortMarketplace(SAMPLE, "name");
  check("name: alphabetical", byName[0]?.name === "docx", byName[0]?.name);

  check("the default is installs", JSON.stringify(sortMarketplace(SAMPLE)) === JSON.stringify(byInstalls));
  check("sorting does not mutate the input", SAMPLE[0]?.name === "find-skills");
  // A missing figure must not float to the top as if it were the best.
  check(
    "a missing count sorts last, not first",
    sortMarketplace([s("no-count", "", "a/b", "no-count"), s("counted", "", "c/d", "counted", 5)])[0]?.name === "counted",
  );
  check(
    "and ties break by name, so the order is stable",
    JSON.stringify(sortMarketplace([s("b", "", "x/y", "b", 5), s("a", "", "x/z", "a", 5)]).map((x) => x.name)) ===
      JSON.stringify(["a", "b"]),
  );
}

// ── 3. Nested paths survive ───────────────────────────────────────────
{
  // 389 of their 23 472 rows have a nested path. Flattening one to its last
  // segment would download the wrong folder — or nothing.
  const hit = matchMarketplace(SAMPLE, "git-commit")[0];
  check("a nested path is kept whole", hit?.path === "git/commit", hit?.path);
  check("and the repo is separate from it", hit?.repo === "someone/tools");
}

// -- 4. Their `path` is a leaf name, not a repo-relative path ---------
{
  // I claimed installs from this source were exact because it publishes a path.
  // Measured against the repos: of 8 sampled entries only ONE matched from the
  // repo root. `find-skills` lives at `skills/find-skills`; others sat under
  // plugins/, frameworks/, frontend/. So the path is a folder BASENAME, which
  // is what pickSkillDir matches on — a far better clue than skillsdirectory's
  // display name, but still resolved, and still refused when ambiguous.
  //
  // Trees below are the real ones, fetched while writing this.
  const check1 = pickSkillDir(["skills/find-skills"], "find-skills");
  check("a stripped prefix resolves", check1.ok && check1.dir === "skills/find-skills", check1.ok ? check1.dir : check1.error);

  const nested = pickSkillDir(
    ["plugins/dotnet-advanced/skills/dotnet-pinvoke", "plugins/other/skills/thing"],
    "dotnet-pinvoke",
  );
  check("a deeply nested one resolves", nested.ok && nested.dir === "plugins/dotnet-advanced/skills/dotnet-pinvoke", nested.ok ? nested.dir : nested.error);

  const notUnderSkills = pickSkillDir(["frontend/framer-motion-animator", "backend/api"], "framer-motion-animator");
  check("one outside a skills/ folder resolves", notUnderSkills.ok && notUnderSkills.dir === "frontend/framer-motion-animator");

  // langchain-ai/deepagents really does ship two folders of this name.
  const ambiguous = pickSkillDir(
    ["libs/code/examples/skills/langgraph-docs", "libs/cli/examples/skills/langgraph-docs"],
    "langgraph-docs",
  );
  check("two folders of the same name are refused, not guessed", !ambiguous.ok);
  check("with both named", !ambiguous.ok && ambiguous.candidates?.length === 2, !ambiguous.ok ? JSON.stringify(ambiguous.candidates) : undefined);

  // Using the path AS a repo-relative path is what would have failed: nothing
  // lives at `find-skills`, so the download would have found no files.
  check(
    "the raw path would NOT have been a valid folder",
    !["skills/find-skills"].includes("find-skills"),
    "installing it verbatim downloads nothing",
  );
}

// -- 5. A description that only repeats the name is not a description --
{
  // Measured over the whole snapshot: 20 617 of 23 472 rows — 88% — set
  // `description` to the skill's own name. Nineteen entries are called `docx`
  // and fourteen of them describe themselves as "docx". A card reading `/docx`
  // above the word `docx` spends the useful line saying nothing, so the line is
  // dropped and the meta row (repository, installs, stars) carries the weight.
  // Their site shows a real summary; there is no API for it — every
  // /api/skills/<id> shape returns 404.
  check("a name repeated as description is dropped", usefulDescription("docx", "docx") === "");
  check("case and punctuation do not save it", usefulDescription("Docx.", "docx") === "");
  check("nor does spacing", usefulDescription("find skills", "find-skills") === "");
  check(
    "a real description survives",
    usefulDescription("Create, read and edit Word documents.", "docx") ===
      "Create, read and edit Word documents.",
  );
  check("a description that merely contains the name survives", usefulDescription("docx tools for reports", "docx").length > 0);
  check("an empty description stays empty", usefulDescription("", "docx") === "");
}

console.log(failures ? `\n${failures} FAILED` : "\nALL MARKETPLACE CHECKS PASSED");
process.exit(failures ? 1 : 0);
