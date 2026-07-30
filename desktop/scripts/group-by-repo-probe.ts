/**
 * Collapsing a repository's skills into one row.
 *
 * microsoft/azure-skills publishes dozens of them, and as flat cards they filled
 * the grid — every card repeating the same repository, the same 448k installs
 * and the same star count, pushing everyone else's work off the screen.
 *
 * The checks that matter are about not lying with the collapse: the order the
 * Sort by picker produced has to survive it, nothing may be dropped, and a
 * group of two is not a group.
 */

import {
  groupByRepo,
  MIN_GROUP,
  type Groupable,
} from "../src/renderer/components/directory/group-by-repo";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

let n = 0;
const card = (
  repo: string,
  name: string,
  installs?: number,
  installed = false,
): Groupable => ({
  uid: `u${++n}`,
  name,
  repository: repo,
  source: "claudemarketplaces",
  installs,
  installed,
});

const count = (rows: ReturnType<typeof groupByRepo>): number =>
  rows.reduce((t, r) => t + (r.kind === "group" ? r.group.items.length : 1), 0);

// ── 1. The reported case ──────────────────────────────────────────────
{
  const azure = [
    "azure-compliance",
    "azure-resource-lookup",
    "azure-aigateway",
    "azure-rbac",
    "entra-app-registration",
    "azure-kusto",
  ].map((s) => card("microsoft/azure-skills", s, 448_000));
  const others = [card("someone/one-skill", "solo", 100)];
  const rows = groupByRepo([...azure, ...others]);

  check("six from one repo become one row", rows.length === 2, rows.length);
  check("that row is a group", rows[0]?.kind === "group");
  check(
    "holding all six",
    rows[0]?.kind === "group" && rows[0].group.items.length === 6,
    rows[0]?.kind === "group" ? rows[0].group.items.length : undefined,
  );
  check("the lone card stays loose", rows[1]?.kind === "one");
  // A collapse that loses a card is worse than no collapse.
  check("nothing is dropped", count(rows) === 7, count(rows));
}

// ── 2. A group of two is not a group ──────────────────────────────────
{
  const rows = groupByRepo([card("a/b", "one"), card("a/b", "two")]);
  check("two from one repo stay loose", rows.every((r) => r.kind === "one"), rows.length);
  check("and both are there", count(rows) === 2);
  // Exactly at the threshold it does group.
  const at = groupByRepo(
    Array.from({ length: MIN_GROUP }, (_, i) => card("a/b", `s${i}`)),
  );
  check(`exactly ${MIN_GROUP} groups`, at.length === 1 && at[0]?.kind === "group", at.length);
}

// ── 3. The chosen order survives ──────────────────────────────────────
{
  // The caller has already sorted. Re-ordering here would silently override the
  // Sort by picker, so a group takes the position of its FIRST member.
  const rows = groupByRepo([
    card("solo/first", "top", 900_000),
    ...Array.from({ length: 4 }, (_, i) => card("big/repo", `s${i}`, 500_000)),
    card("solo/last", "bottom", 10),
  ]);
  check("the leading loose card stays first", rows[0]?.kind === "one");
  check("the group takes its first member's place", rows[1]?.kind === "group");
  check("and the trailing card stays last", rows[2]?.kind === "one");
  check("nothing is dropped", count(rows) === 6, count(rows));
}
{
  // Interleaved repos: grouping must gather them, not only collapse adjacent
  // runs, or the same repo appears twice.
  const rows = groupByRepo([
    card("a/x", "1"),
    card("b/y", "1"),
    card("a/x", "2"),
    card("b/y", "2"),
    card("a/x", "3"),
    card("b/y", "3"),
  ]);
  check("interleaved repos gather into two groups", rows.length === 2, rows.length);
  check("each holding three", rows.every((r) => r.kind === "group" && r.group.items.length === 3));
  check("a repo appears once", new Set(rows.map((r) => (r.kind === "group" ? r.group.key : ""))).size === 2);
  check("nothing is dropped", count(rows) === 6);
}

// ── 4. What the header has to say ─────────────────────────────────────
{
  const rows = groupByRepo([
    card("a/b", "one", 10, true),
    card("a/b", "two", 900, false),
    card("a/b", "three", 50, true),
  ]);
  const g = rows[0]!.kind === "group" ? rows[0]!.group : null;
  check("the group is keyed by repository", g?.key === "a/b", g?.key);
  check("it counts what is installed", g?.installedCount === 2, g?.installedCount);
  // The best figure, not the first or a sum: a header saying 960 installs for a
  // repo whose top skill has 900 would be a number that exists nowhere.
  check("it reports the best installs in the group", g?.installs === 900, g?.installs);
}

// ── 5. Edges ──────────────────────────────────────────────────────────
{
  check("an empty list yields no rows", groupByRepo([]).length === 0);
  check("one card is one row", groupByRepo([card("a/b", "x")]).length === 1);
  // A repo card has no `repository`; it must fall back to its source rather
  // than collapsing every such card into one nameless group.
  const repoCards: Groupable[] = ["a", "b", "c"].map((x, i) => ({
    uid: `r${i}`,
    name: x,
    source: "iaa2005/monet-directory/skills",
    installed: false,
  }));
  const rows = groupByRepo(repoCards);
  check("cards with no repository group by source", rows.length === 1 && rows[0]?.kind === "group");
  check(
    "and the key is that source",
    rows[0]?.kind === "group" && rows[0].group.key === "iaa2005/monet-directory/skills",
  );
  check(
    "a group with no figures reports none rather than zero",
    rows[0]?.kind === "group" && rows[0].group.installs === undefined,
    rows[0]?.kind === "group" ? rows[0].group.installs : undefined,
  );
}

console.log(failures ? `\n${failures} FAILED` : "\nALL GROUP-BY-REPO CHECKS PASSED");
process.exit(failures ? 1 : 0);
