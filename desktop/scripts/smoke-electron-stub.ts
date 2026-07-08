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
  getName: () => 'smoke',
  isPackaged: false,
}
export default { ipcMain, BrowserWindow, app }
