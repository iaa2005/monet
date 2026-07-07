import { contextBridge } from 'electron'

// Minimal API exposed to renderer — will be extended in Step 2.3 (IPC)
const electronAPI = {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
