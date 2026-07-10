/**
 * Skills IPC — manage user skills from the Settings UI.
 *
 * Skills live in the standard Claude Code location the agent already reads:
 *   <CLAUDE_CONFIG_DIR>/skills/<slug>/SKILL.md   (== <dataDir>/claude/skills)
 * Each SKILL.md is YAML frontmatter (name, description) + an instructions body.
 * After a mutation we clear the vendor skill memo + our tool cache so the
 * running agent picks up the change without an app restart.
 */

import { ipcMain } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

export interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  author: string;
  updatedAt: number;
}

function skillsDir(): string {
  const dir = join(getDataDir(), "claude", "skills");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "skill"
  );
}

function stripQuotes(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "");
}

function parseFrontmatter(md: string): {
  name?: string;
  description?: string;
  author?: string;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { body: md };
  const [, fm, body] = m;
  const field = (k: string): string | undefined => {
    const hit = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm);
    return hit ? stripQuotes(hit[1]) : undefined;
  };
  return {
    name: field("name"),
    description: field("description"),
    author: field("author"),
    body,
  };
}

/** First non-empty markdown line, used as a description fallback. */
function firstLine(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line) return line.slice(0, 200);
  }
  return "";
}

function readSkill(slug: string): SkillInfo | null {
  const file = join(skillsDir(), slug, "SKILL.md");
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8");
    const fm = parseFrontmatter(raw);
    return {
      slug,
      name: fm.name || slug,
      description: fm.description || firstLine(fm.body),
      author: fm.author || "You",
      updatedAt: statSync(file).mtimeMs,
    };
  } catch {
    return null;
  }
}

/** All user skills from the skills dir (also used by the "/" command menu). */
export function listSkillInfos(): SkillInfo[] {
  const base = skillsDir();
  const out: SkillInfo[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const info = readSkill(entry.name);
    if (info) out.push(info);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
const listSkills = listSkillInfos;

function refreshSkillCaches(): void {
  // Vendor memoizes skill-dir discovery; our tool set caches the catalog.
  // Clear both so the next agent run sees the new/removed skill.
  void import("@vendor/skills/loadSkillsDir.js")
    .then((m) => m.clearSkillCaches?.())
    .catch(() => {});
  void import("../agent/vendor-tools.js")
    .then((m) => m.resetVendorTools?.())
    .catch(() => {});
}

function writeSkill(opts: {
  name: string;
  description: string;
  instructions: string;
  author?: string;
}): SkillInfo {
  const slug = slugify(opts.name);
  const dir = join(skillsDir(), slug);
  mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `name: ${opts.name.trim()}`,
    `description: ${opts.description.trim().replace(/\n+/g, " ")}`,
    ...(opts.author ? [`author: ${opts.author.trim()}`] : []),
    "---",
    "",
    opts.instructions.trim(),
    "",
  ].join("\n");
  writeFileSync(join(dir, "SKILL.md"), fm, "utf-8");
  refreshSkillCaches();
  return readSkill(slug)!;
}

export function registerSkillsIPC(): void {
  ipcMain.handle("skills:list", () => listSkills());

  ipcMain.handle(
    "skills:create",
    (
      _e,
      payload: { name: string; description: string; instructions: string },
    ): SkillInfo => {
      if (!payload?.name?.trim()) throw new Error("Skill name is required");
      return writeSkill({
        name: payload.name,
        description: payload.description ?? "",
        instructions: payload.instructions ?? "",
      });
    },
  );

  // Import a raw SKILL.md (from "Upload a skill"). The file must carry its
  // name/description in YAML frontmatter; we derive the folder from the name.
  ipcMain.handle(
    "skills:import",
    (_e, payload: { filename: string; content: string }): SkillInfo => {
      const fm = parseFrontmatter(payload.content);
      const name = fm.name || payload.filename.replace(/\.(md|skill)$/i, "");
      if (!name.trim()) throw new Error("Could not determine a skill name");
      return writeSkill({
        name,
        description: fm.description ?? firstLine(fm.body),
        instructions: fm.body ?? payload.content,
        author: fm.author,
      });
    },
  );

  ipcMain.handle("skills:delete", (_e, slug: string): { ok: boolean } => {
    const dir = join(skillsDir(), slug);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    refreshSkillCaches();
    return { ok: true };
  });
}
