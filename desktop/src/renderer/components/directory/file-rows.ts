/**
 * A skill's files as folders and names, not as paths.
 *
 * Reported while reading heygen-com/hyperframes, which ships seventeen files:
 * the list was a column of `references/routes/…` strings whose only distinct part
 * was at the end, and the end was the part that got truncated. Every row began
 * with the same eleven characters.
 *
 * So the shared prefix becomes a heading and the rows carry only their own name.
 */

export interface FileRow {
  kind: "dir" | "file";
  /** What the row shows: a folder name, or a file name without its folder. */
  name: string;
  /** The full path, for selecting the file. Folders are not selectable. */
  path: string;
  /** How many folders deep, for the indent. */
  depth: number;
}

/**
 * Folders before their files, each sorted by name, with SKILL.md first.
 *
 * SKILL.md leads because it is the skill — everything else is something it
 * refers to, and it is the file the preview opens on.
 */
export function fileRows(paths: string[]): FileRow[] {
  const rows: FileRow[] = [];
  const entry = paths.find((p) => p === "SKILL.md");
  if (entry) rows.push({ kind: "file", name: entry, path: entry, depth: 0 });

  /** Everything under `prefix`, one level at a time. */
  const walk = (prefix: string, depth: number): void => {
    const here = paths.filter(
      (p) => p.startsWith(prefix) && p !== "SKILL.md" && p.length > prefix.length,
    );
    const rest = here.map((p) => p.slice(prefix.length));
    const dirs = [...new Set(rest.filter((r) => r.includes("/")).map((r) => r.split("/")[0]!))];
    const files = rest.filter((r) => !r.includes("/"));
    for (const d of dirs.sort()) {
      rows.push({ kind: "dir", name: d, path: `${prefix}${d}`, depth });
      walk(`${prefix}${d}/`, depth + 1);
    }
    for (const f of files.sort())
      rows.push({ kind: "file", name: f, path: `${prefix}${f}`, depth });
  };
  walk("", 0);
  return rows;
}
