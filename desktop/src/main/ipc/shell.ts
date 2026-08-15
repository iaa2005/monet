/**
 * Shell IPC — uses PowerShell on Windows for proper UTF-8 encoding.
 * Falls back to cmd /c on other platforms.
 */

import { ipcMain, shell } from "electron";
import { spawn } from "child_process";

export function registerShellIPC(): void {
  ipcMain.handle("shell:openPath", async (_event, filePath: string) => {
    await shell.showItemInFolder(filePath);
  });

  /**
   * Open a FOLDER in the OS file manager — the folder itself, not its parent
   * with the folder selected. showItemInFolder does the latter, which is right
   * for "reveal this file" and wrong for "show me where my files are": handed
   * a directory it opens one level too high, with the thing you asked for as a
   * highlighted row you still have to double-click.
   */
  ipcMain.handle(
    "shell:openFolder",
    async (_event, dir: string): Promise<{ ok: boolean; error?: string }> => {
      // openPath answers with an error STRING (empty when it worked) rather
      // than throwing, so a missing folder is a message, not a crash.
      const error = await shell.openPath(dir);
      return error ? { ok: false, error } : { ok: true };
    },
  );

  // Open a URL in the user's real browser. Guarded to http(s) so a renderer
  // string can't launch file:// or a custom protocol handler. Use this instead
  // of <a target="_blank">: with no setWindowOpenHandler, that opens a bare
  // Electron window — the wrong place to sign into Notion/GitHub.
  ipcMain.handle(
    "shell:openExternal",
    async (_event, url: string): Promise<{ ok: boolean }> => {
      if (!/^https?:\/\//i.test(url)) return { ok: false };
      await shell.openExternal(url);
      return { ok: true };
    },
  );

  ipcMain.handle("shell:run", async (_event, command: string, cwd?: string) => {
    const isWin = process.platform === "win32";

    return new Promise((resolve) => {
      const child = isWin
        ? spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`,
            ],
            { cwd: cwd || process.cwd() },
          )
        : spawn("sh", ["-c", command], { cwd: cwd || process.cwd() });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      child.on("error", (err) => {
        resolve({ ok: false, stdout, stderr: "", error: err.message });
      });

      const timer = setTimeout(() => {
        child.kill();
        resolve({
          ok: false,
          stdout,
          stderr,
          error: "Command timed out (30s)",
        });
      }, 30000);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0,
          stdout,
          stderr,
          error: code !== 0 ? `Exit code: ${code}` : undefined,
        });
      });
    });
  });
}
