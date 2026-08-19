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
// The browser tab registry looks a guest up by id. Nothing is registered in a
// smoke run, so "no such page" is the honest answer for every id.
export const webContents = {
  fromId: (_id: number) => null,
  getAllWebContents: () => [],
}
export const session = {
  fromPartition: (_p: string) => ({
    clearStorageData: async () => undefined,
    clearCache: async () => undefined,
  }),
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
  scaleFactor: Number(process.env.SMOKE_SCALE_FACTOR || 1),
  size: { width: 1920, height: 1080 },
}
export const screen = {
  getPrimaryDisplay: () => fakeDisplay,
  getAllDisplays: () => [fakeDisplay],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => fakeDisplay,
  on: (..._args: unknown[]) => undefined,
  // Windows-only in the app (computer/screen.ts), and therefore the half a
  // probe written on a Mac never reaches: without these, the DIP conversion
  // throws "screen.dipToScreenPoint is not a function" the moment a probe
  // runs on win32. Scaled by the fake display's factor, so a probe can set
  // SMOKE_SCALE_FACTOR and watch a 150% screen behave like one.
  dipToScreenPoint: (p: { x: number; y: number }) => ({
    x: Math.round(p.x * fakeDisplay.scaleFactor),
    y: Math.round(p.y * fakeDisplay.scaleFactor),
  }),
  screenToDipPoint: (p: { x: number; y: number }) => ({
    x: p.x / fakeDisplay.scaleFactor,
    y: p.y / fakeDisplay.scaleFactor,
  }),
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
// net-fetch prefers net.fetch (it survives VPNs where plain fetch doesn't) and
// falls back to global fetch when it's absent — which is what we want here, so
// this only has to exist. It entered the graph with CreateRoutine: the tool can
// arm the scheduler, and the scheduler pulls in the agent to run a routine.
export const net = {}

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
  webContents,
  session,
  shell,
  dialog,
  screen,
  desktopCapturer,
  nativeImage,
  clipboard,
  globalShortcut,
  app,
  safeStorage,
  net,
}
