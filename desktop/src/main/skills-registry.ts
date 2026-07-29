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

/** Strip everything that differs between a display name and a folder name:
 * "Competitor Analysis" and "competitor-analysis" must compare equal. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type PickResult =
  | { ok: true; dir: string }
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
 */
export function pickSkillDir(dirs: string[], name: string): PickResult {
  if (dirs.length === 0)
    return { ok: false, error: "That repository has no SKILL.md anywhere." };

  const want = normalizeName(name);
  const exact = dirs.filter(
    (d) => normalizeName(d.split("/").pop() ?? d) === want,
  );
  if (exact.length === 1) return { ok: true, dir: exact[0]! };
  if (exact.length > 1)
    return {
      ok: false,
      error: `"${name}" matches ${exact.length} folders in that repository.`,
      candidates: exact,
    };

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

/** One page of registry results. Errors are thrown with a message meant for
 * the user — the Directory shows it next to the search box. */
export async function searchRegistry(
  query: string,
  limit = 30,
): Promise<RegistrySkill[]> {
  const url = new URL(BASE);
  if (query.trim()) url.searchParams.set("q", query.trim());
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 100)));
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
