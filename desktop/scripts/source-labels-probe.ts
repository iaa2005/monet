/**
 * Source chip labels.
 *
 * Reported: "не понимаю как эти кнопки-источники работают, вообще нет логики" —
 * the chips read `All | monet-directory | skills | Skills Directory`, and there
 * is indeed no logic visible in that. The rule was `id.split("/")[1]`, the
 * middle segment of `owner/repo[/sub]`, which throws away the owner AND the
 * subfolder:
 *
 *   anthropics/skills              → "skills"            (whose skills?)
 *   iaa2005/monet-directory/skills → "monet-directory"   (which part of it?)
 *
 * A chip that cannot be told from another chip is worse than a long one, so
 * these checks are mostly about collisions.
 */

import {
  offeredSuggestions,
  sourceChipLabels,
  type LabelableSource,
} from "../src/renderer/components/directory/source-labels";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const gh = (id: string): LabelableSource => {
  const p = id.split("/");
  return {
    kind: "github",
    id,
    repo: p.slice(0, 2).join("/"),
    sub: p.slice(2).join("/"),
  };
};
const reg = (id: string, name: string): LabelableSource => ({
  kind: "registry",
  id,
  name,
});

// ── 1. The reported row ───────────────────────────────────────────────
{
  const l = sourceChipLabels([
    gh("iaa2005/monet-directory/skills"),
    gh("anthropics/skills"),
    reg("skillsdirectory", "Skills Directory"),
  ]);
  check(
    "a subfolder source keeps its subfolder",
    l.get("iaa2005/monet-directory/skills") === "monet-directory/skills",
    l.get("iaa2005/monet-directory/skills"),
  );
  check("a plain repo reads as the repo", l.get("anthropics/skills") === "skills");
  check("a registry uses its display name", l.get("skillsdirectory") === "Skills Directory");
  check("every source gets a label", l.size === 3);
  check(
    "and no two are the same",
    new Set(l.values()).size === l.size,
    JSON.stringify([...l.values()]),
  );
}

// ── 2. Collisions bring the owner back ────────────────────────────────
{
  // The failure the old rule could not even detect: two chips reading "skills"
  // and no way to tell which filters which.
  const l = sourceChipLabels([gh("anthropics/skills"), gh("foo/skills")]);
  check("a collision is disambiguated", l.get("anthropics/skills") !== l.get("foo/skills"));
  check("by the owner", l.get("anthropics/skills") === "anthropics/skills", l.get("anthropics/skills"));
  check("for both of them", l.get("foo/skills") === "foo/skills", l.get("foo/skills"));
}
{
  // Same repo name, different subfolders — already distinct, so leave them be.
  const l = sourceChipLabels([gh("a/pack/one"), gh("a/pack/two")]);
  check(
    "different subfolders need no owner",
    l.get("a/pack/one") === "pack/one" && l.get("a/pack/two") === "pack/two",
    JSON.stringify([...l.values()]),
  );
}
{
  // The same repo AND the same subfolder from two owners.
  const l = sourceChipLabels([gh("a/pack/x"), gh("b/pack/x")]);
  check("a deep collision is disambiguated too", l.get("a/pack/x") !== l.get("b/pack/x"));
  check("keeping the subfolder", l.get("a/pack/x") === "a/pack/x", l.get("a/pack/x"));
}

// ── 3. Edges ──────────────────────────────────────────────────────────
{
  check("an empty list yields nothing", sourceChipLabels([]).size === 0);
  const l = sourceChipLabels([{ kind: "github", id: "weird" }]);
  check("a malformed id still gets a label", (l.get("weird") ?? "").length > 0, l.get("weird"));
  const r = sourceChipLabels([{ kind: "registry", id: "nameless" }]);
  check("a nameless registry falls back to its id", r.get("nameless") === "nameless");
  // Two registries with one display name is a catalog problem, not a label
  // one — but it must not crash or drop an entry.
  const two = sourceChipLabels([reg("a", "Same"), reg("b", "Same")]);
  check("duplicate registry names still map every id", two.size === 2, JSON.stringify([...two]));
}

// -- 4. Suggestions come back when a source is removed ----------------
{
  // Reported: "в Suggested sources обратно не возвращаются источники если их
  // удалить, надо заново зайти на страницу skills". The catalog's own `added`
  // flag is a snapshot from fetch time, so it went stale the moment a source
  // was removed. Derived from the live list, it cannot.
  const catalog = [
    { id: "anthropic-skills", repo: "anthropics/skills" },
    { id: "skillsdirectory" },
  ];

  const withBoth = [gh("anthropics/skills"), reg("skillsdirectory", "Skills Directory")];
  check("nothing is offered when both are configured", offeredSuggestions(catalog, withBoth).length === 0);

  // Remove the repo — its suggestion must be back immediately.
  const afterRemove = [reg("skillsdirectory", "Skills Directory")];
  const back = offeredSuggestions(catalog, afterRemove);
  check("removing a source brings its suggestion back", back.length === 1, JSON.stringify(back));
  check("and it is the right one", back[0]?.id === "anthropic-skills");

  check("an empty config offers everything", offeredSuggestions(catalog, []).length === 2);

  // A catalog id is kebab-case; a configured github source is owner/repo. The
  // match has to work across that, or the chip would be offered twice.
  check(
    "a configured repo suppresses its kebab-case catalog id",
    offeredSuggestions(catalog, [gh("anthropics/skills")]).every((x) => x.id !== "anthropic-skills"),
  );
  // A switched-OFF source is still configured — it belongs in the chip row, not
  // back in the suggestions, or it would appear in both places at once.
  const off = [{ ...gh("anthropics/skills") }];
  check(
    "a source that is merely switched off is not re-offered",
    offeredSuggestions(catalog, off).every((x) => x.id !== "anthropic-skills"),
  );
}

console.log(failures ? `\n${failures} FAILED` : "\nALL SOURCE-LABEL CHECKS PASSED");
process.exit(failures ? 1 : 0);
