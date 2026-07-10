import { contextBridge, ipcRenderer, webUtils } from "electron";
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
      space?: string;
      attachments?: {
        name: string;
        mediaType: string;
        kind: "text" | "image" | "audio" | "video" | "file";
        text?: string;
        dataBase64?: string;
      }[];
    }): Promise<{ ok: boolean }> => ipcRenderer.invoke("chat:send", payload),
    abort: (sessionId?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("chat:abort", sessionId),
    reset: (sessionId?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("chat:reset", sessionId),
    compact: (
      sessionId?: string,
    ): Promise<{ ok: boolean; before?: number; after?: number; error?: string }> =>
      ipcRenderer.invoke("chat:compact", sessionId),
    estimate: (sessionId?: string): Promise<{ tokens: number }> =>
      ipcRenderer.invoke("chat:estimate", sessionId),
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
    setActiveModel: (providerId: string, modelId: string): Promise<boolean> =>
      ipcRenderer.invoke("providers:setActiveModel", providerId, modelId),
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
    create: (title?: string, space?: string): Promise<unknown> =>
      ipcRenderer.invoke("sessions:create", title, space),
    getById: (id: string): Promise<unknown> =>
      ipcRenderer.invoke("sessions:get", id),
    save: (session: unknown): Promise<void> =>
      ipcRenderer.invoke("sessions:save", session),
    list: (
      limit?: number,
      offset?: number,
      space?: string,
      status?: string,
      sort?: string,
      sortDir?: string,
    ): Promise<unknown[]> =>
      ipcRenderer.invoke(
        "sessions:list",
        limit,
        offset,
        space,
        status,
        sort,
        sortDir,
      ),
    search: (query: string, limit?: number): Promise<unknown[]> =>
      ipcRenderer.invoke("sessions:search", query, limit),
    deleteById: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("sessions:delete", id),
    updateTitle: (id: string, title: string): Promise<unknown> =>
      ipcRenderer.invoke("sessions:updateTitle", id, title),
    listArchived: (space?: string): Promise<unknown[]> =>
      ipcRenderer.invoke("sessions:listArchived", space),
    setArchived: (id: string, archived: boolean): Promise<void> =>
      ipcRenderer.invoke("sessions:setArchived", id, archived),
    setPinned: (id: string, pinned: boolean): Promise<void> =>
      ipcRenderer.invoke("sessions:setPinned", id, pinned),
    setWorkspace: (id: string, workspace: string): Promise<void> =>
      ipcRenderer.invoke("sessions:setWorkspace", id, workspace),
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
    files: (slug: string): Promise<{ path: string; isDir: boolean }[]> =>
      ipcRenderer.invoke("skills:files", slug),
    readFile: (
      slug: string,
      rel: string,
    ): Promise<{ ok: boolean; content?: string; error?: string }> =>
      ipcRenderer.invoke("skills:readFile", slug, rel),
    writeFile: (
      slug: string,
      rel: string,
      content: string,
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("skills:writeFile", slug, rel, content),
    importFolder: (
      path: string,
    ): Promise<{ ok: boolean; skill?: unknown; error?: string }> =>
      ipcRenderer.invoke("skills:importFolder", path),
  },

  // Absolute filesystem path for a dropped File (webUtils bridge).
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  stt: {
    transcribe: (payload: {
      audioBase64: string;
      mimeType: string;
      endpoint: string;
      apiKey?: string;
      model?: string;
      language?: string;
    }): Promise<{ ok: boolean; text?: string; error?: string }> =>
      ipcRenderer.invoke("stt:transcribe", payload),
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

  commands: {
    list: (): Promise<{
      commands: { name: string; description: string }[];
      skills: { name: string; description: string }[];
    }> => ipcRenderer.invoke("commands:list"),
  },

  sandbox: {
    getConfig: (): Promise<{ engine: string }> =>
      ipcRenderer.invoke("sandbox:getConfig"),
    setConfig: (patch: { engine?: string }): Promise<{ engine: string }> =>
      ipcRenderer.invoke("sandbox:setConfig", patch),
  },

  artifacts: {
    save: (payload: {
      sessionId: string;
      name: string;
      dataBase64: string;
    }): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke("artifacts:save", payload),
    readImage: (
      path: string,
      mediaType?: string,
    ): Promise<{ ok: boolean; dataUrl?: string; error?: string }> =>
      ipcRenderer.invoke("artifacts:readImage", path, mediaType),
    open: (path: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("artifacts:open", path),
  },

  git: {
    info: (cwd?: string): Promise<unknown> =>
      ipcRenderer.invoke("git:info", cwd),
    diff: (
      cwd?: string,
    ): Promise<{
      ok: boolean;
      patch?: string;
      untracked?: string[];
      error?: string;
    }> => ipcRenderer.invoke("git:diff", cwd),
    createPR: (payload: {
      cwd?: string;
      mode: "pr" | "draft" | "manual";
    }): Promise<{ ok: boolean; url?: string; error?: string }> =>
      ipcRenderer.invoke("git:createPR", payload),
    showInExplorer: (path: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("git:showInExplorer", path),
    copy: (text: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("git:copy", text),
    openTerminal: (path: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("git:openTerminal", path),
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
