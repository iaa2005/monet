/**
 * Turning a request for a skill into files on disk — the checkable half.
 *
 * A skill is instructions the model will follow, so writing one is closer to
 * writing code than to saving a note: the name becomes a directory, the
 * description is what the agent matches on when deciding whether to load it, and
 * any extra files are relative paths this process will create. Every one of
 * those is a place to get it wrong, so the rules live here, dependency-free,
 * and the probe drives them rather than a copy.
 */

export interface SkillFile {
  /** Relative to the skill's own folder: `scripts/run.py`. */
  path: string;
  content: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  files?: SkillFile[];
}

export interface Rejected {
  ok: false;
  error: string;
}
export interface Accepted {
  ok: true;
  /** Folder name — the same as `name`, once it has passed. */
  slug: string;
  /** The full text of SKILL.md, frontmatter included. */
  skillMd: string;
  files: SkillFile[];
}

/** A skill's folder name, and the word the user types after the slash. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
/** The description is a matcher, not a paragraph. */
const MAX_DESCRIPTION = 500;
const MAX_BODY = 100_000;
const MAX_FILES = 40;
const MAX_FILE = 200_000;

/** A path inside the skill's folder, and nowhere else. */
function badPath(p: string): string | null {
  if (!p || p.length > 200) return "path must be 1-200 characters";
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.startsWith("\\"))
    return "path must be relative";
  if (p.includes("\\")) return "use forward slashes";
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".."))
    return "path must not contain . or .. segments";
  if (parts.some((s) => !/^[A-Za-z0-9._-]+$/.test(s)))
    return "path segments may use letters, digits, dot, dash and underscore";
  if (p.toLowerCase() === "skill.md")
    return "SKILL.md is written from `body`, not from `files`";
  return null;
}

/** YAML needs quoting when a value could be read as something else. */
function yamlValue(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  // Quote unless it is plainly safe unquoted: no colon-space, no leading
  // indicator character, no trailing colon.
  const safe = !/[:#]|^[-?*&!|>%@`'"]|:$/.test(flat);
  return safe ? flat : `"${flat.replace(/"/g, '\\"')}"`;
}

/**
 * Check a draft and render it. Nothing is written here — the caller decides
 * where, and whether it may overwrite.
 */
export function prepareSkill(draft: SkillDraft): Accepted | Rejected {
  // Not lower-cased first: `ReleaseNotes` would pass as `releasenotes`, and the
  // name IS the word the user types after the slash. Silently answering to
  // `/releasenotes` when `/release-notes` was meant is worse than refusing.
  const name = (draft.name ?? "").trim();
  if (!name) return { ok: false, error: "name is required" };
  if (name.length > MAX_NAME)
    return { ok: false, error: `name must be at most ${MAX_NAME} characters` };
  if (!NAME.test(name))
    return {
      ok: false,
      error: `name must be kebab-case (got ${JSON.stringify(draft.name)})`,
    };

  const description = (draft.description ?? "").replace(/\s+/g, " ").trim();
  if (!description)
    return {
      ok: false,
      // Said plainly, because a vague description is the most common way a
      // skill ends up never being used: this line is what the agent matches on.
      error:
        "description is required — it is what the agent matches on, so say WHEN the skill applies",
    };
  if (description.length > MAX_DESCRIPTION)
    return {
      ok: false,
      error: `description must be at most ${MAX_DESCRIPTION} characters`,
    };

  const body = (draft.body ?? "").trim();
  if (!body) return { ok: false, error: "body is required" };
  if (body.length > MAX_BODY)
    return { ok: false, error: `body must be at most ${MAX_BODY} characters` };

  const files = draft.files ?? [];
  if (files.length > MAX_FILES)
    return { ok: false, error: `at most ${MAX_FILES} extra files` };
  const seen = new Set<string>();
  for (const f of files) {
    const bad = badPath(f.path);
    if (bad) return { ok: false, error: `${f.path || "(empty)"}: ${bad}` };
    const key = f.path.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `${f.path}: listed twice` };
    seen.add(key);
    if (typeof f.content !== "string")
      return { ok: false, error: `${f.path}: content must be a string` };
    if (f.content.length > MAX_FILE)
      return {
        ok: false,
        error: `${f.path}: at most ${MAX_FILE} characters`,
      };
  }

  const skillMd = [
    "---",
    `name: ${yamlValue(name)}`,
    `description: ${yamlValue(description)}`,
    "---",
    "",
    body,
    "",
  ].join("\n");

  return { ok: true, slug: name, skillMd, files };
}
