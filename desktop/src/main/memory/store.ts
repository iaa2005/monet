/**
 * User memory store — long-term facts the agent carries between chats.
 *
 * Files live in <dataDir>/claude/memory/:
 *   profile.md            — who the user is (one file, section "You")
 *   topics/<slug>.md      — sustained interests / workflows
 *   areas/<slug>.md       — long-running projects
 * Each file is YAML-ish frontmatter (name, summary) + a markdown body of
 * facts. buildMemoryPrompt() folds them into the system prompt (capped).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { getDataDir } from "../data-dir.js";
import { tunablePrompt } from "../prompts/index.js";

/**
 * Three switches, one per LEVEL, and that is the whole design.
 *
 * There used to be six, spread over two settings pages that did not know
 * about each other: `generateMemory` and `extractEveryMinutes` and
 * `searchChats` here, `lessons` and `runNotes` in the agent-features file
 * behind Advanced, and the Remember tool ungated entirely. They crossed:
 * project lessons were GENERATED under `generateMemory` and INJECTED under
 * `lessons`, so an install with the first off and the second on — which is
 * what the reporting machine had — showed "enabled" on one page, offered a
 * "Learn now" button on the other, and did nothing at night. Neither page
 * said so.
 *
 * Now: what is read, what tops it up, and what carries between runs.
 */
export interface MemoryConfig {
  /**
   * Memory is used in chats at all: the files in the system prompt, this
   * workspace's lessons, the SearchPastChats tool, the Remember tool.
   *
   * Off means the agent neither reads memory nor writes it. Nothing is
   * deleted — the files stay, and the page still shows them.
   */
  useInChats: boolean;
  /**
   * The nightly pass runs by itself: consolidation, and the per-workspace
   * lessons alongside it.
   *
   * The only automatic model call memory makes. There used to be a second —
   * a per-turn extraction, every few minutes in every chat, writing to a
   * daily log the nightly pass then read. It is gone: two writers, two
   * prompts and a third file format, for facts the agent can write itself
   * with the Remember tool at the moment it learns them.
   */
  nightly: boolean;
  /**
   * A goal that finishes writes what it did; one that blocks writes what
   * stopped it, and the next run in that folder starts with those lines.
   *
   * Memory of a project rather than of the user, which is why it lives here
   * and not under "how the agent works": it is a thing the app remembers.
   * Costs nothing — no model call, no tokens beyond the lines themselves.
   */
  runNotes: boolean;
}

const DEFAULTS: MemoryConfig = { useInChats: true, nightly: true, runNotes: true };

/**
 * A switch that used to live in `<dataDir>/agent-features.json`.
 *
 * Read as a file rather than through agent/features.ts: this is a one-way
 * migration of two keys, and importing the feature registry from the memory
 * store to do it would be a dependency that outlives the reason for it.
 *
 * Only `runNotes` is carried. The other, `lessons`, gated INJECTING a
 * workspace's lessons while a different switch gated generating them — the
 * pair that disagreed on the reporting machine. It folds into `useInChats`,
 * which is what the page now says it covers.
 */
function legacyFeature(name: "runNotes"): boolean | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(getDataDir(), "agent-features.json"), "utf-8"),
    ) as Record<string, unknown>;
    return typeof raw[name] === "boolean" ? (raw[name] as boolean) : undefined;
  } catch {
    return undefined;
  }
}

export interface MemoryFileInfo {
  /** "profile" | "topics/<slug>" | "areas/<slug>" */
  id: string;
  section: "you" | "topics" | "areas";
  name: string;
  summary: string;
  updatedAt: number;
}

const FILE_CAP = 2_500;
const TOTAL_CAP = 10_000;

/** Index caps, matching the vendor's: it must always fit in context. */
const ENTRYPOINT_NAME = "MEMORY.md";
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;

