/**
 * Changes panel — working-tree diff shown in the right sidebar (Code mode).
 * Loads the current workspace's git diff (tracked + untracked) and renders
 * per-file diffs with syntax highlighting via DiffView.
 */

import { useEffect, useMemo, useState } from "react";
import { DiffView } from "@/components/chat/DiffView";
import { parseUnifiedDiff, langFromPath } from "@/components/chat/diff-core";

interface DiffFileChunk {
  path: string;
  added: number;
  removed: number;
  body: string;
}

function parsePatch(patch: string): DiffFileChunk[] {
  if (!patch.trim()) return [];
  const files: DiffFileChunk[] = [];
  const parts = patch.split(/^diff --git /m).filter(Boolean);
  for (const part of parts) {
    const header = part.split("\n", 1)[0] ?? "";
    const m = header.match(/ b\/(.+)$/) ?? header.match(/^a\/.+ b\/(.+)$/);
    const path = (m?.[1] ?? header).trim();
    let added = 0;
    let removed = 0;
    for (const line of part.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    files.push({ path, added, removed, body: `diff --git ${part}` });
  }
  return files;
}

interface GitDiffResult {
  ok: boolean;
  patch?: string;
  untracked?: string[];
  error?: string;
}

interface GitDiffResult {
  ok: boolean;
  patch?: string;
  untracked?: string[];
  error?: string;
}

export function ChangesPanel(): JSX.Element {
  const [files, setFiles] = useState<DiffFileChunk[] | null>(null);
  const [untracked, setUntracked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    setFiles(null);
    setError(null);
    void window.electronAPI
      ?.git.diff()
      .then((r: GitDiffResult) => {
        if (!r.ok) setError(r.error ?? "git diff failed");
        else {
          setFiles(parsePatch(r.patch ?? ""));
          setUntracked(r.untracked ?? []);
        }
      })
      .catch((e: unknown) => setError(String(e)));
  };

  useEffect(load, []);

  const diffFiles = useMemo(
    () =>
      files?.map((f) => ({
        ...f,
        rows: parseUnifiedDiff(f.body),
        lang: langFromPath(f.path),
      })) ?? null,
    [files],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">Working tree changes</span>
        <button
          type="button"
          onClick={load}
          title="Refresh"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {error && (
          <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {files && files.length === 0 && untracked.length === 0 && !error && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No uncommitted changes.
          </p>
        )}
        {!files && !error && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Loading diff…
          </p>
        )}
        {diffFiles?.map((f) => (
          <div key={f.path} className="mb-4">
              <div className="mb-1 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {f.path}
                </span>
                <span className="shrink-0 text-[11px]">
                  <span className="text-green-text">+{f.added}</span>{" "}
                  <span className="text-red-text">−{f.removed}</span>
                </span>
              </div>
              <div className="glass-panel overflow-hidden rounded-lg border border-border bg-card">
                <DiffView
                  rows={f.rows}
                  language={f.lang}
                  maxHeight={420}
                />
              </div>
            </div>
          ))}
        {untracked.length > 0 && (
          <div className="mt-2">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Untracked
            </div>
            {untracked.map((p) => (
              <div
                key={p}
                className="truncate py-0.5 font-mono text-xs text-green-text"
              >
                + {p}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
