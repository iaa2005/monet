/**
 * Writing a skill on the model's say-so.
 *
 * A skill is instructions the agent will later follow, and this tool lets the
 * model create one during a turn. So the checks are mostly about what must NOT
 * get through: a name that is really a path, a file that escapes the folder, a
 * description too vague to ever match — and a SKILL.md whose frontmatter parses
 * back to what was asked for, since a broken header makes the skill invisible
 * rather than broken, which is harder to notice.
 */

import { parse as parseYaml } from "yaml";
import { prepareSkill } from "../src/main/agent/skill-authoring";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const good = {
  name: "release-notes",
  description: "Use when writing release notes from a range of git commits.",
  body: "1. Read the commits.\n2. Group by area.\n3. Write one line each.",
};

// ── 1. A good draft renders ───────────────────────────────────────────
{
  const r = prepareSkill(good);
  check("a good draft is accepted", r.ok, r.ok ? r.slug : r.error);
  if (r.ok) {
    check("the folder is the name", r.slug === "release-notes");
    const [, front] = r.skillMd.split("---\n");
    const meta = parseYaml(front ?? "") as { name?: string; description?: string };
    // Parsed back rather than string-matched: the header is YAML, and the only
    // question that matters is what a YAML reader makes of it.
    check("frontmatter parses", !!meta, JSON.stringify(meta));
    check("name round-trips", meta.name === "release-notes", meta.name);
    check("description round-trips", meta.description === good.description, meta.description);
    check("the body is there", r.skillMd.includes("2. Group by area."));
    check("and it ends with a newline", r.skillMd.endsWith("\n"));
  }
}

// ── 2. Names that are not names ───────────────────────────────────────
{
  const bad: [string, string][] = [
    ["empty", ""],
    ["a path", "notes/../../etc"],
    ["a slash", "my/skill"],
    ["a backslash", "my\\skill"],
    ["spaces", "release notes"],
    ["underscores", "release_notes"],
    ["capitals", "ReleaseNotes"],
    ["a leading dash", "-notes"],
    ["a trailing dash", "notes-"],
    ["a double dash", "release--notes"],
    ["a dot", "notes.md"],
    ["a tilde", "~"],
    ["too long", "a".repeat(65)],
  ];
  for (const [label, name] of bad) {
    const r = prepareSkill({ ...good, name });
    check(`refused: ${label}`, !r.ok, r.ok ? `accepted as ${r.slug}` : "");
  }
  // Capitals are a typo, not a crime: lower-cased and accepted would be
  // surprising, so it is refused with the name in the message.
  const caps = prepareSkill({ ...good, name: "ReleaseNotes" });
  check(
    "and the message shows what was given",
    !caps.ok && caps.error.includes("ReleaseNotes"),
    caps.ok ? "" : caps.error,
  );
}

// ── 3. The description is the matcher ─────────────────────────────────
{
  check("an empty description is refused", !prepareSkill({ ...good, description: "  " }).ok);
  const r = prepareSkill({ ...good, description: "   " });
  check(
    "and the message says why it matters",
    !r.ok && r.error.includes("matches on"),
    r.ok ? "" : r.error,
  );
  check(
    "an over-long one is refused",
    !prepareSkill({ ...good, description: "x".repeat(501) }).ok,
  );
  // Newlines in a description would break the frontmatter line.
  const multi = prepareSkill({
    ...good,
    description: "Use when\nwriting notes",
  });
  check("newlines are folded, not passed through", multi.ok && !multi.skillMd.split("---")[1]!.includes("Use when\nwriting"));
}

// ── 4. Frontmatter that would not parse ───────────────────────────────
{
  // The failure this prevents is silent: a description with a colon makes the
  // YAML a nested map, the skill loses its description, and it simply never
  // matches anything again.
  const colon = prepareSkill({
    ...good,
    description: "Use when: writing notes, e.g. #release",
  });
  check("a description with a colon is accepted", colon.ok);
  if (colon.ok) {
    const meta = parseYaml(colon.skillMd.split("---\n")[1] ?? "") as {
      description?: string;
    };
    check(
      "and survives a YAML round trip",
      meta.description === "Use when: writing notes, e.g. #release",
      JSON.stringify(meta.description),
    );
  }
  for (const tricky of ['"quoted"', "- dashed", "@at", "ends with colon:", "% percent"]) {
    const r = prepareSkill({ ...good, description: `${tricky} something` });
    if (!r.ok) {
      check(`tricky description accepted: ${tricky}`, false, r.error);
      continue;
    }
    const meta = parseYaml(r.skillMd.split("---\n")[1] ?? "") as { description?: string };
    check(
      `round-trips: ${tricky}`,
      meta.description === `${tricky} something`,
      JSON.stringify(meta.description),
    );
  }
}

// ── 5. Extra files stay inside the folder ─────────────────────────────
{
  const withFiles = prepareSkill({
    ...good,
    files: [
      { path: "scripts/run.py", content: "print('hi')" },
      { path: "reference/notes.md", content: "# notes" },
    ],
  });
  check("relative files are accepted", withFiles.ok, withFiles.ok ? "" : withFiles.error);
  check("and kept", withFiles.ok && withFiles.files.length === 2);

  const escapes: [string, string][] = [
    ["parent", "../evil.sh"],
    ["deep parent", "scripts/../../evil.sh"],
    ["absolute posix", "/etc/passwd"],
    ["absolute windows", "C:/Windows/System32/evil.dll"],
    ["unc", "\\\\server\\share\\evil"],
    ["backslash", "scripts\\run.py"],
    ["empty", ""],
    ["a dot segment", "./run.py"],
    ["a bare dot", "."],
  ];
  for (const [label, path] of escapes) {
    const r = prepareSkill({ ...good, files: [{ path, content: "x" }] });
    check(`refused file path: ${label}`, !r.ok, r.ok ? `accepted ${path}` : "");
  }
  // SKILL.md comes from `body`; letting `files` write it too would mean two
  // sources for one file and a silent winner.
  const clash = prepareSkill({ ...good, files: [{ path: "SKILL.md", content: "x" }] });
  check("SKILL.md cannot be smuggled in as a file", !clash.ok, clash.ok ? "" : clash.error);
  const dupe = prepareSkill({
    ...good,
    files: [
      { path: "a.txt", content: "1" },
      { path: "A.TXT", content: "2" },
    ],
  });
  check("the same file twice is refused", !dupe.ok, dupe.ok ? "" : dupe.error);
}

// ── 6. Sizes ──────────────────────────────────────────────────────────
{
  check("an empty body is refused", !prepareSkill({ ...good, body: "\n  \n" }).ok);
  check("a huge body is refused", !prepareSkill({ ...good, body: "x".repeat(100_001) }).ok);
  check(
    "too many files are refused",
    !prepareSkill({
      ...good,
      files: Array.from({ length: 41 }, (_, i) => ({ path: `f${i}.txt`, content: "x" })),
    }).ok,
  );
  check(
    "a huge file is refused",
    !prepareSkill({ ...good, files: [{ path: "big.txt", content: "x".repeat(200_001) }] }).ok,
  );
}

console.log(failures ? `\n${failures} FAILED` : "\nALL SKILL-AUTHORING CHECKS PASSED");
process.exit(failures ? 1 : 0);
