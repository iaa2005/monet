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

/**
 * How long a sandbox call gets before it is killed — and how much longer the
 * model may ask for.
 *
 * The default was 60s everywhere except RunCommand, which quietly used five
 * minutes. RunPython therefore died at a minute, and the thing it died in the
 * middle of was almost always an install: seen live, `pip install` of a
 * browser engine killed at 60s, after which the run spent thirty more turns
 * working around a failure that was only a deadline. A minute is fine for
 * "compute this" and wrong for "fetch that", and the tool cannot tell which
 * it is — but the model can, so it may say.
 */
export const SANDBOX_TIMEOUT_MS = 5 * 60_000;
/** The ceiling on what the model may ask for. Beyond this it wants the
 * background runner, which does not hold the turn open at all. */
export const MAX_SANDBOX_TIMEOUT_MS = 20 * 60_000;

/** Clamp a model-supplied timeout (in seconds) to something sane. */
export function timeoutFromSeconds(seconds?: number): number {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0)
    return SANDBOX_TIMEOUT_MS;
  return Math.min(Math.round(seconds * 1000), MAX_SANDBOX_TIMEOUT_MS);
}
export const MAX_STREAM_CHARS = 60_000;
