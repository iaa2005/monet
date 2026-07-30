/**
 * claudemarketplaces.com as a skill source.
 *
 * Same shape of thing as skillsdirectory — an index of GitHub repos — but the
 * opposite fetch strategy, forced by their API:
 *
 *   - it returns the WHOLE list on every call: 23 472 entries, 12.7 MB. Every
 *     paging and search parameter is ignored (limit, q, search, page, offset all
 *     measured against the live endpoint: same 12.7 MB, same 23 472 rows). So
 *     the snapshot is fetched once, trimmed, cached, and searched locally.
 *   - it carries `path` — where in the repo the skill actually lives. That is
 *     the thing skillsdirectory does not give, and it means an install here is
 *     exact: no resolving a display name against a repo's tree, and no refusing
 *     when several folders match.
 *
 * No categories: the field does not exist in their data, so the Directory's
 * category filter does not apply to this source.
 */

import { fetchRetry } from "./net-fetch.js";

const API = "https://claudemarketplaces.com/api/skills";

/** The response is 12.7 MB and changes slowly — a listing of published repos,
 * not a live feed. Long enough that browsing costs one download per session. */
const CACHE_MS = 6 * 60 * 60_000;

export interface MarketplaceSkill {
  /** `owner/repo/path` — already unique in their data. */
  id: string;
  name: string;
  description: string;
  /** `owner/repo` where the files are. */
  repo: string;
  /** Path INSIDE the repo. Present on every row, so installs need no guessing. */
  path: string;
  stars?: number;
  installs?: number;
}

let cache: { at: number; list: MarketplaceSkill[] } | null = null;
let inFlight: Promise<MarketplaceSkill[]> | null = null;

/** Keep only what a card needs. The raw rows carry installCommand, repoSlug,
 * timestamps and flags — holding 23 472 of those in memory for the life of the
 * process buys nothing. */
function trim(raw: unknown): MarketplaceSkill[] {
  if (!Array.isArray(raw)) return [];
  const out: MarketplaceSkill[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const e = r as Record<string, unknown>;
    const repo = typeof e.repo === "string" ? e.repo : "";
    const path = typeof e.path === "string" ? e.path : "";
    // Both are required: without them there is nothing to download.
    if (!repo.includes("/") || !path) continue;
    out.push({
      id: typeof e.id === "string" && e.id ? e.id : `${repo}/${path}`,
      name: typeof e.name === "string" && e.name ? e.name : path.split("/").pop()!,
      description:
        typeof e.description === "string" ? e.description.slice(0, 400) : "",
      repo,
      path,
      stars: typeof e.stars === "number" ? e.stars : undefined,
      installs: typeof e.installs === "number" ? e.installs : undefined,
    });
  }
  return out;
}

/** The snapshot. Concurrent callers share one download — the Directory opens
 * with a listing request and a suggestions request, and 12.7 MB twice would be
 * a self-inflicted wound. */
export async function marketplaceSnapshot(
  force = false,
): Promise<MarketplaceSkill[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetchRetry(API, {
        headers: { "User-Agent": "monet-desktop" },
      });
      if (!res.ok)
        throw new Error(`claudemarketplaces.com returned ${res.status}.`);
      const list = trim(await res.json());
      cache = { at: Date.now(), list };
      return list;
    } catch (err) {
      // A stale snapshot beats an empty Directory; only a first failure is fatal.
      if (cache) return cache.list;
      throw err;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Word-wise match over name and description — every term must appear
 * somewhere, so "git commit" does not return everything about git. */
export function matchMarketplace(
  list: MarketplaceSkill[],
  query: string,
): MarketplaceSkill[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return list;
  return list.filter((s) => {
    const hay = `${s.name} ${s.description} ${s.repo}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * Most-installed first when browsing.
 *
 * Unlike skillsdirectory's star counts — which are the REPO's, repeated on
 * every skill in it — `installs` is per skill, so it actually ranks skills.
 */
export function sortMarketplace(list: MarketplaceSkill[]): MarketplaceSkill[] {
  return [...list].sort(
    (a, b) => (b.installs ?? 0) - (a.installs ?? 0) || a.name.localeCompare(b.name),
  );
}
