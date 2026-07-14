/**
 * Skill store IPC — browse and install skills from a GitHub repository.
 *
 * The source is `owner/repo` or `owner/repo/subdir` (default: anthropics/skills).
 * Listing costs ONE API request (git trees, recursive) — every directory
 * containing a SKILL.md is a skill; names/descriptions come from raw SKILL.md
 * frontmatter (raw.githubusercontent.com, not rate-limited like the API).
 * Install downloads the skill folder's files into the local skills dir.
 */

import { ipcMain } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getDataDir } from "../data-dir.js";

export interface StoreSkill {
  /** Repo-relative dir of the skill (unique id within the store). */
  path: string;
  name: string;
  description: string;
  installed: boolean;
}

const UA = { "User-Agent": "monet-desktop" };
const CACHE_MS = 10 * 60 * 1000;

function skillsDir(): string {
  const dir = join(getDataDir(), "claude", "skills");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function configFile(): string {
  return join(getDataDir(), "skill-store.json");
}

function getSource(): string {
  try {
    const j = JSON.parse(readFileSync(configFile(), "utf-8")) as {
      source?: string;
    };
    if (typeof j.source === "string" && j.source.trim()) return j.source.trim();
  } catch {
    /* default below */
  }
  return "anthropics/skills";
}

function parseSource(src: string): { repo: string; sub: string } {
  const parts = src.replace(/^\/+|\/+$/g, "").split("/");
  const repo = parts.slice(0, 2).join("/");
  const sub = parts.slice(2).join("/");
  return { repo, sub };
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const field = (k: string): string | undefined => {
    const hit = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(m[1]);
    return hit ? hit[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { name: field("name"), description: field("description") };
}

function slugify(name: string): string {
  return (
    name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) ||
    "skill"
  );
}

// One tree cache per source spec.
let treeCache: { source: string; at: number; paths: string[] } | null = null;

async function fetchTree(source: string): Promise<string[]> {
  if (
    treeCache &&
    treeCache.source === source &&
    Date.now() - treeCache.at < CACHE_MS
  )
    return treeCache.paths;
  const { repo } = parseSource(source);
  const res = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
    { headers: { ...UA, Accept: "application/vnd.github+json" } },
  );
  if (!res.ok)
    throw new Error(
      res.status === 404
        ? `Repository "${repo}" not found (private repos aren't supported).`
        : `GitHub API error ${res.status} — try again later.`,
    );
  const json = (await res.json()) as {
    tree?: { path: string; type: string }[];
    truncated?: boolean;
  };
  const paths = (json.tree ?? [])
    .filter((e) => e.type === "blob")
    .map((e) => e.path);
  treeCache = { source, at: Date.now(), paths };
  return paths;
}

async function fetchRaw(repo: string, path: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${repo}/HEAD/${path}`,
      { headers: UA },
    );
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function listStore(source: string): Promise<StoreSkill[]> {
  const { repo, sub } = parseSource(source);
  const paths = await fetchTree(source);
  const prefix = sub ? `${sub}/` : "";
  const dirs = paths
    .filter((p) => p.startsWith(prefix) && p.endsWith("/SKILL.md"))
    .map((p) => p.slice(0, -"/SKILL.md".length))
    .slice(0, 60);
  const local = skillsDir();
  const metas = await Promise.allSettled(
    dirs.map(async (dir) => {
      const md = await fetchRaw(repo, `${dir}/SKILL.md`);
      const fm = md ? parseFrontmatter(md) : {};
      const base = dir.split("/").pop() ?? dir;
      return {
        path: dir,
        name: fm.name || base,
        description: (fm.description ?? "").slice(0, 240),
        installed: existsSync(join(local, slugify(base))),
      } satisfies StoreSkill;
    }),
  );
  return metas
    .filter((r): r is PromiseFulfilledResult<StoreSkill> => r.status === "fulfilled")
    .map((r) => r.value)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function installSkill(
  source: string,
  dir: string,
): Promise<{ ok: boolean; slug?: string; error?: string }> {
  try {
    const { repo } = parseSource(source);
    const paths = await fetchTree(source);
    const files = paths.filter((p) => p.startsWith(`${dir}/`));
    if (!files.includes(`${dir}/SKILL.md`))
      return { ok: false, error: "No SKILL.md in that folder" };
    const base = slugify(dir.split("/").pop() ?? dir);
    let slug = base;
    for (let n = 2; existsSync(join(skillsDir(), slug)); n++) slug = `${base}-${n}`;
    // Cap the download (a skill is text + a few assets, not a repo mirror).
    for (const p of files.slice(0, 80)) {
      const content = await fetchRaw(repo, p);
      if (content == null) continue;
      const rel = p.slice(dir.length + 1);
      const target = join(skillsDir(), slug, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf-8");
    }
    // The agent caches the skill catalog — refresh like ipc/skills.ts does.
    void import("@vendor/skills/loadSkillsDir.js")
      .then((m) => (m as { clearSkillCaches?: () => void }).clearSkillCaches?.())
      .catch(() => {});
    void import("../agent/vendor-tools.js")
      .then((m) => m.resetVendorTools?.())
      .catch(() => {});
    return { ok: true, slug };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "install failed",
    };
  }
}

export function registerSkillStoreIPC(): void {
  ipcMain.handle("skillstore:getSource", (): string => getSource());
  ipcMain.handle("skillstore:setSource", (_e, source: string): string => {
    writeFileSync(
      configFile(),
      JSON.stringify({ source: source.trim() }, null, 2),
    );
    treeCache = null;
    return getSource();
  });
  ipcMain.handle(
    "skillstore:list",
    async (): Promise<{ ok: boolean; skills?: StoreSkill[]; error?: string }> => {
      try {
        return { ok: true, skills: await listStore(getSource()) };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "listing failed",
        };
      }
    },
  );
  ipcMain.handle("skillstore:install", (_e, dir: string) =>
    installSkill(getSource(), dir),
  );
}
