/**
 * Tunable prompts — the desktop's own prompt text, externalised to editable
 * files so it can be fine-tuned WITHOUT touching code.
 *
 * Each prompt has an in-code default (the `fallback`). On first use the default
 * is written to <dataDir>/prompts/<key>.md (non-destructive), and from then on
 * the FILE is the source of truth: edit it and restart (or call reloadPrompts)
 * to apply. Keeping the default in code means no duplicated catalog to maintain
 * and no transcription risk — the file simply seeds itself from the code.
 *
 * This covers the desktop-authored prompts (mode/space directives, the custom
 * tool descriptions, memory/sub-agent preambles). The large vendor system
 * prompt lives in src/vendor and is intentionally NOT mirrored here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

function promptsDir(): string {
  const dir = join(getDataDir(), "prompts");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const cache = new Map<string, string>();

/** Filename-safe slug guard (keys are hand-written, this is defence in depth). */
function safeKey(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, "-");
}

/**
 * Return a user-tunable prompt. Uses <dataDir>/prompts/<key>.md when present;
 * otherwise seeds that file with `fallback` and returns it. Cached per process.
 */
export function tunablePrompt(key: string, fallback: string): string {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let text = fallback;
  try {
    const file = join(promptsDir(), `${safeKey(key)}.md`);
    if (existsSync(file)) {
      text = readFileSync(file, "utf-8");
    } else {
      writeFileSync(file, fallback, "utf-8"); // seed for editing
    }
  } catch {
    /* fall back to the in-code default */
  }
  cache.set(key, text);
  return text;
}

/** Drop the cache so edited prompt files are re-read (without an app restart). */
export function reloadPrompts(): void {
  cache.clear();
}

/** Absolute path of the tunable-prompts folder (for a "reveal in folder" UI). */
export function promptsDirPath(): string {
  return promptsDir();
}
