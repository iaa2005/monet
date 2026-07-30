/**
 * skillsdirectory.com as a skill source.
 *
 * It is an INDEX, not a host — despite the name, nothing is stored on their
 * server. Every entry carries `repository` in `owner/repo` form and the files
 * live on GitHub, so installing goes through the same download path as a
 * hand-added repo. That is the whole reason this is small.
 *
 * What the API does NOT give is where inside the repo the skill lives. A single
 * repo routinely holds twenty of them (aaron-he-zhu/seo-geo-claude-skills has
 * exactly that), and neither the list nor the detail endpoint carries a path.
 * So the folder is resolved against the repo's own tree — see pickSkillDir,
 * which is where the guessing is contained and tested.
 *
 * Nearly 97 000 entries, so this is a SEARCH source: listing it wholesale is
 * not a thing anyone wants, and the Directory queries it by keyword instead.
 */

import { bestFirst, ties } from "./agent-folders.js";

const BASE = "https://www.skillsdirectory.com/api/registry";
const UA = { "User-Agent": "monet-desktop" };

export interface RegistrySkill {
  name: string;
  /** The registry's own id — `<author>-<skill>`, not a repo path. */
  slug: string;
  description: string;
  /** `owner/repo` — where the files actually are. */
  repository: string;
  category?: string;
  author?: string;
  stars?: number;
  verified?: boolean;
  tags?: string[];
}

/**
 * Their list API often sets `description` to the skill's own name — 19 `docx`
 * entries and most of them say "docx". A card reading `/docx` above the word
 * `docx` is worse than one with no description: it takes the space where the
 * useful line would be and says nothing. Their site shows a real summary, but
 * there is no API for it (every /api/skills/<id> shape returns 404).
 */
export function usefulDescription(desc: string, name: string): string {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm(desc) === norm(name) ? "" : desc;
}

/** Strip everything that differs between a display name and a folder name:
 * "Competitor Analysis" and "competitor-analysis" must compare equal. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Words, for comparing a name against a folder a token at a time. */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** How many tokens of prefix one name may carry over the other. */
const MAX_PREFIX = 2;

/**
 * How many tokens of prefix separate `cand` from `want`, or null if they are not
 * the same name at all. 0 never happens here — that is an exact match.
 *
 * Reported: `vercel-react-best-practices` matched none of the nine folders in
 * vercel-labs/agent-skills, whose skill is at `skills/react-best-practices` —
 * the catalogue prefixes the name with the vendor and the repository does not.
 * The reverse happens too: the same catalogue lists a `react-best-practices`
 * whose folder in another repo IS called `vercel-react-best-practices`.
 *
 * Both directions, and deliberately tight, because matching too eagerly installs
 * the WRONG skill. Whole tokens only, at least two of them, and at most two
 * tokens of difference. That is what keeps `vercel-cli-with-tokens` from being
 * answered by a folder called `tokens`.
 */
function prefixDistance(want: string, cand: string): number | null {
  const w = tokens(want);
  const c = tokens(cand);
  const [long, short] = w.length >= c.length ? [w, c] : [c, w];
  const extra = long.length - short.length;
  if (short.length < 2 || extra === 0 || extra > MAX_PREFIX) return null;
  return long.slice(extra).join("-") === short.join("-") ? extra : null;
}

export type PickResult =
  | {
      ok: true;
      dir: string;
      /**
       * The other folders holding a skill of this name, best-first, when the repo
       * ships one copy per agent. The picked `dir` is the first of them.
       *
       * Carried so the preview can say which variant it is about to install and
       * offer the rest — with fifteen copies in pbakaus/impeccable, silently
       * taking one and saying nothing would be the wrong kind of quiet.
       */
      variants?: string[];
    }
  | { ok: false; error: string; candidates?: string[] };

/**
 * Which folder in the repo is this registry entry?
 *
 * `dirs` are the repo's skill folders (every directory holding a SKILL.md).
 * Matching is on the folder's BASENAME, because the registry name describes the
 * skill, not its place in the tree: "Competitor Analysis" lives at
 * `research/competitor-analysis`.
 *
 * A repo with exactly one skill needs no match at all — that is the common
 * shape for a single-skill repo whose folder is named after the project rather
 * than the skill.
 *
 * Ambiguity is reported, never guessed: two folders with the same basename in
 * different parents are a real possibility, and installing the wrong one puts
 * unexpected instructions in front of the model.
 *
 * But most of what LOOKED ambiguous was not. Reported from the app: `impeccable`
 * matched fifteen folders and `microsoft-foundry` two, and neither was a
 * genuine question — the fifteen are one copy per agent, and the two are
 * byte-identical. Both are settled by preferring our own folder, then a neutral
 * one, then another agent's; see agent-folders.ts, where that order is measured
 * rather than assumed. A tie between two neutral folders at the same depth is
 * still a real question and still reported.
 */
