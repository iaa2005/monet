/**
 * Shell IPC handler — run bash/powershell commands.
 */

import { ipcMain } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export function registerShellIPC(): void {
  ipcMain.handle('shell:run', async (_event, command: string, cwd?: string) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: cwd || process.cwd(),
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      })
      return { ok: true, stdout, stderr }
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; message: string }
      return {
        ok: false,
        stdout: execErr.stdout || '',
        stderr: execErr.stderr || '',
        error: execErr.message,
      }
    }
  })
}
