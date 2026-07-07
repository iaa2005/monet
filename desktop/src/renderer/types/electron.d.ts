/**
 * Type declarations for window.electronAPI (exposed via preload).
 */

import type { LLMEvent, LLMRequest } from "../main/llm/adapter.js";
import type { LLMProvider, LLMProviderInput } from "../main/provider/types.js";
import type {
  PermissionRequest,
  PermissionDecision,
} from "../main/ipc/permissions.js";

export interface ElectronAPI {
  platform: string;
  versions: { node: string; chrome: string; electron: string };
  chat: {
    send: (request: LLMRequest) => Promise<{ ok: boolean }>;
    abort: () => Promise<{ ok: boolean }>;
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
    set: (path: string) => Promise<{ ok: boolean; path: string }>;
  };
  sessions: {
    create: (title?: string) => Promise<unknown>;
    getById: (id: string) => Promise<unknown>;
    save: (session: unknown) => Promise<void>;
    list: (limit?: number, offset?: number) => Promise<unknown[]>;
    search: (query: string, limit?: number) => Promise<unknown[]>;
    deleteById: (id: string) => Promise<boolean>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
