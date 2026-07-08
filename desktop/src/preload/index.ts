import { contextBridge, ipcRenderer } from "electron";
import type { LLMEvent } from "../main/llm/adapter.js";
import type { LLMProvider, LLMProviderInput } from "../main/provider/types.js";
import type {
  PermissionRequest,
  PermissionDecision,
} from "../main/ipc/permissions.js";

const electronAPI = {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },

  chat: {
    send: (payload: {
      sessionId?: string;
      message: string;
      seed?: { role: "user" | "assistant"; content: string }[];
      mode?: string;
      attachments?: {
        name: string;
        mediaType: string;
        kind: "text" | "image";
        text?: string;
        dataBase64?: string;
      }[];
    }): Promise<{ ok: boolean }> => ipcRenderer.invoke("chat:send", payload),
    abort: (sessionId?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("chat:abort", sessionId),
    reset: (sessionId?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("chat:reset", sessionId),
    onToken: (
      callback: (payload: { sessionId: string; event: LLMEvent }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: { sessionId: string; event: LLMEvent },
      ) => callback(payload);
      ipcRenderer.on("chat:token", handler);
      return () => ipcRenderer.removeListener("chat:token", handler);
    },
  },

  files: {
    read: (path: string): Promise<string> =>
      ipcRenderer.invoke("files:read", path),
    write: (path: string, content: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("files:write", path, content),
    list: (
      dirPath: string,
    ): Promise<
      { name: string; isDirectory: boolean; isFile: boolean; path: string }[]
    > => ipcRenderer.invoke("files:list", dirPath),
    exists: (path: string): Promise<boolean> =>
      ipcRenderer.invoke("files:exists", path),
    pickDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke("files:pick-directory"),
    stat: (
      path: string,
    ): Promise<{ size: number; isFile: boolean; isDirectory: boolean }> =>
      ipcRenderer.invoke("files:stat", path),
  },

  shell: {
    run: (
      command: string,
      cwd?: string,
    ): Promise<{
      ok: boolean;
      stdout: string;
      stderr: string;
      error?: string;
    }> => ipcRenderer.invoke("shell:run", command, cwd),
    openPath: (path: string): Promise<void> =>
      ipcRenderer.invoke("shell:openPath", path),
  },

  providers: {
    list: (): Promise<LLMProvider[]> => ipcRenderer.invoke("providers:list"),
    get: (id: string): Promise<LLMProvider | undefined> =>
      ipcRenderer.invoke("providers:get", id),
    getActive: (): Promise<LLMProvider | undefined> =>
      ipcRenderer.invoke("providers:getActive"),
    add: (input: LLMProviderInput): Promise<LLMProvider> =>
      ipcRenderer.invoke("providers:add", input),
    update: (
      id: string,
      input: Partial<LLMProviderInput>,
    ): Promise<LLMProvider | null> =>
      ipcRenderer.invoke("providers:update", id, input),
    remove: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("providers:remove", id),
    setActive: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("providers:setActive", id),
  },

  permissions: {
    onRequest: (
      callback: (request: PermissionRequest) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, req: PermissionRequest) =>
        callback(req);
      ipcRenderer.on("permissions:request", handler);
      return () => ipcRenderer.removeListener("permissions:request", handler);
    },
    respond: (decision: PermissionDecision): void => {
      ipcRenderer.send("permissions:response", decision);
    },
  },

  workspace: {
    get: (): Promise<string> => ipcRenderer.invoke("workspace:get"),
    set: (
      path: string,
    ): Promise<{ ok: boolean; path: string; claudeMd: string | null }> =>
      ipcRenderer.invoke("workspace:set", path),
    getClaudeMd: (): Promise<string | null> =>
      ipcRenderer.invoke("workspace:getClaudeMd"),
  },

  sessions: {
    create: (title?: string): Promise<unknown> =>
      ipcRenderer.invoke("sessions:create", title),
    getById: (id: string): Promise<unknown> =>
      ipcRenderer.invoke("sessions:get", id),
    save: (session: unknown): Promise<void> =>
      ipcRenderer.invoke("sessions:save", session),
    list: (limit?: number, offset?: number): Promise<unknown[]> =>
      ipcRenderer.invoke("sessions:list", limit, offset),
    search: (query: string, limit?: number): Promise<unknown[]> =>
      ipcRenderer.invoke("sessions:search", query, limit),
    deleteById: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("sessions:delete", id),
    updateTitle: (id: string, title: string): Promise<unknown> =>
      ipcRenderer.invoke("sessions:updateTitle", id, title),
  },

  stats: {
    get: (rangeDays?: number): Promise<unknown> =>
      ipcRenderer.invoke("stats:get", rangeDays),
  },

  settings: {
    getDataDir: (): Promise<{ dir: string; isDefault: boolean }> =>
      ipcRenderer.invoke("settings:getDataDir"),
    setDataDir: (dir: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("settings:setDataDir", dir),
    pickDataDir: (): Promise<string | null> =>
      ipcRenderer.invoke("settings:pickDataDir"),
  },

  skills: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke("skills:list"),
    create: (payload: {
      name: string;
      description: string;
      instructions: string;
    }): Promise<unknown> => ipcRenderer.invoke("skills:create", payload),
    importFile: (payload: {
      filename: string;
      content: string;
    }): Promise<unknown> => ipcRenderer.invoke("skills:import", payload),
    deleteBySlug: (slug: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("skills:delete", slug),
  },

  mcp: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke("mcp:list"),
    add: (payload: { name: string; config: unknown }): Promise<unknown[]> =>
      ipcRenderer.invoke("mcp:add", payload),
    remove: (name: string): Promise<unknown[]> =>
      ipcRenderer.invoke("mcp:remove", name),
    toggle: (payload: { name: string; enabled: boolean }): Promise<unknown[]> =>
      ipcRenderer.invoke("mcp:toggle", payload),
    reconnect: (): Promise<unknown[]> => ipcRenderer.invoke("mcp:reconnect"),
  },

  win: {
    minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<boolean> =>
      ipcRenderer.invoke("window:toggleMaximize"),
    close: (): Promise<void> => ipcRenderer.invoke("window:close"),
    newWindow: (): Promise<void> => ipcRenderer.invoke("window:new"),
    isMaximized: (): Promise<boolean> =>
      ipcRenderer.invoke("window:isMaximized"),
    onMaximizeChange: (
      callback: (maximized: boolean) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, maximized: boolean) =>
        callback(maximized);
      ipcRenderer.on("window:maximized", handler);
      return () => ipcRenderer.removeListener("window:maximized", handler);
    },
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

export type ElectronAPI = typeof electronAPI;
