/** Shared sandbox types. */

export interface SandboxFile {
  name: string;
  bytes: Uint8Array;
}

/** What an engine returns before files are persisted. */
export interface EngineResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  files: SandboxFile[];
  error?: string;
}

/** What runInSandbox returns to the tool (files saved to the artifacts dir). */
export interface SandboxRunResult {
  ok: boolean;
  engine: string;
  stdout: string;
  stderr: string;
  files: { name: string; path: string; mediaType: string }[];
  error?: string;
}

export const SANDBOX_TIMEOUT_MS = 60_000;
export const MAX_STREAM_CHARS = 60_000;
