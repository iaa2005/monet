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
    abort: () => Promise<{ ok: boolean }>;
    reset: (sessionId?: string) => Promise<{ ok: boolean }>;
    onToken: (callback: (event: LLMEvent) => void) => () => void;
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
    create: (title?: string) => Promise<unknown>;
    getById: (id: string) => Promise<unknown>;
    save: (session: unknown) => Promise<void>;
    list: (limit?: number, offset?: number) => Promise<unknown[]>;
    search: (query: string, limit?: number) => Promise<unknown[]>;
    deleteById: (id: string) => Promise<boolean>;
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
  win: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
