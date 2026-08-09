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
} from "../skills/source-catalog.js";
import {
  BUILTIN_IDS,
  DEFAULT_SOURCES,
  readStoredSources,
  normalizeSource,
  parseStoredSource,
  toStored,
  withBuiltins,
  type SkillSource,
  type SourceKind,
  type StoredSource,
} from "../skills/source-model.js";
import {
  matchMarketplace,
  marketplaceSnapshot,
  sortMarketplace,
  type MarketplaceSort,
} from "../skills/marketplace.js";
import { DEFAULT_CONFIG, directoryConfig } from "../directory/config.js";
import {
  auditSkill,
  isAuditableFile,
  type AuditResult,
} from "../skills/audit.js";
import { fetchAuditRules } from "../skills/audit-rules.js";
import { agentOfPath } from "../skills/agent-folders.js";
import { loadAgentFolders } from "../skills/agent-folder-catalog.js";
import {
  cacheTree,
  cachedTree,
  githubHeaders,
  MISSING,
  treeViaArchive,
} from "../directory/github-budget.js";
import {
  capPerRepo,
  usefulDescription,
  listRegistry,
  pickSkillDir,
  searchRegistry,
  type RegistrySkill as BaseRegistrySkill,
} from "../skills/registry.js";

/** A registry entry as the Directory shows it — plus whether it is already
 * installed locally, which only this side can know. */
export interface RegistrySkill extends BaseRegistrySkill {
  installed?: boolean;
}

