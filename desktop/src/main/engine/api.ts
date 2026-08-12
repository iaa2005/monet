/**
 * The engine's model access — which this app does not route through Anthropic.
 *
 * Code Monet talks to whatever provider the user configured, through
 * src/main/provider and src/main/llm, and its turn loop is src/main/agent.
 * The engine carries a second, complete Anthropic client underneath: a
 * 3400-line streaming query, a 400-line SDK client factory, retry and
 * rate-limit handling, a 1200-line error-message layer. Nothing outside the
 * engine imports any of it, and the only way execution reaches it at all is
 * an agent-type hook falling into the engine's own query loop — which, with
 * no Anthropic credentials, could only fail.
 *
 * So the three shapes here are deliberate:
 *
 *   Model calls THROW, naming the situation. A request that silently returns
 *   nothing looks like a model that had nothing to say; this says what
 *   happened and where to wire it up if we ever want the engine's loop
 *   driving our provider.
 *
 *   Provider-neutral logic is REAL — retry backoff, usage arithmetic, the
 *   user-facing text for an oversized image or PDF. It was never Anthropic's
 *   in any meaningful sense, and dropping it would degrade messages the user
 *   actually reads.
 *
 *   Bookkeeping that only fed their pipeline is a NO-OP: prompt-cache break
 *   tracking existed to report cache efficiency in telemetry that no longer
 *   exists.
 */

import { join } from "path";
import type { NonNullableUsage } from "./stubs/cli/entrypoints/sdk/sdkUtilityTypes.js";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantMessage,
  StreamEvent,
  SystemAPIErrorMessage,
} from "./types/message.js";

const NO_ANTHROPIC =
  "This build has no Anthropic API client. The engine's query loop is not " +
  "wired to a provider here — the app's own loop (src/main/agent) drives " +
  "src/main/provider instead.";

// ── Model calls ───────────────────────────────────────────────────────────

// The declared shapes are the originals'. Every one of these throws, but the
// code that would have handled a response still has to typecheck — `never`
// propagates into every field access downstream and turns one honest failure
// into forty misleading errors.

export async function* queryModelWithStreaming(
  _args: unknown,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  throw new Error(NO_ANTHROPIC);
}

export async function queryModelWithoutStreaming(
  _args: unknown,
): Promise<AssistantMessage> {
  throw new Error(NO_ANTHROPIC);
}

export async function queryHaiku(_args: unknown): Promise<AssistantMessage> {
  throw new Error(NO_ANTHROPIC);
}

export async function getAnthropicClient(_args?: unknown): Promise<Anthropic> {
  throw new Error(NO_ANTHROPIC);
}

/** Output ceiling for a model. The engine asks before sizing a request; the
 *  provider layer enforces its own, so this is a sane floor rather than a
 *  per-model table we would have to keep true. */
export function getMaxOutputTokensForModel(_model: string): number {
  const override = Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
  return Number.isFinite(override) && override > 0 ? override : 8192;
}

/** Request metadata. Upstream this identified the user to Anthropic; the only
 *  part worth keeping is the explicit escape hatch. */
export function getAPIMetadata(): Record<string, unknown> {
  const raw = process.env.CLAUDE_CODE_EXTRA_METADATA;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function getCacheControl(_opts?: unknown): undefined {
  return undefined;
}

export function getExtraBodyParams(_betaHeaders?: string[]): Record<string, unknown> {
  const raw = process.env.CLAUDE_CODE_EXTRA_BODY;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ── Usage arithmetic ──────────────────────────────────────────────────────

export type { NonNullableUsage };

export const EMPTY_USAGE: Readonly<NonNullableUsage> = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  inference_geo: "",
  iterations: [],
  speed: "standard",
} as unknown as NonNullableUsage;

export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  const a = totalUsage as unknown as Record<string, number>;
  const b = messageUsage as unknown as Record<string, number>;
  return {
    ...totalUsage,
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  } as NonNullableUsage;
}

export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: { output_tokens?: number } | undefined,
): NonNullableUsage {
  if (!partUsage) return usage as NonNullableUsage;
  return {
    ...usage,
    output_tokens:
      partUsage.output_tokens ??
      (usage as unknown as Record<string, number>).output_tokens ??
      0,
  } as NonNullableUsage;
}

// ── Retry policy ──────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 10;

export function getDefaultMaxRetries(): number {
  const raw = process.env.CLAUDE_CODE_MAX_RETRIES;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_MAX_RETRIES;
}

/** Exponential backoff with jitter, honouring Retry-After when the server
 *  sent one. Kept real: this is how every provider wants to be retried. */
