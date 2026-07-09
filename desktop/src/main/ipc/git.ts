/**
 * Git IPC — powers the git card above the composer.
 *
 * Everything is computed from the CURRENT workspace directory: repo/branch
 * info with +/- stats, the working-tree diff for the side panel, PR creation
 * (gh CLI when available, otherwise the remote's compare URL), and small
 * shell helpers (Explorer / terminal).
 */

import { ipcMain, shell, clipboard } from "electron";
import { execFile, spawn } from "child_process";
import { basename } from "path";
import { getWorkspacePath } from "./workspace.js";

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}

/** ssh/scp-style remotes → https web URL; strips trailing .git. */
function remoteToWebUrl(remote: string): string | null {
  let url = remote.trim();
  if (!url) return null;
  const scp = url.match(/^git@([^:]+):(.+)$/);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  url = url.replace(/^ssh:\/\/git@/, "https://");
  if (!/^https?:\/\//.test(url)) return null;
  return url.replace(/\.git$/, "");
}

function hostLabel(webUrl: string | null): string {
  if (!webUrl) return "remote";
  if (/github\.com/i.test(webUrl)) return "GitHub";
  if (/gitlab/i.test(webUrl)) return "GitLab";
  if (/bitbucket/i.test(webUrl)) return "Bitbucket";
  if (/dev\.azure|visualstudio\.com/i.test(webUrl)) return "Azure DevOps";
  try {
    return new URL(webUrl).hostname;
  } catch {
    return "remote";
  }
}

export interface GitInfo {
  isRepo: boolean;
  root?: string;
  repoName?: string;
  branch?: string;
  webUrl?: string | null;
  host?: string;
  added?: number;
  removed?: number;
  filesChanged?: number;
  untracked?: number;
}

async function collectInfo(cwd: string): Promise<GitInfo> {
  let root: string;
  try {
    root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    return { isRepo: false };
  }

  const [branch, remote, numstat, untrackedOut] = await Promise.all([
    git(["branch", "--show-current"], root).catch(() => ""),
    git(["remote", "get-url", "origin"], root).catch(() => ""),
    git(["diff", "--numstat", "HEAD"], root).catch(() => ""),
    git(
      ["ls-files", "--others", "--exclude-standard"],
      root,
    ).catch(() => ""),
  ]);

  let added = 0;
  let removed = 0;
  let filesChanged = 0;
  for (const line of numstat.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    filesChanged++;
    if (m[1] !== "-") added += Number(m[1]);
    if (m[2] !== "-") removed += Number(m[2]);
  }
  const webUrl = remoteToWebUrl(remote);

  return {
    isRepo: true,
    root,
    repoName: basename(root),
    branch: branch.trim() || "(detached)",
    webUrl,
    host: hostLabel(webUrl),
    added,
    removed,
    filesChanged,
    untracked: untrackedOut.split("\n").filter(Boolean).length,
  };
}

export function registerGitIPC(): void {
  ipcMain.handle("git:info", async (_e, cwd?: string): Promise<GitInfo> => {
    try {
      return await collectInfo(cwd || getWorkspacePath());
    } catch {
      return { isRepo: false };
    }
  });

  // Working-tree diff (tracked changes vs HEAD) + list of untracked files.
  ipcMain.handle("git:diff", async (_e, cwd?: string) => {
    const dir = cwd || getWorkspacePath();
    try {
      const root = (await git(["rev-parse", "--show-toplevel"], dir)).trim();
      const [patch, untracked] = await Promise.all([
        git(["diff", "HEAD"], root).catch(() => ""),
        git(["ls-files", "--others", "--exclude-standard"], root).catch(
          () => "",
        ),
      ]);
      return {
        ok: true,
        patch,
        untracked: untracked.split("\n").filter(Boolean),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "git diff failed",
      };
    }
  });

  // PR creation: gh CLI (--fill) or the remote's compare page for "manually".
  ipcMain.handle(
    "git:createPR",
    async (
      _e,
      payload: { cwd?: string; mode: "pr" | "draft" | "manual" },
    ): Promise<{ ok: boolean; url?: string; error?: string }> => {
      const dir = payload.cwd || getWorkspacePath();
      try {
        const info = await collectInfo(dir);
        if (!info.isRepo || !info.root)
          return { ok: false, error: "Not a git repository" };

        if (payload.mode === "manual") {
          if (!info.webUrl)
            return { ok: false, error: "No https remote to open" };
          const url = `${info.webUrl}/compare/${encodeURIComponent(info.branch ?? "")}?expand=1`;
          await shell.openExternal(url);
          return { ok: true, url };
        }

        const args = ["pr", "create", "--fill"];
        if (payload.mode === "draft") args.push("--draft");
        const out = await new Promise<string>((resolve, reject) => {
          execFile(
            "gh",
            args,
            { cwd: info.root, windowsHide: true },
            (err, stdout, stderr) => {
              if (err) reject(new Error(stderr?.trim() || err.message));
              else resolve(stdout);
            },
          );
        });
        const url = out.trim().split("\n").pop() ?? "";
        if (/^https?:\/\//.test(url)) void shell.openExternal(url);
        return { ok: true, url };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "PR creation failed",
        };
      }
    },
  );

  ipcMain.handle("git:showInExplorer", (_e, path: string) => {
    shell.openPath(path).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle("git:copy", (_e, text: string) => {
    clipboard.writeText(text ?? "");
    return { ok: true };
  });

  // Windows Terminal when present, classic cmd window otherwise.
  ipcMain.handle("git:openTerminal", (_e, path: string) => {
    try {
      const child = spawn("wt.exe", ["-d", path], {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", () => {
        spawn("cmd.exe", ["/c", "start", "cmd.exe", "/K", `cd /d "${path}"`], {
          detached: true,
          stdio: "ignore",
          shell: false,
        }).unref();
      });
      child.unref();
    } catch {
      spawn("cmd.exe", ["/c", "start", "cmd.exe", "/K", `cd /d "${path}"`], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
    return { ok: true };
  });
}
