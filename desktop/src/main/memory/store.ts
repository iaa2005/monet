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

export interface MemoryConfig {
  searchChats: boolean;
  generateMemory: boolean;
  /** Auto-extraction runs at most once per this many minutes per chat. */
  extractEveryMinutes: number;
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

function memoryDir(): string {
  const dir = join(getDataDir(), "claude", "memory");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function configFile(): string {
  return join(getDataDir(), "memory-config.json");
}

export function getMemoryConfig(): MemoryConfig {
  try {
    const j = JSON.parse(readFileSync(configFile(), "utf-8")) as Partial<MemoryConfig>;
    const mins = Number(j.extractEveryMinutes);
    return {
      searchChats: j.searchChats !== false,
      generateMemory: j.generateMemory !== false,
      extractEveryMinutes:
        Number.isFinite(mins) && mins >= 1 ? Math.min(mins, 240) : 3,
    };
  } catch {
    return { searchChats: true, generateMemory: true, extractEveryMinutes: 3 };
  }
}

export function setMemoryConfig(patch: Partial<MemoryConfig>): MemoryConfig {
  const next = { ...getMemoryConfig(), ...patch };
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

/** The system-prompt injection: every memory file, size-capped. */
/** The memory section's preamble. Exported so it can be seeded as an editable
 * prompt file even before any memory exists (buildMemoryPrompt returns early
 * then). */
export function memoryPreamble(): string {
  return tunablePrompt(
    "memory-preamble",
    [
      "# User memory",
      "Long-term facts about the user, accumulated across past conversations.",
      "Use them for context; the user does not see this section.",
    ].join("\n\n"),
  );
}

export function buildMemoryPrompt(): string | null {
  const files = listMemoryFiles();
  if (files.length === 0) return null;
  const parts: string[] = [memoryPreamble()];
  let total = 0;
  for (const f of files) {
    const r = readMemoryFile(f.id);
    if (!r.ok || !r.body) continue;
    const body = r.body.length > FILE_CAP ? r.body.slice(0, FILE_CAP) + "…" : r.body;
    if (total + body.length > TOTAL_CAP) break;
    total += body.length;
    parts.push(`## ${f.name}\n${body}`);
  }
  // Only emit when at least one memory file was actually added (preamble + ≥1).
  return parts.length > 1 ? parts.join("\n\n") : null;
}
