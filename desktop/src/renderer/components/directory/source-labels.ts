/**
 * What to write on a source chip.
 *
 * The rule was `id.split("/")[1]` — the middle segment of `owner/repo[/sub]`.
 * That produced a row of chips reading "monet-directory", "skills", "Skills
 * Directory", which is why they looked like they had no logic: "skills" is
 * `anthropics/skills` with the owner thrown away, and
 * `iaa2005/monet-directory/skills` lost its subfolder, so two different
 * sources could show the same word.
 *
 * A chip has to answer "whose, and which part of it" in the space of a chip:
 *   iaa2005/monet-directory/skills → monet-directory/skills
 *   anthropics/skills              → skills
 *   skillsdirectory (a registry)   → Skills Directory
 *
 * and where two would collide, the owner comes back to separate them:
 *   anthropics/skills + foo/skills → anthropics/skills, foo/skills
 */

export interface LabelableSource {
  kind: "github" | "registry";
  id: string;
  repo?: string;
  sub?: string;
  name?: string;
}

/** The chip text before collisions are considered. */
function short(s: LabelableSource): string {
  if (s.name) return s.name;
  if (s.kind === "registry") return s.id;
  const repo = s.repo?.split("/")[1] ?? s.id;
  return [repo, s.sub].filter(Boolean).join("/");
}

/** Source id → chip label. */
export function sourceChipLabels(
  sources: LabelableSource[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const s of sources) {
    const k = short(s);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const s of sources) {
    const k = short(s);
    // Only a github source can be disambiguated by owner; two registries with
    // the same display name would need the catalog fixed, not the label.
    out.set(
      s.id,
      (counts.get(k) ?? 0) > 1 && s.kind === "github"
        ? [s.id.split("/")[0], k].join("/")
        : k,
    );
  }
  return out;
}

/**
 * Which curated suggestions are still on offer.
 *
 * The catalog rows carry an `added` flag, but it is a snapshot from when they
 * were fetched: removing a source left it absent from the suggestions until the
 * page was re-entered. Deriving it from the live source list is correct with no
 * refetch, and matches on the repo too — a catalog id is kebab-case
 * ("anthropic-skills") while a configured github source is `owner/repo`.
 */
export function offeredSuggestions<
  S extends { id: string; repo?: string },
  T extends { id: string; repo?: string },
>(suggested: T[], sources: S[]): T[] {
  const have = new Set(sources.flatMap((s) => [s.id, s.repo ?? ""]));
  return suggested.filter((x) => !have.has(x.id) && !have.has(x.repo ?? ""));
}

/**
 * `owner/repo[/sub]` → `owner`, for the avatar at github.com/<owner>.png.
 *
 * Returns "" for anything that is not a GitHub login. A registry card falls
 * back to its SOURCE id when it has no repository, and "claudemarketplaces" is
 * not an owner — asking GitHub for its avatar is a guaranteed 404 and a torn
 * image in the grid.
 */
export function ownerOf(repoOrId: string | undefined): string {
  const first = (repoOrId ?? "").split("/")[0]?.trim() ?? "";
  // GitHub logins are alphanumeric with hyphens, and never start with one.
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(first) ? first : "";
}

/**
 * The owner whose avatar to show, or "" when there is nobody to show.
 *
 * `ownerOf` cannot tell a login from a registry id, and it should not pretend to:
 * `claudemarketplaces` is a perfectly valid-looking login and a guaranteed 404.
 * What separates them is the slash — a card's provenance is `owner/repo`, a
 * registry id is one word. So the question "is there an avatar for this" belongs
 * here rather than being asked slightly differently at each call site.
 */
export function avatarOwner(repoOrSource: string | undefined): string {
  return (repoOrSource ?? "").includes("/") ? ownerOf(repoOrSource) : "";
}
