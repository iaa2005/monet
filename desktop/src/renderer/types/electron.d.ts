/**
 * Type declarations for window.electronAPI (exposed via preload).
 */

import type { LLMEvent, LLMRequest } from "../main/llm/adapter.js";
import type { LLMProvider, LLMProviderInput } from "../main/provider/types.js";
import type {
  PermissionRequest,
  PermissionDecision,
} from "../main/ipc/permissions.js";

export type { PermissionRequest, PermissionDecision };

export interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  author: string;
  updatedAt: number;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpServerStatus {
  name: string;
  status: "connected" | "connecting" | "error" | "disabled";
  toolCount: number;
  error?: string;
  config: McpServerConfig;
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
      attachments?: {
        name: string;
        mediaType: string;
        kind: "text" | "image";
        text?: string;
        dataBase64?: string;
      }[];
    }) => Promise<{ ok: boolean }>;
    abort: (sessionId?: string) => Promise<{ ok: boolean }>;
    reset: (sessionId?: string) => Promise<{ ok: boolean }>;
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
  };
  permissions: {
    onRequest: (callback: (request: PermissionRequest) => void) => () => void;
    respond: (decision: PermissionDecision) => void;
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
