// Content for the claude-api bundled skill.
// Patched: replaced build-time .md imports with runtime fs.readFileSync
// (original code used `import x from './file.md'` which only works with bun build)

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readMd(relPath: string): string {
  return readFileSync(join(__dirname, relPath), "utf-8");
}

const csharpClaudeApi = readMd("claude-api/csharp/claude-api.md");
const curlExamples = readMd("claude-api/curl/examples.md");
const goClaudeApi = readMd("claude-api/go/claude-api.md");
const javaClaudeApi = readMd("claude-api/java/claude-api.md");
const phpClaudeApi = readMd("claude-api/php/claude-api.md");
const pythonAgentSdkPatterns = readMd(
  "claude-api/python/agent-sdk/patterns.md",
);
const pythonAgentSdkReadme = readMd("claude-api/python/agent-sdk/README.md");
const pythonClaudeApiBatches = readMd(
  "claude-api/python/claude-api/batches.md",
);
const pythonClaudeApiFilesApi = readMd(
  "claude-api/python/claude-api/files-api.md",
);
const pythonClaudeApiReadme = readMd("claude-api/python/claude-api/README.md");
const pythonClaudeApiStreaming = readMd(
  "claude-api/python/claude-api/streaming.md",
);
const pythonClaudeApiToolUse = readMd(
  "claude-api/python/claude-api/tool-use.md",
);
const rubyClaudeApi = readMd("claude-api/ruby/claude-api.md");
const skillPrompt = readMd("claude-api/SKILL.md");
const sharedErrorCodes = readMd("claude-api/shared/error-codes.md");
const sharedLiveSources = readMd("claude-api/shared/live-sources.md");
const sharedModels = readMd("claude-api/shared/models.md");
const sharedPromptCaching = readMd("claude-api/shared/prompt-caching.md");
const sharedToolUseConcepts = readMd("claude-api/shared/tool-use-concepts.md");
const typescriptAgentSdkPatterns = readMd(
  "claude-api/typescript/agent-sdk/patterns.md",
);
const typescriptAgentSdkReadme = readMd(
  "claude-api/typescript/agent-sdk/README.md",
);
const typescriptClaudeApiBatches = readMd(
  "claude-api/typescript/claude-api/batches.md",
);
const typescriptClaudeApiFilesApi = readMd(
  "claude-api/typescript/claude-api/files-api.md",
);
const typescriptClaudeApiReadme = readMd(
  "claude-api/typescript/claude-api/README.md",
);
const typescriptClaudeApiStreaming = readMd(
  "claude-api/typescript/claude-api/streaming.md",
);
const typescriptClaudeApiToolUse = readMd(
  "claude-api/typescript/claude-api/tool-use.md",
);

export const SKILL_MODEL_VARS = {
  OPUS_ID: "claude-opus-4-6",
  OPUS_NAME: "Claude Opus 4.6",
  SONNET_ID: "claude-sonnet-4-6",
  SONNET_NAME: "Claude Sonnet 4.6",
  HAIKU_ID: "claude-haiku-4-5",
  HAIKU_NAME: "Claude Haiku 4.5",
  PREV_SONNET_ID: "claude-sonnet-4-5",
} satisfies Record<string, string>;

export const SKILL_PROMPT: string = skillPrompt;

export const SKILL_FILES: Record<string, string> = {
  "csharp/claude-api.md": csharpClaudeApi,
  "curl/examples.md": curlExamples,
  "go/claude-api.md": goClaudeApi,
  "java/claude-api.md": javaClaudeApi,
  "php/claude-api.md": phpClaudeApi,
  "python/agent-sdk/README.md": pythonAgentSdkReadme,
  "python/agent-sdk/patterns.md": pythonAgentSdkPatterns,
  "python/claude-api/README.md": pythonClaudeApiReadme,
  "python/claude-api/batches.md": pythonClaudeApiBatches,
  "python/claude-api/files-api.md": pythonClaudeApiFilesApi,
  "python/claude-api/streaming.md": pythonClaudeApiStreaming,
  "python/claude-api/tool-use.md": pythonClaudeApiToolUse,
  "ruby/claude-api.md": rubyClaudeApi,
  "shared/error-codes.md": sharedErrorCodes,
  "shared/live-sources.md": sharedLiveSources,
  "shared/models.md": sharedModels,
  "shared/prompt-caching.md": sharedPromptCaching,
  "shared/tool-use-concepts.md": sharedToolUseConcepts,
  "typescript/agent-sdk/README.md": typescriptAgentSdkReadme,
  "typescript/agent-sdk/patterns.md": typescriptAgentSdkPatterns,
  "typescript/claude-api/README.md": typescriptClaudeApiReadme,
  "typescript/claude-api/batches.md": typescriptClaudeApiBatches,
  "typescript/claude-api/files-api.md": typescriptClaudeApiFilesApi,
  "typescript/claude-api/streaming.md": typescriptClaudeApiStreaming,
  "typescript/claude-api/tool-use.md": typescriptClaudeApiToolUse,
};
