/**
 * Skill store IPC — browse and install skills from GitHub repositories.
 *
 * A source is `owner/repo` or `owner/repo/subdir`; the user keeps a LIST of
 * them (default: iaa2005/monet-directory/skills) and the Directory shows them merged,
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
  fetchSuggestedSources,
  type SuggestedSource,
} from "../skill-source-catalog.js";
import {
  capPerRepo,
  listRegistry,
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
  /** Repo-relative dir of the skill. Empty for a registry card: the registry
   * does not say where in the repo the skill lives, so it is resolved at
   * install time against the repo's own tree. */
  path: string;
  /** The source's id — `owner/repo[/sub]`, or a registry id. The card's
   * provenance line, and what the source chips filter on. */
  source: string;
  kind: SourceKind;
  /** Registry cards only: `owner/repo` where the files actually are. */
  repository?: string;
  name: string;
  description: string;
  installed: boolean;
  /** Local folder name once installed — what removal needs. */
  slug: string;
}

export type SourceKind = "github" | "registry";

/**
 * A skill source.
 *
 * `github` is enumerable: one tree request lists every folder holding a
 * SKILL.md. `registry` is not — skillsdirectory.com indexes ~97 000 entries
 * and returns them a page at a time, so it contributes a page rather than a
 * complete listing, and its cards resolve to a folder only on install.
 */
export type SkillSource =
  | { kind: "github"; id: string; repo: string; sub: string }
  | { kind: "registry"; id: string; api: string; name: string; homepage?: string };

const SKILLSDIRECTORY: Extract<SkillSource, { kind: "registry" }> = {
  kind: "registry",
  id: "skillsdirectory",
  api: "https://www.skillsdirectory.com/api/registry",
  name: "Skills Directory",
  homepage: "https://www.skillsdirectory.com",
};

/** Config rows are either a bare string (a GitHub repo — the original format,
 * still what most entries are) or an object for anything else. */
type StoredSource = string | { kind?: string; id?: string; repo?: string; api?: string; name?: string; homepage?: string };

export function parseStoredSource(raw: StoredSource): SkillSource | null {
  if (typeof raw === "string") {
    const norm = normalizeSource(raw);
    if (norm.split("/").length < 2) return null;
    const parts = norm.split("/");
    return {
      kind: "github",
      id: norm,
      repo: parts.slice(0, 2).join("/"),
      sub: parts.slice(2).join("/"),
    };
  }
  if (raw?.kind === "registry") {
    // Only the one registry is understood; an unknown api is not something to
    // guess a protocol for.
    const api = typeof raw.api === "string" ? raw.api : "";
    if (raw.id === SKILLSDIRECTORY.id || api === SKILLSDIRECTORY.api)
      return SKILLSDIRECTORY;
    return null;
  }
  if (typeof raw?.repo === "string") return parseStoredSource(raw.repo);
  return null;
}

/** Back to what goes in the config file — strings stay strings so a
 * hand-edited skill-store.json keeps reading the way it always did. */
function toStored(s: SkillSource): StoredSource {
  return s.kind === "github" ? s.id : { kind: "registry", id: s.id };
}

const UA = { "User-Agent": "monet-desktop" };
const CACHE_MS = 10 * 60 * 1000;
/** Out of the box: the project's own skills, plus the directory — which is
 * where "not just a search" comes from. It is a source like any other now, so
 * its chip is there before anything is typed. */
const DEFAULT_SOURCES: SkillSource[] = [
  parseStoredSource("iaa2005/monet-directory/skills")!,
  SKILLSDIRECTORY,
];

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

function getSources(): SkillSource[] {
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
    const parsed = list
      .map((x) => parseStoredSource(x as StoredSource))
      .filter((x): x is SkillSource => x !== null);
    const seen = new Set<string>();
    const clean = parsed.filter((x) => !seen.has(x.id) && seen.add(x.id));
    if (clean.length) return clean;
  } catch {
    /* default below */
  }
  return DEFAULT_SOURCES;
}

function setSources(list: StoredSource[]): SkillSource[] {
  const parsed = list
    .map((x) => parseStoredSource(x))
    .filter((x): x is SkillSource => x !== null);
  const seen = new Set<string>();
  const clean = parsed.filter((x) => !seen.has(x.id) && seen.add(x.id));
  writeFileSync(
    configFile(),
    JSON.stringify({ sources: clean.map(toStored) }, null, 2),
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

/** The API's own maximum. Was 40, which is what made the registry look like it
 * held fifty skills — the per-repo cap only ever accounted for a handful. */
const REGISTRY_PAGE = 100;

async function listGithub(src: Extract<SkillSource, { kind: "github" }>): Promise<StoreSkill[]> {
  const paths = await fetchTree(src.id);
  const prefix = src.sub ? `${src.sub}/` : "";
  const dirs = paths
    .filter((p) => p.startsWith(prefix) && p.endsWith("/SKILL.md"))
    .map((p) => p.slice(0, -"/SKILL.md".length))
    .slice(0, 60);
  const local = skillsDir();
  const metas = await Promise.allSettled(
    dirs.map(async (dir) => {
      const md = await fetchRaw(src.repo, `${dir}/SKILL.md`);
      const fm = md ? parseFrontmatter(md) : {};
      const base = dir.split("/").pop() ?? dir;
      const slug = slugify(base);
      return {
        path: dir,
        source: src.id,
        kind: "github" as const,
        name: fm.name || base,
        description: (fm.description ?? "").slice(0, 400),
        installed: existsSync(join(local, slug)),
        slug,
      } satisfies StoreSkill;
    }),
  );
  return metas
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<StoreSkill>).value);
}

