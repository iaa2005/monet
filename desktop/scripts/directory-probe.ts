/**
 * Exercises the two new main-process modules for real: multi-source skill
 * listing against GitHub, and the MCP registry client against the live API.
 *
 * Isolated: app.getAppPath is repointed at a temp folder BEFORE anything
 * imports data-dir, so nothing here touches the user's real .monet dir.
 */
import { app, ipcMain } from "electron";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_SOURCES } from "../src/main/skills/source-model.js";

const sandbox = mkdtempSync(join(tmpdir(), "monet-dirprobe-"));
// defaultDataDir() = dirname(getAppPath())/.monet
app.getAppPath = () => join(sandbox, "desktop");
app.getPath = () => sandbox;
console.log("sandbox:", sandbox);

type Handler = (e: unknown, ...args: any[]) => any;
const handlers = new Map<string, Handler>();
(ipcMain as any).handle = (ch: string, fn: Handler) => handlers.set(ch, fn);

const { registerSkillStoreIPC } = await import("../src/main/ipc/skill-store.js");
const { registerMcpRegistryIPC } = await import(
  "../src/main/ipc/mcp-registry.js"
);
const { registerSkillsIPC } = await import("../src/main/ipc/skills.js");
registerSkillStoreIPC();
// Registered so the DELETE path is the real one: the bug being pinned is that
// skills:delete did not tell the skill store to forget the folder.
registerSkillsIPC();
registerMcpRegistryIPC();

const call = (ch: string, ...args: any[]): any => {
  const h = handlers.get(ch);
  if (!h) throw new Error(`no handler for ${ch}`);
  return h({}, ...args);
};

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
};

// ── Sources ────────────────────────────────────────────────────────────────
console.log("\n# sources");
const def = call("skillstore:getSources") as { kind: string; id: string }[];
const defaultIds = def.map((s) => s.id);
// Sources are typed now: a github source enumerated from a repo, plus the
// registry, which is in the defaults so its chip is there before anything is
// typed rather than only answering a search.
// Counted off DEFAULT_SOURCES rather than spelled out: a hardcoded list here
// turns "the user asked for another source" into a red probe on working code,
// which teaches you to ignore the probe.
check(
  "the built-in sources are the defaults, all enabled",
  JSON.stringify(def.map((s) => `${s.kind}:${s.id}`)) ===
    JSON.stringify(DEFAULT_SOURCES.map((s) => `${s.kind}:${s.id}`)),
  JSON.stringify(def),
);
check(
  "and every one is a github repo or a registry",
  def.every((s) => s.kind === "github" || s.kind === "registry"),
  JSON.stringify(def.map((s) => s.kind)),
);

// Reported: "Skills Directory включаются но не выключаются". The exact payload
// the Directory sends when a chip is clicked, through the real handlers.
{
  const flip = (id: string, enabled: boolean): any[] =>
    (call("skillstore:getSources") as any[]).map((x) =>
      x.id === id
        ? { kind: x.kind, id: x.id, enabled }
        : x.kind === "github" && x.enabled
          ? x.id
          : { kind: x.kind, id: x.id, enabled: x.enabled },
    );
  const stateOf = (id: string): boolean | undefined =>
    (call("skillstore:getSources") as any[]).find((x) => x.id === id)?.enabled;

  check("the registry starts on", stateOf("skillsdirectory") === true);
  call("skillstore:setSources", flip("skillsdirectory", false));
  check("switching it OFF sticks", stateOf("skillsdirectory") === false, String(stateOf("skillsdirectory")));
  // Read twice: a top-up that re-added an enabled copy would show on the second.
  check("and is still off on a second read", stateOf("skillsdirectory") === false);
  call("skillstore:setSources", flip("skillsdirectory", true));
  check("switching it back ON sticks", stateOf("skillsdirectory") === true);

  const other = "iaa2005/monet-directory/skills";
  call("skillstore:setSources", flip(other, false));
  check("a github built-in switches off too", stateOf(other) === false, String(stateOf(other)));
  check("without disturbing the registry", stateOf("skillsdirectory") === true);
  call("skillstore:setSources", flip(other, true));
}

