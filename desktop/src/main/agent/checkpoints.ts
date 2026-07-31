/**
 * Workspace checkpoints for Code Rewind — a SHADOW git repo per chat.
 *
 * We keep a hidden git store under <dataDir>/checkpoints/<sessionId> whose
 * work-tree is the user's workspace. It never touches the user's own .git (a
 * separate --git-dir) and respects the workspace's .gitignore, so heavy dirs
 * like node_modules are skipped. After each Code turn we snapshot (add -A +
 * commit); "Rewind to here" restores a snapshot with `reset --hard`, which
 * reverts edits, restores deletions and drops files the later turns added,
 * without deleting the user's untracked files.
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataSubdir } from "../data-dir.js";
import {
  DEFAULT_EXCLUDES,
  needsPackConfig,
  shadowSlug,
  withPackConfig,
} from "./checkpoint-store.js";

export function shadowDir(sessionId: string): string {
  return join(getDataSubdir("checkpoints"), shadowSlug(sessionId));
}

// The pattern list lives in checkpoint-excludes.ts — dependency-free, so a probe
// can hold it to what real git actually ignores.

/** Ensure the shadow repo's info/exclude carries our default ignores. Also
 * upgrades shadow repos created before this file existed. Cheap; idempotent. */
function ensureExcludes(gitDir: string): void {
  try {
    const infoDir = join(gitDir, "info");
    if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
    const excludePath = join(infoDir, "exclude");
    const current = existsSync(excludePath)
      ? readFileSync(excludePath, "utf8")
      : "";
    if (current !== DEFAULT_EXCLUDES) writeFileSync(excludePath, DEFAULT_EXCLUDES);
  } catch {
    /* best-effort */
  }
}

/** Write the packing settings into a store that has not got them yet. */
function ensurePacking(gitDir: string): void {
  try {
    const cfg = join(gitDir, "config");
    if (!existsSync(cfg)) return;
    const current = readFileSync(cfg, "utf8");
    if (needsPackConfig(current)) writeFileSync(cfg, withPackConfig(current));
  } catch {
    /* best-effort: an unpacked store still works */
  }
}

function git(
  workspace: string,
  gitDir: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      [
        "--git-dir",
        gitDir,
        "--work-tree",
        workspace,
        "-c",
        "user.name=Monet",
        "-c",
        "user.email=checkpoint@monet.local",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        ...args,
      ],
      { cwd: workspace, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        child.kill();
        resolve({ code: null, stdout, stderr: stderr + "\n[timeout]" });
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      done = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function isInited(gitDir: string): boolean {
  return existsSync(join(gitDir, "HEAD"));
}

/**
 * Snapshot the workspace into the chat's shadow repo. Best-effort: returns the
 * new commit sha, or null if there's no workspace / git isn't available.
 */
export async function snapshotWorkspace(
  sessionId: string,
  workspace: string | undefined,
): Promise<string | null> {
  if (!workspace || !existsSync(workspace)) return null;
  const gitDir = shadowDir(sessionId);
  try {
    if (!existsSync(gitDir)) mkdirSync(gitDir, { recursive: true });
    if (!isInited(gitDir)) {
      const init = await git(workspace, gitDir, ["init", "-q"]);
      if (init.code !== 0) {
        // Once per session is enough, but silence was worse: every failure
        // here quietly costs the user their Rewind for the turn, and "git is
        // not installed" was indistinguishable from "worked fine".
        console.error(
          `[checkpoint] git init failed (${sessionId}): ${(init.stderr || "git not available?").slice(-300)}`,
        );
        return null;
      }
    }
    ensureExcludes(gitDir);
    ensurePacking(gitDir);
    const add = await git(workspace, gitDir, ["add", "-A"]);
    if (add.code !== 0) {
      console.error(
        `[checkpoint] add failed (${sessionId}): ${(add.stderr || add.stdout).slice(-300)}`,
      );
      return null;
    }
    // --allow-empty so an unchanged turn still yields a distinct checkpoint.
    const commit = await git(workspace, gitDir, [
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `checkpoint ${new Date().toISOString()}`,
    ]);
    if (commit.code !== 0) return null;
    const rev = await git(workspace, gitDir, ["rev-parse", "HEAD"], 15_000);
    return rev.code === 0 ? rev.stdout.trim() : null;
  } catch {
    return null;
  }
}

export interface CheckpointDiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * How much would rewinding to `sha` undo? Diffs the checkpoint against the
 * latest checkpoint (HEAD) — i.e. everything that changed on later turns.
 * Cheap and side-effect-free (no add/commit), so it's safe to call on hover.
 * Returns null when there's nothing to show or git isn't available.
 */
export async function checkpointDiffStat(
  sessionId: string,
  workspace: string | undefined,
  sha: string,
): Promise<CheckpointDiffStat | null> {
  if (!workspace || !existsSync(workspace)) return null;
  const gitDir = shadowDir(sessionId);
  if (!isInited(gitDir)) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  const res = await git(
    workspace,
    gitDir,
    ["diff", "--numstat", `${sha}`, "HEAD"],
    15_000,
  );
  if (res.code !== 0) return null;
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of res.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [ins, del] = trimmed.split("\t");
    files += 1;
    // Binary files report "-" for both counts.
    if (ins && ins !== "-") insertions += Number(ins) || 0;
    if (del && del !== "-") deletions += Number(del) || 0;
  }
  return { files, insertions, deletions };
}

/** Restore the workspace to a checkpoint commit (Rewind to here). */
export async function rewindWorkspace(
  sessionId: string,
  workspace: string | undefined,
  sha: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!workspace || !existsSync(workspace))
    return { ok: false, error: "No workspace to rewind." };
  const gitDir = shadowDir(sessionId);
  if (!isInited(gitDir))
    return { ok: false, error: "No checkpoints exist for this chat yet." };
  if (!/^[0-9a-f]{7,40}$/i.test(sha))
    return { ok: false, error: "Invalid checkpoint id." };
  const kind = await git(workspace, gitDir, ["cat-file", "-t", sha], 15_000);
  if (kind.code !== 0 || kind.stdout.trim() !== "commit")
    return { ok: false, error: "That checkpoint is no longer available." };
  const reset = await git(workspace, gitDir, ["reset", "--hard", sha]);
  if (reset.code !== 0)
    return {
      ok: false,
      error: `Rewind failed:\n${(reset.stderr || reset.stdout).slice(-400)}`,
    };
  return { ok: true };
}
