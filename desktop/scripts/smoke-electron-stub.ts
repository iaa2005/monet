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
export const shell = {
  openPath: async (..._args: unknown[]) => "",
  showItemInFolder: (..._args: unknown[]) => undefined,
  openExternal: async (..._args: unknown[]) => undefined,
}
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
}
const fakeDisplay = {
  id: 0,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
  size: { width: 1920, height: 1080 },
}
export const screen = {
  getPrimaryDisplay: () => fakeDisplay,
  getAllDisplays: () => [fakeDisplay],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => fakeDisplay,
  on: (..._args: unknown[]) => undefined,
}
export const desktopCapturer = {
  getSources: async () => [],
}
export const nativeImage = {
  createEmpty: () => ({
    isEmpty: () => true,
    toDataURL: () => "",
    toPNG: () => Buffer.alloc(0),
    getSize: () => ({ width: 0, height: 0 }),
  }),
  createFromDataURL: (..._args: unknown[]) => ({
    toPNG: () => Buffer.alloc(0),
    getSize: () => ({ width: 0, height: 0 }),
  }),
}
export const clipboard = {
  readText: () => "",
  writeText: (..._args: unknown[]) => undefined,
  readImage: () => nativeImage.createEmpty(),
}
export const globalShortcut = {
  register: (..._args: unknown[]) => true,
  unregister: (..._args: unknown[]) => undefined,
  unregisterAll: () => undefined,
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
export default {
  ipcMain,
  BrowserWindow,
  shell,
  dialog,
  screen,
  desktopCapturer,
  nativeImage,
  clipboard,
  globalShortcut,
  app,
  safeStorage,
}
