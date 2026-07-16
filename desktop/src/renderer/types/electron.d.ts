/**
 * Type declarations for window.electronAPI (exposed via preload).
 */

import type { LLMEvent, LLMRequest } from "../main/llm/adapter.js";
import type { LLMProvider, LLMProviderInput } from "../main/provider/types.js";
import type { ChatMessage } from "./chat";
import type {
  Routine,
  RoutineInput,
  RoutineRun,
} from "../main/routines/store.js";

export type { Routine, RoutineInput, RoutineRun };
import type {
  PermissionRequest,
  PermissionDecision,
} from "../main/ipc/permissions.js";
import type {
  AskUserRequest,
  AskUserAnswer,
  AskUserQuestionSpec,
  AskUserOption,
} from "../main/ipc/ask-user.js";

export type { PermissionRequest, PermissionDecision };
export type { AskUserRequest, AskUserAnswer, AskUserQuestionSpec, AskUserOption };

export interface SandboxFileEntry {
  name: string;
  size: number;
  mtimeMs: number;
  path: string;
  mediaType: string;
}

export interface ContextCategory {
  key: string;
  label: string;
  tokens: number;
  items?: { label: string; tokens: number }[];
}

export interface ContextBreakdown {
  budget: number;
  used: number;
  free: number;
  categories: ContextCategory[];
  apiUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  } | null;
}

export interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  author: string;
  updatedAt: number;
}

export interface MemoryFileInfo {
  id: string;
  section: "you" | "topics" | "areas";
  name: string;
  summary: string;
  updatedAt: number;
}

export interface ReflectDigest {
  headline: string;
  narrative: string;
  categories: { name: string; pct: number; detail: string }[];
  skills: {
    delegation: { title: string; body: string };
    description: { title: string; body: string };
    discernment: { title: string; body: string };
    diligence: { title: string; body: string };
  };
}

export interface PaintingInfo {
  title: string;
  year: string;
  file: string;
  width: number;
  height: number;
  faces: { file: string; bbox: { x: number; y: number; w: number; h: number } }[];
}

export interface StoreSkill {
  path: string;
  name: string;
  description: string;
  installed: boolean;
}

export interface AgentSummary {
  slug: string;
  type: string;
  description: string;
  tools?: string[];
  model?: string;
  source: "built-in" | "user";
  editable: boolean;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  oauthClientId?: string;
  timeout?: number;
  enabled?: boolean;
}

export interface McpServerStatus {
  name: string;
  status: "connected" | "connecting" | "error" | "disabled";
  toolCount: number;
  error?: string;
  config: McpServerConfig;
}

export interface GitInfo {
  isRepo: boolean;
  root?: string;
  repoName?: string;
  branch?: string;
  webUrl?: string | null;
  host?: string;
  added?: number;
  removed?: number;
  filesChanged?: number;
  untracked?: number;
}

