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

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
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
 * What we last wrote for each key, so an untouched seed can be told apart from
 * a prompt the user actually edited. Without this, seeding is a one-way door:
 * the first run freezes that version of every prompt on disk and no later
 * improvement in the app ever reaches an existing install.
 */
function seededPath(): string {
  return join(promptsDir(), ".seeded.json");
}

function readSeeded(): Record<string, string> {
  try {
    const f = seededPath();
    if (!existsSync(f)) return {};
    return JSON.parse(readFileSync(f, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSeeded(map: Record<string, string>): void {
  try {
    writeFileSync(seededPath(), JSON.stringify(map, null, 2), "utf-8");
  } catch {
    /* best-effort bookkeeping */
  }
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
}

/** Marks a file that existed before seed tracking: never auto-refreshed. */
const UNKNOWN_PROVENANCE = "pre-tracking";

/** Restore a prompt to its in-code default (Settings → "Reset to default").
 * The only way back for a file whose provenance we could not establish. */
export function resetTunablePrompt(key: string): void {
  try {
    const file = join(promptsDir(), `${safeKey(key)}.md`);
    if (existsSync(file)) rmSync(file);
    const seeded = readSeeded();
    delete seeded[key];
    writeSeeded(seeded);
    cache.delete(key);
  } catch {
    /* best-effort */
  }
}

/**
 * Return a user-tunable prompt. Uses <dataDir>/prompts/<key>.md when present;
 * otherwise seeds that file with `fallback` and returns it. Cached per process.
 *
 * A file still byte-identical to the default we seeded is refreshed when that
 * default changes — the user never edited it, so holding it back would only
 * pin them to an older prompt. Anything they DID edit is left alone.
 */
export function tunablePrompt(key: string, fallback: string): string {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let text = fallback;
  try {
    const file = join(promptsDir(), `${safeKey(key)}.md`);
    const seeded = readSeeded();
    if (existsSync(file)) {
      text = readFileSync(file, "utf-8");
      const untouched = digest(text) === seeded[key];
      if (untouched && text !== fallback) {
        writeFileSync(file, fallback, "utf-8");
        text = fallback;
        writeSeeded({ ...seeded, [key]: digest(fallback) });
      } else if (!(key in seeded)) {
        // Seeded before this bookkeeping existed, so its provenance is
        // unknown. Record a sentinel that can never equal a digest: the file
        // is then treated as the user's and never auto-rewritten. Recording
        // the real digest instead would mark a genuine edit as "untouched"
        // and overwrite it on the next launch.
        writeSeeded({ ...seeded, [key]: UNKNOWN_PROVENANCE });
      }
    } else {
      writeFileSync(file, fallback, "utf-8"); // seed for editing
      writeSeeded({ ...seeded, [key]: digest(fallback) });
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
