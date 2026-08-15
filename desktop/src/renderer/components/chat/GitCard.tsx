/**
 * Git card — a thin repo/branch bar above the composer (Code mode).
 *
 * Left: repo name (menu: Show in Explorer / Copy path / Open on GitHub-GitLab-…
 * / Open in terminal) and the current branch (menu: Copy branch name / Open in
 * terminal). Right: "+N −M" working-tree stats (click → Changes tab in the
 * right panel) and a Create PR split menu (gh CLI or the remote's compare page).
 *
 * Refreshes on mount, workspace change, after each agent run (sessionsVersion)
 * and on window focus.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Loader2,
  Terminal as TerminalIcon,
} from "@/components/icons/hg";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import type { ElectronAPI, GitInfo } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const menuCls =
  "absolute bottom-full left-0 z-50 mb-1 w-52 rounded-lg border border-border bg-card p-1 shadow-lg";
const itemCls =
  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]";

export function GitCard(): JSX.Element | null {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [menu, setMenu] = useState<"repo" | "branch" | "pr" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const workspaceVersion = useChatStore((s) => s.workspaceVersion);
  const sessionsVersion = useChatStore((s) => s.sessionsVersion);

  const load = useCallback((): void => {
    void api()
      ?.git.info()
      .then((r) => setInfo(r))
      .catch(() => setInfo(null));
  }, []);

  useEffect(load, [load, workspaceVersion, sessionsVersion]);
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  // Close menus on outside click.
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setMenu(null);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menu]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(t);
  }, [note]);

  if (!info?.isRepo) return null;

  const copy = (text: string, label: string): void => {
    void api()?.git.copy(text);
    setMenu(null);
    setNote(`${label} copied`);
  };

  const createPR = async (mode: "pr" | "draft" | "manual"): Promise<void> => {
    setMenu(null);
    setBusy(true);
    try {
      const r = await api()?.git.createPR({ mode });
      if (r?.ok) setNote(mode === "manual" ? "Compare page opened" : "PR created");
      else setNote(r?.error?.split("\n")[0] ?? "PR creation failed");
    } finally {
      setBusy(false);
    }
  };

  const hasChanges = (info.added ?? 0) + (info.removed ?? 0) > 0 ||
    (info.filesChanged ?? 0) > 0 || (info.untracked ?? 0) > 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-1">
      <div
        ref={rootRef}
        className="glass-panel flex items-center gap-1.5 rounded-lg border border-border bg-card px-1.5 py-1.5 text-[12px]"
      >
        {/* Repo */}
        <div className="relative min-w-0">
          <button
            type="button"
            onClick={() => setMenu(menu === "repo" ? null : "repo")}
            className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 font-medium transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
            title={info.root}
          >
            <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{info.repoName}</span>
          </button>
          {menu === "repo" && (
            <div className={menuCls}>
              <button
                type="button"
                className={itemCls}
                onClick={() => {
                  void api()?.git.showInExplorer(info.root ?? "");
                  setMenu(null);
                }}
              >
                <FolderOpen className="size-3.5 text-muted-foreground" />
                Show in Explorer
              </button>
              <button
                type="button"
                className={itemCls}
                onClick={() => copy(info.root ?? "", "Path")}
              >
                <Copy className="size-3.5 text-muted-foreground" />
                Copy path
              </button>
              {info.webUrl && (
                <button
                  type="button"
                  className={itemCls}
                  onClick={() => {
                    window.open(info.webUrl ?? "", "_blank");
                    setMenu(null);
                  }}
                >
                  <ExternalLink className="size-3.5 text-muted-foreground" />
                  Open repo on {info.host}
                </button>
              )}
              <button
                type="button"
                className={itemCls}
                onClick={() => {
                  void api()?.git.openTerminal(info.root ?? "");
                  setMenu(null);
                }}
              >
                <TerminalIcon className="size-3.5 text-muted-foreground" />
                Open in terminal
              </button>
            </div>
          )}
        </div>

        {/* Branch */}
        <div className="relative min-w-0">
          <button
            type="button"
            onClick={() => setMenu(menu === "branch" ? null : "branch")}
            className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.06]"
          >
            <GitBranch className="size-3.5 shrink-0" />
            <span className="max-w-[16ch] truncate">{info.branch}</span>
          </button>
          {menu === "branch" && (
            <div className={menuCls}>
              <button
                type="button"
                className={itemCls}
                onClick={() => copy(info.branch ?? "", "Branch name")}
              >
                <Copy className="size-3.5 text-muted-foreground" />
                Copy branch name
              </button>
              <button
                type="button"
                className={itemCls}
                onClick={() => {
                  void api()?.git.openTerminal(info.root ?? "");
                  setMenu(null);
                }}
              >
                <TerminalIcon className="size-3.5 text-muted-foreground" />
                Open in terminal
              </button>
            </div>
          )}
        </div>

        <span className="flex-1" />

        {note && (
          <span className="mr-1 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            <Check className="size-3 text-green-text" />
            {note}
          </span>
        )}

        {/* +N −M → Changes tab in the right panel */}
        {hasChanges && (
          <button
            type="button"
            title="View diff"
            onClick={() => useChatStore.getState().requestOpenChanges()}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[11px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
          >
            <span className="text-green-text">+{info.added ?? 0}</span>
            <span className="text-red-text">−{info.removed ?? 0}</span>
            {(info.untracked ?? 0) > 0 && (
              <span className="text-muted-foreground">
                ·{info.untracked} new
              </span>
            )}
          </button>
        )}

        {/* Create PR */}
        <div className="relative">
          <button
            type="button"
            disabled={busy}
            onClick={() => setMenu(menu === "pr" ? null : "pr")}
            className="flex shrink-0 items-center gap-1 rounded-md bg-black/[0.05] px-2 py-1 font-medium transition-colors hover:bg-black/[0.08] disabled:opacity-60 dark:bg-white/[0.06] dark:hover:bg-white/[0.1]"
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <GitPullRequest className="size-3" />
            )}
            Create PR
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>
          {menu === "pr" && (
            <div className={cn(menuCls, "left-auto right-0")}>
              <button
                type="button"
                className={itemCls}
                onClick={() => void createPR("pr")}
              >
                <GitPullRequest className="size-3.5 text-muted-foreground" />
                Create PR
              </button>
              <button
                type="button"
                className={itemCls}
                onClick={() => void createPR("draft")}
              >
                <GitPullRequest className="size-3.5 text-muted-foreground/60" />
                Create draft PR
              </button>
              <button
                type="button"
                className={itemCls}
                onClick={() => void createPR("manual")}
              >
                <ExternalLink className="size-3.5 text-muted-foreground" />
                Manually create PR
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