export interface ElectronAPI {
  platform: string;
  versions: { node: string; chrome: string; electron: string };
  chat: {
    send: (payload: {
      sessionId?: string;
      message: string;
      seed?: { role: "user" | "assistant"; content: string }[];
      mode?: string;
      space?: string;
      effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
      attachments?: {
        name: string;
        mediaType: string;
        kind: "text" | "image" | "audio" | "video" | "file";
        text?: string;
        dataBase64?: string;
      }[];
    }) => Promise<{ ok: boolean }>;
    abort: (sessionId?: string) => Promise<{ ok: boolean }>;
    reset: (sessionId?: string) => Promise<{ ok: boolean }>;
    rewindTranscript: (
      sessionId: string,
      keepUserTurns: number,
      totalUserTurns?: number,
    ) => Promise<{ fidelity: "full" | "text"; removed: number }>;
    compact: (sessionId?: string) => Promise<{
      ok: boolean;
      before?: number;
      after?: number;
      error?: string;
    }>;
    estimate: (sessionId?: string) => Promise<{ tokens: number }>;
    contextEvents: (sessionId?: string) => Promise<
      {
        id: string;
        type: "compact" | "rewind" | "command";
        at: string;
        manual: boolean;
        beforeTokens: number | null;
        afterTokens: number | null;
      }[]
    >;
    undoCompact: (
      sessionId: string,
      eventId: string,
    ) => Promise<{ ok: boolean; restored?: number; error?: string }>;
    contextBreakdown: (
      sessionId?: string,
      space?: string,
      messageTokens?: number,
    ) => Promise<ContextBreakdown>;
    onToken: (
      callback: (payload: { sessionId: string; event: LLMEvent }) => void,
    ) => () => void;
  };
  files: {
    read: (path: string) => Promise<string>;
    write: (path: string, content: string) => Promise<{ ok: boolean }>;
    list: (
      dirPath: string,
    ) => Promise<
      { name: string; isDirectory: boolean; isFile: boolean; path: string }[]
    >;
    exists: (path: string) => Promise<boolean>;
    pickDirectory: () => Promise<string | null>;
    stat: (
      path: string,
    ) => Promise<{ size: number; isFile: boolean; isDirectory: boolean }>;
    readBytes: (
      path: string,
    ) => Promise<{ ok: boolean; base64?: string; error?: string }>;
    saveAs: (
      path: string,
      name?: string,
    ) => Promise<{ ok: boolean; savedTo?: string; error?: string }>;
  };
  shell: {
    run: (
      command: string,
      cwd?: string,
    ) => Promise<{
      ok: boolean;
      stdout: string;
      stderr: string;
      error?: string;
    }>;
    openPath: (path: string) => Promise<void>;
  };
  providers: {
    list: () => Promise<LLMProvider[]>;
    get: (id: string) => Promise<LLMProvider | undefined>;
    getActive: () => Promise<LLMProvider | undefined>;
    add: (input: LLMProviderInput) => Promise<LLMProvider>;
    update: (
      id: string,
      input: Partial<LLMProviderInput>,
    ) => Promise<LLMProvider | null>;
    remove: (id: string) => Promise<boolean>;
    setActive: (id: string) => Promise<boolean>;
    setActiveModel: (providerId: string, modelId: string) => Promise<boolean>;
  };
  permissions: {
    onRequest: (callback: (request: PermissionRequest) => void) => () => void;
    respond: (decision: PermissionDecision) => void;
  };
  askUser: {
    onRequest: (callback: (request: AskUserRequest) => void) => () => void;
    respond: (
      id: string,
      cancelled: boolean,
      answers?: AskUserAnswer[],
    ) => void;
  };
  workspace: {
    get: () => Promise<string>;
    set: (
      path: string,
    ) => Promise<{ ok: boolean; path: string; claudeMd: string | null }>;
    getClaudeMd: () => Promise<string | null>;
  };
  sessions: {
    create: (title?: string, space?: string) => Promise<unknown>;
    getById: (id: string) => Promise<unknown>;
    save: (session: unknown) => Promise<void>;
    list: (
      limit?: number,
      offset?: number,
      space?: string,
      status?: string,
      sort?: string,
      sortDir?: string,
    ) => Promise<unknown[]>;
    search: (query: string, limit?: number) => Promise<unknown[]>;
    deleteById: (id: string) => Promise<boolean>;
    updateTitle: (id: string, title: string) => Promise<unknown>;
    listArchived: (space?: string) => Promise<unknown[]>;
    setArchived: (id: string, archived: boolean) => Promise<void>;
    setPinned: (id: string, pinned: boolean) => Promise<void>;
    setWorkspace: (id: string, workspace: string) => Promise<void>;
    onTitleChanged: (
      callback: (p: { sessionId: string; title: string }) => void,
    ) => () => void;
  };
  stats: {
    get: (rangeDays?: number) => Promise<{
      sessions: number;
      messages: number;
      userMessages: number;
      activeDays: number;
      currentStreak: number;
      longestStreak: number;
      peakHour: number | null;
      approxTokens: number;
      perDay: { date: string; count: number }[];
      perDayMinutes: { date: string; minutes: number }[];
    }>;
  };
  settings: {
    getDataDir: () => Promise<{ dir: string; isDefault: boolean }>;
    setDataDir: (dir: string) => Promise<{ ok: boolean }>;
    pickDataDir: () => Promise<string | null>;
  };
  skills: {
    list: () => Promise<SkillInfo[]>;
    create: (payload: {
      name: string;
      description: string;
      instructions: string;
    }) => Promise<SkillInfo>;
    importFile: (payload: {
      filename: string;
      content: string;
    }) => Promise<SkillInfo>;
    deleteBySlug: (slug: string) => Promise<{ ok: boolean }>;
    files: (slug: string) => Promise<{ path: string; isDir: boolean }[]>;
    readFile: (
      slug: string,
      rel: string,
    ) => Promise<{ ok: boolean; content?: string; error?: string }>;
    writeFile: (
      slug: string,
      rel: string,
      content: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    importFolder: (
      path: string,
    ) => Promise<{ ok: boolean; skill?: SkillInfo; error?: string }>;
  };
  memory: {
    getConfig: () => Promise<{ searchChats: boolean; generateMemory: boolean; extractEveryMinutes: number }>;
    setConfig: (patch: {
      searchChats?: boolean;
      generateMemory?: boolean;
      extractEveryMinutes?: number;
    }) => Promise<{ searchChats: boolean; generateMemory: boolean; extractEveryMinutes: number }>;
    list: () => Promise<MemoryFileInfo[]>;
    read: (id: string) => Promise<{
      ok: boolean;
      name?: string;
      summary?: string;
      body?: string;
      error?: string;
    }>;
    write: (
      id: string,
      data: { name: string; summary: string; body: string },
    ) => Promise<{ ok: boolean; error?: string }>;
    deleteById: (id: string) => Promise<{ ok: boolean }>;
    addNote: (note: string) => Promise<{ ok: boolean; applied: string[] }>;
  };
  profile: {
    get: () => Promise<{
      name: string;
      about: string;
      fullName: string;
      work: string;
      avatarDataUrl: string | null;
    }>;
    set: (patch: {
      name?: string;
      about?: string;
      fullName?: string;
      work?: string;
    }) => Promise<{ name: string; about: string; fullName: string; work: string }>;
    setAvatarFile: (path: string) => Promise<{ ok: boolean; error?: string }>;
    setAvatarUrl: (url: string) => Promise<{ ok: boolean; error?: string }>;
    paintings: () => Promise<{
      ok: boolean;
      items?: PaintingInfo[];
      error?: string;
    }>;
    paintingImage: (
      file: string,
    ) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
    pickPaintingFace: (file: string) => Promise<{ ok: boolean; error?: string }>;
    gallery: () => Promise<{
      ok: boolean;
      items?: { url: string; dataUrl: string }[];
      error?: string;
    }>;
    onChanged: (
      callback: (p: {
        name: string;
        about: string;
        avatarDataUrl: string | null;
      }) => void,
    ) => () => void;
  };
  reflect: {
    digest: (
      days: number,
      force?: boolean,
    ) => Promise<{ ok: boolean; digest?: ReflectDigest; error?: string }>;
  };
  skillStore: {
    getSource: () => Promise<string>;
    setSource: (source: string) => Promise<string>;
    list: () => Promise<{ ok: boolean; skills?: StoreSkill[]; error?: string }>;
    install: (
      dir: string,
    ) => Promise<{ ok: boolean; slug?: string; error?: string }>;
  };
  agents: {
    list: () => Promise<AgentSummary[]>;
    create: (payload: {
      name: string;
      description: string;
      prompt: string;
      tools?: string[];
      model?: string;
      effort?: string;
    }) => Promise<AgentSummary>;
    getRaw: (
      slug: string,
    ) => Promise<{ ok: boolean; content?: string; error?: string }>;
    writeRaw: (
      slug: string,
      content: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    deleteBySlug: (slug: string) => Promise<{ ok: boolean }>;
    availableTools: () => Promise<string[]>;
  };
  /** Absolute filesystem path for a dropped/picked File. */
  getPathForFile: (file: File) => string;
  stt: {
    transcribe: (payload: {
      audioBase64: string;
      mimeType: string;
      endpoint: string;
      apiKey?: string;
      model?: string;
      language?: string;
    }) => Promise<{ ok: boolean; text?: string; error?: string }>;
  };
  mcp: {
    list: () => Promise<McpServerStatus[]>;
    add: (payload: {
      name: string;
      config: McpServerConfig;
    }) => Promise<McpServerStatus[]>;
    remove: (name: string) => Promise<McpServerStatus[]>;
    toggle: (payload: {
      name: string;
      enabled: boolean;
    }) => Promise<McpServerStatus[]>;
    reconnect: () => Promise<McpServerStatus[]>;
  };
  commands: {
    list: () => Promise<{
      commands: { name: string; description: string }[];
      skills: { name: string; description: string }[];
    }>;
  };
  incognito: {
    purge: (sessionId: string) => Promise<{ ok: boolean }>;
  };
  browser: {
    getConfig: () => Promise<{ enabled: boolean }>;
    setConfig: (patch: { enabled?: boolean }) => Promise<{ enabled: boolean }>;
  };
  computer: {
    getConfig: () => Promise<{ enabled: boolean; deniedApps: string[] }>;
    setConfig: (patch: {
      enabled?: boolean;
      deniedApps?: string[];
    }) => Promise<{ enabled: boolean; deniedApps: string[] }>;
  };
  sandbox: {
    getConfig: () => Promise<{ engine: string }>;
    setConfig: (patch: { engine?: string }) => Promise<{ engine: string }>;
    preparePodman: () => Promise<{ ok: boolean; error?: string; needsWsl?: boolean }>;
    checkPodman: () => Promise<{ ok: boolean; error?: string; needsWsl?: boolean }>;
    isPodmanReady: () => Promise<{ ok: boolean }>;
    warmPodman: () => Promise<{ ok: boolean }>;
    listFiles: (sessionId?: string) => Promise<SandboxFileEntry[]>;
    workDir: (sessionId?: string) => Promise<string>;
  };
  tuning: {
    toolSearchGet: () => Promise<{ enabled: boolean }>;
    toolSearchSet: (patch: { enabled?: boolean }) => Promise<{ enabled: boolean }>;
    lspGet: () => Promise<{ enabled: boolean }>;
    lspSet: (patch: { enabled?: boolean }) => Promise<{ enabled: boolean }>;
    promptsReload: () => Promise<{ ok: boolean }>;
    promptsReveal: () => Promise<{ ok: boolean; dir: string }>;
    migrateTranscripts: () => Promise<{ migrated: number; skipped: number }>;
  };
  routines: {
    list: () => Promise<(Routine & { humanSchedule?: string })[]>;
    get: (id: string) => Promise<(Routine & { humanSchedule?: string }) | null>;
    create: (input: RoutineInput) => Promise<Routine>;
    update: (id: string, patch: Partial<Routine>) => Promise<Routine | null>;
    setEnabled: (id: string, enabled: boolean) => Promise<Routine | null>;
    delete: (id: string) => Promise<{ ok: boolean }>;
    runNow: (id: string) => Promise<RoutineRun | null>;
    listRuns: (id: string) => Promise<RoutineRun[]>;
    cronPreview: (
      cron: string,
    ) => Promise<
      { valid: false } | { valid: true; human: string; next: string | null }
    >;
    draft: (
      description: string,
      space: "home" | "code",
    ) => Promise<{
      ok: boolean;
      draft?: { name: string; prompt: string; cron: string; space: "home" | "code" };
      error?: string;
    }>;
    onRan: (
      callback: (p: {
        routineId: string;
        sessionId?: string;
        status: string;
      }) => void,
    ) => () => void;
  };
  transfer: {
    exportChat: (
      sessionId: string,
      opts: {
        format: "monet" | "markdown";
        includeArtifacts: boolean;
        includeContext: boolean;
        includeRawTools?: boolean;
      },
    ) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
    importChat: () => Promise<{
      ok: boolean;
      canceled?: boolean;
      error?: string;
      session?: {
        id: string;
        title: string;
        messages: ChatMessage[];
        workspace?: string;
      };
    }>;
  };
  checkpoints: {
    rewind: (
      sessionId: string,
      sha: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    diffStat: (
      sessionId: string,
      sha: string,
    ) => Promise<{
      files: number;
      insertions: number;
      deletions: number;
    } | null>;
  };
  artifacts: {
    save: (payload: {
      sessionId: string;
      name: string;
      dataBase64: string;
    }) => Promise<{ ok: boolean; path?: string; error?: string }>;
    readImage: (
      path: string,
      mediaType?: string,
    ) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
    open: (path: string) => Promise<{ ok: boolean }>;
    readText: (
      path: string,
    ) => Promise<{ ok: boolean; content?: string; error?: string }>;
    readBytes: (
      path: string,
    ) => Promise<{ ok: boolean; base64?: string; error?: string }>;
    download: (
      path: string,
      name?: string,
    ) => Promise<{ ok: boolean; savedTo?: string; error?: string }>;
  };
  git: {
    info: (cwd?: string) => Promise<GitInfo>;
    diff: (cwd?: string) => Promise<{
      ok: boolean;
      patch?: string;
      untracked?: string[];
      error?: string;
    }>;
    createPR: (payload: {
      cwd?: string;
      mode: "pr" | "draft" | "manual";
    }) => Promise<{ ok: boolean; url?: string; error?: string }>;
    showInExplorer: (path: string) => Promise<{ ok: boolean }>;
    copy: (text: string) => Promise<{ ok: boolean }>;
    openTerminal: (path: string) => Promise<{ ok: boolean }>;
  };
  win: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<void>;
    newWindow: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
