/**
 * Resolving a skillsdirectory.com entry to a folder in its repo.
 *
 * The registry indexes GitHub rather than hosting anything: every entry names
 * a `repository`, and the files live there. What no endpoint returns — not the
 * list, not the detail — is WHERE inside that repo the skill sits, and a repo
 * routinely holds twenty of them. So the folder is inferred, and this is the
 * inference.
 *
 * Getting it wrong is not cosmetic: installing the wrong folder puts
 * instructions the user never asked for in front of the model. So the rule is
 * to report ambiguity rather than pick a plausible-looking winner.
 *
 * Case 1 is real data — the registry entry "Competitor Analysis" against the
 * twenty skill folders of aaron-he-zhu/seo-geo-claude-skills, both fetched
 * live while writing this.
 */

import {
  normalizeName,
  pickSkillDir,
} from "../src/main/skills-registry";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** The real tree of aaron-he-zhu/seo-geo-claude-skills. */
const SEO_REPO = [
  "build/geo-content-optimizer",
  "build/meta-tags-optimizer",
  "build/schema-markup-generator",
  "build/seo-content-writer",
  "cross-cutting/content-quality-auditor",
  "cross-cutting/domain-authority-auditor",
  "cross-cutting/entity-optimizer",
  "cross-cutting/memory-management",
  "monitor/alert-manager",
  "monitor/backlink-analyzer",
  "monitor/performance-reporter",
  "monitor/rank-tracker",
  "optimize/content-refresher",
  "optimize/internal-linking-optimizer",
  "optimize/on-page-seo-auditor",
  "optimize/technical-seo-checker",
  "research/competitor-analysis",
  "research/content-gap-analysis",
  "research/keyword-research",
  "research/serp-analysis",
];

// ── 1. The real case ──────────────────────────────────────────────────
{
  const r = pickSkillDir(SEO_REPO, "Competitor Analysis");
  check(
    "a display name resolves to its folder",
    r.ok && r.dir === "research/competitor-analysis",
    r.ok ? r.dir : r.error,
  );
  const r2 = pickSkillDir(SEO_REPO, "Rank Tracker");
  check("and so does one nested elsewhere", r2.ok && r2.dir === "monitor/rank-tracker");
}

// ── 2. Name shapes that must all compare equal ────────────────────────
{
  check("case is ignored", normalizeName("Competitor Analysis") === normalizeName("competitor-analysis"));
  check("underscores too", normalizeName("rank_tracker") === normalizeName("rank-tracker"));
  check("and stray punctuation", normalizeName("SERP  Analysis!") === normalizeName("serp-analysis"));
  check("but different words stay different", normalizeName("rank-tracker") !== normalizeName("rank-trackers"));
}

// ── 3. A single-skill repo needs no match at all ──────────────────────
{
  // Common shape: the folder is named after the project, the registry entry
  // after the skill. With one candidate there is nothing to be wrong about.
  const r = pickSkillDir(["skills/thing"], "Something Else Entirely");
  check("one skill in the repo is taken as-is", r.ok && r.dir === "skills/thing", r.ok ? r.dir : r.error);
}

// ── 4. Ambiguity is reported, never guessed ───────────────────────────
{
  const dirs = ["a/analysis", "b/analysis"];
  const r = pickSkillDir(dirs, "Analysis");
  check("two folders with the same name refuse to resolve", !r.ok);
  check(
    "and the candidates are named so the user can choose",
    !r.ok && r.candidates?.length === 2,
    !r.ok ? JSON.stringify(r.candidates) : undefined,
  );
  // Picking the first would install one of two different skills at random.
  check("no silent winner is chosen", !r.ok);
}
{
  const r = pickSkillDir(SEO_REPO, "Totally Unrelated Skill");
  check("an unmatched name in a busy repo fails", !r.ok);
  check(
    "with a message naming the scale of the problem",
    !r.ok && r.error.includes("20"),
    !r.ok ? r.error : undefined,
  );
  check("and a capped list of candidates", !r.ok && (r.candidates?.length ?? 0) <= 20);
}

// ── 5. Entries named after a nested path ──────────────────────────────
{
  const r = pickSkillDir(SEO_REPO, "build/meta-tags-optimizer");
  check(
    "a full path is accepted too",
    r.ok && r.dir === "build/meta-tags-optimizer",
    r.ok ? r.dir : r.error,
  );
}

// ── 6. A repo with no skills at all ───────────────────────────────────
{
  const r = pickSkillDir([], "Anything");
  check("an empty repo fails clearly", !r.ok);
  check(
    "saying no SKILL.md was found rather than blaming the name",
    !r.ok && /no SKILL\.md/i.test(r.error),
    !r.ok ? r.error : undefined,
  );
}

// ── 7. The basename wins over a coincidental parent ───────────────────
{
  // "memory-management" as a folder, and another skill sitting UNDER a
  // directory of that name. Matching whole paths first would pick the wrong one.
  const dirs = ["cross-cutting/memory-management", "memory-management/other-thing"];
  const r = pickSkillDir(dirs, "Memory Management");
  check(
    "the folder itself is chosen, not something inside a like-named parent",
    r.ok && r.dir === "cross-cutting/memory-management",
    r.ok ? r.dir : r.error,
  );
}

console.log(failures ? `\n${failures} FAILED` : "\nALL SKILLS-REGISTRY CHECKS PASSED");
process.exit(failures ? 1 : 0);