const normalized = (call("skillstore:setSources", [
  "https://github.com/iaa2005/monet-directory",
  "  anthropics/skills  ",
  "garbage",
  "iaa2005/monet-directory",
  "https://github.com/foo/bar/tree/main/skills",
]) as { id: string }[]).map((s) => s.id);
// The built-ins are always in the list, whatever is written: switchable, not
// removable, or a user who deleted one would have no way back.
check(
  "URL forms normalized, junk dropped, duplicates collapsed",
  JSON.stringify(normalized.filter((id) => !defaultIds.includes(id))) ===
    JSON.stringify(["iaa2005/monet-directory", "anthropics/skills", "foo/bar/skills"]),
  JSON.stringify(normalized),
);
check(
  "built-ins survive a write that omits them",
  defaultIds.every((id) => normalized.includes(id)),
  JSON.stringify(normalized),
);
check(
  "persisted to disk",
  existsSync(join(sandbox, ".monet", "skill-store.json")) &&
    JSON.parse(
      readFileSync(join(sandbox, ".monet", "skill-store.json"), "utf-8"),
    ).sources.length === normalized.length,
);

// ── Listing (real GitHub) ──────────────────────────────────────────────────
console.log("\n# listing two real repos + one that does not exist");
call("skillstore:setSources", [
  "iaa2005/monet-directory/skills",
  "anthropics/skills",
  "iaa2005/definitely-not-a-repo",
]);
const listed = await call("skillstore:list");
check("ok", listed.ok === true);
const bySource = new Map<string, number>();
for (const s of listed.skills ?? [])
  bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
console.log("      counts:", JSON.stringify([...bySource]));
check("monet-skills present", (bySource.get("iaa2005/monet-directory/skills") ?? 0) >= 10);
check("anthropics/skills present", (bySource.get("anthropics/skills") ?? 0) > 0);
check(
  "the broken repo is reported, not swallowed",
  (listed.errors ?? []).some((e: string) => e.includes("definitely-not-a-repo")),
  JSON.stringify(listed.errors),
);
check(
  "one bad source did not blank the others",
  (listed.skills ?? []).length > 10,
  `${listed.skills?.length} skills`,
);
const sample = (listed.skills ?? []).find((s: any) => s.name === "pptx");
console.log("      sample:", JSON.stringify(sample));
check("cards carry slug + source", !!sample?.slug && !!sample?.source);
check("descriptions loaded", (sample?.description ?? "").length > 20);

// Identity. `source::path` was the key, and it collides for every registry
// card — they share an empty path, because the folder is only resolved at
// install. Installing one then marked them all installed and pointed every
// Remove button at the same folder. Same class of bug as `docx` existing in
// two repos and both rows claiming to be installed.
const uids = (listed.skills ?? []).map((s: any) => s.uid);
check("every card has a uid", uids.every((u: string) => !!u));
check("and they are unique", new Set(uids).size === uids.length, `${new Set(uids).size}/${uids.length}`);
const sameName = (listed.skills ?? []).filter((s: any) => s.name === "docx");
if (sameName.length > 1)
  check(
    "the same skill name in two repos is two distinct rows",
    new Set(sameName.map((s: any) => s.uid)).size === sameName.length,
    JSON.stringify(sameName.map((s: any) => s.uid)),
  );

// ── Install (real download into the sandbox) ───────────────────────────────
console.log("\n# install");
const inst = await call("skillstore:install", {
  source: "iaa2005/monet-directory/skills",
  path: "skills/pptx",
  // The uid the Directory sends. Without it nothing is recorded, so leaving it
  // out was testing a payload the app never sends.
  uid: sample?.uid,
});
check("install ok", inst.ok === true, inst.error ?? "");
const skillMd = join(sandbox, ".monet", "claude", "skills", inst.slug ?? "", "SKILL.md");
check("SKILL.md landed", existsSync(skillMd), skillMd);
check(
  "scripts came too (subdirectories, not just the top file)",
  existsSync(
    join(sandbox, ".monet", "claude", "skills", inst.slug ?? "", "scripts", "inspect_pptx.py"),
  ),
);
const relisted = await call("skillstore:list");
check(
  "re-listing marks it installed",
  relisted.skills?.find((s: any) => s.path === "skills/pptx" && s.source === "iaa2005/monet-directory/skills")
    ?.installed === true,
);

