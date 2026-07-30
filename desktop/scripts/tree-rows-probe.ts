/**
 * The flat tree and its render window.
 *
 * The reported symptom was jank in a folder with many files, and the suspected
 * cause was the icons. Measured, that was wrong: a folder of 986 files asks for
 * exactly one icon URL, because every row after the first is a cache hit. What
 * scales with the file count is the rows — so the fix is to keep every file in
 * the list and put only the visible ones in the document.
 *
 * Which makes these the checks that matter: the flat list must contain exactly
 * what the recursive tree drew, in the same order, and the window must never
 * omit a row that is on screen — an off-by-one here is a blank band while
 * scrolling, which looks exactly like the bug being fixed.
 */

import { flattenTree, visibleWindow } from "../src/renderer/components/tree-rows";
import type { TreeEntry } from "../src/renderer/components/tree-rows";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

const dir = (path: string): TreeEntry => ({
  name: path.split("/").pop()!,
  path,
  isDirectory: true,
  isFile: false,
});
const file = (path: string): TreeEntry => ({
  name: path.split("/").pop()!,
  path,
  isDirectory: false,
  isFile: true,
});

const top = [dir("/p/src"), dir("/p/docs"), file("/p/readme.md")];
const kids = new Map<string, TreeEntry[]>([
  ["/p/src", [dir("/p/src/ui"), file("/p/src/index.ts")]],
  ["/p/src/ui", [file("/p/src/ui/App.tsx")]],
  ["/p/docs", [file("/p/docs/guide.md")]],
]);

// ── 1. Flattening is display order, not walk order ────────────────────
{
  const rows = flattenTree(top, new Set(), new Map());
  check(
    "nothing open lists only the top level",
    rows.map((r) => r.entry.name).join(" ") === "src docs readme.md",
    rows.map((r) => r.entry.name).join(" "),
  );
  check("…all at depth 0", rows.every((r) => r.depth === 0));
}

{
  const rows = flattenTree(top, new Set(["/p/src"]), kids);
  check(
    "an open folder is followed by its contents, then its sibling",
    rows.map((r) => r.entry.name).join(" ") ===
      "src ui index.ts docs readme.md",
    rows.map((r) => r.entry.name).join(" "),
  );
  check(
    "children are one level deeper",
    rows.find((r) => r.entry.name === "index.ts")?.depth === 1,
  );
}

{
  const rows = flattenTree(top, new Set(["/p/src", "/p/src/ui"]), kids);
  check(
    "nesting keeps going",
    rows.map((r) => r.entry.name).join(" ") ===
      "src ui App.tsx index.ts docs readme.md",
    rows.map((r) => r.entry.name).join(" "),
  );
  check(
    "and indents accordingly",
    rows.find((r) => r.entry.name === "App.tsx")?.depth === 2,
  );
}

// ── 2. Open but not yet loaded is not a hole ──────────────────────────
{
  const rows = flattenTree(top, new Set(["/p/docs"]), new Map());
  check(
    "an open folder whose children have not arrived shows just itself",
    rows.map((r) => r.entry.name).join(" ") === "src docs readme.md",
    rows.map((r) => r.entry.name).join(" "),
  );
}

// ── 3. Expanding a FILE cannot happen ─────────────────────────────────
{
  // A stale entry in the open set — the path was a folder before a rebuild.
  const rows = flattenTree(top, new Set(["/p/readme.md"]), kids);
  check(
    "a file in the expanded set is still just a file",
    rows.length === 3,
    rows.length,
  );
}

// ── 4. The window covers everything on screen ─────────────────────────
{
  const H = 22;
  const w = visibleWindow(1000, H, 0, 440); // 20 rows visible
  check("from the top, the window starts at 0", w.start === 0, w.start);
  check("no padding above the first row", w.padTop === 0);
  check(
    "the list keeps its real height",
    w.padTop + (w.end - w.start) * H + w.padBottom === 1000 * H,
    w.padTop + (w.end - w.start) * H + w.padBottom,
  );

  // Every scroll position: the rows on screen must be inside the window.
  let missed = 0;
  for (let top = 0; top <= (1000 - 20) * H; top += 7) {
    const win = visibleWindow(1000, H, top, 440);
    const firstOnScreen = Math.floor(top / H);
    const lastOnScreen = Math.floor((top + 440 - 1) / H);
    if (win.start > firstOnScreen || win.end <= lastOnScreen) missed++;
  }
  check(
    "no scroll position leaves a visible row unrendered",
    missed === 0,
    missed,
  );

  // …and again with no overscan. With the default 8 rows of slack the window
  // can be wrong by one at the bottom and still cover the screen, so the check
  // above passes on arithmetic that is off by one. This pins the arithmetic.
  let bare = 0;
  for (let top = 0; top <= (1000 - 20) * H; top += 7) {
    const win = visibleWindow(1000, H, top, 440, 0);
    const firstOnScreen = Math.floor(top / H);
    const lastOnScreen = Math.floor((top + 440 - 1) / H);
    if (win.start > firstOnScreen || win.end <= lastOnScreen) bare++;
  }
  check("…with no overscan to hide a boundary error", bare === 0, bare);

  // A viewport that is not a whole number of rows is the case the +1 exists
  // for: 450px shows 21 rows, the last of them a sliver.
  let ragged = 0;
  for (let top = 0; top < 400; top += 3) {
    const win = visibleWindow(1000, H, top, 450, 0);
    if (win.end <= Math.floor((top + 450 - 1) / H)) ragged++;
  }
  check("a partly-visible last row is still rendered", ragged === 0, ragged);

  const mid = visibleWindow(1000, H, 5000, 440);
  check(
    "height is preserved mid-list too",
    mid.padTop + (mid.end - mid.start) * H + mid.padBottom === 1000 * H,
  );
  check(
    "and the document holds a window, not the list",
    mid.end - mid.start < 60,
    mid.end - mid.start,
  );

  const end = visibleWindow(1000, H, 1000 * H, 440);
  check("scrolled past the end, nothing is padded below", end.padBottom === 0);
  check("…and the window stops at the last row", end.end === 1000, end.end);

  check(
    "an empty list has an empty window",
    visibleWindow(0, H, 0, 440).end === 0,
  );
  check(
    "a viewport of zero still renders the overscan, not nothing",
    visibleWindow(100, H, 0, 0).end > 0,
  );
}

console.log(
  failures === 0 ? "\nALL TREE-ROW CHECKS PASSED" : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
