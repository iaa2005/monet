/**
 * Type declarations for window.electronAPI (exposed via preload).
 */

import type { LLMEvent, LLMRequest } from "../main/llm/adapter.js";
import type { LLMProvider, LLMProviderInput } from "../main/provider/types.js";
import type {
  CatalogModelInfo,
  CatalogProviderInfo,
} from "../main/llm/models-dev.js";
import type { ConnectorAccount } from "../main/connectors/types.js";
import type { UiConnectorService } from "../main/connectors/services/types.js";
import type { BrowserConfig } from "../main/browser/config.js";
import type { DevServer } from "../main/browser/dev-servers.js";
import type { BrowserSelection } from "../main/browser/selection.js";
import type { Bookmark, Visit } from "../main/browser/bookmark-store.js";
import type { ServerConfig, ServerState } from "../main/browser/servers.js";
import type { SessionUiState } from "../main/ui-state.js";
import type { SttSettings } from "../main/stt-settings.js";
import type { Plan, PlanTodoStatus } from "@shared/plan";
import type { ChatMessage } from "./chat";

export type { BrowserConfig, DevServer, BrowserSelection, ServerConfig, ServerState };
export type { Bookmark, Visit };
export type { SessionUiState };
export type { SttSettings };
export type { Plan, PlanTodoStatus };
export type {
  BrowserEngine,
  BrowserApproval,
  BrowserPersist,
} from "../main/browser/config.js";
import type {
  Routine,
  RoutineInput,
  RoutineRun,
} from "../main/routines/store.js";

export type { Routine, RoutineInput, RoutineRun };
export type { UiConnectorService };
export type { CatalogModelInfo, CatalogProviderInfo };
export type { Goal as GoalRecord } from "../main/agent/goal/state.js";
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

/** OpenRouter model catalog entry (from GET /api/v1/models). */
export interface ORModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
    image?: string;
    request?: string;
  };
  architecture: {
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
  supported_parameters: string[];
  top_provider?: {
    context_length?: number;
    /** Absent/null for many models — leave max output unset then. */
    max_completion_tokens?: number | null;
  };
}

/** OpenRouter key/credits info (from GET /api/v1/key). */
/** Combined /key + /credits balance (see main/llm/openrouter-api.ts).
 * All optional: the two endpoints fail independently. */
export interface ORKeyInfo {
  label?: string;
  isFreeTier?: boolean;
  /** $ spent through THIS key. */
  keyUsage?: number;
  keyLimit?: number | null;
  keyLimitRemaining?: number | null;
  /** Account-wide credits purchased / lifetime usage / remaining. */
  totalCredits?: number;
  totalUsage?: number;
  balance?: number;
}

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

/** A skillsdirectory.com entry. `repository` is where the files actually are —
 * the directory indexes GitHub rather than hosting anything. */
export interface RegistrySkill {
  name: string;
  slug: string;
  description: string;
  repository: string;
  category?: string;
  author?: string;
  stars?: number;
  verified?: boolean;
  tags?: string[];
  installed?: boolean;
}

/** A configured skill source. `github` is enumerated; `registry`
 * (skillsdirectory.com, ~97k entries) contributes a page at a time. */
/** A curated source from the community repo's skill-sources.json. */
export interface SuggestedSource {
  id: string;
  kind: "github" | "registry";
  name: string;
  description?: string;
  repo?: string;
  api?: string;
  homepage?: string;
  added: boolean;
}

export interface SkillSource {
  kind: "github" | "registry";
  id: string;
  /** Off means not listed and not fetched. */
  enabled: boolean;
  /** Ships with the app: switchable, never deletable. */
  builtin: boolean;
  repo?: string;
  sub?: string;
  api?: string;
  name?: string;
  homepage?: string;
}

/**
 * One thing the audit saw in a skill's files, mirroring `Finding` in
 * src/main/skill-audit.ts — the audit runs in main, the verdict is read here.
 */
export interface AuditFinding {
  category:
    | "remote_code_execution"
    | "external_download"
    | "credential_access"
    | "exfiltration"
    | "destructive_command"
    | "obfuscation"
    | "prompt_injection";
  severity: "high" | "medium" | "low";
  file: string;
  line: number;
  /** What was seen. */
  detail: string;
  /** The matched text, so the claim is checkable rather than asserted. */
  evidence: string;
}

