/**
 * Diff core — the single source of truth for turning two texts (or a unified
 * `@@` patch) into diff rows, plus context folding and stats. Pure logic, no
 * JSX: shared by DiffView (rendering), CodeBlock (inline Edit/Write previews)
 * and DiffViewer (the review panel), so every diff in the app aligns line
 * numbers, folds context and counts +/- the exact same way.
 */

import { diffArrays } from "diff";

export type DiffKind = "normal" | "added" | "removed";

export interface DiffRow {
  text: string;
  /** 1-based line number on the old side (removed + context rows). */
  oldNo?: number;
  /** 1-based line number on the new side (added + context rows). */
  newNo?: number;
  kind: DiffKind;
}

// ─── old → new line diff ────────────────────────────────────────────────────

/**
 * Line diff of `oldText` → `newText` via jsdiff (a real LCS, not a windowed
 * lookahead). `startLine` offsets the displayed numbers so an Edit that
 * touches line 240 numbers its rows from 240.
 */
export function computeRows(
  oldText: string,
  newText: string,
  startLine = 1,
): DiffRow[] {
  const offset = startLine - 1;
  const oldLines = oldText.length ? oldText.split("\n") : [];
  const newLines = newText.length ? newText.split("\n") : [];

  // Write (no old) / full delete (no new): skip the diff so a single leading
  // empty line isn't reported as a spurious removed/added pair.
  if (oldLines.length === 0)
    return newLines.map((text, i) => ({
      text,
      newNo: offset + i + 1,
      kind: "added" as const,
    }));
  if (newLines.length === 0)
    return oldLines.map((text, i) => ({
      text,
      oldNo: offset + i + 1,
      kind: "removed" as const,
    }));

  // jsdiff's LCS can use quadratic time and memory. Keep large edits useful
  // without letting an accidental whole-file diff freeze the renderer.
  const MAX_DIFF_LINES = 20_000;
  const MAX_DIFF_CELLS = 2_000_000;
  if (
    oldLines.length + newLines.length > MAX_DIFF_LINES ||
    oldLines.length * newLines.length > MAX_DIFF_CELLS
  ) {
    return [
      ...oldLines.map((text, i) => ({
        text,
        oldNo: offset + i + 1,
        kind: "removed" as const,
      })),
      ...newLines.map((text, i) => ({
        text,
        newNo: offset + i + 1,
        kind: "added" as const,
      })),
    ];
  }

  const rows: DiffRow[] = [];
  let oldNo = offset + 1;
  let newNo = offset + 1;
  for (const part of diffArrays(oldLines, newLines)) {
    for (const text of part.value) {
      if (part.added) rows.push({ text, newNo: newNo++, kind: "added" });
      else if (part.removed) rows.push({ text, oldNo: oldNo++, kind: "removed" });
      else rows.push({ text, oldNo: oldNo++, newNo: newNo++, kind: "normal" });
    }
  }
  return rows;
}

// ─── unified (`@@`) patch ───────────────────────────────────────────────────

/** True for text that already is a git / unified diff (`diff --git`, `@@ -a`). */
export function isUnifiedDiff(code: string): boolean {
  return /^(?:diff --git |@@ -\d)/m.test(code);
}

/** Parse an already-unified diff into rows, tracking both line counters.
 *
 * The text is not always a CLEAN patch: a tool result wraps one in prose
 * ("Edited foo.html (38.3 KB).") and markdown fences, and treating those as
 * context rows numbered them 1, 2, 3 ahead of a hunk that starts at line 369.
 * So nothing counts as a row until the first hunk header, and fence lines are
 * dropped wherever they appear. */
