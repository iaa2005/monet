/**
 * The table mode of the file viewer: a spreadsheet you can actually type in.
 *
 * Cells are contentEditable rather than inputs, and they commit on blur rather
 * than on every keystroke. A grid of controlled inputs re-renders the whole
 * sheet on each character, which a 200×40 table cannot afford; committing on
 * blur keeps the model in the parent and the typing in the DOM, where it is
 * already fast.
 *
 * The grid is capped. A workbook can carry a million rows, and a viewer that
 * tries to draw them stops being a viewer — the cap is reported rather than
 * hidden, so nobody edits row 300 of a file believing it is the last one.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { columnName } from "./csv";

export interface SheetData {
  name: string;
  rows: string[][];
}

export const MAX_ROWS = 500;
export const MAX_COLS = 60;

export function SheetEditor({
  sheets,
  onCellCommit,
  onAddRow,
  onAddColumn,
  canEdit,
}: {
  sheets: SheetData[];
  /** A cell lost focus with different text in it. */
  onCellCommit: (sheet: number, row: number, col: number, value: string) => void;
  onAddRow?: (sheet: number) => void;
  onAddColumn?: (sheet: number) => void;
  canEdit: boolean;
}): JSX.Element {
  const [active, setActive] = useState(0);
  const sheet = sheets[Math.min(active, sheets.length - 1)];

  // A workbook can be swapped under us (another file in the same pane).
  useEffect(() => {
    if (active >= sheets.length) setActive(0);
  }, [sheets.length, active]);

  if (!sheet) {
    return (
      <div className="p-6 text-center text-xs text-muted-foreground">
        This file has no sheets.
      </div>
    );
  }

  const rows = sheet.rows.slice(0, MAX_ROWS);
  const cols = Math.min(
    rows.reduce((w, r) => Math.max(w, r.length), 1),
    MAX_COLS,
  );
  const clippedRows = sheet.rows.length - rows.length;
  const clippedCols =
    sheet.rows.reduce((w, r) => Math.max(w, r.length), 1) - cols;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {sheets.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto p-1.5">
          {sheets.map((s, i) => (
            <button
              key={`${s.name}:${i}`}
              type="button"
              onClick={() => setActive(i)}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
                i === active
                  ? "bg-brand-wash text-brand"
                  : "text-muted-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.06]",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              {/* The corner and the column letters stay put while you scroll —
                  a header that scrolls away leaves you counting columns. */}
              <th className="sticky left-0 top-0 z-20 min-w-10 border-b border-r border-border bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground" />
              {Array.from({ length: cols }, (_, c) => (
                <th
                  key={c}
                  className="sticky top-0 z-10 min-w-28 border-b border-r border-border bg-muted px-2 py-1 text-left text-[11px] font-medium text-muted-foreground"
                >
                  {columnName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <td className="sticky left-0 z-10 border-b border-r border-border bg-muted px-2 py-1 text-right text-[11px] tabular-nums text-muted-foreground">
                  {r + 1}
                </td>
                {Array.from({ length: cols }, (_, c) => (
                  <Cell
                    key={c}
                    value={row[c] ?? ""}
                    canEdit={canEdit}
                    onCommit={(v) => onCellCommit(active, r, c, v)}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {canEdit && (onAddRow || onAddColumn) && (
          <div className="flex gap-2 p-2">
            {onAddRow && (
              <button
                type="button"
                onClick={() => onAddRow(active)}
                className="rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
              >
                + Row
              </button>
            )}
            {onAddColumn && (
              <button
                type="button"
                onClick={() => onAddColumn(active)}
                className="rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
              >
                + Column
              </button>
            )}
          </div>
        )}

        {(clippedRows > 0 || clippedCols > 0) && (
          <div className="px-2 pb-2 text-[11px] text-muted-foreground">
            Showing the first {rows.length} rows and {cols} columns
            {clippedRows > 0 ? ` — ${clippedRows} more rows` : ""}
            {clippedCols > 0 ? ` — ${clippedCols} more columns` : ""} are in the
            file but not drawn here.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One cell. Uncontrolled on purpose: React writes the text once, the browser
 * owns it while you type, and the value comes back on blur. `suppressContent-
 * EditableWarning` is the price of that, and it is the right trade — the
 * alternative re-renders 12,000 cells per keystroke.
 */
function Cell({
  value,
  canEdit,
  onCommit,
}: {
  value: string;
  canEdit: boolean;
  onCommit: (value: string) => void;
}): JSX.Element {
  const ref = useRef<HTMLTableCellElement>(null);

  // Follow the model when it changes underneath — a reload, an undo, another
  // sheet — but never while this cell has the caret.
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== value) {
      el.textContent = value;
    }
  }, [value]);

  return (
    <td
      ref={ref}
      contentEditable={canEdit}
      suppressContentEditableWarning
      spellCheck={false}
      onBlur={(e) => {
        const next = e.currentTarget.textContent ?? "";
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(e) => {
        // Enter commits and moves on rather than opening a line inside a cell.
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          e.currentTarget.textContent = value;
          e.currentTarget.blur();
        }
      }}
      className={cn(
        "min-w-28 max-w-80 truncate border-b border-r border-border px-2 py-1 align-top outline-none",
        canEdit && "focus:bg-brand-wash focus:text-foreground",
      )}
    >
      {value}
    </td>
  );
}