export interface SkillAudit {
  findings: AuditFinding[];
  /** How many files were read — a verdict over 2 of 20 is not a verdict. */
  filesScanned: number;
  /** What was not read, named rather than passed over in silence. */
  skipped: string[];
  worst: "high" | "medium" | "low" | "none";
}

export interface StoreSkill {
  /** Stable unique identity — source plus repo/path, never the name. Two
   * sources can ship a skill called `docx`. */
  uid: string;
  /** Empty for a registry card — the directory does not say where in the repo
   * the skill lives, so it is resolved at install time. */
  path: string;
  /** The source's id: `owner/repo[/sub]`, or a registry id. */
  source: string;
  kind?: "github" | "registry";
  /** Registry cards only: `owner/repo` where the files actually are. */
  repository?: string;
  /** Registry cards only: a clue to which folder, resolved at install. Not a
   * repo-relative path. */
  hint?: string;
  /** Where to read this skill before installing it. */
  url?: string;
  /** Registry cards: install count, and the REPO's stars. */
  installs?: number;
  stars?: number;
  /** Registry cards only — what the category filter offers. */
  category?: string;
  name: string;
  description: string;
  installed: boolean;
  /** Local folder name once installed — what removal needs. */
  slug: string;
}

export interface RegistryVar {
  name: string;
  description?: string;
  required: boolean;
  secret: boolean;
  value?: string;
}

