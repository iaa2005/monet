/**
 * The three memory switches, and what they used to be.
 *
 * There were six, on two settings pages that did not know about each other,
 * and two of them crossed: project lessons were GENERATED under one and
 * INJECTED under another, so an install with the first off and the second on —
 * which is what the reporting machine had — showed "enabled" on one page,
 * offered a "Learn now" button on the other, and did nothing at night.
 *
 * So the checks here are mostly about the migration. A switch someone turned
 * off must not come back on because the code was reorganised, and that failure
 * is completely silent: the only sign is a model call at 3am they had said no
 * to, or a memory injected into a chat they had kept it out of.
 *
 *   npm run smoke:memcfg
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "monet-memcfg-"));
process.env.MONET_DATA_DIR = dir;

const {
  getMemoryConfig,
  setMemoryConfig,
  addMemoryNote,
  readMemoryFile,
  appendToMemoryFile,
  buildMemoryPrompt,
} = await import("../src/main/memory/store");

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};

const writeConfig = (o: unknown): void =>
  writeFileSync(join(dir, "memory-config.json"), JSON.stringify(o), "utf-8");
const writeFeatures = (o: unknown): void =>
  writeFileSync(join(dir, "agent-features.json"), JSON.stringify(o), "utf-8");

// ── A fresh install ─────────────────────────────────────────────────────
check("everything is on out of the box", (() => {
  const c = getMemoryConfig();
  return c.useInChats && c.nightly && c.runNotes;
})());

// ── Migrating the old six ───────────────────────────────────────────────

// `searchChats` was the nearest old equivalent of "use memory in chats": it
// gated the one memory tool a user could see.
writeConfig({ searchChats: false, generateMemory: true, extractEveryMinutes: 10 });
check("searchChats: false becomes memory off in chats", !getMemoryConfig().useInChats);
check("...while the nightly pass is untouched", getMemoryConfig().nightly);

writeConfig({ searchChats: true, generateMemory: false, extractEveryMinutes: 0 });
check("generateMemory: false becomes the nightly pass off", !getMemoryConfig().nightly);
check("...while chats keep their memory", getMemoryConfig().useInChats);

// runNotes lived in the OTHER file, behind Advanced. Someone who switched it
// off there must not find it back on here.
writeConfig({ searchChats: true, generateMemory: true });
writeFeatures({ runNotes: false, method: true });
check("runNotes: false carries over from agent-features", !getMemoryConfig().runNotes);
writeFeatures({ runNotes: true });
check("and true carries over as true", getMemoryConfig().runNotes);
writeFeatures({ method: true });
check("an old file that never mentioned it leaves the default", getMemoryConfig().runNotes);

// ── Writing it back ─────────────────────────────────────────────────────
writeConfig({ searchChats: true, generateMemory: true, extractEveryMinutes: 30 });
{
  const next = setMemoryConfig({ nightly: false });
  check("a patch changes only what it names", next.useInChats && !next.nightly);
  const onDisk = JSON.parse(
    readFileSync(join(dir, "memory-config.json"), "utf-8"),
  ) as Record<string, unknown>;
  // The dead key must LEAVE the file. A setting that no longer exists sitting
  // in a config a user might open and read is a lie in a file.
  check(
    "the per-turn pass leaves the file entirely",
    !("extractEveryMinutes" in onDisk) && !("searchChats" in onDisk),
    Object.keys(onDisk),
  );
}

// ── The note box ────────────────────────────────────────────────────────
{
  rmSync(join(dir, "claude"), { recursive: true, force: true });
  addMemoryNote("My plant is named Gerald");
  addMemoryNote("I use bun, not npm");
  const profile = readMemoryFile("profile");
  // APPENDED, both of them. The old path handed the note to the ACTIVE chat
  // model and wrote back a full replacement of up to three files — one
  // sentence in a box could rewrite the lot.
  check("a note is saved", profile.ok && /Gerald/.test(profile.body ?? ""));
  check(
    "and a second one does not replace the first",
    /Gerald/.test(profile.body ?? "") && /bun/.test(profile.body ?? ""),
    profile.body,
  );
  check("an empty note is refused", !addMemoryNote("   ").ok);

  // Same append used by the Remember tool, keeping name and summary.
  appendToMemoryFile("topics/testing", "- prefers probes to unit tests", {
    name: "Testing",
    summary: "How they like tests",
  });
  appendToMemoryFile("topics/testing", "- and measured numbers in commits", {
    name: "IGNORED",
    summary: "IGNORED",
  });
  const t = readMemoryFile("topics/testing");
  check("an existing file keeps its own name", t.name === "Testing", t.name);
  check(
    "and accumulates",
    /probes/.test(t.body ?? "") && /measured/.test(t.body ?? ""),
    t.body,
  );
}

// ── One block about the user ────────────────────────────────────────────
{
  const withProfile = buildMemoryPrompt('Call the user "Alex".') ?? "";
  // Two headings became one. A model told about the user in two sections has
  // to decide which is authoritative; it should not have to.
  check("the profile rides inside the memory block", withProfile.includes("Alex"));
  check(
    "under one heading, not two",
    (withProfile.match(/^# /gm) ?? []).length === 1,
    withProfile.match(/^# .*/gm),
  );
  check("and the files are still there", withProfile.includes("Gerald"));
  // A profile with no memory files yet must still reach the model: it is the
  // first thing a new user fills in.
  rmSync(join(dir, "claude"), { recursive: true, force: true });
  const alone = buildMemoryPrompt('Call the user "Alex".') ?? "";
  check("a profile alone is still emitted", alone.includes("Alex"));
  check("and nothing at all is nothing", buildMemoryPrompt(null) === null);
}

// ── What "new signal" means without a daily log ─────────────────────────
{
  const { changedSince } = await import("../src/main/memory/consolidate");
  rmSync(join(dir, "claude"), { recursive: true, force: true });
  check("nothing written, nothing to tidy", changedSince(0).length === 0);
  appendToMemoryFile("profile", "- something new", { name: "P", summary: "s" });
  // Appending is the only way anything reaches memory during the day, and an
  // append touches the file — so mtime IS the signal, now that there is no
  // log to count bullets in.
  check("an appended file is new signal", changedSince(0).includes("profile"));
  check(
    "and is not, to a pass that already read it",
    changedSince(Date.now() + 5_000).length === 0,
  );
}

// ── The two things the plan says the pages must now do ──────────────────
{
  // Read as source: both are one-line facts about wiring, and importing the
  // renderer to check the second would drag React in for a string.
  const ipc = readFileSync("src/main/ipc/memory.ts", "utf-8");
  // The buttons are a REQUEST, not a schedule: they must work with the
  // nightly switch off, or the page offers a button that silently declines.
  check(
    "the page's buttons bypass the nightly gate",
    /runConsolidation\(\{ force: true \}\)/.test(ipc) &&
      /runLessonsDream\(\{ force: true \}\)/.test(ipc),
  );
  const adv = readFileSync(
    "src/renderer/components/settings/AdvancedSettings.tsx",
    "utf-8",
  );
  check(
    "Advanced no longer has a memory section of its own",
    !adv.includes("Between runs"),
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nALL MEMORY-CONFIG CHECKS PASSED");
process.exit(failures ? 1 : 0);