export function parseUnifiedDiff(code: string): DiffRow[] {
  let oldLine = 1;
  let newLine = 1;
  let inHunk = false;
  const rows: DiffRow[] = [];
  for (const line of code.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // prose, ```fences, ---/+++ headers — not the diff
    if (line.startsWith("```")) continue; // a fence closing (or re-opening) mid-text
    if (line.startsWith("\\ No newline")) continue;
    const kind: DiffKind = line.startsWith("-")
      ? "removed"
      : line.startsWith("+")
        ? "added"
        : "normal";
    const text = line.startsWith(" ") || kind !== "normal" ? line.slice(1) : line;
    rows.push({
      text,
      oldNo: kind === "added" ? undefined : oldLine,
      newNo: kind === "removed" ? undefined : newLine,
      kind,
    });
    if (kind !== "added") oldLine++;
    if (kind !== "removed") newLine++;
  }
  return rows;
}

// ─── stats ──────────────────────────────────────────────────────────────────

export function diffStats(
  oldText: string,
  newText: string,
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of computeRows(oldText, newText)) {
    if (r.kind === "added") added++;
    else if (r.kind === "removed") removed++;
  }
  return { added, removed };
}

// ─── context folding ────────────────────────────────────────────────────────

export type DiffSegment =
  | { kind: "rows"; rows: DiffRow[] }
  /** A run of unchanged rows collapsed behind a "N unmodified lines" divider.
   * `rows` empty + `skipped` set = a hunk boundary in a unified patch: the
   * lines exist in the file but not in the patch, so there is nothing to
   * expand — the divider only states how many were skipped. */
  | { kind: "gap"; rows: DiffRow[]; skipped?: number };

/**
 * Collapse long runs of unchanged rows into gaps, keeping `context` unchanged
 * rows visible on each side of every change — the "N unmodified lines" folding
 * from the official diff view. Runs short enough that folding wouldn't hide
 * more than it costs are left inline.
 *
 * Rows parsed from a unified patch are not contiguous: line numbers JUMP at
 * hunk boundaries, and rendering row 377 directly above row 518 read like the
 * file lost a hundred lines. A jump becomes an explicit non-expandable gap.
 */
export function foldRows(
  rows: DiffRow[],
  context = 3,
  minGap = 2,
): DiffSegment[] {
  // Mark rows within `context` of any change as pinned-visible.
  const near = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind === "normal") return;
    for (let j = i - context; j <= i + context; j++)
      if (j >= 0 && j < rows.length) near[j] = true;
  });

  const segments: DiffSegment[] = [];
  let i = 0;
  // The line numbers the next row should carry if it is contiguous.
  let expectOld: number | undefined;
  let expectNew: number | undefined;
  let run: DiffRow[] = [];
  let runVisible = near[0] ?? false;

  const flushRun = (): void => {
    if (run.length === 0) return;
    if (!runVisible && run.length > minGap)
      segments.push({ kind: "gap", rows: run });
    else segments.push({ kind: "rows", rows: run });
    run = [];
  };

  for (; i < rows.length; i++) {
    const r = rows[i];
    const jumped =
      (r.oldNo != null && expectOld != null && r.oldNo !== expectOld) ||
      (r.newNo != null && expectNew != null && r.newNo !== expectNew);
    if (jumped) {
      flushRun();
      const skipped = Math.max(
        r.oldNo != null && expectOld != null ? r.oldNo - expectOld : 0,
        r.newNo != null && expectNew != null ? r.newNo - expectNew : 0,
      );
      if (skipped > 0) segments.push({ kind: "gap", rows: [], skipped });
      runVisible = near[i];
    }
    if (near[i] !== runVisible) {
      flushRun();
      runVisible = near[i];
    }
    run.push(r);
    if (r.oldNo != null) expectOld = r.oldNo + 1;
    if (r.newNo != null) expectNew = r.newNo + 1;
  }
  flushRun();
  return segments;
}

// ─── language detection ─────────────────────────────────────────────────────

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  scala: "scala",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  xml: "xml",
  svg: "svg",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  md: "markdown",
  mdx: "markdown",
  txt: "text",
  log: "text",
  dockerfile: "docker",
  makefile: "makefile",
};

/** Map a file path (or bare name) to a Prism/refractor language id. */
export function langFromPath(path: string): string {
  const base = path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  const ext = base.includes(".") ? base.split(".").pop()! : base;
  return EXT_LANG[ext] || EXT_LANG[base] || "text";
}