export interface RegistryServer {
  id: string;
  name: string;
  namespace: string;
  description: string;
  version: string;
  repoUrl?: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  vars: RegistryVar[];
  placeholders?: string[];
  unsupported?: string;
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
    /** Apply a permission-mode change to a turn already running. */
    setPermissionMode: (
      sessionId: string,
      mode: string,
    ) => Promise<{ ok: boolean }>;
    /** Hand text to a turn already in flight. ok:false = session is idle. */
    inject: (sessionId: string, text: string) => Promise<{ ok: boolean }>;
    /** Drop the last N prompts from the model's context (files untouched). */
    undoPrompts: (
      sessionId: string,
      count?: number,
    ) => Promise<{ removed: number; turnsLeft: number; messagesDropped: number }>;
    undoableTurns: (sessionId: string) => Promise<number>;
    reset: (sessionId?: string) => Promise<{ ok: boolean }>;
    forkTranscript: (
      fromSessionId: string,
      toSessionId: string,
      keepUserTurns?: number,
      totalUserTurns?: number,
    ) => Promise<{ fidelity: "full" | "text" }>;
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
    /** Recursive name search from `rootPath`. `truncated` when a limit or the
     * time budget cut the list short. */
    search: (
      rootPath: string,
      query: string,
    ) => Promise<{
      hits: { name: string; path: string; isDirectory: boolean; rel: string }[];
      truncated: boolean;
    }>;
    /** Workspace changed on disk. Returns an unsubscribe. */
    onChanged: (cb: () => void) => () => void;
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
    openExternal: (url: string) => Promise<{ ok: boolean }>;
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
    orModels: (apiKey: string) => Promise<{
      ok: boolean;
      models?: ORModel[];
      error?: string;
    }>;
    orKeyInfo: (apiKey: string) => Promise<{
      ok: boolean;
      info?: ORKeyInfo;
      error?: string;
    }>;
    fetchModels: (
      baseURL: string,
      apiKey: string,
    ) => Promise<{ ok: boolean; models?: { name: string }[]; error?: string }>;
    catalogProviders: (force?: boolean) => Promise<{
      ok: boolean;
      providers?: CatalogProviderInfo[];
      ageMs?: number | null;
      error?: string;
    }>;
    catalogModels: (
      catalogProviderId: string,
    ) => Promise<{ ok: boolean; models?: CatalogModelInfo[]; error?: string }>;
    routingGet: () => Promise<{
      backgroundProviderId: string;
      backgroundModel: string;
    }>;
    routingSet: (patch: {
      backgroundProviderId?: string;
      backgroundModel?: string;
    }) => Promise<{ backgroundProviderId: string; backgroundModel: string }>;
  };
  permissions: {
    onRequest: (callback: (request: PermissionRequest) => void) => () => void;
    /** The id is required — several requests can be outstanding at once. */
    respond: (id: string, decision: PermissionDecision) => void;
  };
  plan: {
    onRequest: (
      callback: (request: { id: string; plan: string; planId?: string }) => void,
    ) => () => void;
    respond: (
      id: string,
      decision: "approve" | "approve-auto" | "keep-planning",
      feedback?: string,
    ) => void;
    /** The plan document — read/annotate (plan/store.ts in main). */
    current: (sessionId: string) => Promise<Plan | null>;
    list: (sessionId: string) => Promise<Plan[]>;
    comment: (
      planId: string,
      text: string,
      todoId?: string,
    ) => Promise<Plan | null>;
    setTodo: (
      planId: string,
      todoId: string,
      status: PlanTodoStatus,
    ) => Promise<Plan | null>;
    markdown: (planId: string) => Promise<string | null>;
    setStatus: (planId: string, status: "draft" | "done") => Promise<Plan | null>;
    onChanged: (callback: (sessionId: string) => void) => () => void;
    onModeChanged: (
      callback: (payload: { sessionId: string; mode: string }) => void,
    ) => () => void;
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
    /** `ok: false` when the directory is gone — a moved project or an offline
     * share is an ordinary state here, not a thrown error. */
    set: (
      path: string,
    ) => Promise<{
      ok: boolean;
      path: string;
      claudeMd?: string | null;
      error?: string;
    }>;
    getClaudeMd: () => Promise<string | null>;
  };
  /** Durable log of tool executions (Background tasks). Rows are written by
   * the agent loop; the renderer only reads and clears. */
  tasks: {
    list: (limit?: number) => Promise<unknown[]>;
    clear: () => Promise<boolean>;
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
      activityDays?: number,
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
    consolidationState: () => Promise<{
      lastConsolidatedAt: number;
      lastRunAt: number;
      lastSummary: string;
      lastError: string | null;
      lastTouched: string[];
      runs: number;
      pending: number;
    }>;
    consolidate: () => Promise<{
      ok: boolean;
      ran: boolean;
      reason?: string;
      summary?: string;
      touched?: string[];
      error?: string;
    }>;
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
    getSources: () => Promise<SkillSource[]>;
    setSources: (list: unknown[]) => Promise<SkillSource[]>;
    categories: () => Promise<string[]>;
    list: (opts?: {
      query?: string;
      offset?: number;
      category?: string;
      sort?: string;
    }) => Promise<{
      ok: boolean;
      skills?: StoreSkill[];
      errors?: string[];
      error?: string;
    }>;
    install: (payload: {
      source: string;
      path: string;
      uid?: string;
      kind?: "github" | "registry";
      hint?: string;
      repository?: string;
      name?: string;
      /** The folder the user picked among a repo's per-agent copies. */
      dir?: string;
    }) => Promise<{
      ok: boolean;
      slug?: string;
      error?: string;
      candidates?: string[];
    }>;
    preview: (payload: {
      source: string;
      path: string;
      kind?: "github" | "registry";
      repository?: string;
      hint?: string;
      name?: string;
      /** Read this folder instead of the resolved one — the agent picker. */
      dir?: string;
    }) => Promise<{
      ok: boolean;
      repo?: string;
      dir?: string;
      /** Folders holding this skill, best-first, when a repo ships one copy per
       * agent, each labelled by main so the renderer keeps no second list.
       * Absent when there is nothing to choose between. */
      variants?: { dir: string; agent: string; label: string }[];
      files?: string[];
      content?: string;
      /** The text of every file that was read, so the viewer can show them all
       * rather than only SKILL.md. */
      texts?: Record<string, string>;
      url?: string;
      /** Our own static check of the files above, run before any install. */
      audit?: SkillAudit;
      error?: string;
      candidates?: string[];
    }>;
    registryPage: (payload: {
      query?: string;
      offset?: number;
      category?: string;
      sort?: string;
    }) => Promise<{
      ok: boolean;
      skills?: StoreSkill[];
      error?: string;
    }>;
    suggestions: (force?: boolean) => Promise<{
      ok: boolean;
      sources?: SuggestedSource[];
    }>;
    searchRegistry: (payload: { query?: string; limit?: number }) => Promise<{
      ok: boolean;
      skills?: unknown[];
      error?: string;
    }>;
    installRegistry: (payload: { repository: string; name: string }) => Promise<{
      ok: boolean;
      slug?: string;
      error?: string;
      candidates?: string[];
    }>;
  };
  mcpRegistry: {
    search: (payload: { query?: string; limit?: number }) => Promise<{
      ok: boolean;
      servers?: RegistryServer[];
      error?: string;
    }>;
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
    getSettings: () => Promise<SttSettings>;
    setSettings: (patch: Partial<SttSettings>) => Promise<SttSettings>;
  };
  goal: {
    get: (sessionId: string) => Promise<GoalRecord | null>;
    start: (
      sessionId: string,
      input: {
        objective: string;
        completionCriterion?: string;
        connectorGrants?: string[];
        maxTurns?: number;
        maxTokens?: number;
      },
    ) => Promise<{ ok: boolean; goal?: GoalRecord; error?: string }>;
    pause: (sessionId: string) => Promise<GoalRecord | null>;
    resume: (sessionId: string) => Promise<GoalRecord | null>;
    cancel: (sessionId: string) => Promise<{ ok: boolean }>;
  };
  mcp: {
    list: () => Promise<McpServerStatus[]>;
    tools: (server: string) => Promise<{ name: string; description: string }[]>;
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
    /** Browser OAuth sign-in for a remote server. */
    signIn: (name: string) => Promise<{
      ok: boolean;
      error?: string;
      servers?: McpServerStatus[];
    }>;
    signOut: (name: string) => Promise<McpServerStatus[]>;
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
    getConfig: () => Promise<BrowserConfig>;
    setConfig: (patch: Partial<BrowserConfig>) => Promise<BrowserConfig>;
    partition: (sessionId?: string) => Promise<string>;
    clearData: (partition: string) => Promise<void>;
    devServers: () => Promise<DevServer[]>;
    registerTab: (tabId: string, webContentsId: number) => Promise<void>;
    unregisterTab: (tabId: string) => Promise<void>;
    activateTab: (tabId: string) => Promise<void>;
    onOpenTab: (cb: (url: string) => void) => () => void;
    uiState: {
      get: (sessionId: string) => Promise<SessionUiState | null>;
      set: (sessionId: string, state: SessionUiState) => Promise<void>;
    };
    pickFile: () => Promise<string | null>;
    saveScreenshot: () => Promise<{ ok: boolean; error?: string }>;
    onReveal: (cb: () => void) => () => void;
    servers: {
      list: () => Promise<ServerState[]>;
      save: (servers: ServerConfig[]) => Promise<void>;
      start: (id: string) => Promise<void>;
      stop: (id: string) => Promise<{ ok: boolean; error?: string }>;
      output: (id: string) => Promise<string>;
      suggest: () => Promise<ServerConfig[]>;
      onChanged: (cb: () => void) => () => void;
    };
    bookmarks: {
      list: () => Promise<Bookmark[]>;
      toggle: (url: string, title: string) => Promise<{ bookmarked: boolean }>;
      remove: (id: string) => Promise<void>;
      isBookmarked: (url: string) => Promise<boolean>;
      recent: (limit?: number) => Promise<Visit[]>;
      onChanged: (cb: () => void) => () => void;
    };
    setDesignMode: (on: boolean) => Promise<{ ok: boolean; error?: string }>;
    onSelection: (cb: (sel: BrowserSelection) => void) => () => void;
    onDesignMode: (cb: (on: boolean) => void) => () => void;
  };
  computer: {
    getConfig: () => Promise<{ enabled: boolean; deniedApps: string[] }>;
    setConfig: (patch: {
      enabled?: boolean;
      deniedApps?: string[];
    }) => Promise<{ enabled: boolean; deniedApps: string[] }>;
  };
  connectors: {
    presets: () => Promise<UiConnectorService[]>;
    list: () => Promise<ConnectorAccount[]>;
    options: () => Promise<
      { id: string; label: string; kind: "connector" | "mcp" }[]
    >;
    add: (input: {
      presetId: string;
      label?: string;
      username: string;
      secret: Record<string, string>;
    }) => Promise<ConnectorAccount>;
    update: (
      id: string,
      patch: { label?: string; username?: string; enabled?: boolean },
    ) => Promise<ConnectorAccount | null>;
    delete: (id: string) => Promise<{ ok: boolean }>;
    test: (id: string) => Promise<{ ok: boolean; error?: string }>;
    setPermission: (
      accountId: string,
      actionId: string,
      level: "allow" | "ask" | "deny" | null,
    ) => Promise<ConnectorAccount | null>;
    storeCatalog: () => Promise<{
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
    }>;
    storePreview: (id: string) => Promise<{
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
    }>;
    storeInstall: (id: string) => Promise<{ ok: boolean; error?: string }>;
    storeRemove: (id: string) => Promise<{ ok: boolean; error?: string }>;
    storeInstalled: () => Promise<string[]>;
    googleSignIn: (opts: {
      presetId: string;
      clientId: string;
      clientSecret: string;
    }) => Promise<{ ok: boolean; error?: string }>;
    telegramSendCode: (opts: {
      accountId: string;
      apiId: string;
      apiHash: string;
      phone: string;
    }) => Promise<{ ok: boolean; error?: string }>;
    telegramSignIn: (opts: {
      accountId: string;
      code: string;
      password?: string;
    }) => Promise<{ ok: boolean; error?: string; needsPassword?: boolean }>;
    mcpOAuthSignIn: (opts: {
      presetId: string;
    }) => Promise<{ ok: boolean; error?: string }>;
  };
  sandbox: {
    getConfig: () => Promise<{ engine: string }>;
    setConfig: (patch: { engine?: string }) => Promise<{ engine: string }>;
    preparePodman: () => Promise<{ ok: boolean; error?: string; needsWsl?: boolean }>;
    checkPodman: () => Promise<{ ok: boolean; error?: string; needsWsl?: boolean }>;
    isPodmanReady: () => Promise<{ ok: boolean }>;
    warmPodman: (sessionId?: string) => Promise<{ ok: boolean }>;
    getSessionConfig: (
      sessionId: string,
    ) => Promise<{ engine: string; override: string | null }>;
    setSessionConfig: (
      sessionId: string,
      engine: string | null,
    ) => Promise<{ engine: string }>;
    listFiles: (sessionId?: string) => Promise<SandboxFileEntry[]>;
    workDir: (sessionId?: string) => Promise<string>;
    supportsShell: (sessionId?: string) => Promise<{ ok: boolean }>;
    shellRun: (
      sessionId: string,
      command: string,
    ) => Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }>;
  };
  tuning: {
    powerGet: () => Promise<{ keepAwake: boolean; active: boolean }>;
    powerSet: (patch: {
      keepAwake?: boolean;
    }) => Promise<{ keepAwake: boolean; active: boolean }>;
    toolSearchGet: () => Promise<{ enabled: boolean }>;
    toolSearchSet: (patch: { enabled?: boolean }) => Promise<{ enabled: boolean }>;
    cavemanGet: () => Promise<{ enabled: boolean }>;
    cavemanSet: (patch: { enabled?: boolean }) => Promise<{ enabled: boolean }>;
    leanGet: () => Promise<{ leanTools: boolean; vendorMemory: boolean }>;
    leanSet: (patch: {
      leanTools?: boolean;
      vendorMemory?: boolean;
    }) => Promise<{ leanTools: boolean; vendorMemory: boolean }>;
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
    triggerInfo: () => Promise<{ baseUrl: string; apiKey: string }>;
    chats: (space?: string) => Promise<
      { id: string; title: string; at: string; routineId: string; routineName: string }[]
    >;
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
    }>;
    onRan: (
      callback: (p: {
        routineId: string;
        sessionId?: string;
        status: string;
      }) => void,
    ) => () => void;
    onStarted: (
      callback: (p: {
        routineId: string;
        sessionId: string;
        name: string;
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
    downloadAll: (
      items: { path: string; name?: string }[],
    ) => Promise<{
      ok: boolean;
      savedTo?: string;
      saved?: number;
      error?: string;
    }>;
    appIcon: (path: string) => Promise<{ ok: boolean; dataUrl?: string }>;
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
