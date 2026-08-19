import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { LLMEvent } from "../main/llm/adapter.js";
import type { LLMProvider, LLMProviderInput } from "../main/provider/types.js";
import type {
  CatalogModelInfo,
  CatalogProviderInfo,
} from "../main/llm/models-dev.js";
import type {
  PermissionRequest,
  PermissionDecision,
} from "../main/ipc/permissions.js";
import type { AskUserRequest, AskUserAnswer } from "../main/ipc/ask-user.js";
import type { UiPrefs } from "../main/app/ui-prefs.js";
import type { UpdateState } from "../main/app/updater.js";
import type { FeatureFlags } from "../shared/agent-features.js";
import type { PlanApprovalRequest, PlanDecision } from "../main/ipc/plan.js";
import type { ConnectorAccount } from "../main/connectors/types.js";
import type { UiConnectorService } from "../main/connectors/services/types.js";
import type { BrowserConfig } from "../main/browser/config.js";
import type { DevServer } from "../main/browser/dev-servers.js";
import type { BrowserSelection } from "../main/browser/selection.js";
import type { Bookmark, Visit } from "../main/browser/bookmark-store.js";
import type { ServerConfig, ServerState } from "../main/browser/servers.js";
import type { SessionUiState } from "../main/session/ui-state.js";
import type { SttSettings } from "../main/stt/settings.js";
import type {
  InstallProgress,
  SttModelStatus,
} from "../main/stt/gigaam.js";
import type { TtsProgress, TtsStatus } from "../main/tts/engine.js";

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
      /** The user bubble's id, tying this prompt to its transcript turn.
       * Every send path must pass it — see ChatSendPayload in ipc/chat.ts. */
      userMessageId?: string;
      mode?: string;
      space?: string;
      effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
      /** Set on Voice Mode sends: the reply is read aloud by this voice. */
      voiceGender?: "female" | "male";
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
    /** Apply a permission-mode change to a turn already running. */
    /** Tell main which chat is on screen, so a finished turn in another one
     * (or behind another window) can raise a desktop notification. */
    setVisibleSession: (sessionId?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("chat:setVisibleSession", sessionId),
    /** Main asks the UI to open a chat — a clicked notification. */
    onFocusSession: (cb: (sessionId: string) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, id: string): void => cb(id);
      ipcRenderer.on("chat:focusSession", handler);
      return () => ipcRenderer.off("chat:focusSession", handler);
    },
    setPermissionMode: (
      sessionId: string,
      mode: string,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("chat:setPermissionMode", sessionId, mode),
    /** Hand text (and files) to a turn already in flight. ok:false = idle. */
    inject: (
      sessionId: string,
      text: string,
      attachments?: unknown[],
      space?: string,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("chat:inject", sessionId, text, attachments, space),
    /** Which prompts the model can still read — drawn directly, not derived. */
    turnContext: (
      sessionId: string,
    ): Promise<{ id: string; inContext: boolean }[]> =>
      ipcRenderer.invoke("chat:turnContext", sessionId),
    /** Take one prompt (and its turn) out of the model's context, or put it back. */
    setTurnContext: (
      sessionId: string,
      messageId: string,
      inContext: boolean,
    ): Promise<{ ok: boolean; changed: number }> =>
      ipcRenderer.invoke("chat:setTurnContext", sessionId, messageId, inContext),
    reset: (sessionId?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("chat:reset", sessionId),
    /** Copy the full-fidelity transcript into a fork's session, cut just
     * before the given prompt, with message ids renamed through `idMap` to
     * the fork's own bubble ids. */
    forkTranscript: (
      fromSessionId: string,
      toSessionId: string,
      beforePromptId?: string,
      idMap?: Record<string, string>,
    ): Promise<{ ok: boolean; removed: number; error?: string }> =>
      ipcRenderer.invoke(
        "chat:forkTranscript",
        fromSessionId,
        toSessionId,
        beforePromptId,
        idMap,
      ),
    /** Cut the model's transcript to just before this prompt's turn. Answers
     * ok:false rather than guessing when the prompt has no bound transcript
     * turn — the caller must not truncate its own display until this has
     * said yes. */
    rewindTranscript: (
      sessionId: string,
      beforePromptId: string,
    ): Promise<{ ok: boolean; removed: number; error?: string }> =>
      ipcRenderer.invoke("chat:rewindTranscript", sessionId, beforePromptId),
    compact: (
      sessionId?: string,
    ): Promise<{ ok: boolean; before?: number; after?: number; error?: string }> =>
      ipcRenderer.invoke("chat:compact", sessionId),
    estimate: (sessionId?: string): Promise<{ tokens: number }> =>
      ipcRenderer.invoke("chat:estimate", sessionId),
    contextEvents: (
      sessionId?: string,
    ): Promise<
      {
        id: string;
        seq: number;
        type: "compact" | "rewind";
        at: string;
        manual: boolean;
        beforeTokens: number | null;
        afterTokens: number | null;
      }[]
    > => ipcRenderer.invoke("chat:contextEvents", sessionId),
    undoCompact: (
      sessionId: string,
      eventId: string,
    ): Promise<{ ok: boolean; restored?: number; error?: string }> =>
      ipcRenderer.invoke("chat:undoCompact", sessionId, eventId),
    contextBreakdown: (
      sessionId?: string,
      space?: string,
    ): Promise<{
      budget: number;
      used: number;
      free: number;
      categories: { key: string; label: string; tokens: number }[];
    }> =>
      ipcRenderer.invoke(
        "chat:contextBreakdown",
        sessionId,
        space,
      ),
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
    /** Bytes, not text — a workbook cannot survive a utf-8 round trip. */
    writeBytes: (path: string, base64: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("files:writeBytes", path, base64),
    list: (
      dirPath: string,
    ): Promise<
      { name: string; isDirectory: boolean; isFile: boolean; path: string }[]
    > => ipcRenderer.invoke("files:list", dirPath),
    search: (
      rootPath: string,
      query: string,
      includeHidden?: boolean,
    ): Promise<{
      hits: { name: string; path: string; isDirectory: boolean; rel: string }[];
      truncated: boolean;
    }> => ipcRenderer.invoke("files:search", rootPath, query, includeHidden),
    /** Fires when the workspace changes on disk. Returns an unsubscribe. */
    onChanged: (cb: () => void): (() => void) => {
      const handler = (): void => cb();
      ipcRenderer.on("files:changed", handler);
      return () => ipcRenderer.off("files:changed", handler);
    },
    exists: (path: string): Promise<boolean> =>
      ipcRenderer.invoke("files:exists", path),
    pickDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke("files:pick-directory"),
    stat: (
      path: string,
    ): Promise<{ size: number; isFile: boolean; isDirectory: boolean }> =>
      ipcRenderer.invoke("files:stat", path),
    readBytes: (
      path: string,
    ): Promise<{ ok: boolean; base64?: string; error?: string }> =>
      ipcRenderer.invoke("files:readBytes", path),
    saveAs: (
      path: string,
      name?: string,
    ): Promise<{ ok: boolean; savedTo?: string; error?: string }> =>
      ipcRenderer.invoke("files:saveAs", path, name),
    create: (
      parentDir: string,
      name: string,
      isDirectory: boolean,
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke("files:create", parentDir, name, isDirectory),
    rename: (
      path: string,
      newName: string,
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke("files:rename", path, newName),
    duplicate: (
      path: string,
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke("files:duplicate", path),
    trash: (path: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("files:trash", path),
    addToGitignore: (
      root: string,
      path: string,
    ): Promise<{ ok: boolean; line?: string; error?: string }> =>
      ipcRenderer.invoke("files:addToGitignore", root, path),
    reveal: (path: string): Promise<void> =>
      ipcRenderer.invoke("files:reveal", path),
    pasteInto: (
      targetDir: string,
      sourcePath: string,
      cut: boolean,
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke("files:pasteInto", targetDir, sourcePath, cut),
  },

  shell: {
    openExternal: (url: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("shell:openExternal", url),
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
    /** Open a folder itself in the OS file manager (openPath reveals a file
     * from its parent — this is the "show me the folder" half). */
    openFolder: (dir: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("shell:openFolder", dir),
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
    orModels: (apiKey: string): Promise<{ ok: boolean; models?: unknown[]; error?: string }> =>
      ipcRenderer.invoke("providers:orModels", apiKey),
    orKeyInfo: (apiKey: string): Promise<{ ok: boolean; info?: unknown; error?: string }> =>
      ipcRenderer.invoke("providers:orKeyInfo", apiKey),
    fetchModels: (
      baseURL: string,
      apiKey: string,
    ): Promise<{ ok: boolean; models?: { name: string }[]; error?: string }> =>
      ipcRenderer.invoke("providers:fetchModels", baseURL, apiKey),
    catalogProviders: (
      force?: boolean,
    ): Promise<{
      ok: boolean;
      providers?: CatalogProviderInfo[];
      ageMs?: number | null;
      error?: string;
    }> => ipcRenderer.invoke("providers:catalogProviders", force),
    catalogModels: (
      catalogProviderId: string,
    ): Promise<{ ok: boolean; models?: CatalogModelInfo[]; error?: string }> =>
      ipcRenderer.invoke("providers:catalogModels", catalogProviderId),
    routingGet: (): Promise<{ backgroundProviderId: string; backgroundModel: string }> =>
      ipcRenderer.invoke("routing:get"),
    routingSet: (patch: {
      backgroundProviderId?: string;
      backgroundModel?: string;
    }): Promise<{ backgroundProviderId: string; backgroundModel: string }> =>
      ipcRenderer.invoke("routing:set", patch),
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
    /** The id is required: several requests can be outstanding at once, and
     * an unlabelled answer would resolve all of them. */
    respond: (id: string, decision: PermissionDecision): void => {
      ipcRenderer.send("permissions:response", { id, decision });
    },
  },

  updates: {
    /** Where the update stands: idle / available / downloading / ready /
     * error. Nothing downloads until download() is called. */
    state: (): Promise<UpdateState> => ipcRenderer.invoke("update:state"),
    check: (): Promise<UpdateState> => ipcRenderer.invoke("update:check"),
    download: (): Promise<UpdateState> => ipcRenderer.invoke("update:download"),
    install: (): Promise<void> => ipcRenderer.invoke("update:install"),
    onState: (callback: (state: UpdateState) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, state: UpdateState) =>
        callback(state);
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
  },

  plan: {
    onRequest: (
      callback: (request: PlanApprovalRequest) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        req: PlanApprovalRequest,
      ) => callback(req);
      ipcRenderer.on("plan:request", handler);
      return () => ipcRenderer.removeListener("plan:request", handler);
    },
    respond: (id: string, decision: PlanDecision, feedback?: string): void => {
      ipcRenderer.send("plan:response", { id, decision, feedback });
    },
    // The approval round-trip ended (answered, timed out, or the window is
    // going away) — the renderer must drop a pending request it still holds.
    onRequestSettled: (callback: (id: string) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, id: string) =>
        callback(id);
      ipcRenderer.on("plan:requestSettled", handler);
      return () => ipcRenderer.removeListener("plan:requestSettled", handler);
    },
    // ── The plan document (plan/store.ts) ─────────────────────────────
    current: (sessionId: string): Promise<unknown> =>
      ipcRenderer.invoke("plan:current", sessionId),
    list: (sessionId: string): Promise<unknown[]> =>
      ipcRenderer.invoke("plan:list", sessionId),
    comment: (
      planId: string,
      text: string,
      todoId?: string,
    ): Promise<unknown> =>
      ipcRenderer.invoke("plan:comment", planId, text, todoId),
    setTodo: (
      planId: string,
      todoId: string,
      status: string,
    ): Promise<unknown> =>
      ipcRenderer.invoke("plan:setTodo", planId, todoId, status),
    markdown: (planId: string): Promise<string | null> =>
      ipcRenderer.invoke("plan:markdown", planId),
    setStatus: (planId: string, status: string): Promise<unknown> =>
      ipcRenderer.invoke("plan:setStatus", planId, status),
    onChanged: (callback: (sessionId: string) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, sessionId: string) =>
        callback(sessionId);
      ipcRenderer.on("plan:changed", handler);
      return () => ipcRenderer.removeListener("plan:changed", handler);
    },
    // The MODEL changed the session's permission mode (entered plan mode, or
    // an approval flipped it to default/acceptEdits) — the selector follows.
    onModeChanged: (
      callback: (payload: { sessionId: string; mode: string }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: { sessionId: string; mode: string },
      ) => callback(payload);
      ipcRenderer.on("plan:modeChanged", handler);
      return () => ipcRenderer.removeListener("plan:modeChanged", handler);
    },
  },

  askUser: {
    onRequest: (
      callback: (request: AskUserRequest) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, req: AskUserRequest) =>
        callback(req);
      ipcRenderer.on("ask:request", handler);
      return () => ipcRenderer.removeListener("ask:request", handler);
    },
    respond: (
      id: string,
      cancelled: boolean,
      answers?: AskUserAnswer[],
    ): void => {
      ipcRenderer.send("ask:response", { id, cancelled, answers });
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

  // Durable log of tool executions — the Background tasks panel. Read-only
  // from here: rows are written by the agent loop, which is the only thing
  // that knows a tool actually ran.
  tasks: {
    list: (limit?: number): Promise<unknown[]> =>
      ipcRenderer.invoke("tasks:list", limit),
    clear: (): Promise<boolean> => ipcRenderer.invoke("tasks:clear"),
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
      activityDays?: number,
    ): Promise<unknown[]> =>
      ipcRenderer.invoke(
        "sessions:list",
        limit,
        offset,
        space,
        status,
        sort,
        sortDir,
        activityDays,
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
    onTitleChanged: (
      callback: (p: { sessionId: string; title: string }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        p: { sessionId: string; title: string },
      ) => callback(p);
      ipcRenderer.on("sessions:titleChanged", handler);
      return () => ipcRenderer.removeListener("sessions:titleChanged", handler);
    },
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
    inspectDataDir: (
      dir: string,
    ): Promise<{ exists: boolean; hasData: boolean; chats: number }> =>
      ipcRenderer.invoke("settings:inspectDataDir", dir),
    pickDataDir: (): Promise<string | null> =>
      ipcRenderer.invoke("settings:pickDataDir"),
    uiPrefs: (): Promise<UiPrefs> => ipcRenderer.invoke("settings:uiPrefs"),
    setUiPrefs: (patch: Partial<UiPrefs>): Promise<UiPrefs> =>
      ipcRenderer.invoke("settings:setUiPrefs", patch),
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

  ocr: {
    // The hidden rasteriser window's two channels. They are on the shared
    // preload because that window uses the same one as the app — it is the
    // app's own page, just never shown.
    onRasterise: (cb: (req: unknown) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, req: unknown): void => cb(req);
      ipcRenderer.on("ocr:rasterise", handler);
      return () => ipcRenderer.off("ocr:rasterise", handler);
    },
    rasterised: (payload: unknown): void => {
      ipcRenderer.send("ocr:rasterised", payload);
    },
    models: (): Promise<import("../main/ipc/ocr.js").UiOcrModel[]> =>
      ipcRenderer.invoke("ocr:models"),
    config: (): Promise<import("../main/ocr/settings.js").OcrConfig> =>
      ipcRenderer.invoke("ocr:config"),
    setConfig: (
      patch: Partial<import("../main/ocr/settings.js").OcrConfig>,
    ): Promise<import("../main/ocr/settings.js").OcrConfig> =>
      ipcRenderer.invoke("ocr:setConfig", patch),
    install: (
      modelId: string,
      dtype: string,
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("ocr:install", modelId, dtype),
    cancelInstall: (modelId: string, dtype: string): Promise<boolean> =>
      ipcRenderer.invoke("ocr:cancelInstall", modelId, dtype),
    remove: (modelId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("ocr:remove", modelId),
    pickFile: (): Promise<string | null> => ipcRenderer.invoke("ocr:pickFile"),
    layoutStatus: (): Promise<{
      repo: string;
      installed: boolean;
      bytes: number;
      size: string;
    }> => ipcRenderer.invoke("ocr:layoutStatus"),
    installLayout: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("ocr:installLayout"),
    /** Read one file and hand back the Markdown — the Settings "try it" path. */
    test: (
      path: string,
    ): Promise<{ ok: boolean; text?: string; error?: string; seconds?: number; device?: string }> =>
      ipcRenderer.invoke("ocr:test", path),
    onInstallProgress: (
      cb: (p: import("../main/ocr/install.js").OcrInstallProgress) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        p: import("../main/ocr/install.js").OcrInstallProgress,
      ): void => cb(p);
      ipcRenderer.on("ocr:installProgress", handler);
      return () => ipcRenderer.off("ocr:installProgress", handler);
    },
  },

  obsidian: {
    list: (): Promise<import("../main/ipc/obsidian.js").UiVault[]> =>
      ipcRenderer.invoke("obsidian:list"),
    add: (
      path: string,
      name?: string,
    ): Promise<{
      ok: boolean;
      vault?: import("../main/ipc/obsidian.js").UiVault;
      error?: string;
    }> => ipcRenderer.invoke("obsidian:add", path, name),
    update: (
      id: string,
      patch: {
        name?: string;
        enabled?: boolean;
        readOnly?: boolean;
        attachmentFolder?: string;
      },
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("obsidian:update", id, patch),
    remove: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("obsidian:remove", id),
    openFolder: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("obsidian:openFolder", id),
    resolve: (
      ref: string,
    ): Promise<{
      ok: boolean;
      path?: string;
      name?: string;
      candidates?: { name: string; relPath: string; vaultName: string }[];
    }> => ipcRenderer.invoke("obsidian:resolve", ref),
    openInApp: (absPath: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("obsidian:openInApp", absPath),
    exists: (refs: string[]): Promise<Record<string, boolean>> =>
      ipcRenderer.invoke("obsidian:exists", refs),
    resolveAttachment: (
      name: string,
    ): Promise<{ ok: boolean; path?: string; kind?: string }> =>
      ipcRenderer.invoke("obsidian:resolveAttachment", name),
    graph: (): Promise<{
      nodes: {
        id: string;
        name: string;
        vaultName: string;
        relPath: string;
        path: string;
        format: string;
        tags: string[];
        links: number;
      }[];
      edges: { from: string; to: string }[];
    }> => ipcRenderer.invoke("obsidian:graph"),
  },

  memory: {
    getConfig: (): Promise<{ searchChats: boolean; generateMemory: boolean; extractEveryMinutes: number }> =>
      ipcRenderer.invoke("memory:getConfig"),
    setConfig: (patch: {
      searchChats?: boolean;
      generateMemory?: boolean;
      extractEveryMinutes?: number;
    }): Promise<{ searchChats: boolean; generateMemory: boolean; extractEveryMinutes: number }> =>
      ipcRenderer.invoke("memory:setConfig", patch),
    list: (): Promise<unknown[]> => ipcRenderer.invoke("memory:list"),
    read: (
      id: string,
    ): Promise<{
      ok: boolean;
      name?: string;
      summary?: string;
      body?: string;
      error?: string;
    }> => ipcRenderer.invoke("memory:read", id),
    write: (
      id: string,
      data: { name: string; summary: string; body: string },
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("memory:write", id, data),
    deleteById: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("memory:delete", id),
    addNote: (note: string): Promise<{ ok: boolean; applied: string[] }> =>
      ipcRenderer.invoke("memory:addNote", note),
    consolidationState: (): Promise<{
      lastConsolidatedAt: number;
      lastRunAt: number;
      lastSummary: string;
      lastError: string | null;
      lastTouched: string[];
      runs: number;
      /** Log bullets waiting for the next pass. */
      pending: number;
    }> => ipcRenderer.invoke("memory:consolidationState"),
    consolidate: (): Promise<{
      ok: boolean;
      ran: boolean;
      reason?: string;
      summary?: string;
      touched?: string[];
      error?: string;
    }> => ipcRenderer.invoke("memory:consolidate"),
    lessonsList: (): Promise<
      {
        workspace: string;
        summary: string;
        body: string;
        updatedAt: number;
        canRollback: boolean;
      }[]
    > => ipcRenderer.invoke("memory:lessonsList"),
    lessonsState: (): Promise<{
      lastRunAt: number;
      lastSummary: string;
      lastError: string | null;
      lastTouched: string[];
      runs: number;
    }> => ipcRenderer.invoke("memory:lessonsState"),
    lessonsRollback: (
      workspace: string,
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("memory:lessonsRollback", workspace),
    lessonsDelete: (workspace: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("memory:lessonsDelete", workspace),
    lessonsDream: (): Promise<{
      ok: boolean;
      ran: boolean;
      reason?: string;
      touched?: string[];
      error?: string;
    }> => ipcRenderer.invoke("memory:lessonsDream"),
  },

  profile: {
    get: (): Promise<{
      name: string;
      about: string;
      avatarDataUrl: string | null;
    }> => ipcRenderer.invoke("profile:get"),
    set: (patch: {
      name?: string;
      about?: string;
    }): Promise<{ name: string; about: string }> =>
      ipcRenderer.invoke("profile:set", patch),
    setAvatarFile: (path: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("profile:setAvatarFile", path),
    paintings: (): Promise<{ ok: boolean; items?: unknown[]; error?: string }> =>
      ipcRenderer.invoke("profile:paintings"),
    paintingImage: (
      file: string,
    ): Promise<{ ok: boolean; dataUrl?: string; error?: string }> =>
      ipcRenderer.invoke("profile:paintingImage", file),
    pickPaintingFace: (file: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("profile:pickPaintingFace", file),
    onChanged: (
      callback: (p: {
        name: string;
        about: string;
        avatarDataUrl: string | null;
      }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        p: { name: string; about: string; avatarDataUrl: string | null },
      ) => callback(p);
      ipcRenderer.on("profile:changed", handler);
      return () => ipcRenderer.removeListener("profile:changed", handler);
    },
  },

  reflect: {
    digest: (
      days: number,
      force?: boolean,
    ): Promise<{ ok: boolean; digest?: unknown; error?: string }> =>
      ipcRenderer.invoke("reflect:digest", days, force),
  },

  skillStore: {
    /** Config + community catalog, in one list — see skillstore:sources. */
    getSources: (): Promise<unknown[]> =>
      ipcRenderer.invoke("skillstore:sources"),
    setSources: (list: unknown[]): Promise<unknown[]> =>
      ipcRenderer.invoke("skillstore:setSources", list),
    categories: (): Promise<string[]> =>
      ipcRenderer.invoke("skillstore:categories"),
    list: (opts?: {
      query?: string;
      offset?: number;
      category?: string;
      sort?: string;
    }): Promise<{
      ok: boolean;
      skills?: unknown[];
      errors?: string[];
      error?: string;
    }> => ipcRenderer.invoke("skillstore:list", opts),
    install: (payload: {
      source: string;
      path: string;
      uid?: string;
      kind?: string;
      hint?: string;
      repository?: string;
      name?: string;
      /** The folder the user picked among a repo's per-agent copies. */
      dir?: string;
    }): Promise<{
      ok: boolean;
      slug?: string;
      error?: string;
      candidates?: string[];
    }> => ipcRenderer.invoke("skillstore:install", payload),
    /** SKILL.md and the file list, read from the repo before installing. */
    preview: (payload: {
      source: string;
      path: string;
      kind?: string;
      repository?: string;
      hint?: string;
      name?: string;
      /** Read this folder instead of the resolved one — the agent picker. */
      dir?: string;
    }): Promise<{
      ok: boolean;
      repo?: string;
      dir?: string;
      /** Folders holding this skill, best-first, when a repo ships one per agent. */
      variants?: { dir: string; agent: string; label: string }[];
      files?: string[];
      content?: string;
      /** Every text file that was read, so the viewer shows the scripts too. */
      texts?: Record<string, string>;
      url?: string;
      /** Our own static check of those files — see src/main/skills/audit.ts. */
      audit?: {
        findings: {
          category: string;
          severity: "high" | "medium" | "low";
          file: string;
          line: number;
          detail: string;
          evidence: string;
        }[];
        filesScanned: number;
        skipped: string[];
        worst: "high" | "medium" | "low" | "none";
      };
      error?: string;
      candidates?: string[];
    }> => ipcRenderer.invoke("skillstore:preview", payload),
    /** The next page of the registry sources alone — scrolling must not
     * re-enumerate every github repo. */
    registryPage: (payload: {
      query?: string;
      offset?: number;
      category?: string;
      sort?: string;
    }): Promise<{ ok: boolean; skills?: unknown[]; error?: string }> =>
      ipcRenderer.invoke("skillstore:registryPage", payload),
    /** Curated sources published in the community repo — nothing is executed,
     * it is a list of places to look for skills. */
    suggestions: (force?: boolean): Promise<{
      ok: boolean;
      sources?: unknown[];
    }> => ipcRenderer.invoke("skillstore:suggestions", force),
    // skillsdirectory.com — a search source (~97k entries), not a browsable
    // one. It indexes GitHub, so installing is the ordinary repo download.
    searchRegistry: (payload: {
      query?: string;
      limit?: number;
    }): Promise<{ ok: boolean; skills?: unknown[]; error?: string }> =>
      ipcRenderer.invoke("skillstore:searchRegistry", payload),
    installRegistry: (payload: {
      repository: string;
      name: string;
    }): Promise<{
      ok: boolean;
      slug?: string;
      error?: string;
      candidates?: string[];
    }> => ipcRenderer.invoke("skillstore:installRegistry", payload),
  },

  mcpRegistry: {
    search: (payload: {
      query?: string;
      limit?: number;
    }): Promise<{ ok: boolean; servers?: unknown[]; error?: string }> =>
      ipcRenderer.invoke("mcpregistry:search", payload),
  },

  agents: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke("agents:list"),
    create: (payload: {
      name: string;
      description: string;
      prompt: string;
      tools?: string[];
      model?: string;
      effort?: string;
    }): Promise<unknown> => ipcRenderer.invoke("agents:create", payload),
    getRaw: (
      slug: string,
    ): Promise<{ ok: boolean; content?: string; error?: string }> =>
      ipcRenderer.invoke("agents:getRaw", slug),
    writeRaw: (
      slug: string,
      content: string,
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("agents:writeRaw", slug, content),
    deleteBySlug: (slug: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("agents:delete", slug),
    availableTools: (): Promise<string[]> =>
      ipcRenderer.invoke("agents:availableTools"),
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
    /** Dictation settings, stored in the data dir (key encrypted at rest). */
    getSettings: (): Promise<SttSettings> =>
      ipcRenderer.invoke("stt:getSettings"),
    setSettings: (patch: Partial<SttSettings>): Promise<SttSettings> =>
      ipcRenderer.invoke("stt:setSettings", patch),

    /** On-device GigaAM (sherpa-onnx in main) — the Russian-speaking engine. */
    nativeAvailable: (): Promise<boolean> =>
      ipcRenderer.invoke("stt:nativeAvailable"),
    models: (): Promise<SttModelStatus[]> => ipcRenderer.invoke("stt:models"),
    installModel: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("stt:installModel", id),
    cancelInstall: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("stt:cancelInstall", id),
    removeModel: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("stt:removeModel", id),
    /** 16 kHz mono PCM straight from the recorder — no file, no CORS, no key. */
    transcribePcm: (p: {
      modelId: string;
      samples: Float32Array;
      sampleRate: number;
    }): Promise<{ ok: boolean; text?: string; error?: string; ms?: number }> =>
      ipcRenderer.invoke("stt:transcribePcm", p),
    onModelProgress: (cb: (p: InstallProgress) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, p: InstallProgress): void =>
        cb(p);
      ipcRenderer.on("stt:modelProgress", handler);
      return () => ipcRenderer.off("stt:modelProgress", handler);
    },
  },

  /** On-device voice (Supertonic 3) — synthesis in main, playback here. */
  voice: {
    readiness: (): Promise<{
      ready: boolean;
      stt: { ok: boolean; reason: string };
      tts: { ok: boolean; reason: string };
    }> => ipcRenderer.invoke("voice:readiness"),
  },
  tts: {
    available: (): Promise<boolean> => ipcRenderer.invoke("tts:available"),
    status: (): Promise<TtsStatus> => ipcRenderer.invoke("tts:status"),
    install: (firstVoice: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("tts:install", firstVoice),
    cancelInstall: (): Promise<boolean> => ipcRenderer.invoke("tts:cancelInstall"),
    remove: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("tts:remove"),
    installVoice: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("tts:installVoice", id),
    importVoice: (p: {
      name: string;
      gender: "F" | "M";
    }): Promise<{ ok: boolean; id?: string; error?: string }> =>
      ipcRenderer.invoke("tts:importVoice", p),
    removeVoice: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("tts:removeVoice", id),
    prepareCloner: (p: {
      samplesBase64: string;
      sampleRate: number;
      name: string;
      lang: string;
    }): Promise<{
      ok: boolean;
      dir?: string;
      command?: string;
      seconds?: number;
      error?: string;
    }> => ipcRenderer.invoke("tts:prepareCloner", p),
    revealCloner: (): Promise<void> => ipcRenderer.invoke("tts:revealCloner"),
    speak: (p: {
      text: string;
      voice: string;
      lang?: string;
      steps?: number;
      speed?: number;
    }): Promise<{
      ok: boolean;
      samplesBase64?: string;
      sampleRate?: number;
      ms?: number;
      error?: string;
    }> => ipcRenderer.invoke("tts:speak", p),
    stripTags: (text: string): Promise<string> =>
      ipcRenderer.invoke("tts:stripTags", text),
    onProgress: (cb: (p: TtsProgress) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, p: TtsProgress): void => cb(p);
      ipcRenderer.on("tts:progress", handler);
      return () => ipcRenderer.off("tts:progress", handler);
    },
  },

  goal: {
    get: (sessionId: string): Promise<unknown> =>
      ipcRenderer.invoke("goal:get", sessionId),
    start: (
      sessionId: string,
      input: {
        objective: string;
        completionCriterion?: string;
        connectorGrants?: string[];
        maxTurns?: number;
        maxTokens?: number;
      },
    ): Promise<{ ok: boolean; goal?: unknown; error?: string }> =>
      ipcRenderer.invoke("goal:start", sessionId, input),
    pause: (sessionId: string): Promise<unknown> =>
      ipcRenderer.invoke("goal:pause", sessionId),
    resume: (sessionId: string): Promise<unknown> =>
      ipcRenderer.invoke("goal:resume", sessionId),
    cancel: (sessionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("goal:cancel", sessionId),
  },

  mcp: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke("mcp:list"),
    tools: (server: string): Promise<{ name: string; description: string }[]> =>
      ipcRenderer.invoke("mcp:tools", server),
    add: (payload: { name: string; config: unknown }): Promise<unknown[]> =>
      ipcRenderer.invoke("mcp:add", payload),
    remove: (name: string): Promise<unknown[]> =>
      ipcRenderer.invoke("mcp:remove", name),
    toggle: (payload: { name: string; enabled: boolean }): Promise<unknown[]> =>
      ipcRenderer.invoke("mcp:toggle", payload),
    reconnect: (): Promise<unknown[]> => ipcRenderer.invoke("mcp:reconnect"),
    /** Browser OAuth sign-in for a remote server. */
    signIn: (
      name: string,
    ): Promise<{ ok: boolean; error?: string; servers?: unknown[] }> =>
      ipcRenderer.invoke("mcp:signIn", name),
    signOut: (name: string): Promise<unknown[]> =>
      ipcRenderer.invoke("mcp:signOut", name),
  },

  commands: {
    list: (): Promise<{
      commands: { name: string; description: string }[];
      skills: { name: string; description: string }[];
    }> => ipcRenderer.invoke("commands:list"),
  },

  incognito: {
    purge: (sessionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("incognito:purge", sessionId),
  },

  browser: {
    getConfig: (): Promise<BrowserConfig> =>
      ipcRenderer.invoke("browser:getConfig"),
    setConfig: (patch: Partial<BrowserConfig>): Promise<BrowserConfig> =>
      ipcRenderer.invoke("browser:setConfig", patch),
    /** Chromium partition for the panel's webview (cookies, localStorage). */
    partition: (sessionId?: string): Promise<string> =>
      ipcRenderer.invoke("browser:partition", sessionId),
    clearData: (partition: string): Promise<void> =>
      ipcRenderer.invoke("browser:clearData", partition),
    devServers: (): Promise<DevServer[]> =>
      ipcRenderer.invoke("browser:devServers"),
    /** The bridge engine: pairing code, whether a browser answered, and which
     * tab it is holding. */
    bridgeStatus: (): Promise<{
      listening: boolean;
      port: number;
      connected: boolean;
      tabs: {
        id: number;
        url: string;
        title: string;
        session: string | null;
        active: boolean;
      }[];
      token: string;
    }> => ipcRenderer.invoke("browser:bridgeStatus"),
    /** Mint a new pairing code — every paired browser is dropped. */
    bridgeRegenerate: (): Promise<string> =>
      ipcRenderer.invoke("browser:bridgeRegenerate"),
    /** Copy the extension somewhere Chrome's "Load unpacked" can take, and
     * reveal it. Answers with the folder. */
    bridgeExport: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke("browser:bridgeExport"),
    /** Tell main which guest belongs to this tab (after dom-ready). */
    registerTab: (tabId: string, webContentsId: number): Promise<void> =>
      ipcRenderer.invoke("browser:registerTab", tabId, webContentsId),
    unregisterTab: (tabId: string): Promise<void> =>
      ipcRenderer.invoke("browser:unregisterTab", tabId),
    activateTab: (tabId: string): Promise<void> =>
      ipcRenderer.invoke("browser:activateTab", tabId),
    /** A page asked for target=_blank; main routed it back for a new tab. */
    onOpenTab: (
      cb: (url: string, ownerSessionId?: string) => void,
    ): (() => void) => {
      const handler = (_e: unknown, url: string, owner?: string): void =>
        cb(url, owner);
      ipcRenderer.on("browser:openTab", handler);
      return () => ipcRenderer.off("browser:openTab", handler);
    },
    /** Hidden browser layer: pages a run keeps while its chat is off screen. */
    adoptHeadless: (sessionId: string): Promise<string[]> =>
      ipcRenderer.invoke("browser:adoptHeadless", sessionId),
    toHeadless: (sessionId: string, urls: string[]): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("browser:toHeadless", sessionId, urls),
    hasHeadless: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke("browser:hasHeadless", sessionId),
    /** Per-chat layout: panel, terminal, browser tabs. */
    uiState: {
      get: (sessionId: string): Promise<SessionUiState | null> =>
        ipcRenderer.invoke("uistate:get", sessionId),
      set: (sessionId: string, state: SessionUiState): Promise<void> =>
        ipcRenderer.invoke("uistate:set", sessionId, state),
    },
    pickFile: (): Promise<string | null> =>
      ipcRenderer.invoke("browser:pickFile"),
    saveScreenshot: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("browser:saveScreenshot"),
    /** Main needs the panel on screen before a screenshot or a scroll. */
    onReveal: (cb: () => void): (() => void) => {
      const handler = (): void => cb();
      ipcRenderer.on("browser:reveal", handler);
      return () => ipcRenderer.off("browser:reveal", handler);
    },
    /** Dev servers declared in the workspace's .monet/servers.json. */
    servers: {
      list: (): Promise<ServerState[]> => ipcRenderer.invoke("servers:list"),
      save: (servers: ServerConfig[]): Promise<void> =>
        ipcRenderer.invoke("servers:save", servers),
      start: (id: string): Promise<void> => ipcRenderer.invoke("servers:start", id),
      stop: (id: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke("servers:stop", id),
      output: (id: string): Promise<string> =>
        ipcRenderer.invoke("servers:output", id),
      suggest: (): Promise<ServerConfig[]> => ipcRenderer.invoke("servers:suggest"),
      onChanged: (cb: () => void): (() => void) => {
        const handler = (): void => cb();
        ipcRenderer.on("browser:serversChanged", handler);
        return () => ipcRenderer.off("browser:serversChanged", handler);
      },
    },
    /** Bookmarks + visit history behind the empty tab and the toolbar star. */
    bookmarks: {
      list: (): Promise<Bookmark[]> => ipcRenderer.invoke("bookmarks:list"),
      toggle: (url: string, title: string): Promise<{ bookmarked: boolean }> =>
        ipcRenderer.invoke("bookmarks:toggle", url, title),
      remove: (id: string): Promise<void> =>
        ipcRenderer.invoke("bookmarks:remove", id),
      isBookmarked: (url: string): Promise<boolean> =>
        ipcRenderer.invoke("bookmarks:isBookmarked", url),
      recent: (limit?: number): Promise<Visit[]> =>
        ipcRenderer.invoke("bookmarks:recent", limit),
      onChanged: (cb: () => void): (() => void) => {
        const handler = (): void => cb();
        ipcRenderer.on("browser:bookmarksChanged", handler);
        return () => ipcRenderer.off("browser:bookmarksChanged", handler);
      },
    },
    setDesignMode: (on: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("browser:setDesignMode", on),
    /** The user picked an element (or marked a region) in design mode. */
    onSelection: (cb: (sel: BrowserSelection) => void): (() => void) => {
      const handler = (_e: unknown, sel: BrowserSelection): void => cb(sel);
      ipcRenderer.on("browser:selection", handler);
      return () => ipcRenderer.off("browser:selection", handler);
    },
    /** The page turned design mode off itself (Escape). */
    onDesignMode: (cb: (on: boolean) => void): (() => void) => {
      const handler = (_e: unknown, on: boolean): void => cb(on);
      ipcRenderer.on("browser:designMode", handler);
      return () => ipcRenderer.off("browser:designMode", handler);
    },
  },

  computer: {
    getConfig: (): Promise<{ enabled: boolean; deniedApps: string[] }> =>
      ipcRenderer.invoke("computer:getConfig"),
    setConfig: (patch: {
      enabled?: boolean;
      deniedApps?: string[];
    }): Promise<{ enabled: boolean; deniedApps: string[] }> =>
      ipcRenderer.invoke("computer:setConfig", patch),
    overlayPreview: (): Promise<void> =>
      ipcRenderer.invoke("computer:overlayPreview"),
    permissions: (): Promise<{
      supported: boolean;
      ax: boolean;
      screen: boolean;
      helper: boolean;
    }> => ipcRenderer.invoke("computer:permissions"),
    openPrivacy: (pane: "accessibility" | "screen"): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("computer:openPrivacy", pane),
    /** True while the window is parked in the corner for a Computer Use run. */
    onParked: (cb: (parked: boolean) => void): (() => void) => {
      const handler = (_e: unknown, parked: boolean): void => cb(parked);
      ipcRenderer.on("computer:parked", handler);
      return () => ipcRenderer.removeListener("computer:parked", handler);
    },
  },

  connectors: {
    presets: (): Promise<UiConnectorService[]> =>
      ipcRenderer.invoke("connectors:presets"),
    list: (): Promise<ConnectorAccount[]> => ipcRenderer.invoke("connectors:list"),
    options: (): Promise<
      { id: string; label: string; kind: "connector" | "mcp" }[]
    > => ipcRenderer.invoke("connectors:options"),
    add: (input: {
      presetId: string;
      label?: string;
      username: string;
      secret: Record<string, string>;
    }): Promise<ConnectorAccount> => ipcRenderer.invoke("connectors:add", input),
    update: (
      id: string,
      patch: { label?: string; username?: string; enabled?: boolean },
    ): Promise<ConnectorAccount | null> =>
      ipcRenderer.invoke("connectors:update", id, patch),
    delete: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("connectors:delete", id),
    test: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("connectors:test", id),
    setPermission: (
      accountId: string,
      actionId: string,
      level: "allow" | "ask" | "deny" | null,
    ): Promise<ConnectorAccount | null> =>
      ipcRenderer.invoke("connectors:setPermission", accountId, actionId, level),
    storeCatalog: (): Promise<{
      entries: {
        id: string;
        name: string;
        company: string;
        description: string;
        version: string;
        capabilities: string[];
        iconSvg?: string;
      }[];
      error?: string;
    }> => ipcRenderer.invoke("connectors:storeCatalog"),
    storePreview: (
      id: string,
    ): Promise<{
      ok: boolean;
      preview?: {
        id: string;
        name: string;
        version: string;
        authKind: string;
        capabilities: string[];
        endpoints: string[];
        note?: string;
      };
      error?: string;
    }> => ipcRenderer.invoke("connectors:storePreview", id),
    storeInstall: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("connectors:storeInstall", id),
    storeRemove: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("connectors:storeRemove", id),
    storeInstalled: (): Promise<string[]> =>
      ipcRenderer.invoke("connectors:storeInstalled"),
    googleSignIn: (opts: {
      presetId: string;
      clientId: string;
      clientSecret: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("connectors:googleSignIn", opts),
    telegramSendCode: (opts: {
      accountId: string;
      apiId: string;
      apiHash: string;
      phone: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("connectors:telegramSendCode", opts),
    telegramSignIn: (opts: {
      accountId: string;
      code: string;
      password?: string;
    }): Promise<{ ok: boolean; error?: string; needsPassword?: boolean }> =>
      ipcRenderer.invoke("connectors:telegramSignIn", opts),
    mcpOAuthSignIn: (opts: {
      presetId: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("connectors:mcpOAuthSignIn", opts),
    /** Connectors whose OAuth grant is missing or refused. */
    authNeeds: (): Promise<
      {
        accountId: string;
        presetId: string;
        label: string;
        reason: "never-signed-in" | "expired";
        detail?: string;
      }[]
    > => ipcRenderer.invoke("connectors:authNeeds"),
  },

  sandbox: {
    getConfig: (): Promise<{ engine: string }> =>
      ipcRenderer.invoke("sandbox:getConfig"),
    setConfig: (patch: { engine?: string }): Promise<{ engine: string }> =>
      ipcRenderer.invoke("sandbox:setConfig", patch),
    preparePodman: (): Promise<{ ok: boolean; error?: string; needsWsl?: boolean }> =>
      ipcRenderer.invoke("sandbox:preparePodman"),
    checkPodman: (): Promise<{ ok: boolean; error?: string; needsWsl?: boolean }> =>
      ipcRenderer.invoke("sandbox:checkPodman"),
    isPodmanReady: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("sandbox:isPodmanReady"),
    warmPodman: (sessionId?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("sandbox:warmPodman", sessionId),
    /**
     * A live shell for this chat, in a pty. It outlives the panel and the chat
     * switch — `open` on an existing session redraws from its buffer.
     */
    terminal: {
      /** With a terminalId: reattach to it. Without: start another one. */
      open: (
        sessionId: string,
        space: string | undefined,
        cols?: number,
        rows?: number,
        terminalId?: string,
      ): Promise<{
        ok: boolean;
        id?: string;
        title?: string;
        buffer?: string;
        error?: string;
      }> =>
        ipcRenderer.invoke(
          "terminal:open",
          sessionId,
          space,
          cols,
          rows,
          terminalId,
        ),
      list: (sessionId: string): Promise<{ id: string; title: string }[]> =>
        ipcRenderer.invoke("terminal:list", sessionId),
      write: (terminalId: string, data: string): void =>
        ipcRenderer.send("terminal:write", terminalId, data),
      resize: (terminalId: string, cols: number, rows: number): void =>
        ipcRenderer.send("terminal:resize", terminalId, cols, rows),
      close: (terminalId: string): Promise<void> =>
        ipcRenderer.invoke("terminal:close", terminalId),
      has: (terminalId: string): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke("terminal:has", terminalId),
      /** Output as it happens. Returns an unsubscribe. */
      onData: (fn: (terminalId: string, data: string) => void): (() => void) => {
        const h = (_e: unknown, terminalId: string, data: string): void =>
          fn(terminalId, data);
        ipcRenderer.on("terminal:data", h);
        return () => ipcRenderer.removeListener("terminal:data", h);
      },
      onExit: (fn: (terminalId: string, code: number) => void): (() => void) => {
        const h = (_e: unknown, terminalId: string, code: number): void =>
          fn(terminalId, code);
        ipcRenderer.on("terminal:exit", h);
        return () => ipcRenderer.removeListener("terminal:exit", h);
      },
    },
    /** The toolchains added on top of the base image — see image-extras.ts. */
    image: {
      get: (): Promise<{
        extras: { presets: string[]; extra: string };
        presets: {
          id: string;
          label: string;
          category: string;
          size: string;
          provides: string;
          builtin?: boolean;
        }[];
        tag: string;
      }> => ipcRenderer.invoke("sandboxImage:get"),
      set: (patch: {
        presets?: string[];
        extra?: string;
      }): Promise<{ extras: { presets: string[]; extra: string }; tag: string }> =>
        ipcRenderer.invoke("sandboxImage:set", patch),
      rebuild: (): Promise<{
        ok: boolean;
        log: string;
        error?: string;
        tag: string;
      }> => ipcRenderer.invoke("sandboxImage:rebuild"),
    },
    /** Move the zero-state ("default") sandbox files onto a newborn session. */
    adoptDefault: (sessionId: string): Promise<{ moved: number }> =>
      ipcRenderer.invoke("sandbox:adoptDefault", sessionId),
    getSessionConfig: (
      sessionId: string,
    ): Promise<{ engine: string; override: string | null }> =>
      ipcRenderer.invoke("sandbox:getSessionConfig", sessionId),
    setSessionConfig: (
      sessionId: string,
      engine: string | null,
    ): Promise<{ engine: string }> =>
      ipcRenderer.invoke("sandbox:setSessionConfig", sessionId, engine),
    listFiles: (
      sessionId?: string,
    ): Promise<
      {
        name: string;
        size: number;
        mtimeMs: number;
        path: string;
        mediaType: string;
      }[]
    > => ipcRenderer.invoke("sandbox:listFiles", sessionId),
    /** One text file from the chat's sandbox — the chart widget's `src`. */
    readText: (
      sessionId: string | undefined,
      name: string,
    ): Promise<{ ok: boolean; content?: string; error?: string }> =>
      ipcRenderer.invoke("sandbox:readText", sessionId, name),
    workDir: (sessionId?: string): Promise<string> =>
      ipcRenderer.invoke("sandbox:workDir", sessionId),
    supportsShell: (sessionId?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("sandbox:supportsShell", sessionId),
    shellRun: (
      sessionId: string,
      command: string,
    ): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> =>
      ipcRenderer.invoke("sandbox:shellRun", sessionId, command),
  },

  tuning: {
    powerGet: (): Promise<{ keepAwake: boolean; active: boolean }> =>
      ipcRenderer.invoke("power:get"),
    powerSet: (patch: {
      keepAwake?: boolean;
    }): Promise<{ keepAwake: boolean; active: boolean }> =>
      ipcRenderer.invoke("power:set", patch),
    toolSearchGet: (): Promise<{ enabled: boolean }> =>
      ipcRenderer.invoke("toolsearch:get"),
    toolSearchSet: (patch: { enabled?: boolean }): Promise<{ enabled: boolean }> =>
      ipcRenderer.invoke("toolsearch:set", patch),
    featuresGet: (): Promise<FeatureFlags> => ipcRenderer.invoke("features:get"),
    featuresSet: (patch: Partial<FeatureFlags>): Promise<FeatureFlags> =>
      ipcRenderer.invoke("features:set", patch),
    cavemanGet: (): Promise<{ enabled: boolean }> =>
      ipcRenderer.invoke("caveman:get"),
    cavemanSet: (patch: { enabled?: boolean }): Promise<{ enabled: boolean }> =>
      ipcRenderer.invoke("caveman:set", patch),
    leanGet: (): Promise<{ leanTools: boolean }> =>
      ipcRenderer.invoke("lean:get"),
    leanSet: (patch: {
      leanTools?: boolean;
    }): Promise<{ leanTools: boolean }> =>
      ipcRenderer.invoke("lean:set", patch),
    lspGet: (): Promise<{ enabled: boolean }> => ipcRenderer.invoke("lsp:get"),
    lspSet: (patch: { enabled?: boolean }): Promise<{ enabled: boolean }> =>
      ipcRenderer.invoke("lsp:set", patch),
    promptsReload: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("prompts:reload"),
    promptsReveal: (): Promise<{ ok: boolean; dir: string }> =>
      ipcRenderer.invoke("prompts:reveal"),
  },

  routines: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke("routines:list"),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke("routines:get", id),
    create: (input: unknown): Promise<unknown> =>
      ipcRenderer.invoke("routines:create", input),
    update: (id: string, patch: unknown): Promise<unknown> =>
      ipcRenderer.invoke("routines:update", id, patch),
    setEnabled: (id: string, enabled: boolean): Promise<unknown> =>
      ipcRenderer.invoke("routines:setEnabled", id, enabled),
    delete: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("routines:delete", id),
    runNow: (id: string): Promise<unknown> =>
      ipcRenderer.invoke("routines:runNow", id),
    listRuns: (id: string): Promise<unknown[]> =>
      ipcRenderer.invoke("routines:listRuns", id),
    triggerInfo: (): Promise<{ baseUrl: string; apiKey: string }> =>
      ipcRenderer.invoke("routines:triggerInfo"),
    chats: (space?: string): Promise<
        { id: string; title: string; at: string; routineId: string; routineName: string }[]
      > => ipcRenderer.invoke("routines:chats", space),
    cronPreview: (
      cron: string,
    ): Promise<
      { valid: false } | { valid: true; human: string; next: string | null }
    > => ipcRenderer.invoke("routines:cronPreview", cron),
    draft: (
      description: string,
      space: "home" | "code",
    ): Promise<{
      ok: boolean;
      draft?: {
        name: string;
        prompt: string;
        cron: string;
        space: "home" | "code";
        connectors?: string[];
        output?: { kind: "chat" | "notification" | "connector"; connector?: string };
        grants?: string[];
      };
      error?: string;
    }> => ipcRenderer.invoke("routines:draft", description, space),
    onRan: (
      callback: (p: { routineId: string; sessionId?: string; status: string }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        p: { routineId: string; sessionId?: string; status: string },
      ): void => callback(p);
      ipcRenderer.on("routines:ran", handler);
      return () => ipcRenderer.removeListener("routines:ran", handler);
    },
    onStarted: (
      callback: (p: { routineId: string; sessionId: string; name: string }) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        p: { routineId: string; sessionId: string; name: string },
      ): void => callback(p);
      ipcRenderer.on("routines:started", handler);
      return () => ipcRenderer.removeListener("routines:started", handler);
    },
  },

  transfer: {
    exportChat: (
      sessionId: string,
      opts: {
        format: "monet" | "markdown";
        includeArtifacts: boolean;
        includeContext: boolean;
        includeRawTools?: boolean;
      },
    ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
      ipcRenderer.invoke("chat:export", sessionId, opts),
    importChat: (): Promise<{
      ok: boolean;
      canceled?: boolean;
      error?: string;
      session?: {
        id: string;
        title: string;
        messages: unknown[];
        workspace?: string;
      };
    }> => ipcRenderer.invoke("chat:import"),
  },

  checkpoints: {
    rewind: (
      sessionId: string,
      sha: string,
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("checkpoints:rewind", sessionId, sha),
    diffStat: (
      sessionId: string,
      sha: string,
    ): Promise<{
      files: number;
      insertions: number;
      deletions: number;
    } | null> => ipcRenderer.invoke("checkpoints:diffStat", sessionId, sha),
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
    /** This chat's artifacts folder, in the OS file manager. */
    openFolder: (sessionId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("artifacts:openFolder", sessionId),
    readText: (
      path: string,
    ): Promise<{ ok: boolean; content?: string; error?: string }> =>
      ipcRenderer.invoke("artifacts:readText", path),
    readBytes: (
      path: string,
    ): Promise<{ ok: boolean; base64?: string; error?: string }> =>
      ipcRenderer.invoke("artifacts:readBytes", path),
    download: (
      path: string,
      name?: string,
    ): Promise<{ ok: boolean; savedTo?: string; error?: string }> =>
      ipcRenderer.invoke("artifacts:download", path, name),
    downloadAll: (
      items: { path: string; name?: string }[],
    ): Promise<{
      ok: boolean;
      savedTo?: string;
      saved?: number;
      error?: string;
    }> => ipcRenderer.invoke("artifacts:downloadAll", items),
    appIcon: (path: string): Promise<{ ok: boolean; dataUrl?: string }> =>
      ipcRenderer.invoke("artifacts:appIcon", path),
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
    isFullScreen: (): Promise<boolean> =>
      ipcRenderer.invoke("window:isFullScreen"),
    onFullScreenChange: (
      callback: (fullscreen: boolean) => void,
    ): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, fs: boolean) =>
        callback(fs);
      ipcRenderer.on("window:fullscreen", handler);
      return () => ipcRenderer.removeListener("window:fullscreen", handler);
    },
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

export type ElectronAPI = typeof electronAPI;
