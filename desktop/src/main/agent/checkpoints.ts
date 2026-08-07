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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
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
 * The folder a shadow repo's commits were taken FROM.
 *
 * The store is keyed by chat, not by folder, and the two ends disagreed
 * about which folder they meant: snapshots were taken in the run's own
 * cwd, while rewind and the diff used the app's global workspace. Switch
 * the workspace between a turn and a rewind and `reset --hard` wrote one
 * folder's files into another and deleted whatever the first did not have
 * — silently, and with no way back.
 *
 * So each store records its work-tree, once, and a rewind that does not
 * match refuses instead of guessing. Recorded next to the git data rather
 * than in the session DB because it is a property of the STORE: the file
 * and the commits it describes cannot be separated, moved or restored
 * apart from each other.
 */
function worktreeMarker(gitDir: string): string {
  return join(gitDir, "monet-worktree");
}

function rememberWorktree(gitDir: string, workspace: string): void {
  try {
    if (!existsSync(worktreeMarker(gitDir)))
      writeFileSync(worktreeMarker(gitDir), workspace, "utf8");
  } catch {
    /* best-effort: an unmarked store still works, it just cannot be checked */
  }
}

/** The folder this store belongs to, or null for a store made before the
 * marker existed. */
export function storedWorktree(gitDir: string): string | null {
  try {
    const p = worktreeMarker(gitDir);
    return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
  } catch {
    return null;
  }
}

/** Same folder? Compared case-insensitively and without a trailing
 * separator, because Windows hands the same directory back spelled several
 * ways and a refusal on a spelling difference is its own bug. */