export interface StoreSkill {
  /**
   * Stable, unique identity for this card, and the key an install is recorded
   * under.
   *
   * Not the name: `docx` exists in anthropics/skills and in this project's own
   * repo, and keying on the name made installing one mark both as installed —
   * and, worse, made the second card's Remove button point at the first one's
   * folder. Not source+path either: a registry card has no path (the folder is
   * resolved at install time), so every registry card shared one key.
   */
  uid: string;
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
  /**
   * Registry cards only: the best clue to WHICH folder in that repo, used at
   * install time. Not a repo-relative path — measured against real repos,
   * claudemarketplaces publishes a leaf name: it reports `find-skills` for a
   * skill that lives at `skills/find-skills`, and 5 of 8 sampled entries sat
   * somewhere else entirely (`plugins/x/skills/y`, `frameworks/shared-skills/
   * skills/z`). A better clue than a display name, still a clue.
   */
  hint?: string;
  name: string;
  description: string;
  installed: boolean;
  /** Registry cards only — what the category filter offers. */
  category?: string;
  /** Local folder name once installed — what removal needs. */
  slug: string;
  /**
   * Registry cards: how many people installed this skill, and the REPOSITORY's
   * star count. Kept apart because they measure different things — nineteen
   * skills called `docx` each inherit their own repo's stars, and none of that
   * figure is about the skill.
   */
  installs?: number;
  stars?: number;
  /**
   * Where to go and read this before installing it. A skill is instructions the
   * model will follow, so the source should be one click away.
   *
   * `tree/HEAD/<path>` rather than a branch name: verified against real repos,
   * and it means the link needs no extra request to learn the default branch.
   */
  url?: string;
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

/**
 * Which card each installed folder came from: `{ <slug>: <uid> }`.
 *
 * Without it "installed" can only be guessed from the folder name, and two
 * sources shipping a skill of the same name are indistinguishable. Recorded on
 * install; read on every listing.
 */
function originsFile(): string {
  return join(getDataDir(), "skill-origins.json");
}

function readOrigins(): Record<string, string> {
  try {
    const j = JSON.parse(readFileSync(originsFile(), "utf-8")) as unknown;
    return j && typeof j === "object" ? (j as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Forget a folder we no longer have.
 *
 * Found in the wild: five records in skill-origins.json, and not one of their
 * folders still existed — deleting a skill removed the directory and left its
 * record behind. That is not only untidy. `installResolver` builds its `claimed`
 * set from these keys, so a record for a folder that is gone makes a REAL folder
 * of the same name read as not installed.
 */
export function forgetOrigin(slug: string): void {
  try {
    const all = readOrigins();
    if (!(slug in all)) return;
    delete all[slug];
    writeFileSync(originsFile(), JSON.stringify(all, null, 2), "utf-8");
  } catch {
    /* the prune on the next listing catches it */
  }
}

function recordOrigin(slug: string, uid: string): void {
  try {
    const all = readOrigins();
    all[slug] = uid;
    writeFileSync(originsFile(), JSON.stringify(all, null, 2), "utf-8");
  } catch {
    /* the listing falls back to matching by folder name */
  }
}

/**
 * Resolve "is this card installed, and under which folder".
 *
 * The name fallback is NOT a migration, and calling it one would be wrong: a
 * folder in the skills directory that this app did not install is a permanent
 * case, not a legacy one. It can be dropped in by hand, or put there by Claude
 * Code itself, and either way the Directory should say `installed` rather than
 * offer to install it again on top.
 *
 * What it must not do is claim the same folder twice. Built once per listing so
 * the pass is deterministic: `docx` from two sources would otherwise both point
 * at one folder, and Remove would delete the other card's skill.
 */
function installResolver(): (uid: string, name: string) => {
  installed: boolean;
  slug: string;
} {
  const dir = skillsDir();
  // Drop records whose folder is gone before using them. A skill can also be
  // deleted from outside the app, so this has to be self-healing rather than
  // relying on every delete going through us.
  const origins = readOrigins();
  const live = Object.fromEntries(
    Object.entries(origins).filter(([slug]) => existsSync(join(dir, slug))),
  );
  if (Object.keys(live).length !== Object.keys(origins).length) {
    try {
      writeFileSync(originsFile(), JSON.stringify(live, null, 2), "utf-8");
    } catch {
      /* the in-memory copy is already correct for this listing */
    }
  }
  const byUid = new Map<string, string>();
  for (const [slug, uid] of Object.entries(live)) byUid.set(uid, slug);
  const claimed = new Set(Object.keys(live));
  return (uid, name) => {
    const known = byUid.get(uid);
    if (known) return { installed: existsSync(join(dir, known)), slug: known };
    const guess = slugify(name);
    if (!claimed.has(guess) && existsSync(join(dir, guess))) {
      claimed.add(guess); // first card wins; the rest are genuinely not installed
      return { installed: true, slug: guess };
    }
    return { installed: false, slug: guess };
  };
}

function getSources(): SkillSource[] {
  try {
    const j = JSON.parse(readFileSync(configFile(), "utf-8")) as {
      sources?: unknown;
    };
    const parsed = readStoredSources(j)
      .map((x) => parseStoredSource(x))
      .filter((x): x is SkillSource => x !== null);
    const seen = new Set<string>();
    const clean = parsed.filter((x) => !seen.has(x.id) && seen.add(x.id));
    if (clean.length) return withBuiltins(clean);
  } catch {
    /* default below */
  }
  return DEFAULT_SOURCES;
}

/**
 * Config + catalog, merged. See the `skillstore:sources` handler.
 *
 * A catalog failure is not an error worth surfacing: the configured sources are
 * unaffected and the row simply has fewer switches in it.
 */
async function allSources(): Promise<SkillSource[]> {
  const stored = getSources();
  const have = new Set(stored.map((s) => s.id));
  let extra: SkillSource[] = [];
  try {
    const catalog = await fetchSuggestedSources();
    extra = catalog
      .filter((c) => !have.has(c.id) && !have.has(c.repo ?? ""))
      .map((c) =>
        parseStoredSource(
          c.kind === "github"
            ? (c.repo ?? c.id)
            : { kind: c.kind, id: c.id, api: c.api },
        ),
      )
      .filter((x): x is SkillSource => x !== null)
      // Not builtin: the user may delete a curated source, unlike one that
      // ships in the binary and has nowhere to come back from.
      .map((x) => ({ ...x, builtin: false }));
  } catch {
    /* no catalog — the configured sources stand on their own */
  }
  return [...stored, ...extra];
}

function setSources(list: StoredSource[]): SkillSource[] {
  const parsed = list
    .map((x) => parseStoredSource(x))
    .filter((x): x is SkillSource => x !== null);
  const seen = new Set<string>();
  const clean = withBuiltins(
    parsed.filter((x) => !seen.has(x.id) && seen.add(x.id)),
  );
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

/**
 * Every file in a repository.
 *
 * Three ways to get it, and the reason is a limit the user hit hard: anonymous
 * api.github.com allows 60 calls an HOUR, and one listing spends one. See
 * directory/github-budget.ts — the token, the cache that survives restart, and the archive
 * that the limit does not apply to.
 */
async function fetchTree(source: string): Promise<string[]> {
  const { repo } = parseSource(source);
  const hit = treeCache.get(repo);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.paths;
  // Yesterday's listing beats a request today. A repo's skills do not move often
  // and this is what stops a restart re-spending the whole budget.
  const saved = cachedTree(repo);
  if (saved) {
    treeCache.set(repo, { at: Date.now(), paths: saved });
    return saved;
  }
  const keep = (paths: string[]): string[] => {
    treeCache.set(repo, { at: Date.now(), paths });
    cacheTree(repo, paths);
    return paths;
  };
  const res = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
    // The user's own token, when the GitHub connector holds one: the same call,
    // 5 000 an hour instead of 60.
    { headers: await githubHeaders({ ...UA, Accept: "application/vnd.github+json" }) },
  );
  if (!res.ok) {
    if (res.status === 404)
      throw new Error(
        `Repository "${repo}" not found (private repos aren't supported).`,
      );
    if (res.status === 403 || res.status === 429) {
      // Out of budget is not out of options: the archive host answers while the
      // API is refusing, and costs nothing against the limit. Slower, so it is
      // the fallback rather than the route.
      try {
        return keep(await treeViaArchive(repo));
      } catch (err) {
        if (err instanceof Error && err.message === MISSING)
          throw new Error(
            `Repository "${repo}" not found (private repos aren't supported).`,
          );
        const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
        const mins = reset > Date.now() ? Math.ceil((reset - Date.now()) / 60_000) : 0;
        throw new Error(
          `GitHub rate limit reached${mins ? `, and the archive could not be read either — it resets in ${mins} minute${mins === 1 ? "" : "s"}.` : " — try again later."} Connecting GitHub in Settings raises the limit from 60 an hour to 5000.`,
        );
      }
    }
    throw new Error(`GitHub API error ${res.status} — try again later.`);
  }
  const json = (await res.json()) as {
    tree?: { path: string; type: string }[];
    truncated?: boolean;
  };
  return keep((json.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path));
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

/** Page size and the per-repo cap come from the catalog repo — see
 * directory/config.ts. This is only the value used before the first fetch
 * lands. */
const REGISTRY_PAGE = DEFAULT_CONFIG.registryPageSize;

/** How many of a skill's files to read for the audit. A skill is text and a few
 * scripts; anything past this is a repo mirror and not what is being judged. */
const AUDIT_FILES = 25;

async function listGithub(src: Extract<SkillSource, { kind: "github" }>): Promise<StoreSkill[]> {
  const paths = await fetchTree(src.id);
  const prefix = src.sub ? `${src.sub}/` : "";
  const dirs = paths
    .filter((p) => p.startsWith(prefix) && p.endsWith("/SKILL.md"))
    .map((p) => p.slice(0, -"/SKILL.md".length))
    .slice(0, 60);
  const resolve = installResolver();
  const metas = await Promise.allSettled(
    dirs.map(async (dir) => {
      const md = await fetchRaw(src.repo, `${dir}/SKILL.md`);
      const fm = md ? parseFrontmatter(md) : {};
      const base = dir.split("/").pop() ?? dir;
      const uid = `${src.id}|${dir}`;
      const { installed, slug } = resolve(uid, base);
      return {
        uid,
        url: `https://github.com/${src.repo}/tree/HEAD/${dir}`,
        path: dir,
        source: src.id,
        kind: "github" as const,
        name: fm.name || base,
        description: (fm.description ?? "").slice(0, 400),
        installed,
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
/**
 * A page of claudemarketplaces, as cards.
 *
 * Local paging over a cached snapshot, because their API returns all 23 472
 * rows on every request and ignores every paging parameter.
 *
 * Their `path` is NOT repo-relative. Checked against the repos themselves: they
 * report `find-skills` for `skills/find-skills`, and most sampled entries sat
 * deeper still. So it is passed as a resolution HINT — a folder basename, which
 * is what pickSkillDir matches on, and a much better clue than the display name
 * skillsdirectory leaves us with. Ambiguity is still refused, not guessed.
 */
async function listMarketplaceSource(
  src: Extract<SkillSource, { kind: "registry" }>,
  query: string,
  offset: number,
  sort?: RegistrySort,
): Promise<StoreSkill[]> {
  const cfg = await directoryConfig();
  const snapshot = await marketplaceSnapshot();
  // Search results keep relevance order unless an explicit key is asked for;
  // browsing always needs one.
  const key: MarketplaceSort =
    sort === "stars" ? "stars" : sort === "name" ? "name" : "installs";
  const found = query.trim() ? matchMarketplace(snapshot, query) : snapshot;
  const hits =
    query.trim() && !sort ? found : sortMarketplace(found, key);
  const resolve = installResolver();
  return hits.slice(offset, offset + cfg.registryPageSize).map((r) => {
    const uid = `${src.id}|${r.repo}|${r.path}`;
    return {
      uid,
      // Their own page: it shows the description, the install count and a link
      // on to the repo. The exact folder is not known until install.
      url: `https://claudemarketplaces.com/skills/${r.id}`,
      // Empty: the folder is resolved at install, like any registry card.
      path: "",
      source: src.id,
      kind: "registry" as const,
      repository: r.repo,
      hint: r.path,
      name: r.name,
      description: usefulDescription(r.description, r.name),
      installs: r.installs,
      stars: r.stars,
      ...resolve(uid, r.name),
    } satisfies StoreSkill;
  });
}

async function listRegistrySource(
  src: Extract<SkillSource, { kind: "registry" }>,
  query: string,
  offset: number,
  category?: string,
  sort?: RegistrySort,
): Promise<StoreSkill[]> {
  const cfg = await directoryConfig();
  const page = await listRegistry({
    query,
    category,
    offset,
    limit: cfg.registryPageSize,
    // No install counts in this registry — only the repo's stars.
    sort: sort === "stars" ? "stars" : undefined,
  });
  const resolve = installResolver();
  return capPerRepo(page, cfg.maxPerRepo).map((r) => ({
    // Includes the repository: two registry entries can share a name, and the
    // path cannot be part of the identity because it is not known until install.
    uid: `${src.id}|${r.repository}|${r.name}`,
    // Their skill page — the folder inside the repo is unknown until install, so
    // the repo root would be the only alternative and says much less.
    url: r.slug
      ? `https://www.skillsdirectory.com/skills/${r.slug}`
      : `https://github.com/${r.repository}`,
    // The registry never says WHERE in the repo the skill is — resolved at
    // install against the repo's tree, so there is nothing to put here.
    path: "",
    source: src.id,
    kind: "registry" as const,
    repository: r.repository,
    name: r.name,
    description: usefulDescription(r.description, r.name),
    stars: r.stars,
    category: r.category,
    ...resolve(`${src.id}|${r.repository}|${r.name}`, r.name),
  }));
}

/** Sort keys a REGISTRY can honour. A github source has neither figure, so it
 * is unaffected and keeps its own order. */
export type RegistrySort = "installs" | "stars" | "name";

function listOne(
  src: SkillSource,
  query: string,
  offset: number,
  category?: string,
  sort?: RegistrySort,
): Promise<StoreSkill[]> {
  if (src.kind === "github") return listGithub(src);
  return src.format === "claudemarketplaces-v1"
    ? listMarketplaceSource(src, query, offset, sort)
    : listRegistrySource(src, query, offset, category, sort);
}

/** Every source, merged. One unreachable repo must not blank the whole
 * Directory, so failures come back as `errors` alongside whatever loaded. */
async function listAll(
  sources: SkillSource[],
  query = "",
  offset = 0,
  category?: string,
  sort?: RegistrySort,
): Promise<{ skills: StoreSkill[]; errors: string[] }> {
  const results = await Promise.allSettled(
    sources.map((s) => listOne(s, query, offset, category, sort)),
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
  uid?: string,
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
    // Remember which card this folder came from, so the next listing can tell
    // two same-named skills from different sources apart.
    if (uid) recordOrigin(slug, uid);
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
  /**
   * Read a skill BEFORE installing it.
   *
   * A skill is instructions the model will follow, fetched from a stranger's
   * repository. Sending the user to github.com to read it was better than
   * nothing; showing it here means they can actually read it in the moment they
   * are deciding.
   *
   * For a registry card the folder is not known yet, so this resolves it the
   * same way an install would — which also means the preview fails exactly where
   * the install would fail, and says so, instead of the user finding out after.
   */
  ipcMain.handle(
    "skillstore:preview",
    async (
      _e,
      payload: {
        source: string;
        path: string;
        kind?: SourceKind;
        repository?: string;
        hint?: string;
        name?: string;
        /** Show this folder instead of the resolved one — the agent picker. */
        dir?: string;
      },
    ): Promise<{
      ok: boolean;
      repo?: string;
      dir?: string;
      /**
       * Every folder in the repo holding a skill of this name, best-first, each
       * with the agent it belongs to. Present only when there is a choice.
       *
       * The label comes from here rather than a copy of the agent list in the
       * renderer: one source of truth, and the catalogue can add to it.
       */
      variants?: { dir: string; agent: string; label: string }[];
      files?: string[];
      content?: string;
      texts?: Record<string, string>;
      audit?: AuditResult;
      url?: string;
      error?: string;
      candidates?: string[];
    }> => {
      try {
        let repo = payload.source;
        let dir = payload.path;
        let variants: { dir: string; agent: string; label: string }[] | undefined;
        if (payload.kind === "registry") {
          if (!payload.repository)
            return { ok: false, error: "That entry has no repository." };
          repo = payload.repository;
          // Names the folders a published agent uses, so a variant reads as
          // "Trae CN" rather than ".trae-cn". Cached for a day and never fatal.
          await loadAgentFolders();
          const paths = await fetchTree(repo);
          const dirs = paths
            .filter((p) => p.endsWith("/SKILL.md"))
            .map((p) => p.slice(0, -"/SKILL.md".length));
          const pick = payload.hint
            ? (() => {
                const byHint = pickSkillDir(dirs, payload.hint!);
                return byHint.ok ? byHint : pickSkillDir(dirs, payload.name ?? "");
              })()
            : pickSkillDir(dirs, payload.name ?? "");
          if (!pick.ok)
            return { ok: false, error: pick.error, candidates: pick.candidates };
          variants = pick.variants?.map((d) => {
            const a = agentOfPath(d);
            // A neutral folder is named by its root, so two of them are still
            // told apart: `skills/x` and `plugin/skills/x`.
            const root = d.split("/")[0] ?? d;
            return {
              dir: d,
              agent: a?.id ?? `dir:${root}`,
              label: a?.label ?? root,
            };
          });
          // The user's pick wins over the resolver's, but only if the repo has it.
          dir =
            payload.dir && dirs.includes(payload.dir) ? payload.dir : pick.dir;
        } else {
          repo = parseSource(payload.source).repo;
        }
        const paths = await fetchTree(repo);
        const files = paths
          .filter((p) => p === `${dir}/SKILL.md` || p.startsWith(`${dir}/`))
          .map((p) => p.slice(dir.length + 1))
          .sort();
        const content = await fetchRaw(repo, `${dir}/SKILL.md`);
        if (content == null)
          return { ok: false, error: `Could not read ${dir}/SKILL.md.` };

        // Audit the SCRIPTS too, not just SKILL.md: `curl | bash` lives in
        // scripts/install.sh far more often than in the prose. Capped, and
        // binaries are named rather than downloaded.
        const auditable = files.filter(isAuditableFile).slice(0, AUDIT_FILES);
        const skipped = files.filter((f) => !auditable.includes(f));
        const texts: Record<string, string> = { "SKILL.md": content };
        await Promise.all(
          auditable
            .filter((f) => f !== "SKILL.md")
            .map(async (f) => {
              const t = await fetchRaw(repo, `${dir}/${f}`);
              if (t != null) texts[f] = t;
            }),
        );
        return {
          ok: true,
          repo,
          dir,
          // Only when there is an actual choice — one folder is not a variant.
          variants: variants && variants.length > 1 ? variants : undefined,
          files,
          content,
          texts,
          audit: auditSkill(texts, skipped, (await fetchAuditRules()).rules),
          url: `https://github.com/${repo}/tree/HEAD/${dir}`,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "preview failed",
        };
      }
    },
  );

  /**
   * Every source, in one list.
   *
   * The community catalog used to be a separate "Suggested sources" row the user
   * added from. Two concepts for one thing: a source you have and a source you
   * could have. Now a catalog entry simply appears among the switches, on by
   * default, and switching it off is recorded like any other. Adding one for
   * everybody is still a JSON edit and a push.
   *
   * The user's stored decision always wins — a curated source switched off stays
   * off, or the switch would flip itself back on at every launch.
   */
  ipcMain.handle(
    "skillstore:sources",
    async (): Promise<SkillSource[]> => allSources(),
  );

  // The filter's starting list. Seeded from the directory's own categories
  // page; the UI unions in whatever it actually sees.
  ipcMain.handle(
    "skillstore:categories",
    async (): Promise<string[]> => (await directoryConfig()).skillCategories,
  );
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
      opts?: {
        query?: string;
        offset?: number;
        category?: string;
        sort?: RegistrySort;
      },
    ): Promise<{
      ok: boolean;
      skills?: StoreSkill[];
      errors?: string[];
      error?: string;
    }> => {
      try {
        const { skills, errors } = await listAll(
          getSources().filter((s) => s.enabled),
          opts?.query ?? "",
          opts?.offset ?? 0,
          opts?.category || undefined,
          opts?.sort,
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
        uid?: string;
        kind?: SourceKind;
        repository?: string;
        hint?: string;
        name?: string;
        /**
         * The folder the user picked in the preview, when a repo ships one copy
         * per agent. Checked against the repo's own tree below — a path from the
         * renderer decides what gets downloaded, so it is not taken on trust.
         */
        dir?: string;
      },
    ) => {
      if (payload.kind !== "registry")
        return installSkill(payload.source, payload.path, payload.uid);
      if (!payload.repository)
        return { ok: false, error: "That directory entry has no repository." };
      const paths = await fetchTree(payload.repository);
      const dirs = paths
        .filter((p) => p.endsWith("/SKILL.md"))
        .map((p) => p.slice(0, -"/SKILL.md".length));
      if (payload.dir) {
        if (!dirs.includes(payload.dir))
          return { ok: false, error: "That folder is not in this repository." };
        return installSkill(payload.repository, payload.dir, payload.uid);
      }
      // The hint first — a folder basename beats a display name. Falling back to
      // the name covers skillsdirectory, which publishes nothing better.
      const pick = payload.hint
        ? (() => {
            const byHint = pickSkillDir(dirs, payload.hint!);
            return byHint.ok ? byHint : pickSkillDir(dirs, payload.name ?? "");
          })()
        : pickSkillDir(dirs, payload.name ?? "");
      if (!pick.ok)
        return { ok: false, error: pick.error, candidates: pick.candidates };
      return installSkill(payload.repository, pick.dir, payload.uid);
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
      payload: {
        query?: string;
        offset?: number;
        category?: string;
        sort?: RegistrySort;
      },
    ): Promise<{ ok: boolean; skills?: StoreSkill[]; error?: string }> => {
      try {
        const regs = getSources().filter(
          (s): s is Extract<SkillSource, { kind: "registry" }> =>
            s.kind === "registry" && s.enabled,
        );
        if (regs.length === 0) return { ok: true, skills: [] };
        const pages = await Promise.all(
          regs.map((r) =>
            listRegistrySource(
              r,
              payload?.query ?? "",
              payload?.offset ?? 0,
              payload?.category || undefined,
              payload?.sort,
            ),
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
