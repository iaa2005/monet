/**
 * Jupyter notebooks, as something other than JSON.
 *
 * An .ipynb is a document that happens to be stored as JSON, and showing the
 * JSON is showing the filing cabinet instead of the letter: the prose is
 * escaped, the code is a single line of `\n`s, and the outputs — the part
 * that says whether the thing WORKED — are base64 nobody can read.
 *
 * This module is the format, not the screen: parse, serialise, and the cell
 * edits. Two rules run through all of it.
 *
 * **Never lose a field.** A notebook carries metadata this app knows nothing
 * about (kernel specs, widget state, cell tags, an editor's own keys), and a
 * round trip through here must return it untouched — an editor that silently
 * drops what it does not understand is not one anybody can leave open.
 *
 * **Sources are arrays.** nbformat stores a cell body as a list of lines with
 * their newlines kept, and writing a plain string instead produces a file
 * Jupyter opens but git sees as rewritten end to end. The split happens on
 * the way out, once.
 */

export type CellType = "code" | "markdown" | "raw";

export interface NotebookOutput {
  output_type: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  execution_count?: number | null;
  [key: string]: unknown;
}

export interface NotebookCell {
  cell_type: CellType;
  source: string | string[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: NotebookOutput[];
  id?: string;
  [key: string]: unknown;
}

export interface Notebook {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
  [key: string]: unknown;
}

/** What the editor works with: a cell plus a stable key for React. */
export interface UiCell {
  key: string;
  cell: NotebookCell;
}

export function parseNotebook(text: string): Notebook | null {
  try {
    const j = JSON.parse(text) as Notebook;
    if (!j || !Array.isArray(j.cells)) return null;
    return j;
  } catch {
    return null;
  }
}

/** A cell body as one string — what an editor binds to. */
export function cellText(cell: NotebookCell): string {
  const s = cell.source;
  return Array.isArray(s) ? s.join("") : (s ?? "");
}

/**
 * Back to nbformat's line list: every line keeps its "\n" except the last,
 * which keeps whatever the text had. An empty body is an empty list, which
 * is what Jupyter writes for an empty cell.
 */
export function toSourceLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  return parts.map((line, i) => (i < parts.length - 1 ? `${line}\n` : line))
    .filter((line, i, all) => !(i === all.length - 1 && line === ""));
}

/** Plain text of an output, for the ones that carry any. */
export function outputText(out: NotebookOutput): string {
  const join = (v: unknown): string =>
    Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
  if (out.output_type === "stream") return join(out.text);
  if (out.output_type === "error")
    return [out.ename, out.evalue].filter(Boolean).join(": ") +
      (out.traceback?.length ? `\n${stripAnsi(out.traceback.join("\n"))}` : "");
  const data = out.data ?? {};
  return join(data["text/plain"]);
}

/** The image an output carries, if it carries one. */
export function outputImage(
  out: NotebookOutput,
): { mediaType: string; base64: string } | null {
  const data = out.data;
  if (!data) return null;
  for (const mt of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    const v = data[mt];
    const b64 = Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
    if (b64) return { mediaType: mt, base64: b64.replace(/\s+/g, "") };
  }
  return null;
}

/** An SVG output — text, not base64, so it renders as markup. */
export function outputSvg(out: NotebookOutput): string | null {
  const v = out.data?.["image/svg+xml"];
  const s = Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
  return s || null;
}

/**
 * Terminal colour codes, which tracebacks are full of. Left in, they render
 * as `[0;31m` litter across every error the user most needs to read.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*[A-Za-z]/g, "");
}

/** The HTML an output carries — pandas tables, mostly. */
export function outputHtml(out: NotebookOutput): string | null {
  const v = out.data?.["text/html"];
  const s = Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
  return s ? sanitizeOutputHtml(s) : null;
}

/**
 * A notebook is a file that arrived from somewhere, and its HTML outputs are
 * whatever produced it decided to write. Inserted markup does not run its
 * own <script>, but an `onerror=` on an image does, so the parts that can
 * execute come out: tags that load or run, and every on* attribute.
 *
 * Not a general-purpose sanitiser — it is the narrow one this one surface
 * needs, and it errs toward removing.
 */
