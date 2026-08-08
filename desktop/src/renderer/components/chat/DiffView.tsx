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

/** A hunk boundary in a unified patch: the skipped lines are not in the
 * patch at all, so there is nothing to expand — just say how many. */
function HunkDivider({ count }: { count: number }): JSX.Element {
  return (
    <div className="flex w-full items-center gap-1.5 bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground/60">
      <span className="pl-[18px]">
        {count} unmodified line{count === 1 ? "" : "s"} not shown
      </span>
    </div>
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
  // Both sides present = tokenise per side (multi-line-aware). This holds even
  // when `rows` were precomputed from those same texts — a caller that diffs
  // once and passes the result must not lose block-comment/template-literal
  // highlighting. Only the unified-patch path (rows, no texts) falls back to
  // per-row highlighting.
  const haveSides = oldText != null && newText != null;

  // Tokenise each side once (multi-line-aware) so a row picks its highlighted
  // line by number.
  const oldHi = useMemo(
    () => (highlightOn && haveSides ? highlightLines(oldText ?? "", language) : null),
    [highlightOn, haveSides, oldText, language],
  );
  const newHi = useMemo(
    () => (highlightOn && haveSides ? highlightLines(newText ?? "", language) : null),
    [highlightOn, haveSides, newText, language],
  );

  // Batch-highlight for unified-patch path: join all row texts, tokenize once,
  // split back, and assign each row its highlighted node by index. Per-row
  // refractor calls (highlightOne) would freeze the UI on modestly-sized diffs.
  const batchHi = useMemo(() => {
    if (!highlightOn || haveSides) return null;
    const texts = rows.map((r) => r.text);
    const all = texts.join("\n");
    try {
      const lines = highlightLines(all, language);
      return texts.map((_, i) => lines[i] ?? null);
    } catch {
      return null;
    }
  }, [highlightOn, haveSides, rows, language]);

  const content = (row: DiffRow, ri: number): ReactNode => {
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
    if (batchHi) return batchHi[ri] ?? row.text;
    return highlightOne(row.text, language) ?? row.text;
  };

  const segments = useMemo(() => foldRows(rows, context), [rows, context]);

  const renderRow = (row: DiffRow, key: string, ri: number): JSX.Element => (
    <div
      key={key}
      className={cn(
        "flex min-w-0",
        row.kind === "added" && "bg-green-bg",
        row.kind === "removed" && "bg-red-bg",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "w-[3px] shrink-0 self-stretch",
          row.kind === "added" && "bg-green-border",
          row.kind === "removed" && "bg-red-border",
        )}
      />
      <span
        className={cn(
          "w-10 shrink-0 select-none px-1.5 text-right tabular-nums",
          row.kind === "added"
            ? "text-green-text"
            : row.kind === "removed"
              ? "text-red-text"
              : "text-muted-foreground/50",
        )}
      >
        {(row.kind === "removed" ? row.oldNo : row.newNo) ?? " "}
      </span>
      <code
        className="diff-hl diff-wrap min-w-0 flex-1 break-words pr-3"
      >
        {content(row, ri)}
      </code>
    </div>
  );

  // Walk segments with a render budget so a giant all-added Write stays bounded.
  const out: ReactNode[] = [];
  let budget = showAll ? Infinity : PREVIEW_ROWS;
  let hidden = 0;
  let absIdx = 0;
  segments.forEach((seg, si) => {
    if (seg.kind === "gap") {
      // A hunk boundary: the rows are absent from the patch, only their count
      // is known. Nothing to expand.
      if (seg.rows.length === 0) {
        if (seg.skipped) out.push(<HunkDivider key={`hunk-${si}`} count={seg.skipped} />);
        return;
      }
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
      if (!open) {
        absIdx += seg.rows.length;
        return;
      }
    }
    seg.rows.forEach((row, ri) => {
      if (budget <= 0) {
        hidden++;
        absIdx++;
        return;
      }
      out.push(renderRow(row, `${si}-${ri}`, absIdx));
      absIdx++;
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
