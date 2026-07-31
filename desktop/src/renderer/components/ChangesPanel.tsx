/**
 * Changes — the working tree, file by file.
 *
 * Shaped after the review surface people already know: one continuous
 * scroll, a collapsible header per file carrying its own +/− counts, and
 * the diff flush underneath. Not a stack of bordered cards with their own
 * inner scrollbars — nesting a scroll inside a scroll is how you end up
 * unable to reach the middle of a file.
 *
 * Large diffs arrive COLLAPSED. A working tree with forty changed files is
 * the normal case mid-feature, and rendering forty syntax-highlighted diffs
 * to show the user a list of names costs seconds of frozen UI.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FolderGit2, RefreshCw } from "lucide-react";
import { DiffView } from "@/components/chat/DiffView";
import { parseUnifiedDiff, langFromPath } from "@/components/chat/diff-core";
import { useChatStore } from "@/stores/chatStore";
import { cn } from "@/lib/utils";
import type { GitInfo } from "@/types/electron";

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

/** Rows above this many total lines open collapsed. */
const AUTO_COLLAPSE_LINES = 600;

/** The name shown in a file header: the basename, with its folder muted. */
function FileName({ path }: { path: string }): JSX.Element {
  const cut = path.lastIndexOf("/");
  const dir = cut >= 0 ? path.slice(0, cut + 1) : "";
  const base = cut >= 0 ? path.slice(cut + 1) : path;
  return (
    <span className="min-w-0 truncate text-[13px]">
      {dir && <span className="text-muted-foreground">{dir}</span>}
      <span className="font-medium">{base}</span>
    </span>
  );
}

function Counts({ added, removed }: { added: number; removed: number }): JSX.Element {
  return (
    <span className="shrink-0 text-xs tabular-nums">
      {added > 0 && <span className="text-green-text">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-red-text">-{removed}</span>}
    </span>
  );
}

/** One file: a header that toggles, and the diff underneath when open. */
function FileSection({
  path,
  added,
  removed,
  children,
  defaultOpen,
}: {
  path: string;
  added: number;
  removed: number;
  children?: JSX.Element | null;
  defaultOpen: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <FileName path={path} />
        <span className="flex-1" />
        <Counts added={added} removed={removed} />
      </button>
      {open && children}
    </section>
  );
}

export function ChangesPanel(): JSX.Element {
  const [files, setFiles] = useState<DiffFileChunk[] | null>(null);
  const [untracked, setUntracked] = useState<string[]>([]);
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A turn that edits files changes the diff; the panel follows the work
  // instead of waiting to be refreshed by hand.
  const isStreaming = useChatStore((s) => s.isStreaming);

  const load = (): void => {
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
    void window.electronAPI?.git.info().then(setInfo).catch(() => {});
  };

  useEffect(load, []);
  useEffect(() => {
    if (!isStreaming) load();
  }, [isStreaming]);

  const diffFiles = useMemo(
    () =>
      files?.map((f) => ({
        ...f,
        rows: parseUnifiedDiff(f.body),
        lang: langFromPath(f.path),
      })) ?? null,
    [files],
  );

  const totalRows = useMemo(
    () => diffFiles?.reduce((n, f) => n + f.rows.length, 0) ?? 0,
    [diffFiles],
  );
  const collapsed = totalRows > AUTO_COLLAPSE_LINES;
  const empty =
    files && files.length === 0 && untracked.length === 0 && !error;

  return (
    <div className="flex h-full flex-col">
      {/* Where these changes live — the branch, and that this is the tree. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
        <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[13px] font-medium">
          {info?.branch ?? "working tree"}
        </span>
        {info?.branch && (
          <>
            <span className="text-muted-foreground">→</span>
            <span className="text-[13px] text-muted-foreground">working tree</span>
          </>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={load}
          title="Refresh"
          aria-label="Refresh"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      {collapsed && (
        <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          Files are collapsed for large diffs. Select a file to expand it.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="m-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {empty && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No uncommitted changes.
          </p>
        )}
        {!files && !error && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Loading diff…
          </p>
        )}

        {diffFiles?.map((f) => (
          <FileSection
            key={f.path}
            path={f.path}
            added={f.added}
            removed={f.removed}
            defaultOpen={!collapsed}
          >
            <DiffView
              rows={f.rows}
              language={f.lang}
              className={cn("border-t border-border bg-card/40 py-1")}
            />
          </FileSection>
        ))}

        {/* Untracked files have no diff to show — git has never seen them. */}
        {untracked.map((p) => (
          <FileSection key={p} path={p} added={0} removed={0} defaultOpen={false}>
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              New file — not tracked by git yet.
            </p>
          </FileSection>
        ))}
      </div>
    </div>
  );
}
