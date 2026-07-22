/**
 * Exercises the two new main-process modules for real: multi-source skill
 * listing against GitHub, and the MCP registry client against the live API.
 *
 * Isolated: app.getAppPath is repointed at a temp folder BEFORE anything
 * imports data-dir, so nothing here touches the user's real .monet dir.
 */
import { app, ipcMain } from "electron";
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
registerSkillStoreIPC();
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
const def = call("skillstore:getSources");
check("default source", JSON.stringify(def) === '["iaa2005/monet-skills"]', JSON.stringify(def));

const normalized = call("skillstore:setSources", [
  "https://github.com/iaa2005/monet-skills",
  "  anthropics/skills  ",
  "garbage",
  "iaa2005/monet-skills",
  "https://github.com/foo/bar/tree/main/skills",
]);
check(
  "URL forms normalized, junk dropped, duplicates collapsed",
  JSON.stringify(normalized) ===
    JSON.stringify(["iaa2005/monet-skills", "anthropics/skills", "foo/bar/skills"]),
  JSON.stringify(normalized),
);
check(
  "persisted to disk",
  existsSync(join(sandbox, ".monet", "skill-store.json")) &&
    JSON.parse(
      readFileSync(join(sandbox, ".monet", "skill-store.json"), "utf-8"),
    ).sources.length === 3,
);

// ── Listing (real GitHub) ──────────────────────────────────────────────────
console.log("\n# listing two real repos + one that does not exist");
call("skillstore:setSources", [
  "iaa2005/monet-skills",
  "anthropics/skills",
  "iaa2005/definitely-not-a-repo",
]);
const listed = await call("skillstore:list");
check("ok", listed.ok === true);
const bySource = new Map<string, number>();
for (const s of listed.skills ?? [])
  bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
console.log("      counts:", JSON.stringify([...bySource]));
check("monet-skills present", (bySource.get("iaa2005/monet-skills") ?? 0) >= 10);
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

// Same-named skill in two repos must stay two rows.
const names = (listed.skills ?? []).map((s: any) => `${s.source}::${s.path}`);
check("no duplicate keys", new Set(names).size === names.length);

// ── Install (real download into the sandbox) ───────────────────────────────
console.log("\n# install");
const inst = await call("skillstore:install", {
  source: "iaa2005/monet-skills",
  path: "skills/pptx",
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
  relisted.skills?.find((s: any) => s.path === "skills/pptx" && s.source === "iaa2005/monet-skills")
    ?.installed === true,
);

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

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