// ── Removing it must forget it too ─────────────────────────────────────────
//
// Found in the real data dir: five records in skill-origins.json and not one of
// their folders left. Deleting a skill removed the directory and kept the record,
// and that is not merely untidy — installResolver builds its `claimed` set from
// these keys, so a record for a folder that is gone makes a REAL folder of the
// same name read as not installed.
{
  const originsPath = join(sandbox, ".monet", "skill-origins.json");
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(originsPath, "utf-8"));
    } catch {
      return {};
    }
  };
  check("installing recorded an origin", inst.slug! in read(), JSON.stringify(read()));

  await call("skills:delete", inst.slug);
  check(
    "deleting the skill forgets its origin",
    !(inst.slug! in read()),
    JSON.stringify(read()),
  );
  check(
    "and it reads as not installed again",
    (await call("skillstore:list")).skills?.find(
      (s: any) => s.path === "skills/pptx",
    )?.installed === false,
  );

  // The self-healing half: a record whose folder went away behind our back —
  // deleted in a file manager, or by another tool — must not keep its claim.
  writeFileSync(
    originsPath,
    JSON.stringify({ "gone-forever": "some|uid|here" }, null, 2),
    "utf-8",
  );
  await call("skillstore:list");
  check(
    "a stale record is pruned on the next listing",
    !("gone-forever" in read()),
    JSON.stringify(read()),
  );
}

// ── MCP registry (live API) ────────────────────────────────────────────────
console.log("\n# mcp registry");
const search = await call("mcpregistry:search", { query: "filesystem", limit: 30 });
check("search ok", search.ok === true, search.error ?? "");
const servers = search.servers ?? [];
check("results returned", servers.length > 0, `${servers.length}`);
check(
  "ids are unique (version=latest still repeats names)",
  new Set(servers.map((s: any) => s.id)).size === servers.length,
);
const stdio = servers.filter((s: any) => s.transport === "stdio" && !s.unsupported);
const remote = servers.filter((s: any) => s.transport !== "stdio" && !s.unsupported);
console.log(
  `      ${stdio.length} stdio, ${remote.length} remote, ${servers.filter((s: any) => s.unsupported).length} unsupported`,
);
for (const s of stdio.slice(0, 4))
  console.log(`      $ ${s.command} ${(s.args ?? []).join(" ")}`);
for (const s of remote.slice(0, 2))
  console.log(
    `      ${s.transport.toUpperCase()} ${s.url}  vars=${s.vars.map((v: any) => v.name).join(",") || "-"}`,
  );
check(
  "every runnable stdio entry has a command AND args",
  stdio.every((s: any) => s.command && Array.isArray(s.args) && s.args.length > 0),
);
check(
  "npx entries pass -y (else the install prompt hangs unseen)",
  stdio
    .filter((s: any) => s.command === "npx")
    .every((s: any) => s.args.includes("-y")),
);
// A required argument with no value is a SLOT. Emitting the bare flag would
// look like a finished command; every such token must be a visible <slot> and
// must be announced, or the user saves a command that cannot work.
const withSlots = stdio.filter((s: any) => (s.placeholders ?? []).length > 0);
for (const s of withSlots.slice(0, 3))
  console.log(`      slots in ${s.id}: ${s.placeholders.join(" ")}`);
check(
  "declared placeholders really appear in the args",
  withSlots.every((s: any) =>
    s.placeholders.every((p: string) => s.args.includes(p)),
  ),
);
check(
  "no bare <> tokens escape without being declared",
  stdio.every((s: any) =>
    s.args
      .filter((a: string) => a.startsWith("<") && a.endsWith(">"))
      .every((a: string) => (s.placeholders ?? []).includes(a)),
  ),
);
check(
  "every remote entry has a url",
  remote.every((s: any) => typeof s.url === "string" && s.url.startsWith("http")),
);
check(
  "namespace/name split",
  servers.every((s: any) => s.name && !s.name.includes("/")),
);

const empty = await call("mcpregistry:search", { query: "", limit: 12 });
check("empty query browses the registry", (empty.servers ?? []).length > 0);

const nonsense = await call("mcpregistry:search", {
  query: "zzzqqq-not-a-real-server-name",
  limit: 10,
});
check(
  "a no-match query is an empty list, not an error",
  nonsense.ok === true && (nonsense.servers ?? []).length === 0,
  JSON.stringify(nonsense).slice(0, 120),
);

