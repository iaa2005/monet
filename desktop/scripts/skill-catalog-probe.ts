/**
 * Parsing skill-sources.json — the curated source list in the community repo.
 *
 * It arrives over the network from a file anyone with push access edits by
 * hand, so it is untrusted input in the ordinary sense: a typo must not
 * produce a chip that cannot list, and a malformed file must not blank the
 * Directory.
 *
 * The rule being tested is completeness, not correctness of taste: a github
 * entry without a repo and a registry entry without an https api are both
 * unusable, and dropping them is better than showing a source that errors the
 * moment it is clicked.
 */

import { parseCatalog } from "../src/main/skills/source-catalog.js";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── 1. The file as it is meant to look ────────────────────────────────
{
  const list = parseCatalog([
    {
      id: "monet-skills",
      kind: "github",
      repo: "iaa2005/monet-skills",
      name: "Monet Skills",
      description: "The project's own set",
    },
    {
      id: "skillsdirectory",
      kind: "registry",
      api: "https://www.skillsdirectory.com/api/registry",
      homepage: "https://www.skillsdirectory.com",
      name: "Skills Directory",
    },
  ]);
  check("both kinds parse", list.length === 2, list.length);
  check("a repo source keeps its repo", list[0]?.repo === "iaa2005/monet-skills");
  check("a registry keeps its api", list[1]?.api?.startsWith("https://"));
  check("names survive", list[1]?.name === "Skills Directory");
  check("order is the curator's, not sorted", list[0]?.id === "monet-skills");
}

// ── 2. Rows that would make a chip that cannot list ───────────────────
{
  const list = parseCatalog([
    { id: "no-repo", kind: "github", name: "Broken" },
    { id: "bad-repo", kind: "github", repo: "notaslug", name: "Broken too" },
    { id: "no-api", kind: "registry", name: "Broken three" },
    { id: "", kind: "github", repo: "a/b", name: "No id" },
    { kind: "github", repo: "a/b", name: "Missing id entirely" },
  ]);
  check("every unusable row is dropped", list.length === 0, JSON.stringify(list));
}
{
  // http, not https: this is fetched by the app, and downgrading the transport
  // for a list of places to download code from is not a thing to allow.
  const list = parseCatalog([
    { id: "insecure", kind: "registry", api: "http://example.com/api", name: "Insecure" },
  ]);
  check("a plain-http registry is refused", list.length === 0, JSON.stringify(list));
}

// ── 3. Malformed files must not throw ─────────────────────────────────
{
  check("a non-array is empty, not an error", parseCatalog({ nope: true }).length === 0);
  check("null is empty", parseCatalog(null).length === 0);
  check("a string is empty", parseCatalog("[]").length === 0);
  check("junk entries are skipped", parseCatalog([null, 42, "x", []]).length === 0);
  check("an empty array is empty", parseCatalog([]).length === 0);
}

// ── 4. Mixed good and bad ─────────────────────────────────────────────
{
  const list = parseCatalog([
    { id: "bad", kind: "github", name: "no repo" },
    { id: "good", kind: "github", repo: "a/b", name: "Fine" },
  ]);
  check("one bad row does not discard the good ones", list.length === 1, list.length);
  check("and the survivor is the good one", list[0]?.id === "good");
}

// ── 5. Duplicate ids ──────────────────────────────────────────────────
{
  const list = parseCatalog([
    { id: "dup", kind: "github", repo: "first/one", name: "First" },
    { id: "dup", kind: "github", repo: "second/one", name: "Second" },
  ]);
  check("a duplicate id appears once", list.length === 1, list.length);
  check("the first wins — the file's order is the curator's", list[0]?.repo === "first/one");
}

// ── 6. An unknown kind defaults to github rather than vanishing ───────
{
  const list = parseCatalog([{ id: "x", kind: "something-new", repo: "a/b", name: "X" }]);
  check(
    "an unknown kind with a valid repo still works",
    list.length === 1 && list[0]?.kind === "github",
    JSON.stringify(list),
  );
}

console.log(failures ? `\n${failures} FAILED` : "\nALL SKILL-CATALOG CHECKS PASSED");
process.exit(failures ? 1 : 0);
