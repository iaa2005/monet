/**
 * OTSL → Markdown.
 *
 * Asked to read a table, PaddleOCR-VL answers in OTSL — the tag language
 * Docling uses for table structure, where `<fcel>` starts a cell, `<nl>`
 * ends a row, and spans are their own tags. It is a good format and it is
 * not one anybody wants pasted into a note.
 *
 * Only the tags that carry structure are honoured; the rest are dropped
 * rather than guessed at, because a wrong span silently shifts every cell
 * after it and a missing one merely looks plain.
 */

/** Cell tags, in the vocabulary the model emits. */
const CELL = /<(fcel|ecel|ched|rhed|srow)>/g;

export function isOtsl(text: string): boolean {
  return text.includes("<fcel>") || text.includes("<ecel>") || text.includes("<nl>");
}

/** Split into rows of cells. */
export function parseOtsl(text: string): string[][] {
  return text
    .split("<nl>")
    .map((row) =>
      row
        .split(CELL)
        // The split keeps the tag names as capture groups; drop them.
        .filter((part) => !/^(fcel|ecel|ched|rhed|srow)$/.test(part))
        .map((cell) => cell.replace(/<[^>]*>/g, "").trim()),
    )
    .map((cells) => (cells[0] === "" ? cells.slice(1) : cells))
    .filter((cells) => cells.some((c) => c.length > 0));
}

/**
 * A Markdown table, padded to the widest row.
 *
 * Ragged rows happen — a model that loses its place emits four cells in a
 * row of three — and Markdown renders a ragged table as gibberish, so the
 * short rows are filled rather than left to break the whole block.
 */
export function otslToMarkdown(text: string): string {
  const rows = parseOtsl(text);
  if (rows.length === 0) return text.trim();
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): string[] =>
    r.length === width ? r : [...r, ...new Array(width - r.length).fill("")];
  const line = (cells: string[]): string =>
    `| ${pad(cells).map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;

  const out = [line(rows[0]), `|${" --- |".repeat(width)}`];
  for (const r of rows.slice(1)) out.push(line(r));
  return out.join("\n");
}