/**
 * A page of the registry, as cards.
 *
 * Not a listing — there are ~97 000 entries. Without a query this is the most
 * recent page, which is what makes the chip usable before anything is typed;
 * with one it is a search. Capped per repository so a single prolific
 * publisher cannot own the page.
 *
 * One page is deliberately not the whole answer: a search for "git" matches
 * 4805 entries, and the Directory pages through with registryPage below as
 * the user scrolls.
 */
async function listRegistrySource(
  src: Extract<SkillSource, { kind: "registry" }>,
  query: string,
  offset: number,
): Promise<StoreSkill[]> {
  const page = await listRegistry({ query, offset, limit: REGISTRY_PAGE });
  const local = skillsDir();
  return capPerRepo(page, 3).map((r) => ({
    // The registry never says WHERE in the repo the skill is — resolved at
    // install against the repo's tree, so there is nothing to put here.
    path: "",
    source: src.id,
    kind: "registry" as const,
    repository: r.repository,
    name: r.name,
    description: r.description,
    installed: existsSync(join(local, slugify(r.name))),
    slug: slugify(r.name),
  }));
}

function listOne(
  src: SkillSource,
  query: string,
  offset: number,
): Promise<StoreSkill[]> {
  return src.kind === "github"
    ? listGithub(src)
    : listRegistrySource(src, query, offset);
}

/** Every source, merged. One unreachable repo must not blank the whole
 * Directory, so failures come back as `errors` alongside whatever loaded. */
async function listAll(
  sources: SkillSource[],
  query = "",
  offset = 0,
): Promise<{ skills: StoreSkill[]; errors: string[] }> {
  const results = await Promise.allSettled(
    sources.map((s) => listOne(s, query, offset)),
  );
  const skills: StoreSkill[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") skills.push(...r.value);
    else
      errors.push(
        `${sources[i]!.id}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
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
  ipcMain.handle("skillstore:getSources", (): SkillSource[] => getSources());
  ipcMain.handle(
    "skillstore:setSources",
    (_e, list: StoredSource[]): SkillSource[] =>
      setSources(Array.isArray(list) ? list : []),
  );
  ipcMain.handle(
    "skillstore:list",
    async (
      _e,
      opts?: { query?: string; offset?: number },
    ): Promise<{
      ok: boolean;
      skills?: StoreSkill[];
      errors?: string[];
      error?: string;
    }> => {
      try {
        const { skills, errors } = await listAll(
          getSources(),
          opts?.query ?? "",
          opts?.offset ?? 0,
        );
        return { ok: true, skills, errors };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "listing failed",
        };
      }
    },
  );
  // One install entry point. A github card knows its folder; a registry card
  // knows only its repo, so the folder is resolved first — and refused rather
  // than guessed when the repo holds several candidates.
  ipcMain.handle(
    "skillstore:install",
    async (
      _e,
      payload: {
        source: string;
        path: string;
        kind?: SourceKind;
        repository?: string;
        name?: string;
      },
    ) => {
      if (payload.kind !== "registry")
        return installSkill(payload.source, payload.path);
      if (!payload.repository)
        return { ok: false, error: "That directory entry has no repository." };
      const paths = await fetchTree(payload.repository);
      const dirs = paths
        .filter((p) => p.endsWith("/SKILL.md"))
        .map((p) => p.slice(0, -"/SKILL.md".length));
      const pick = pickSkillDir(dirs, payload.name ?? "");
      if (!pick.ok)
        return { ok: false, error: pick.error, candidates: pick.candidates };
      return installSkill(payload.repository, pick.dir);
    },
  );

  /**
   * The next page of the registry sources alone.
   *
   * Separate from `list` on purpose: that one enumerates every github source
   * too, and paging through the registry must not re-fetch a repository's whole
   * tree on every scroll — nor return its skills again as duplicates.
   */
  ipcMain.handle(
    "skillstore:registryPage",
    async (
      _e,
      payload: { query?: string; offset?: number },
    ): Promise<{ ok: boolean; skills?: StoreSkill[]; error?: string }> => {
      try {
        const regs = getSources().filter(
          (s): s is Extract<SkillSource, { kind: "registry" }> =>
            s.kind === "registry",
        );
        if (regs.length === 0) return { ok: true, skills: [] };
        const pages = await Promise.all(
          regs.map((r) =>
            listRegistrySource(r, payload?.query ?? "", payload?.offset ?? 0),
          ),
        );
        return { ok: true, skills: pages.flat() };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "could not load more",
        };
      }
    },
  );

  // Suggested sources, curated in the community repo — the same mechanism the
  // connector store uses, so adding a source for everyone is a JSON edit and a
  // push rather than an app release. Already-configured ones are marked so the
  // UI can grey them out instead of offering a duplicate.
  ipcMain.handle(
    "skillstore:suggestions",
    async (
      _e,
      force?: boolean,
    ): Promise<{ ok: boolean; sources?: (SuggestedSource & { added: boolean })[] }> => {
      const list = await fetchSuggestedSources(force === true);
      const have = new Set(getSources().map((s) => s.id));
      return {
        ok: true,
        sources: list.map((s) => ({ ...s, added: have.has(s.id) || have.has(s.repo ?? "") })),
      };
    },
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
