/**
 * Inline diff — compact unified diff of old→new text for tool-call bubbles
 * (Edit/Write), styled like the official Claude Code edit preview.
 */

import { cn } from "@/lib/utils";

interface DiffLine {
  type: "unchanged" | "added" | "removed";
  content: string;
  oldLine?: number;
  newLine?: number;
}

function computeDiff(oldText: string, newText: string): DiffLine[] {
  // New file (Write) / full delete: skip the LCS walk so a leading empty line
  // isn't reported as a spurious removed/added pair.
  if (oldText.length === 0) {
    return newText
      .split("\n")
      .map((content, i) => ({ type: "added" as const, content, newLine: i + 1 }));
  }
  if (newText.length === 0) {
    return oldText
      .split("\n")
      .map((content, i) => ({ type: "removed" as const, content, oldLine: i + 1 }));
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const out: DiffLine[] = [];
  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (
      oi < oldLines.length &&
      ni < newLines.length &&
      oldLines[oi] === newLines[ni]
    ) {
      out.push({
        type: "unchanged",
        content: oldLines[oi],
        oldLine: oi + 1,
        newLine: ni + 1,
      });
      oi++;
      ni++;
      continue;
    }
    let found = false;
    for (let look = 1; look < 20 && oi + look < oldLines.length; look++) {
      if (oldLines[oi + look] === newLines[ni]) {
        for (let r = 0; r < look; r++)
          out.push({ type: "removed", content: oldLines[oi + r], oldLine: oi + r + 1 });
        oi += look;
        found = true;
        break;
      }
    }
    if (!found) {
      for (let look = 1; look < 20 && ni + look < newLines.length; look++) {
        if (oldLines[oi] === newLines[ni + look]) {
          for (let a = 0; a < look; a++)
            out.push({ type: "added", content: newLines[ni + a], newLine: ni + a + 1 });
          ni += look;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      if (oi < oldLines.length) {
        out.push({ type: "removed", content: oldLines[oi], oldLine: oi + 1 });
        oi++;
      }
      if (ni < newLines.length) {
        out.push({ type: "added", content: newLines[ni], newLine: ni + 1 });
        ni++;
      }
    }
  }
  return out;
}

export function diffStats(oldText: string, newText: string): {
  added: number;
  removed: number;
} {
  const d = computeDiff(oldText, newText);
  return {
    added: d.filter((l) => l.type === "added").length,
    removed: d.filter((l) => l.type === "removed").length,
  };
}

export function InlineDiff({
  oldText,
  newText,
  className,
  maxHeight = 384,
}: {
  oldText: string;
  newText: string;
  className?: string;
  maxHeight?: number;
}): JSX.Element {
  const diff = computeDiff(oldText, newText);
  return (
    <div
      className={cn(
        "overflow-auto rounded-lg border border-border bg-card font-mono text-xs leading-relaxed",
        className,
      )}
      style={{ maxHeight }}
    >
      {diff.map((line, i) => (
        <div
          key={i}
          className={cn(
            "flex px-2",
            line.type === "added" &&
              "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
            line.type === "removed" &&
              "bg-red-500/10 text-red-700 dark:text-red-400",
          )}
        >
          <span className="w-9 shrink-0 select-none pr-3 text-right text-muted-foreground/60">
            {line.oldLine ?? " "}
          </span>
          <span className="w-9 shrink-0 select-none pr-3 text-right text-muted-foreground/60">
            {line.newLine ?? " "}
          </span>
          <span className="w-3 shrink-0 select-none text-muted-foreground">
            {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
          </span>
          <span className="whitespace-pre">{line.content || " "}</span>
        </div>
      ))}
    </div>
  );
}
