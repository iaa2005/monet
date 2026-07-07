/**
 * Shell IPC handler — run bash/powershell commands.
 */

import { ipcMain } from "electron";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export function registerShellIPC(): void {
  ipcMain.handle("shell:run", async (_event, command: string, cwd?: string) => {
    // chcp 65001 forces UTF-8 codepage on Windows (fixes Cyrillic garbled output)
    const isWin = process.platform === "win32";
    const cmd = isWin ? "chcp 65001 >nul && " + command : command;
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: cwd || process.cwd(),
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf8",
      });
      return { ok: true, stdout, stderr };
    } catch (err: unknown) {
      const execErr = err as {
        stdout?: string;
        stderr?: string;
        message: string;
      };
      return {
        ok: false,
        stdout: execErr.stdout || "",
        stderr: execErr.stderr || "",
        error: execErr.message,
      };
    }
  });
}
