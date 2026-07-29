/**
 * The catalog of SUGGESTED skill sources, published in the community repo.
 *
 * Same idea as the connector store (see connectors/store-catalog.ts) and the
 * same repo: adding a source for everyone is an edit to a JSON file and a push,
 * not an app release. Nothing here is executed — it is a list of places to look
 * for skills, and installing from one still goes through the ordinary
 * download-and-inspect path.
 *
 * Repo layout (github.com/iaa2005/monet-directory):
 *   skill-sources.json — an array of the entries below
 *
 * A missing or malformed file is not an error worth surfacing: the Directory
 * simply has nothing to suggest, and the user's own sources are unaffected.
 */

import { fetchRetry } from "./net-fetch.js";

const CATALOG_URL =
  "https://raw.githubusercontent.com/iaa2005/monet-directory/main/skill-sources.json";

const CACHE_MS = 30 * 60_000;

export interface SuggestedSource {
  id: string;
  kind: "github" | "registry";
  name: string;
  description?: string;
  /** github only. */
  repo?: string;
  /** registry only. */
  api?: string;
  homepage?: string;
}

let cache: { at: number; list: SuggestedSource[] } | null = null;

/** Keep only rows that are complete enough to be added as a source — a github
 * entry needs its repo, a registry entry an api we understand. Anything else
 * would produce a chip that cannot list. */
export function parseCatalog(raw: unknown): SuggestedSource[] {
  if (!Array.isArray(raw)) return [];
  const out: SuggestedSource[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const e = r as Record<string, unknown>;
    const kind = e.kind === "registry" ? "registry" : "github";
    const id = typeof e.id === "string" ? e.id : "";
    const name = typeof e.name === "string" ? e.name : id;
    if (!id || !name) continue;
    if (kind === "github") {
      const repo = typeof e.repo === "string" ? e.repo : "";
      if (repo.split("/").length < 2) continue;
      out.push({
        id,
        kind,
        name,
        repo,
        description: typeof e.description === "string" ? e.description : undefined,
        homepage: typeof e.homepage === "string" ? e.homepage : undefined,
      });
    } else {
      const api = typeof e.api === "string" ? e.api : "";
      if (!/^https:\/\//.test(api)) continue;
      out.push({
        id,
        kind,
        name,
        api,
        description: typeof e.description === "string" ? e.description : undefined,
        homepage: typeof e.homepage === "string" ? e.homepage : undefined,
      });
    }
  }
  // First win on a duplicate id — the file's own order is the curator's.
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(s.id) && seen.add(s.id));
}

export async function fetchSuggestedSources(
  force = false,
): Promise<SuggestedSource[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  try {
    const res = await fetchRetry(CATALOG_URL, {
      headers: { "User-Agent": "monet-desktop" },
    });
    if (!res.ok) throw new Error(String(res.status));
    const list = parseCatalog(await res.json());
    cache = { at: Date.now(), list };
    return list;
  } catch {
    // No catalog is a normal state — the file may not exist yet. Serve a stale
    // copy if there is one rather than blanking the suggestions on a blip.
    return cache?.list ?? [];
  }
}
