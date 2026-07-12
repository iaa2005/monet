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
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getDataSubdir } from "../data-dir.js";

function shadowDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session";
  return join(getDataSubdir("checkpoints"), safe);
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
      if (init.code !== 0) return null;
    }
    const add = await git(workspace, gitDir, ["add", "-A"]);
    if (add.code !== 0) return null;
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
