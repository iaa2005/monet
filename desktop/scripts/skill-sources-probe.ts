/**
 * The skill-source model: on/off, and who may be deleted.
 *
 * Reported: "источники-кнопки то добавляются то исчезают. не понимаю... нет
 * логики". Two separate causes, and the model was the bigger one — a chip was
 * a view filter sharing its row with a delete button, and nothing said which
 * was which. It is now one thing: a source is on or off.
 *
 * The rules being pinned:
 *   - a built-in is always present in the list. If it could be removed, a user
 *     who removed it would have no way back short of typing its id, which is
 *     the "sources disappear" half of the report.
 *   - a built-in can be switched off. Off is not gone.
 *   - only what the user added can be deleted.
 *   - a missing `enabled` reads as on, the useful default for an entry someone
 *     added by hand.
 *   - there is ONE config shape. The pre-Directory `{ "source": ... }` key is not
 *     migrated: the app is unreleased, and that migration resurrected a source
 *     nobody had added.
 */

import {
  DEFAULT_SOURCES,
  migrateStoredSources,
  parseStoredSource,
  toStored,
  withBuiltins,
} from "../src/main/skill-source-model";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const BUILTIN = "iaa2005/monet-directory/skills";

// ── 1. The old config format still reads ──────────────────────────────
{
  const s = parseStoredSource("anthropics/skills");
  check("a bare string parses", !!s);
  check("as a github source", s?.kind === "github");
  check("switched on — that is what it meant before the switch existed", s?.enabled === true);
  check("and as the user's own, so it can be deleted", s?.builtin === false);
  check("with the repo split out", s?.kind === "github" && s.repo === "anthropics/skills");
}
{
  const s = parseStoredSource("https://github.com/foo/bar/tree/main/skills");
  check("a github URL normalises", s?.id === "foo/bar/skills", s?.id);
  check("keeping the subfolder", s?.kind === "github" && s.sub === "skills");
}
{
  check("junk is refused", parseStoredSource("garbage") === null);
  check("so is an unknown registry", parseStoredSource({ kind: "registry", id: "nope" }) === null);
}

// ── 2. Built-in vs the user's own ─────────────────────────────────────
{
  const b = parseStoredSource(BUILTIN);
  check("the default skills source is built in", b?.builtin === true, b?.builtin);
  const r = parseStoredSource({ kind: "registry", id: "skillsdirectory" });
  check("so is the registry", r?.builtin === true);
  const own = parseStoredSource("someone/else");
  check("an added repo is not", own?.builtin === false);
}

// ── 3. Off is a state, not a deletion ─────────────────────────────────
{
  const off = parseStoredSource({ id: BUILTIN, enabled: false });
  check("a built-in can be switched off", off?.enabled === false, off?.enabled);
  check("and is still in the list, still built in", off?.builtin === true);
  const regOff = parseStoredSource({ kind: "registry", id: "skillsdirectory", enabled: false });
  check("the registry can be switched off too", regOff?.enabled === false);
  check("without losing its endpoint", regOff?.kind === "registry" && !!regOff.api);
}
{
  // The migration case: no `enabled` key at all.
  const s = parseStoredSource({ id: "a/b" });
  check("a row with no enabled flag reads as on", s?.enabled === true, s?.enabled);
  // And an explicit true is honoured, not just defaulted.
  check("an explicit true is on", parseStoredSource({ id: "a/b", enabled: true })?.enabled === true);
}

// ── 4. The switch survives a round trip ───────────────────────────────
{
  // What the renderer writes back for a switched-off repo, re-read.
  const off = parseStoredSource({ kind: "github", id: "x/y", enabled: false });
  check("off round-trips as off", off?.enabled === false);
  const on = parseStoredSource({ kind: "github", id: "x/y", enabled: true });
  check("on round-trips as on", on?.enabled === true);
  check("and the id survives both", off?.id === "x/y" && on?.id === "x/y");
}