export function pickSkillDir(dirs: string[], name: string): PickResult {
  if (dirs.length === 0)
    return { ok: false, error: "That repository has no SKILL.md anywhere." };

  const base = (d: string): string => d.split("/").pop() ?? d;
  const want = normalizeName(name);

  /** Rank a matched set, or report it when the choice is genuinely arbitrary. */
  const settle = (found: string[]): PickResult | null => {
    const ranked = bestFirst(found);
    if (ranked.length === 0) return null;
    if (ranked.length === 1) return { ok: true, dir: ranked[0]! };
    if (ties(ranked[0]!, ranked[1]!))
      return {
        ok: false,
        error: `"${name}" matches ${ranked.length} folders in that repository.`,
        candidates: ranked,
      };
    return { ok: true, dir: ranked[0]!, variants: ranked };
  };

  const exact = settle(dirs.filter((d) => normalizeName(base(d)) === want));
  if (exact) return exact;

  // The catalogue's name may carry a vendor prefix the repository does not —
  // `vercel-react-best-practices` for a folder called `react-best-practices` —
  // or the other way round. Tried only after an exact match fails.
  //
  // Nearest wins: with both `best-practices` and `react-best-practices` in the
  // repo, the one that leaves less of the name unaccounted for is not a guess
  // between equals, so it is taken rather than reported as ambiguous.
  const near = dirs
    .map((d) => ({ d, at: prefixDistance(name, base(d)) }))
    .filter((x): x is { d: string; at: number } => x.at !== null);
  if (near.length) {
    const best = Math.min(...near.map((x) => x.at));
    const nearly = settle(near.filter((x) => x.at === best).map((x) => x.d));
    if (nearly) return nearly;
  }

  // No name match. One skill in the repo is unambiguous regardless of naming.
  if (dirs.length === 1) return { ok: true, dir: dirs[0]! };

  // Last resort before giving up: the whole path, for entries named after a
  // nested location ("build/meta-tags-optimizer").
  const byPath = dirs.filter((d) => normalizeName(d) === want);
  if (byPath.length === 1) return { ok: true, dir: byPath[0]! };

  return {
    ok: false,
    error: `Could not tell which of the ${dirs.length} skills in that repository "${name}" is.`,
    candidates: dirs.slice(0, 20),
  };
}

/**
 * At most `n` entries per repository.
 *
 * Without this one repo owns the page. `sort=stars` is the worst case — the
 * top three results are all `affaan-m/ECC`, which reports 193 429 stars for
 * every one of its skills, because the figure is the REPO's stars and says
 * nothing about the skill. `recent` behaves, but a prolific publisher would
 * still crowd out everyone else.
 */
export function capPerRepo<T extends { repository: string }>(
  list: T[],
  n: number,
): T[] {
  const seen = new Map<string, number>();
  const out: T[] = [];
  for (const s of list) {
    const c = seen.get(s.repository) ?? 0;
    if (c >= n) continue;
    seen.set(s.repository, c + 1);
    out.push(s);
  }
  return out;
}

/**
 * One page of the registry — searched when there is a query, browsed when
 * there isn't.
 *
 * Default sort is `recent`, not the API's own `votes`. Checked against the
 * live endpoint: `votes` puts a 0-star `ucoz-landing-skill` first because
 * almost nothing has votes, so the order is effectively arbitrary; `stars`
 * clumps by repo. `recent` returns genuinely different, current entries.
 */
export async function listRegistry(opts: {
  query?: string;
  category?: string;
  limit?: number;
  offset?: number;
  sort?: "recent" | "votes" | "stars";
}): Promise<RegistrySkill[]> {
  const query = opts.query?.trim() ?? "";
  const url = new URL(BASE);
  if (query) url.searchParams.set("q", query);
  // Server-side: `development` alone matches 22 389 entries, so filtering the
  // hundred already fetched would be filtering the wrong hundred.
  if (opts.category) url.searchParams.set("category", opts.category);
  // A query orders by relevance on their side; browsing needs an explicit one.
  // `votes` (their default) is effectively unordered — almost nothing has votes,
  // so a 0-star entry comes first. `stars` is offered because the user can ask
  // for it, with the per-repo cap doing the work of keeping one project from
  // owning the page.
  else url.searchParams.set("sort", opts.sort ?? "recent");
  if (opts.offset) url.searchParams.set("offset", String(opts.offset));
  url.searchParams.set(
    "limit",
    String(Math.min(Math.max(opts.limit ?? 30, 1), 100)),
  );
  return fetchPage(url);
}

/** One page of registry results. Errors are thrown with a message meant for
 * the user — the Directory shows it next to the search box. */
export async function searchRegistry(
  query: string,
  limit = 30,
): Promise<RegistrySkill[]> {
  const url = new URL(BASE);
  if (query.trim()) url.searchParams.set("q", query.trim());
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 100)));
  return fetchPage(url);
}

async function fetchPage(url: URL): Promise<RegistrySkill[]> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok)
    throw new Error(
      res.status === 429
        ? "skillsdirectory.com is rate-limiting — try again in a minute."
        : `skillsdirectory.com returned ${res.status}.`,
    );
  const json = (await res.json()) as { skills?: unknown[] };
  return (json.skills ?? [])
    .filter(
      (s): s is Record<string, unknown> => !!s && typeof s === "object",
    )
    // An entry with no repository cannot be installed — the files are on
    // GitHub and nothing else says where.
    .filter((s) => typeof s.repository === "string" && s.repository.includes("/"))
    .map((s) => ({
      name: String(s.name ?? s.slug ?? "Untitled"),
      slug: String(s.slug ?? ""),
      description: String(s.description ?? "").slice(0, 400),
      repository: String(s.repository),
      category: typeof s.category === "string" ? s.category : undefined,
      author: typeof s.author === "string" ? s.author : undefined,
      stars: typeof s.stars === "number" ? s.stars : undefined,
      verified: s.verified === true,
      tags: Array.isArray(s.tags) ? s.tags.map(String).slice(0, 6) : undefined,
    }));
}