export function sanitizeOutputHtml(html: string): string {
  return html
    .replace(/<\s*(script|iframe|object|embed|link|meta|base)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed|link|meta|base)\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/(<[^>]+\s(?:href|src)\s*=\s*["']?)\s*javascript:/gi, "$1");
}

/** Is this output worth drawing at all? */
export function hasRenderableOutput(out: NotebookOutput): boolean {
  return (
    !!outputImage(out) ||
    !!outputSvg(out) ||
    outputText(out).trim().length > 0 ||
    typeof out.data?.["text/html"] === "string" ||
    Array.isArray(out.data?.["text/html"])
  );
}

// ─── Editing ────────────────────────────────────────────────────────────
//
// Every operation returns a NEW notebook and copies only what it changes:
// the cells it does not touch keep their identity, and the top-level keys
// (metadata, nbformat, anything unknown) ride along by spread.

export function setCellSource(
  nb: Notebook,
  index: number,
  text: string,
): Notebook {
  const cells = nb.cells.map((c, i) =>
    i === index ? { ...c, source: toSourceLines(text) } : c,
  );
  return { ...nb, cells };
}

export function newCell(type: CellType): NotebookCell {
  const cell: NotebookCell = {
    cell_type: type,
    source: [],
    metadata: {},
    // nbformat 4.5 wants an id; a short random one is what Jupyter writes.
    id: Math.random().toString(36).slice(2, 10),
  };
  if (type === "code") {
    cell.execution_count = null;
    cell.outputs = [];
  }
  return cell;
}

export function insertCell(
  nb: Notebook,
  index: number,
  type: CellType,
): Notebook {
  const cells = [...nb.cells];
  cells.splice(Math.max(0, Math.min(index, cells.length)), 0, newCell(type));
  return { ...nb, cells };
}

export function deleteCell(nb: Notebook, index: number): Notebook {
  if (nb.cells.length <= 1) return nb; // a notebook with no cells cannot be edited back
  return { ...nb, cells: nb.cells.filter((_c, i) => i !== index) };
}

export function moveCell(nb: Notebook, index: number, delta: number): Notebook {
  const to = index + delta;
  if (to < 0 || to >= nb.cells.length) return nb;
  const cells = [...nb.cells];
  const [cell] = cells.splice(index, 1);
  cells.splice(to, 0, cell!);
  return { ...nb, cells };
}

/**
 * Change what a cell IS. Turning code into prose drops the things only code
 * has — an execution count and outputs belonging to a cell that no longer
 * runs would be a lie about what produced them.
 */
export function setCellType(
  nb: Notebook,
  index: number,
  type: CellType,
): Notebook {
  const cells = nb.cells.map((c, i) => {
    if (i !== index || c.cell_type === type) return c;
    const next: NotebookCell = { ...c, cell_type: type };
    if (type === "code") {
      next.execution_count = null;
      next.outputs = [];
    } else {
      delete next.execution_count;
      delete next.outputs;
    }
    return next;
  });
  return { ...nb, cells };
}

/** Drop every output — the notebook equivalent of clearing the screen. */
export function clearOutputs(nb: Notebook): Notebook {
  return {
    ...nb,
    cells: nb.cells.map((c) =>
      c.cell_type === "code"
        ? { ...c, outputs: [], execution_count: null }
        : c,
    ),
  };
}

/**
 * Back to a file. Two spaces and a trailing newline is what `jupyter` itself
 * writes, and matching it keeps a saved notebook from showing up as a
 * whole-file diff next to one Jupyter saved.
 */
export function serializeNotebook(nb: Notebook): string {
  return `${JSON.stringify(nb, null, 1)}\n`;
}

/** The language a code cell is written in, for highlighting. */
export function notebookLanguage(nb: Notebook): string {
  const meta = nb.metadata ?? {};
  const info = meta["language_info"] as { name?: string } | undefined;
  const spec = meta["kernelspec"] as { language?: string } | undefined;
  return (info?.name || spec?.language || "python").toLowerCase();
}
