/**
 * CSV in and out, for the file viewer's table mode.
 *
 * Not a split on commas. A CSV field may be quoted, and a quoted field may
 * contain the delimiter, a newline, or a doubled quote standing for one — all
 * three appear in the files people actually open, and all three turn a naive
 * split into silent data loss the moment the file is saved back.
 *
 * The delimiter is sniffed rather than assumed: a spreadsheet exported on a
 * machine with a comma decimal separator writes semicolons, and reading that
 * as a comma file yields one wide column. Whatever is found is remembered and
 * written back, so opening a `;` file and saving it does not quietly convert
 * it to `,`.
 */

export type CsvDelimiter = "," | ";" | "\t" | "|";

const CANDIDATES: CsvDelimiter[] = [",", ";", "\t", "|"];

/**
 * Count a candidate outside quotes over the first few lines.
 *
 * Counting inside quotes is how "Smith, John" makes a semicolon file look
 * like a comma file.
 */
function scoreDelimiter(text: string, d: CsvDelimiter): number {
  let count = 0;
  let quoted = false;
  let lines = 0;
  for (let i = 0; i < text.length && lines < 20; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === "\n") {
      lines++;
      continue;
    }
    if (ch === d) count++;
  }
  return count;
}

export function sniffDelimiter(text: string): CsvDelimiter {
  let best: CsvDelimiter = ",";
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const score = scoreDelimiter(text, d);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Parse into a rectangle of strings. Ragged rows are padded, not dropped. */
export function parseCsv(
  text: string,
  delimiter?: CsvDelimiter,
): { rows: string[][]; delimiter: CsvDelimiter } {
  const d = delimiter ?? sniffDelimiter(text);
  // A BOM would otherwise ride along inside the first header cell, where it is
  // invisible and breaks every comparison against that column's name.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        // "" inside a quoted field is one literal quote.
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      continue;
    }
    if (ch === d) {
      endField();
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      endRow();
      continue;
    }
    field += ch;
  }
  // A file that does not end in a newline still has a last row; one that does
  // must not gain an empty one.
  if (field !== "" || row.length > 0) endRow();

  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) while (r.length < width) r.push("");
  return { rows, delimiter: d };
}

/** Quote only where it is needed — a file that did not need quotes keeps none. */
export function toCsv(rows: string[][], delimiter: CsvDelimiter = ","): string {
  const needsQuotes = (v: string): boolean =>
    v.includes(delimiter) ||
    v.includes('"') ||
    v.includes("\n") ||
    v.includes("\r");
  return rows
    .map((r) =>
      r
        .map((v) => (needsQuotes(v) ? `"${v.replace(/"/g, '""')}"` : v))
        .join(delimiter),
    )
    .join("\n");
}

/** A1, B1 … Z1, AA1 — the column name a spreadsheet would show. */
export function columnName(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}
