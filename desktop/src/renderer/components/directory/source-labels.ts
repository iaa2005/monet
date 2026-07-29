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
  if (s.kind === "registry") return s.name ?? s.id;
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
