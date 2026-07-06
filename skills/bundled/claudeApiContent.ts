// Content for the claude-api bundled skill.
// Patched: replaced build-time .md imports with lazy fs.readFileSync.
// All file reads deferred to first getter access (fast module load).
// Paths updated to match current anthropics/skills repo structure.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Maps SKILL_FILES key → actual path on disk (relative to this file)
const PATH_MAP: Record<string, string> = {
  "csharp/claude-api.md": "claude-api/csharp/claude-api/README.md",
  "curl/examples.md": "claude-api/curl/examples.md",
  "go/claude-api.md": "claude-api/go/claude-api/README.md",
  "java/claude-api.md": "claude-api/java/claude-api/README.md",
  "php/claude-api.md": "claude-api/php/claude-api/README.md",
  "python/claude-api/batches.md": "claude-api/python/claude-api/batches.md",
  "python/claude-api/files-api.md": "claude-api/python/claude-api/files-api.md",
  "python/claude-api/README.md": "claude-api/python/claude-api/README.md",
  "python/claude-api/streaming.md": "claude-api/python/claude-api/streaming.md",
  "python/claude-api/tool-use.md": "claude-api/python/claude-api/tool-use.md",
  "ruby/claude-api.md": "claude-api/ruby/claude-api/README.md",
  "shared/error-codes.md": "claude-api/shared/error-codes.md",
  "shared/live-sources.md": "claude-api/shared/live-sources.md",
  "shared/models.md": "claude-api/shared/models.md",
  "shared/prompt-caching.md": "claude-api/shared/prompt-caching.md",
  "shared/tool-use-concepts.md": "claude-api/shared/tool-use-concepts.md",
  "typescript/claude-api/README.md":
    "claude-api/typescript/claude-api/README.md",
  "typescript/claude-api/batches.md":
    "claude-api/typescript/claude-api/batches.md",
  "typescript/claude-api/files-api.md":
    "claude-api/typescript/claude-api/files-api.md",
  "typescript/claude-api/streaming.md":
    "claude-api/typescript/claude-api/streaming.md",
  "typescript/claude-api/tool-use.md":
    "claude-api/typescript/claude-api/tool-use.md",
};

let _cache: Record<string, string> | null = null;

function loadAll(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, path] of Object.entries(PATH_MAP)) {
    try {
      result[key] = readFileSync(join(__dirname, path), "utf-8");
    } catch {
      result[key] = "";
    }
  }
  return result;
}

function getCache(): Record<string, string> {
  if (!_cache) _cache = loadAll();
  return _cache;
}

export const SKILL_MODEL_VARS = {
  OPUS_ID: "claude-opus-4-6",
  OPUS_NAME: "Claude Opus 4.6",
  SONNET_ID: "claude-sonnet-4-6",
  SONNET_NAME: "Claude Sonnet 4.6",
  HAIKU_ID: "claude-haiku-4-5",
  HAIKU_NAME: "Claude Haiku 4.5",
  PREV_SONNET_ID: "claude-sonnet-4-5",
} satisfies Record<string, string>;

export const SKILL_PROMPT: string =
  /* lazy via getter later, but exported as string */
  "" as unknown as string;

// Override with getter after module init — Bun supports this
Object.defineProperty(exports, "SKILL_PROMPT", {
  get: () => getCache()["SKILL.md"] || "",
  enumerable: true,
  configurable: true,
});

export const SKILL_FILES: Record<string, string> = {} as Record<string, string>;

Object.defineProperty(exports, "SKILL_FILES", {
  get: () => {
    const cache = getCache();
    // python/agent-sdk and typescript/agent-sdk removed in newer repo — add empties
    const result: Record<string, string> = {};
    for (const key of Object.keys(PATH_MAP)) {
      result[key] = cache[key] || "";
    }
    result["python/agent-sdk/README.md"] = "";
    result["python/agent-sdk/patterns.md"] = "";
    result["typescript/agent-sdk/README.md"] = "";
    result["typescript/agent-sdk/patterns.md"] = "";
    return result;
  },
  enumerable: true,
  configurable: true,
});
