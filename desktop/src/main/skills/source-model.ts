/**
 * The skill-source model: what a source is, and the two rules about it.
 *
 * 1. A source is ON or OFF. Off means not listed and not fetched — that is the
 *    entire interaction the chips offer. It replaced a "filter the grid by
 *    source" reading of the same row, which nothing explained and which shared
 *    its space with a delete button.
 * 2. What ships with the app can be switched off but never removed. A user who
 *    deleted one would have no way back short of typing its id, which is why
 *    sources appeared to come and go.
 *
 * Dependency-free on purpose: this is the part worth testing, and skill-store.ts
 * pulls in electron and the vendor tree.
 */

/** Normalize a user-typed source: accepts a full GitHub URL or `owner/repo`. */
export function normalizeSource(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/tree\/[^/]+\//, "/") // .../tree/main/subdir → .../subdir
    .replace(/^\/+|\/+$/g, "");
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
type SourceCommon = {
  id: string;
  /** Display name on the source chip. When absent the label is derived from the
   * id — `repo/sub` for GitHub sources, the registry's own name otherwise. */
  name?: string;
  /** Off means not listed and not fetched — the simple switch the chips are. */
  enabled: boolean;
  /** Ships with the app. Can be switched off, never deleted: removing it would
   * leave the user with no way to get it back short of typing the id. */
  builtin: boolean;
};

/**
 * Which registry dialect a source speaks. A URL is not enough: the two differ
 * in the response schema AND in the fetch strategy, so the code has to know
 * which it is talking to.
 *
 *   skillsdirectory-v1  — 96 920 entries, server-side search and paging, but no
 *                         path inside the repo, so installs resolve by name.
 *   claudemarketplaces-v1 — 23 472 entries returned WHOLE (12.7 MB, every paging
 *                         parameter ignored), searched locally, and carrying the
 *                         path, so installs are exact.
 */
export type RegistryFormat = "skillsdirectory-v1" | "claudemarketplaces-v1";

export type SkillSource =
  | ({ kind: "github"; repo: string; sub: string } & SourceCommon)
  | ({
      kind: "registry";
      api: string;
      name: string;
      format: RegistryFormat;
      homepage?: string;
    } & SourceCommon);

const SKILLSDIRECTORY: Extract<SkillSource, { kind: "registry" }> = {
  kind: "registry",
  id: "skillsdirectory",
  api: "https://www.skillsdirectory.com/api/registry",
  name: "Skills Directory",
  format: "skillsdirectory-v1",
  homepage: "https://www.skillsdirectory.com",
  enabled: true,
  builtin: true,
};

const MARKETPLACES: Extract<SkillSource, { kind: "registry" }> = {
  kind: "registry",
  id: "claudemarketplaces",
  api: "https://claudemarketplaces.com/api/skills",
  name: "Claude Marketplaces",
  format: "claudemarketplaces-v1",
  homepage: "https://claudemarketplaces.com",
  enabled: true,
  builtin: true,
};

const MONET_SKILLS: Extract<SkillSource, { kind: "github" }> = {
  kind: "github",
  id: "iaa2005/monet-directory/skills",
  repo: "iaa2005/monet-directory",
  sub: "skills",
  name: "Code Monet Skills",
  enabled: true,
  builtin: true,
};

/** Registries the app understands, by id and by endpoint — a source naming
 * anything else is dropped rather than queried with a guessed dialect. */
const KNOWN_REGISTRIES = [SKILLSDIRECTORY, MARKETPLACES];

/** Ids that ship with the app — switchable, not removable. */
export const BUILTIN_IDS = new Set([
  MONET_SKILLS.id,
  SKILLSDIRECTORY.id,
  MARKETPLACES.id,
]);

/**
 * The source rows in a stored config.
 *
 * One shape only, and the name says so now — it was `migrateStoredSources`,
 * left over from a migration that had already been deleted. There WAS one, for
 * the pre-Directory `{ "source": "owner/repo" }` config, and removing it was
 * right twice over: the app is not released, so there is no installed base to
 * carry, and the migration was actively wrong — it resurrected
 * `anthropics/skills` as a chip the user had never added and could not explain.
 *
 * A config this cannot read falls back to the built-in sources, which is the
 * right answer for a shape nobody should still have.
 */
export function readStoredSources(j: { sources?: unknown }): StoredSource[] {
  return Array.isArray(j.sources) ? (j.sources as StoredSource[]) : [];
}

/** Config rows are either a bare string (a GitHub repo, which is most of them)
 * or an object for anything that needs more than an id. */
export type StoredSource =
  | string
  | {
      kind?: string;
      id?: string;
      repo?: string;
      api?: string;
      name?: string;
      homepage?: string;
      enabled?: boolean;
    };

export function parseStoredSource(raw: StoredSource): SkillSource | null {
  // A bare string is an enabled github source — the common case, kept short so
  // the config file reads well by hand.
  if (typeof raw === "string") {
    const norm = normalizeSource(raw);
    if (norm.split("/").length < 2) return null;
    const parts = norm.split("/");
    const builtin = DEFAULT_SOURCES.find((d) => d.id === norm);
    return {
      kind: "github",
      id: norm,
      repo: parts.slice(0, 2).join("/"),
      sub: parts.slice(2).join("/"),
      ...(builtin?.name ? { name: builtin.name } : {}),
      enabled: true,
      builtin: BUILTIN_IDS.has(norm),
    };
  }
  // Absent `enabled` means on — the useful default for an entry added by hand.
  const enabled = raw?.enabled !== false;
  if (raw?.kind === "registry") {
    // Matched against the registries whose dialect this code implements. An
    // unknown one is dropped, not queried: guessing a schema means turning
    // whatever comes back into an install the user is offered.
    const api = typeof raw.api === "string" ? raw.api : "";
    const known = KNOWN_REGISTRIES.find(
      (k) => raw.id === k.id || api === k.api,
    );
    return known ? { ...known, enabled } : null;
  }
  if (typeof raw?.repo === "string") {
    const base = parseStoredSource(raw.repo);
    return base ? { ...base, enabled } : null;
  }
  if (typeof raw?.id === "string") {
    const base = parseStoredSource(raw.id);
    return base ? { ...base, enabled } : null;
  }
  return null;
}

/** Back to what goes in the config file. An enabled repo stays a bare string, so
 * skill-store.json is a list of repos anyone can edit by hand. */
export function toStored(s: SkillSource): StoredSource {
  // A plain enabled repo stays a bare string, so a hand-edited config keeps
  // reading the way it always did; anything else needs the object form.
  if (s.kind === "github" && s.enabled) return s.id;
  return s.kind === "github"
    ? { id: s.id, enabled: s.enabled }
    : { kind: "registry", id: s.id, enabled: s.enabled };
}

/** Out of the box: the project's own skills, plus the directory — which is
 * where "not just a search" comes from. It is a source like any other now, so
 * its chip is there before anything is typed. */
export const DEFAULT_SOURCES: SkillSource[] = [
  MONET_SKILLS,
  SKILLSDIRECTORY,
  MARKETPLACES,
];

/** The built-ins are always present in the list — switched off if the config
 * says so, but never missing, or a user who removed one could not get it back.
 * This is also why the chips stopped appearing and disappearing: the row is
 * derived from a set that does not change shape between loads. */
export function withBuiltins(list: SkillSource[]): SkillSource[] {
  const have = new Set(list.map((s) => s.id));
  const missing = DEFAULT_SOURCES.filter((d) => !have.has(d.id));
  return [...missing, ...list];
}