export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32_000,
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0)
      return Math.min(seconds * 1000, maxDelayMs);
    const at = Date.parse(retryAfterHeader);
    if (Number.isFinite(at)) {
      const wait = at - Date.now();
      if (wait > 0) return Math.min(wait, maxDelayMs);
    }
  }
  const base = Math.min(500 * 2 ** Math.max(0, attempt - 1), maxDelayMs);
  // Full jitter — synchronised retries from parallel agents are how a rate
  // limit becomes a thundering herd.
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback: ${originalModel} -> ${fallbackModel}`);
    this.name = "FallbackTriggeredError";
  }
}

// ── Error text the user reads ─────────────────────────────────────────────

export const PROMPT_TOO_LONG_ERROR_MESSAGE = "Prompt is too long";
const API_ERROR_MESSAGE_PREFIX = "API Error";

export function startsWithApiErrorPrefix(text: string): boolean {
  return text.startsWith(API_ERROR_MESSAGE_PREFIX);
}

function errorText(msg: AssistantMessage): string {
  const content: unknown = msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b: unknown) =>
        b && typeof b === "object" && "text" in b
          ? String((b as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  return "";
}

export function isPromptTooLongMessage(msg: AssistantMessage): boolean {
  return (
    !!msg.isApiErrorMessage &&
    errorText(msg).includes(PROMPT_TOO_LONG_ERROR_MESSAGE)
  );
}

/** How far over the limit the request was, when the server said. */
export function getPromptTooLongTokenGap(
  msg: AssistantMessage,
): number | undefined {
  if (!isPromptTooLongMessage(msg) || !msg.errorDetails) return undefined;
  const { actualTokens, limitTokens } = msg.errorDetails as {
    actualTokens?: number;
    limitTokens?: number;
  };
  return actualTokens !== undefined && limitTokens !== undefined
    ? actualTokens - limitTokens
    : undefined;
}

export function parsePromptTooLongTokenCounts(rawMessage: string): {
  actualTokens: number | undefined;
  limitTokens: number | undefined;
} {
  // "input length and `max_tokens` exceed context limit: 210000 + 32000 > 200000"
  const m = rawMessage.match(/(\d[\d,]*)\s*\+\s*(\d[\d,]*)\s*>\s*(\d[\d,]*)/);
  if (!m) return { actualTokens: undefined, limitTokens: undefined };
  const num = (s: string): number => Number(s.replace(/,/g, ""));
  return { actualTokens: num(m[1]!) + num(m[2]!), limitTokens: num(m[3]!) };
}

// The desktop is always interactive, so these are the "you can edit and try
// again" wordings — the non-interactive variants existed for the CLI's
// headless mode.
export function getImageTooLargeErrorMessage(): string {
  return "Image was too large. Try again with a smaller image.";
}
export function getPdfInvalidErrorMessage(): string {
  return "The PDF file was not valid. Try converting it to text first (e.g. pdftotext).";
}
export function getPdfPasswordProtectedErrorMessage(): string {
  return "PDF is password protected. Extract or convert it first, then attach the result.";
}
export function getPdfTooLargeErrorMessage(): string {
  return "PDF too large. Try a smaller file, or convert it to text with pdftotext.";
}
export function getRequestTooLargeErrorMessage(): string {
  return "Request too large. Try again with a smaller file.";
}

// ── Prompt-cache break tracking ───────────────────────────────────────────
// These recorded why a prompt cache was invalidated so cache efficiency could
// be reported. The pipeline they reported to is gone.

export function notifyCompaction(
  _querySource: unknown,
  _agentId?: unknown,
): void {}
export function notifyCacheDeletion(
  _querySource: unknown,
  _agentId?: unknown,
): void {}
export function cleanupAgentTracking(_agentId: unknown): void {}

// ── Prompt dumping ────────────────────────────────────────────────────────
// A debugging facility: with it on, every request is appended as JSONL. It
// wrapped the Anthropic client's fetch, so the wrapper has nothing left to
// wrap — the path is kept because callers show it to the user.

export function getDumpPromptsPath(agentIdOrSessionId?: string): string {
  return join(
    process.env.CLAUDE_CONFIG_DIR || process.cwd(),
    "dump-prompts",
    `${agentIdOrSessionId ?? "session"}.jsonl`,
  );
}

export function clearDumpState(_agentIdOrSessionId: string): void {}

export function createDumpPromptsFetch(
  _agentIdOrSessionId: string,
): undefined {
  return undefined;
}
