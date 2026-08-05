/**
 * Directory tuning that lives in the catalog repo, not in this code.
 *
 * The rule: anything that can change WITHOUT a code change belongs in
 * monet-directory. Upstream taxonomies and page sizes are facts about someone
 * else's service — they move when that service moves, and shipping an app
 * release to follow is the wrong shape.
 *
 * What deliberately does NOT move:
 *   - the registry FORMAT list. A value there is a promise that a parser exists;
 *     adding one in a JSON file would produce a source that fails on its first
 *     search. Data cannot grant a capability.
 *   - the built-in source definitions. They are duplicated here on purpose so
 *     the Directory works on a first run, offline, and when the catalog is
 *     unreachable — that is a fallback, not an un-migrated leftover.
 *
 * Every value has a local default, so a missing or malformed config file is a
 * normal state rather than a broken Directory.
 */

import { fetchRetry } from "../net-fetch.js";

const CONFIG_URL =
  "https://raw.githubusercontent.com/iaa2005/monet-directory/main/directory-config.json";

const CACHE_MS = 30 * 60_000;

export interface DirectoryConfig {
  /**
   * Seed list for the skills category filter. Read off skillsdirectory.com's
   * own /categories page — they publish no API for it (both /api/categories and
   * /api/registry/categories are 404), so it is transcribed, and transcriptions
   * go stale. Categories actually seen in results are unioned in on top.
   */
  skillCategories: string[];
  /** Rows per registry request. skillsdirectory caps at 100; asking for more is
   * silently clamped, so this is their limit, not a preference. */
  registryPageSize: number;
  /**
   * Cap per repository on one page. Without it a single publisher owns the view:
   * skillsdirectory sorted by stars returns three consecutive affaan-m/ECC
   * skills, each reporting the repo's 193 429 stars.
   */
  maxPerRepo: number;
}

/** What ships in the binary. Also the answer when the network is not there. */
export const DEFAULT_CONFIG: DirectoryConfig = {
  skillCategories: [
    "ai-agents",
    "blockchain",
    "business",
    "code-quality",
    "content-marketing",
    "data",
    "databases",
    "design",
    "development",
    "devops",
    "documentation",
    "education",
    "research",
    "security",
    "testing",
    "tools",
  ],
  registryPageSize: 100,
  maxPerRepo: 3,
};

/**
 * Merge a fetched config over the defaults, field by field.
 *
 * Field-by-field rather than wholesale: a config that sets only
 * `skillCategories` must not blank the page size. And every value is bounded —
 * this file is edited by hand and fetched over the network, so a `0` or a
 * `100000` in it would otherwise become an empty Directory or a download nobody
 * asked for.
 */
export function mergeConfig(raw: unknown): DirectoryConfig {
  const out: DirectoryConfig = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const e = raw as Record<string, unknown>;

  if (Array.isArray(e.skillCategories)) {
    const slugs = e.skillCategories
      .filter((c): c is string => typeof c === "string")
      .map((c) => c.trim().toLowerCase())
      .filter((c) => /^[a-z0-9][a-z0-9-]*$/.test(c));
    // An empty list would silently remove the filter; keep the defaults then.
    if (slugs.length) out.skillCategories = [...new Set(slugs)].sort();
  }
  if (typeof e.registryPageSize === "number")
    out.registryPageSize = Math.min(Math.max(Math.trunc(e.registryPageSize), 1), 100);
  if (typeof e.maxPerRepo === "number")
    out.maxPerRepo = Math.min(Math.max(Math.trunc(e.maxPerRepo), 1), 50);
  return out;
}

let cache: { at: number; cfg: DirectoryConfig } | null = null;

export async function directoryConfig(force = false): Promise<DirectoryConfig> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.cfg;
  try {
    const res = await fetchRetry(CONFIG_URL, {
      headers: { "User-Agent": "monet-desktop" },
    });
    if (!res.ok) throw new Error(String(res.status));
    const cfg = mergeConfig(await res.json());
    cache = { at: Date.now(), cfg };
    return cfg;
  } catch {
    // Serve a stale copy over a blip; otherwise the built-in defaults.
    return cache?.cfg ?? DEFAULT_CONFIG;
  }
}

/** Synchronous view for code paths that cannot await — the last fetched config,
 * or the defaults before the first fetch lands. */
export function directoryConfigNow(): DirectoryConfig {
  return cache?.cfg ?? DEFAULT_CONFIG;
}