// -- 5. A built-in cannot go missing ----------------------------------
{
  // The "sources disappear" half of the report. Whatever the config says,
  // every built-in is in the list — off if asked, but present.
  const only = [parseStoredSource("someone/else")!];
  const list = withBuiltins(only);
  // Counted off DEFAULT_SOURCES rather than a literal: a third built-in was
  // added (claudemarketplaces) and a hardcoded 3 turned a working change into a
  // red probe.
  check(
    "built-ins are re-added to a config without them",
    list.length === DEFAULT_SOURCES.length + 1,
    `${list.length} vs ${DEFAULT_SOURCES.length} defaults + 1`,
  );
  for (const d of DEFAULT_SOURCES)
    check(`  ${d.id} is present`, list.some((x) => x.id === d.id));
  check("and the user's own is kept", list.some((x) => x.id === "someone/else"));
}
{
  // A built-in switched off must NOT be replaced by an enabled copy — that
  // would flip the switch back on by itself, which is the flicker.
  const off = parseStoredSource({ id: "skillsdirectory", kind: "registry", enabled: false })!;
  const list = withBuiltins([off]);
  check(
    "a switched-off built-in stays off after the top-up",
    list.filter((x) => x.id === "skillsdirectory").every((x) => !x.enabled),
    JSON.stringify(list.filter((x) => x.id === "skillsdirectory").map((x) => x.enabled)),
  );
  check("and appears exactly once", list.filter((x) => x.id === "skillsdirectory").length === 1);
}
{
  check("an empty config yields just the built-ins", withBuiltins([]).length === DEFAULT_SOURCES.length);
  check("every default is built in", DEFAULT_SOURCES.every((d) => d.builtin));
  check("and on by default", DEFAULT_SOURCES.every((d) => d.enabled));
}

// -- 6. The config file stays readable by hand ------------------------
{
  const on = parseStoredSource("a/b")!;
  check("a plain enabled repo is written as a bare string", toStored(on) === "a/b", JSON.stringify(toStored(on)));
  const off = { ...on, enabled: false };
  const st = toStored(off);
  check("a switched-off one needs the object form", typeof st === "object", JSON.stringify(st));
  check("and reads back off", parseStoredSource(st)?.enabled === false);
  check("and reads back with the same id", parseStoredSource(st)?.id === "a/b");
}

// ── One config shape, no migration ───────────────────────────────────
{
  // Reported twice, the second time with the chip circled: a source labelled
  // `skills` that could not be removed by editing the catalogue, because it was
  // never in the catalogue. It came from the pre-Directory config shape,
  // `{ "source": "anthropics/skills" }` — this app's own default in the first
  // version of the skill store, resurrected as a chip nobody had added.
  //
  // The app is unreleased, so that shape is not supported at all now. These
  // checks pin that: the old key is ignored, and an unreadable config falls back
  // to the built-ins rather than to something invented.
  check(
    "the pre-Directory key is ignored",
    migrateStoredSources({ source: "anthropics/skills" } as never).length === 0,
    JSON.stringify(migrateStoredSources({ source: "anthropics/skills" } as never)),
  );
  check(
    "even for a source somebody might have typed",
    migrateStoredSources({ source: "obra/superpowers" } as never).length === 0,
  );
  check("a list is read as it stands", migrateStoredSources({ sources: ["a/b"] }).length === 1);
  check("an empty config yields nothing", migrateStoredSources({}).length === 0);
  check("and junk in `sources` yields nothing", migrateStoredSources({ sources: "a/b" }).length === 0);
  // Nothing was outlawed — the repo is still perfectly addable, and removable.
  const readded = parseStoredSource("anthropics/skills");
  check("the repo can still be added by hand", readded?.id === "anthropics/skills");
  check("and deleted again, not being a builtin", readded?.builtin === false);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL SKILL-SOURCE CHECKS PASSED");
process.exit(failures ? 1 : 0);