// ── The two installs that were reported as broken ──────────────────────────
//
// Both came back as "matches N folders" and could not be installed at all. The
// ranking that fixes it is unit-tested in agent-folders-probe; this runs it
// against the real repositories through the real handler, because the folder
// lists come from GitHub and a rule that only holds for my fixtures is no rule.
console.log("\n# the reported installs, against the real repos");
{
  const imp = await call("skillstore:preview", {
    source: "claudemarketplaces",
    path: "",
    kind: "registry",
    repository: "pbakaus/impeccable",
    name: "impeccable",
  });
  check("impeccable resolves instead of failing", imp.ok === true, imp.error);
  check(
    "and to the Claude copy — the one whose paths work here",
    imp.dir === ".claude/skills/impeccable",
    imp.dir,
  );
  check(
    "with every agent copy offered",
    (imp.variants ?? []).length >= 10,
    (imp.variants ?? []).length,
  );
  // Reading another agent's copy must actually read THAT copy, or the picker is
  // decoration.
  const cursor = await call("skillstore:preview", {
    source: "claudemarketplaces",
    path: "",
    kind: "registry",
    repository: "pbakaus/impeccable",
    name: "impeccable",
    dir: ".cursor/skills/impeccable",
  });
  check("picking another agent reads that folder", cursor.dir === ".cursor/skills/impeccable", cursor.dir);
  check(
    "and the file really differs from the Claude one",
    !!cursor.content && !!imp.content && cursor.content !== imp.content,
    `${imp.content?.length} vs ${cursor.content?.length} bytes`,
  );
  // A folder that is not in the repo must be refused, not fetched.
  const bogus = await call("skillstore:install", {
    source: "claudemarketplaces",
    path: "",
    kind: "registry",
    repository: "pbakaus/impeccable",
    name: "impeccable",
    dir: "../../etc/passwd",
  });
  check("a folder outside the repo is refused", bogus.ok === false, JSON.stringify(bogus).slice(0, 90));

  // Reported: "Could not tell which of the 9 skills in that repository
  // vercel-react-best-practices is". The catalogue prefixes the name with the
  // vendor; the repository does not. Two of those nine folders begin with
  // `vercel`, so this is also the check that the near-match is not loose.
  const vercel = await call("skillstore:preview", {
    source: "claudemarketplaces",
    path: "",
    kind: "registry",
    repository: "vercel-labs/agent-skills",
    name: "vercel-react-best-practices",
  });
  check("a vendor-prefixed name resolves", vercel.ok === true, vercel.error);
  check(
    "and lands on react-best-practices",
    vercel.dir === "skills/react-best-practices",
    vercel.dir,
  );

  const foundry = await call("skillstore:preview", {
    source: "claudemarketplaces",
    path: "",
    kind: "registry",
    repository: "microsoft/azure-skills",
    name: "microsoft-foundry",
  });
  check("microsoft-foundry resolves instead of failing", foundry.ok === true, foundry.error);
  check(
    "and prefers the plain folder over Copilot's",
    foundry.dir === "skills/microsoft-foundry",
    foundry.dir,
  );
}

// ── The skill the app ships, and the folder it lands in ────────────────────
console.log("\n# create-skill");
{
  const { seedSkills } = await import("../src/main/agent/seed-skills.js");
  const skillsDir = join(sandbox, ".monet", "claude", "skills");
  const md = join(skillsDir, "create-skill", "SKILL.md");
  const marker = join(sandbox, ".monet", "seeded-skills.json");

  seedSkills();
  check("/create-skill is seeded on first run", existsSync(md), md);

  // The frontmatter is what makes it a command. Parsed back rather than
  // string-matched, because a header that does not parse leaves the skill
  // INVISIBLE rather than broken, which is the harder failure to notice.
  const front = readFileSync(md, "utf-8").split("---\n")[1] ?? "";
  const meta = (await import("yaml")).parse(front) as {
    name?: string;
    description?: string;
  };
  check("its frontmatter parses", !!meta, JSON.stringify(meta));
  check("with the command's name", meta.name === "create-skill", meta.name);
  check(
    "and a description that says when it fires",
    (meta.description ?? "").length > 30,
    meta.description,
  );
  check("the seeding is recorded", existsSync(marker));

  // An edit is the user's; seeding again must not undo it.
  writeFileSync(
    md,
    "---\nname: create-skill\ndescription: mine\n---\nmy version\n",
    "utf-8",
  );
  seedSkills();
  check(
    "a second run does not overwrite an edited copy",
    readFileSync(md, "utf-8").includes("my version"),
  );

  // And a deletion is a decision. Putting it back would be worse than never
  // having shipped it at all.
  rmSync(join(skillsDir, "create-skill"), { recursive: true, force: true });
  seedSkills();
  check("nor restore a deleted one", !existsSync(md));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