export function sameFolder(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
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
    rememberWorktree(gitDir, workspace);
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

/**
 * A content-hash index of the workspace: path → blob sha.
 *
 * Git does the hashing, which is the point. `add -A` brings the index up
 * to date with the working tree — respecting the project's .gitignore and
 * the store's own excludes, so node_modules never enters the picture —
 * and `ls-files -s` then reads back an exact hash per file. Written by
 * hand this would be a directory walk plus a hashing loop plus an ignore
 * parser, and the ignore parser is the part that would be subtly wrong.
 *
 * This is what a WINDOW is made of: one of these before a tool runs and
 * one after, and the difference is what that tool changed — whether it
 * said so or not, which is how a Python script's writes are caught.
 */
export async function indexWorkspace(
  sessionId: string,
  workspace: string | undefined,
): Promise<Map<string, string> | null> {
  if (!workspace || !existsSync(workspace)) return null;
  const gitDir = shadowDir(sessionId);
  if (!isInited(gitDir)) return null;
  const add = await git(workspace, gitDir, ["add", "-A"], 60_000);
  if (add.code !== 0) return null;
  const list = await git(workspace, gitDir, ["ls-files", "-s"], 60_000);
  if (list.code !== 0) return null;
  const index = new Map<string, string>();
  for (const line of list.stdout.split("\n")) {
    // "<mode> <sha> <stage>\t<path>"
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const sha = line.slice(0, tab).split(/\s+/)[1];
    const path = line.slice(tab + 1);
    if (sha && path) index.set(path, sha);
  }
  return index;
}

/**
 * Put back exactly the files a turn changed, and nothing else.
 *
 * This replaces `reset --hard`, which restored the whole tree — including
 * files the person at the keyboard had edited while the turn ran, with no
 * warning and no way back. Here the caller has already worked out which
 * files are the turn's (see file-ledger.ts); this only carries the plan
 * out, file by file, and reports what it could not do rather than
 * pretending.
 */
export async function restoreFiles(
  sessionId: string,
  workspace: string | undefined,
  sha: string,
  plan: { write: string[]; delete: string[] },
): Promise<{ ok: boolean; restored: number; deleted: number; error?: string }> {
  if (!workspace || !existsSync(workspace))
    return { ok: false, restored: 0, deleted: 0, error: "No workspace." };
  const gitDir = shadowDir(sessionId);
  if (!isInited(gitDir))
    return { ok: false, restored: 0, deleted: 0, error: "No checkpoints yet." };
  if (!/^[0-9a-f]{7,40}$/i.test(sha))
    return { ok: false, restored: 0, deleted: 0, error: "Invalid checkpoint id." };
  const owner = storedWorktree(gitDir);
  if (owner && !sameFolder(owner, workspace))
    return {
      ok: false,
      restored: 0,
      deleted: 0,
      error: `These checkpoints belong to ${owner}, not ${workspace}.`,
    };

  let restored = 0;
  let deleted = 0;
  // `checkout <sha> -- <path>` writes one path from that commit into the
  // working tree, which is the narrow version of what reset --hard did to
  // everything. Done one at a time so a single missing path — a file that
  // did not exist at that checkpoint — costs that file and not the batch.
  for (const path of plan.write) {
    const r = await git(workspace, gitDir, ["checkout", sha, "--", path], 30_000);
    if (r.code === 0) restored++;
  }
  for (const path of plan.delete) {
    try {
      const full = join(workspace, path);
      if (existsSync(full)) {
        rmSync(full, { force: true });
        deleted++;
      }
    } catch {
      /* a file that will not delete is left, and reported by the count */
    }
  }
  return { ok: true, restored, deleted };
}

/**
 * The workspace's current checkpoint — HEAD of the shadow repo, snapshotting
 * first if the repo doesn't exist yet. What a goal records as its baseline:
 * the state of the world before any of its turns ran.
 */
export async function currentCheckpoint(
  sessionId: string,
  workspace: string | undefined,
): Promise<string | null> {
  if (!workspace || !existsSync(workspace)) return null;
  const gitDir = shadowDir(sessionId);
  if (isInited(gitDir)) {
    const rev = await git(workspace, gitDir, ["rev-parse", "HEAD"], 15_000);
    if (rev.code === 0) return rev.stdout.trim();
  }
  return snapshotWorkspace(sessionId, workspace);
}

/**
 * The full diff from a checkpoint to the working tree RIGHT NOW — the
 * completion judge's main evidence. Stages everything first so files created
 * since the checkpoint appear; the index gets rebuilt by the next snapshot
 * anyway. Capped: the judge needs the shape of the work, not every line.
 */
export async function diffSince(
  sessionId: string,
  workspace: string | undefined,
  sha: string,
  maxChars = 9_000,
): Promise<string | null> {
  if (!workspace || !existsSync(workspace)) return null;
  const gitDir = shadowDir(sessionId);
  if (!isInited(gitDir)) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  await git(workspace, gitDir, ["add", "-A"], 60_000);
  const res = await git(workspace, gitDir, ["diff", "--cached", sha], 30_000);
  if (res.code !== 0) return null;
  const out = res.stdout.trim();
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n… (diff truncated)` : out;
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

/**
 * What each turn changed, kept beside the commits it refers to.
 *
 * `<gitDir>/ledgers.json`, sha → the turn's delta. In the store rather
 * than in the session DB for the same reason the work-tree marker is: a
 * ledger without its commits restores nothing, so the two must not be
 * separable.
 */
function ledgerPath(gitDir: string): string {
  return join(gitDir, "ledgers.json");
}

export function saveLedger(
  sessionId: string,
  sha: string,
  delta: unknown,
): void {
  const gitDir = shadowDir(sessionId);
  try {
    // The store may not exist yet — the ledger is written right after a
    // snapshot creates it, but "right after" is an assumption, and a
    // silent failure here costs a rewind its precision much later.
    if (!existsSync(gitDir)) mkdirSync(gitDir, { recursive: true });
    const p = ledgerPath(gitDir);
    const all = existsSync(p)
      ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>)
      : {};
    all[sha] = delta;
    writeFileSync(p, JSON.stringify(all), "utf8");
  } catch {
    /* best-effort: without it a rewind falls back to saying it cannot */
  }
}

export function loadLedger(sessionId: string, sha: string): unknown | null {
  const gitDir = shadowDir(sessionId);
  try {
    const p = ledgerPath(gitDir);
    if (!existsSync(p)) return null;
    const all = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    return all[sha] ?? null;
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
  // The folder these commits were taken from. Resetting them onto a
  // DIFFERENT folder does not fail — it writes one project's files over
  // another's and deletes whatever the first did not contain. Refusing is
  // the only safe answer, and it is a refusal the user can act on.
  const owner = storedWorktree(gitDir);
  if (owner && !sameFolder(owner, workspace))
    return {
      ok: false,
      error:
        `This chat's checkpoints were taken in ${owner}, and the workspace is now ${workspace}. ` +
        `Rewinding would write one folder's files over the other. Switch back to ${owner} to rewind.`,
    };

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
