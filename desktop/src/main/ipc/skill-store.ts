/**
 * Skill store IPC — browse and install skills from GitHub repositories.
 *
 * A source is `owner/repo` or `owner/repo/subdir`; the user keeps a LIST of
 * them (default: iaa2005/monet-skills) and the Directory shows them merged,
 * each card labelled with the repo it came from.
 *
 * Listing one repo costs ONE API request (git trees, recursive) — every
 * directory containing a SKILL.md is a skill; names/descriptions come from raw
 * SKILL.md frontmatter (raw.githubusercontent.com, not rate-limited like the
 * API). Install downloads the skill folder's files into the local skills dir.
 */

import { ipcMain } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getDataDir } from "../data-dir.js";
import {
  pickSkillDir,
  searchRegistry,
  type RegistrySkill as BaseRegistrySkill,
} from "../skills-registry.js";

/** A registry entry as the Directory shows it — plus whether it is already
 * installed locally, which only this side can know. */
export interface RegistrySkill extends BaseRegistrySkill {
  installed?: boolean;
}

export interface StoreSkill {
  /** Repo-relative dir of the skill. Unique only WITHIN a source. */
  path: string;
  /** The `owner/repo[/sub]` this came from — the card's provenance line. */
  source: string;
  name: string;
  description: string;
  installed: boolean;
  /** Local folder name once installed — what removal needs. */
  slug: string;
}

const UA = { "User-Agent": "monet-desktop" };
const CACHE_MS = 10 * 60 * 1000;
const DEFAULT_SOURCES = ["iaa2005/monet-skills"];

function skillsDir(): string {
  const dir = join(getDataDir(), "claude", "skills");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function configFile(): string {
  return join(getDataDir(), "skill-store.json");
}

/** Normalize a user-typed source: accepts a full GitHub URL or `owner/repo`. */
export function normalizeSource(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/tree\/[^/]+\//, "/") // .../tree/main/subdir → .../subdir
    .replace(/^\/+|\/+$/g, "");
}

function getSources(): string[] {
  try {
    const j = JSON.parse(readFileSync(configFile(), "utf-8")) as {
      sources?: unknown;
      source?: unknown;
    };
    // Migration: the single-source config predates the Directory.
    const list = Array.isArray(j.sources)
      ? j.sources
      : typeof j.source === "string"
        ? [j.source]
        : [];
    const clean = list
      .filter((s): s is string => typeof s === "string")
      .map(normalizeSource)
      .filter((s) => s.split("/").length >= 2);
    if (clean.length) return [...new Set(clean)];
  } catch {
    /* default below */
  }
  return DEFAULT_SOURCES;
}

function setSources(list: string[]): string[] {
  const clean = [
    ...new Set(
      list.map(normalizeSource).filter((s) => s.split("/").length >= 2),
    ),
  ];
  writeFileSync(
    configFile(),
    JSON.stringify({ sources: clean }, null, 2),
    "utf-8",
  );
  return clean.length ? clean : DEFAULT_SOURCES;
}

function parseSource(src: string): { repo: string; sub: string } {
  const parts = normalizeSource(src).split("/");
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

// One tree cache per repo (not per source — a subdir shares its repo's tree).
const treeCache = new Map<string, { at: number; paths: string[] }>();

async function fetchTree(source: string): Promise<string[]> {
  const { repo } = parseSource(source);
  const hit = treeCache.get(repo);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.paths;
  const res = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
    { headers: { ...UA, Accept: "application/vnd.github+json" } },
  );
  if (!res.ok)
    throw new Error(
      res.status === 404
        ? `Repository "${repo}" not found (private repos aren't supported).`
        : res.status === 403
          ? `GitHub rate limit reached — wait a few minutes.`
          : `GitHub API error ${res.status} — try again later.`,
    );
  const json = (await res.json()) as {
    tree?: { path: string; type: string }[];
    truncated?: boolean;
  };
  const paths = (json.tree ?? [])
    .filter((e) => e.type === "blob")
    .map((e) => e.path);
  treeCache.set(repo, { at: Date.now(), paths });
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

async function listOne(source: string): Promise<StoreSkill[]> {
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
      const slug = slugify(base);
      return {
        path: dir,
        source,
        name: fm.name || base,
        description: (fm.description ?? "").slice(0, 400),
        installed: existsSync(join(local, slug)),
        slug,
      } satisfies StoreSkill;
    }),
  );
  return metas
    .filter((r): r is PromiseFulfilledResult<StoreSkill> => r.status === "fulfilled")
    .map((r) => r.value);
}

/** Every source, merged. One unreachable repo must not blank the whole
 * Directory, so failures come back as `errors` alongside whatever loaded. */
async function listAll(
  sources: string[],
): Promise<{ skills: StoreSkill[]; errors: string[] }> {
  const results = await Promise.allSettled(sources.map(listOne));
  const skills: StoreSkill[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") skills.push(...r.value);
    else
      errors.push(
        `${sources[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
  });
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, errors };
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
  ipcMain.handle("skillstore:getSources", (): string[] => getSources());
  ipcMain.handle("skillstore:setSources", (_e, list: string[]): string[] =>
    setSources(Array.isArray(list) ? list : []),
  );
  ipcMain.handle(
    "skillstore:list",
    async (): Promise<{
      ok: boolean;
      skills?: StoreSkill[];
      errors?: string[];
      error?: string;
    }> => {
      try {
        const { skills, errors } = await listAll(getSources());
        return { ok: true, skills, errors };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "listing failed",
        };
      }
    },
  );
  ipcMain.handle(
    "skillstore:install",
    (_e, payload: { source: string; path: string }) =>
      installSkill(payload.source, payload.path),
  );

  // ── skillsdirectory.com ────────────────────────────────────────────
  // A SEARCH source, not a browsable one: ~97 000 entries. It indexes GitHub
  // rather than hosting anything, so an install is the ordinary repo download
  // once the entry's folder has been resolved.
  ipcMain.handle(
    "skillstore:searchRegistry",
    async (
      _e,
      payload: { query?: string; limit?: number },
    ): Promise<{ ok: boolean; skills?: RegistrySkill[]; error?: string }> => {
      try {
        const skills = await searchRegistry(payload?.query ?? "", payload?.limit);
        // Mark what is already here, so the card can say so like repo cards do.
        const local = skillsDir();
        return {
          ok: true,
          skills: skills.map((s) => ({
            ...s,
            installed: existsSync(join(local, slugify(s.name))),
          })) as RegistrySkill[],
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "registry search failed",
        };
      }
    },
  );

  ipcMain.handle(
    "skillstore:installRegistry",
    async (
      _e,
      payload: { repository: string; name: string },
    ): Promise<{
      ok: boolean;
      slug?: string;
      error?: string;
      candidates?: string[];
    }> => {
      try {
        // The registry says which repo, never which folder — resolve against
        // the repo's own tree.
        const paths = await fetchTree(payload.repository);
        const dirs = paths
          .filter((p) => p.endsWith("/SKILL.md"))
          .map((p) => p.slice(0, -"/SKILL.md".length));
        const pick = pickSkillDir(dirs, payload.name);
        if (!pick.ok) return { ok: false, error: pick.error, candidates: pick.candidates };
        return await installSkill(payload.repository, pick.dir);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "install failed",
        };
      }
    },
  );
}
