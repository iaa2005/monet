/**
 * A CSV file, shown as the table it is.
 *
 * The text stays the source of truth: this parses on the way in and serialises
 * on the way out, so the viewer's existing save path (write the string) is
 * unchanged and the Text tab always shows exactly what will be written. The
 * delimiter the file arrived with is carried through — a semicolon file that
 * came back as commas would be a silent conversion nobody asked for.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { parseCsv, toCsv, type CsvDelimiter } from "./csv";
import { SheetEditor, type SheetData } from "./SheetEditor";

export function CsvTable({
  text,
  canEdit,
  onChange,
}: {
  text: string;
  canEdit: boolean;
  /** The whole file, re-serialised. Null when nothing differs from `text`. */
  onChange: (next: string | null) => void;
}): JSX.Element {
  const parsed = useMemo(() => parseCsv(text), [text]);
  const [rows, setRows] = useState<string[][]>(parsed.rows);
  const delimiter = useRef<CsvDelimiter>(parsed.delimiter);

  // Reload, undo, a different file in the same pane: follow the text.
  useEffect(() => {
    setRows(parsed.rows);
    delimiter.current = parsed.delimiter;
  }, [parsed]);

  const commit = (next: string[][]): void => {
    setRows(next);
    const serialised = toCsv(next, delimiter.current);
    onChange(serialised === text ? null : serialised);
  };

  const sheets: SheetData[] = [{ name: "CSV", rows }];

  return (
    <SheetEditor
      sheets={sheets}
      canEdit={canEdit}
      onCellCommit={(_s, r, c, value) => {
        const next = rows.map((row) => row.slice());
        while (next.length <= r) next.push([]);
        const row = next[r];
        while (row.length <= c) row.push("");
        row[c] = value;
        commit(next);
      }}
      onAddRow={() => {
        const width = rows.reduce((w, r) => Math.max(w, r.length), 1);
        commit([...rows.map((r) => r.slice()), Array(width).fill("")]);
      }}
      onAddColumn={() => {
        commit(rows.map((r) => [...r, ""]));
      }}
    />
  );
}
