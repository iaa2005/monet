/**
 * Turning a skill's paths into folders and names.
 *
 * The reported case is heygen-com/hyperframes: seventeen files whose list read as
 * `references/routes/embedded…`, `references/routes/faceless-e…`, truncated
 * exactly where they differed.
 *
 * The checks that matter are about not losing or inventing a file, and about the
 * indent actually corresponding to the path — a tree that draws the wrong depth
 * is harder to read than the flat list it replaced.
 */

import { fileRows, type FileRow } from "../src/renderer/components/directory/file-rows";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const shape = (rows: FileRow[]): string =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.name}${r.kind === "dir" ? "/" : ""}`).join("\n");

// ── 1. The reported skill, exactly as it ships ────────────────────────
{
  const paths = [
    "SKILL.md",
    "references/capability-menu.md",
    "references/intent-interview.md",
    "references/pitch-round.md",
    "references/route-briefs.md",
    "references/routes/embedded-player.md",
    "references/routes/faceless-explainer.md",
    "references/routes/general-video.md",
    "references/routes/motion-graphic.md",
    "references/routes/music-to-video.md",
    "references/routes/pr-to-video.md",
    "references/routes/product-launch.md",
    "references/routes/remotion-target.md",
    "references/routes/slideshow.md",
    "references/routes/talking-head.md",
    "references/skill-lifecycle.md",
    "references/workflow-catalog.md",
  ];
  const rows = fileRows(paths);
  console.log("\n" + shape(rows) + "\n");

  // Nothing may vanish: a file list that quietly drops a file is worse than an
  // ugly one, because the audit reports on files this list is meant to show.
  const files = rows.filter((r) => r.kind === "file").map((r) => r.path);
  check("every file is present", files.length === paths.length, `${files.length}/${paths.length}`);
  check("and none is invented", files.every((f) => paths.includes(f)));
  check("SKILL.md leads", rows[0]?.name === "SKILL.md" && rows[0]?.depth === 0);
  check("references is a folder row", rows[1]?.kind === "dir" && rows[1]?.name === "references");
  check("at depth 0", rows[1]?.depth === 0);
  check("the nested folder appears once", rows.filter((r) => r.kind === "dir" && r.name === "routes").length === 1);
  check(
    "and one level deeper",
    rows.find((r) => r.name === "routes")?.depth === 1,
    rows.find((r) => r.name === "routes")?.depth,
  );
  // The whole point: a row shows its own name, not the path everyone shares.
  check(
    "rows carry only their own name",
    rows.every((r) => !r.name.includes("/")),
    rows.filter((r) => r.name.includes("/")).map((r) => r.name).join(","),
  );
  check(
    "the deep files sit under routes",
    rows.find((r) => r.name === "embedded-player.md")?.depth === 2,
    rows.find((r) => r.name === "embedded-player.md")?.depth,
  );
  // Folders before files at each level, so a level reads as a block.
  const refIdx = rows.findIndex((r) => r.name === "references");
  const routesIdx = rows.findIndex((r) => r.name === "routes");
  const capIdx = rows.findIndex((r) => r.name === "capability-menu.md");
  check("folders come before their sibling files", routesIdx < capIdx, `${routesIdx} < ${capIdx}`);
  check("and after their own parent", refIdx < routesIdx);
  // Depth must match the path, or the indent lies.
  check(
    "depth equals the number of folders in the path",
    rows.every((r) => r.depth === r.path.split("/").length - 1),
    rows.filter((r) => r.depth !== r.path.split("/").length - 1).map((r) => r.path).join(","),
  );
}

// ── 2. Shapes that are not the happy case ─────────────────────────────
{
  check("no files, no rows", fileRows([]).length === 0);
  check("one file is one row", fileRows(["SKILL.md"]).length === 1);
  // A skill with no SKILL.md should not crash or fabricate one.
  const orphan = fileRows(["scripts/run.py"]);
  check("a missing SKILL.md is fine", orphan.length === 2 && orphan[0]?.kind === "dir", shape(orphan));
  // Two folders at the same level, sorted.
  const two = fileRows(["SKILL.md", "b/y.md", "a/x.md"]);
  check(
    "sibling folders are sorted",
    two.filter((r) => r.kind === "dir").map((r) => r.name).join(",") === "a,b",
    two.filter((r) => r.kind === "dir").map((r) => r.name).join(","),
  );
  // Deep nesting: the indent has to keep up.
  const deep = fileRows(["a/b/c/d/e.md"]);
  check("deep nesting keeps its depths", shape(deep) === "a/\n  b/\n    c/\n      d/\n        e.md", JSON.stringify(shape(deep)));
  check("and still lists the file once", deep.filter((r) => r.kind === "file").length === 1);
  // A folder whose name repeats deeper must not collapse into one row.
  const same = fileRows(["x/x.md", "x/x/x.md"]);
  check("a repeated name is not collapsed", same.filter((r) => r.kind === "dir").length === 2, shape(same));
  check("and both files survive", same.filter((r) => r.kind === "file").length === 2, shape(same));
  // Order of input must not change the output.
  const a = shape(fileRows(["SKILL.md", "r/a.md", "r/s/b.md"]));
  const b = shape(fileRows(["r/s/b.md", "r/a.md", "SKILL.md"]));
  check("input order does not matter", a === b, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL FILE-ROW CHECKS PASSED");
process.exit(failures ? 1 : 0);
