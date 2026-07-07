/**
 * Shell IPC — uses PowerShell on Windows for proper UTF-8 encoding.
 * Falls back to cmd /c on other platforms.
 */

import { ipcMain } from "electron";
import { spawn } from "child_process";

export function registerShellIPC(): void {
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
