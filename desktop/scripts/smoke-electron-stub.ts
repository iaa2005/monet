/**
 * Electron stub for the node smoke run (scripts/smoke-agent.mjs) — the agent
 * closure touches only these surfaces at import time.
 */
export const ipcMain = {
  handle: (..._args: unknown[]) => undefined,
  on: (..._args: unknown[]) => undefined,
}
export const BrowserWindow = {
  getFocusedWindow: () => null,
  getAllWindows: () => [],
}
export const app = {
  getPath: (_name: string) => process.cwd(),
  getAppPath: () => process.cwd(),
  getName: () => 'smoke',
  isPackaged: false,
}
// provider/manager.ts (pulled in transitively via the sub-agent runner) uses
// safeStorage to (de)crypt API keys at import time.
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
}
export default { ipcMain, BrowserWindow, app, safeStorage }