function memoryDir(): string {
  const dir = join(getDataDir(), "claude", "memory");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** The memory root — daily logs and the MEMORY.md index live alongside the files. */
export function getMemoryDir(): string {
  return memoryDir();
}

function configFile(): string {
  return join(getDataDir(), "memory-config.json");
}

export function getMemoryConfig(): MemoryConfig {
  try {
    const j = JSON.parse(readFileSync(configFile(), "utf-8")) as Partial<MemoryConfig> &
      // What the file held before the three switches replaced the six.
      Partial<{ searchChats: boolean; generateMemory: boolean }>;
    return {
      // `searchChats` was the nearest old equivalent: it gated the one memory
      // tool a user could see, so someone who turned it off had said "keep
      // memory out of my chats" as plainly as the old settings allowed.
      useInChats: (j.useInChats ?? j.searchChats) !== false,
      nightly: (j.nightly ?? j.generateMemory) !== false,
      // `runNotes` used to live in the agent-features file, behind Advanced →
      // "Between runs", where nothing else was about memory. Carried over so
      // someone who switched it off there does not find it back on here.
      runNotes: (j.runNotes ?? legacyFeature("runNotes")) !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setMemoryConfig(patch: Partial<MemoryConfig>): MemoryConfig {
  // Written from the whole config rather than merged into the file, so a key
  // that no longer exists — `extractEveryMinutes`, from the per-turn pass —
  // disappears from disk the first time anything is changed.
  const cur = getMemoryConfig();
  const next: MemoryConfig = {
    useInChats: patch.useInChats ?? cur.useInChats,
    nightly: patch.nightly ?? cur.nightly,
    runNotes: patch.runNotes ?? cur.runNotes,
  };
  // Written field by field rather than merged over what was there, so the
  // keys of the old six-switch shape leave the file the first time anything
  // is changed instead of sitting in it looking meaningful.
  writeFileSync(configFile(), JSON.stringify(next, null, 2));
  return next;
}

/** Valid ids only — a bad id must never escape the memory dir. */
export function isValidMemoryId(id: string): boolean {
  return /^(profile|(topics|areas)\/[a-z0-9][a-z0-9-]{0,63})$/.test(id);
}

function fileFor(id: string): string {
  return join(memoryDir(), `${id}.md`);
}

function parseFrontmatter(raw: string): {
  name?: string;
  summary?: string;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { body: raw.trim() };
  const field = (k: string): string | undefined => {
    const hit = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(m[1]);
    return hit ? hit[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { name: field("name"), summary: field("summary"), body: m[2].trim() };
}

export function listMemoryFiles(): MemoryFileInfo[] {
  const out: MemoryFileInfo[] = [];
  const push = (id: string, section: MemoryFileInfo["section"]): void => {
    const f = fileFor(id);
    if (!existsSync(f)) return;
    try {
      const fm = parseFrontmatter(readFileSync(f, "utf-8"));
      out.push({
        id,
        section,
        name: fm.name || id.split("/").pop() || id,
        summary: fm.summary || fm.body.split("\n")[0]?.slice(0, 140) || "",
        updatedAt: statSync(f).mtimeMs,
      });
    } catch {
      /* skip unreadable */
    }
  };
  push("profile", "you");
  for (const section of ["topics", "areas"] as const) {
    const dir = join(memoryDir(), section);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".md")) push(`${section}/${f.slice(0, -3)}`, section);
    }
  }
  return out;
}

export function readMemoryFile(
  id: string,
): { ok: boolean; name?: string; summary?: string; body?: string; error?: string } {
  if (!isValidMemoryId(id)) return { ok: false, error: "Invalid memory id" };
  const f = fileFor(id);
  if (!existsSync(f)) return { ok: false, error: "Not found" };
  const fm = parseFrontmatter(readFileSync(f, "utf-8"));
  return { ok: true, name: fm.name, summary: fm.summary, body: fm.body };
}

export function writeMemoryFile(
  id: string,
  data: { name: string; summary: string; body: string },
): { ok: boolean; error?: string } {
  if (!isValidMemoryId(id)) return { ok: false, error: "Invalid memory id" };
  const f = fileFor(id);
  mkdirSync(dirname(f), { recursive: true });
  const raw = [
    "---",
    `name: ${data.name.trim().replace(/\n/g, " ")}`,
    `summary: ${data.summary.trim().replace(/\n/g, " ")}`,
    "---",
    "",
    data.body.trim(),
    "",
  ].join("\n");
  writeFileSync(f, raw, "utf-8");
  return { ok: true };
}

export function deleteMemoryFile(id: string): { ok: boolean } {
  if (isValidMemoryId(id) && existsSync(fileFor(id)))
    rmSync(fileFor(id), { force: true });
  return { ok: true };
}

export function slugifyMemoryName(name: string): string {
  return (
    name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) ||
    "note"
  );
}

/**
 * Add one fact to a memory file, keeping everything already in it.
 *
 * The only way anything writes to memory during a conversation, and append is
 * the whole point: a file accumulates across chats, and the alternative —
 * handing a cheap model the file and asking for a replacement — is how months
 * of accumulated facts get dropped by a pass that could not see them. The
 * nightly consolidation is allowed to rewrite, because it reads everything
 * first.
 */
export function appendToMemoryFile(
  id: string,
  entry: string,
  fallback: { name: string; summary: string },
): { ok: boolean; error?: string } {
  const existing = readMemoryFile(id);
  const body = existing.ok && existing.body?.trim()
    ? `${existing.body.trim()}
${entry}`
    : entry;
  return writeMemoryFile(id, {
    name: existing.name || fallback.name,
    summary: existing.summary || fallback.summary,
    body,
  });
}

/**
 * "Tell Code Monet to remember…", from the Memory page.
 *
 * Appended verbatim, with no model in the way. It used to run an extraction
 * pass — the ACTIVE chat model, not the background one — which read every
 * memory file and wrote back full replacements for up to three of them. One
 * sentence typed into a box could rewrite the lot, and on a local model it
 * was several minutes of prefill with no timeout behind it.
 *
 * Sorting it into the right topic is the nightly pass's job. It has the whole
 * picture; a note box does not.
 */
export function addMemoryNote(note: string): { ok: boolean; error?: string } {
  const text = note.trim();
  if (!text) return { ok: false, error: "Nothing to remember." };
  return appendToMemoryFile("profile", `- ${text}`, {
    name: "Profile",
    summary: "Who the user is",
  });
}

/** The system-prompt injection: every memory file, size-capped. */
/** The memory section's preamble. Exported so it can be seeded as an editable
 * prompt file even before any memory exists (buildMemoryPrompt returns early
 * then). */
export function memoryPreamble(): string {
  return tunablePrompt(
    "memory-preamble",
    [
      "# About the user",
      "What they have told you about themselves, and what you have learned across past conversations. Use it for context; they do not see this section.",
    ].join("\n\n"),
  );
}

/** MEMORY.md — the distilled index the nightly pass maintains. */
export function indexPath(): string {
  return join(memoryDir(), ENTRYPOINT_NAME);
}

export function readMemoryIndex(): string {
  try {
    return readFileSync(indexPath(), "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Rewrite the index. It is an INDEX, not a dump: one line per memory, capped
 * the way the vendor caps it (200 lines / 25KB) so it can always be carried in
 * context.
 */
export function writeMemoryIndex(
  entries: { title: string; id: string; hook: string }[],
): void {
  const lines: string[] = ["# Memory index", ""];
  for (const e of entries.slice(0, MAX_INDEX_LINES)) {
    const title = e.title.replace(/[\r\n\]]+/g, " ").trim() || e.id;
    const hook = e.hook.replace(/[\r\n]+/g, " ").trim();
    let line = `- [${title}](${e.id}.md)${hook ? ` — ${hook}` : ""}`;
    if (line.length > 200) line = line.slice(0, 199) + "…";
    lines.push(line);
  }
  let out = lines.join("\n") + "\n";
  if (Buffer.byteLength(out, "utf-8") > MAX_INDEX_BYTES)
    out = out.slice(0, MAX_INDEX_BYTES) + "\n";
  writeFileSync(indexPath(), out, "utf-8");
}

/**
 * One block for who the user is, from both places it is written down.
 *
 * `profile` is what they typed into Settings → Profile; the files are what
 * has accumulated since. They used to be two sections with two headings —
 * "# User profile" and "# User memory" — so a model reading the prompt was
 * told about the user in two places and had to decide which was
 * authoritative. One section now, with the standing facts first.
 *
 * The index is capped separately by writeMemoryIndex (200 lines / 25 KB), and
 * that cap USED to be the only one it had: TOTAL_CAP counted the bodies and
 * not the index, so a full index could add six thousand tokens to every turn
 * on top of the ten thousand characters this thought it was allowing. It is
 * inside the budget now.
 */
export function buildMemoryPrompt(profile?: string | null): string | null {
  const files = listMemoryFiles();
  const parts: string[] = [memoryPreamble()];
  let total = 0;
  const own = profile?.trim();
  if (own) {
    parts.push(own);
    total += own.length;
  }
  // The index goes next: when the bodies below get capped, it still tells the
  // model which memories exist so it can go read one deliberately.
  const index = readMemoryIndex();
  if (index && total + index.length <= TOTAL_CAP) {
    parts.push(index);
    total += index.length;
  }
  let bodies = 0;
  for (const f of files) {
    const r = readMemoryFile(f.id);
    if (!r.ok || !r.body) continue;
    const body = r.body.length > FILE_CAP ? r.body.slice(0, FILE_CAP) + "…" : r.body;
    if (total + body.length > TOTAL_CAP) break;
    total += body.length;
    bodies++;
    parts.push(`## ${f.name}\n${body}`);
  }
  // Emit when there is real content — the profile, a body, or an index
  // pointing at files whose bodies were all capped out.
  return bodies > 0 || index || own ? parts.join("\n\n") : null;
}
