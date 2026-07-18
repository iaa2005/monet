/**
 * DiffView — the one presentational diff, matching the official desktop
 * review look: line-number gutter, +/- markers, a coloured left accent bar,
 * syntax highlighting inside every row, and long unchanged runs collapsed
 * behind clickable "N unmodified lines" dividers.
 *
 * It renders only the rows (no header/copy chrome) so it can drop into the
 * CodeBlock panel (inline Edit/Write previews) and the DiffViewer review panel
 * alike. Give it either `oldText`/`newText` or pre-parsed `rows`.
 */

import { useMemo, useState, type ReactNode } from "react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  computeRows,
  foldRows,
  type DiffRow,
} from "./diff-core";
import { highlightLines, highlightOne } from "./highlight";

export interface DiffViewProps {
  oldText?: string;
  newText?: string;
  /** Pre-parsed rows (e.g. a unified `@@` patch). Overrides oldText/newText. */
  rows?: DiffRow[];
  language?: string;
  /** Display offset for line numbers (an Edit at line 240 starts there). */
  startLine?: number;
  /** Unchanged lines kept visible on each side of a change before folding. */
  context?: number;
  className?: string;
  maxHeight?: number | string;
}

// Past this many rows we skip syntax highlighting (tokenising a whole huge file
// is not worth it) and cap how many rows render until the user asks for more.
const HIGHLIGHT_CAP = 2500;
const PREVIEW_ROWS = 400;

function GapDivider({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const Icon = open ? ChevronsDownUp : ChevronsUpDown;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 bg-muted/40 px-3 py-1 text-left text-[11px] text-muted-foreground/80 transition-colors hover:bg-muted/70 hover:text-foreground"
    >
      <Icon className="size-3 shrink-0" />
      <span>
        {count} unmodified line{count === 1 ? "" : "s"}
      </span>
    </button>
  );
}

export function DiffView({
  oldText,
  newText,
  rows: rowsProp,
  language = "",
  startLine = 1,
  context = 3,
  className,
  maxHeight,
}: DiffViewProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(
    () =>
      rowsProp ??
      computeRows(oldText ?? "", newText ?? "", startLine),
    [rowsProp, oldText, newText, startLine],
  );

  const highlightOn = language !== "" && rows.length <= HIGHLIGHT_CAP;
  const haveSides = rowsProp == null && oldText != null && newText != null;

  // Tokenise each side once (multi-line-aware) so a row picks its highlighted
  // line by number; the unified-patch path (no sides) highlights per row.
  const oldHi = useMemo(
    () => (highlightOn && haveSides ? highlightLines(oldText ?? "", language) : null),
    [highlightOn, haveSides, oldText, language],
  );
  const newHi = useMemo(
    () => (highlightOn && haveSides ? highlightLines(newText ?? "", language) : null),
    [highlightOn, haveSides, newText, language],
  );

  const content = (row: DiffRow): ReactNode => {
    if (row.text.length === 0) return " ";
    if (!highlightOn) return row.text;
    if (haveSides && oldHi && newHi) {
      const arr = row.kind === "removed" ? oldHi : newHi;
      const no = row.kind === "removed" ? row.oldNo : row.newNo;
      if (no != null) {
        const idx = no - startLine;
        if (idx >= 0 && idx < arr.length) return arr[idx] ?? row.text;
      }
      return row.text;
    }
    return highlightOne(row.text, language) ?? row.text;
  };

  const segments = useMemo(() => foldRows(rows, context), [rows, context]);

  const renderRow = (row: DiffRow, key: string): JSX.Element => (
    <div
      key={key}
      className={cn(
        "flex min-w-0",
        row.kind === "added" && "bg-diff-add-bg",
        row.kind === "removed" && "bg-diff-remove-bg",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "w-[3px] shrink-0 self-stretch",
          row.kind === "added" && "bg-diff-add-border",
          row.kind === "removed" && "bg-diff-remove-border",
        )}
      />
      <span className="w-10 shrink-0 select-none px-1.5 text-right tabular-nums text-muted-foreground/50">
        {(row.kind === "removed" ? row.oldNo : row.newNo) ?? " "}
      </span>
      <span
        aria-hidden
        className={cn(
          "w-3 shrink-0 select-none text-center",
          row.kind === "added" && "text-diff-add-text",
          row.kind === "removed" && "text-diff-remove-text",
          row.kind === "normal" && "text-transparent",
        )}
      >
        {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : ""}
      </span>
      <code
        className="diff-hl min-w-0 flex-1 whitespace-pre-wrap break-words pr-3 pl-1"
        style={{ textIndent: "-1.5rem", paddingLeft: "1.75rem" }}
      >
        {content(row)}
      </code>
    </div>
  );

  // Walk segments with a render budget so a giant all-added Write stays bounded.
  const out: ReactNode[] = [];
  let budget = showAll ? Infinity : PREVIEW_ROWS;
  let hidden = 0;
  segments.forEach((seg, si) => {
    if (seg.kind === "gap") {
      const open = expanded.has(si);
      out.push(
        <GapDivider
          key={`gap-${si}`}
          count={seg.rows.length}
          open={open}
          onToggle={() =>
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(si)) next.delete(si);
              else next.add(si);
              return next;
            })
          }
        />,
      );
      if (!open) return;
    }
    seg.rows.forEach((row, ri) => {
      if (budget <= 0) {
        hidden++;
        return;
      }
      out.push(renderRow(row, `${si}-${ri}`));
      budget--;
    });
  });

  return (
    <div
      className={cn("overflow-auto font-mono text-[12.5px] leading-[1.55]", className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {out}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="block w-full border-t border-border bg-muted/40 px-3 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Show {hidden} more line{hidden === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
