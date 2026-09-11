/**
 * Anthropic Messages API client.
 *
 * Pure HTTP implementation — no @anthropic-ai/sdk dependency.
 * Handles SSE streaming for Anthropic and DeepSeek (Anthropic-compatible).
 */

import type { ActiveModel, EffortLevel, Modality } from "../provider/types.js";
import { fitToModalities } from "./modality-fit.js";
import type {
  LLMAdapter,
  LLMContentBlock,
  LLMEvent,
  LLMRequest,
} from "./adapter.js";
import { sanitizeMaxTokens } from "./adapter.js";
import { droppedStream } from "./stream-end.js";
import { effortLadder, thinkingBudget } from "@shared/effort.js";
import { asDeadlineError, streamTimeoutMs, withDeadline } from "./timeouts.js";

/**
 * Apply reasoning to an Anthropic request body. With effort set we enable
 * extended thinking (a token budget) and OMIT temperature — the API rejects a
 * custom temperature alongside thinking. max_tokens must exceed the budget, so
 * bump it if the caller's output budget is too small.
 *
 * Anthropic has no named effort levels at all: the names are this app's, and
 * what goes on the wire is a number. So the budget comes from the step's
 * POSITION on this model's ladder (@shared/effort.ts) rather than a lookup
 * table — which is what lets a ladder of any length, with any names, mean
 * something here.
 */
function applyThinking(
  body: Record<string, unknown>,
  request: LLMRequest,
  ladder: readonly string[],
): void {
  // No effort requested → send no thinking config at all.
  if (!request.effort) return;
  const budget = thinkingBudget(request.effort, ladder);
  // A step this model does not have is not a step. Sending some fallback
  // budget would be inventing an instruction the user did not give.
  if (budget === null) return;
  body.thinking = { type: "enabled", budget_tokens: budget };
  const min = Math.min(budget + 4096, request.max_tokens);
  if ((body.max_tokens as number) < min) body.max_tokens = min;
}

/** Anthropic accepts text/image/document blocks natively; audio and video
 * have no equivalent — degrade those to a text placeholder. */
function toAnthropicContent(
  content: string | LLMContentBlock[],
): string | unknown[] {
  if (typeof content === "string") return content;
  return content.map((b) => {
    if (b.type === "audio" || b.type === "video") {
      return {
        type: "text",
        text: `[${b.type} attachment${b.name ? ` "${b.name}"` : ""} — not supported by this provider]`,
      };
    }
    if (b.type === "document") return { type: "document", source: b.source };
    return b;
  });
}

interface AnthropicSSEEvent {
  type:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_delta"
    | "message_stop"
    | "ping"
    | "error";
  message?: {
    id: string;
    model: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    index?: number;
  };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    // message_delta carries the final stop_reason (end_turn / max_tokens /
    // tool_use) — useful for diagnosing truncated/cut-off responses.
    stop_reason?: string;
    stop_sequence?: string;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  error?: { type: string; message: string };
}

export class AnthropicClient implements LLMAdapter {
  readonly providerId: string;
  readonly providerName: string;
  private baseURL: string;
  private apiKey: string;
  /** What the model can take in — media it cannot is described in words. */
  private readonly modalities: readonly Modality[] | undefined;

  /** Silence before the stream is abandoned. 0 = wait indefinitely. */
  private readonly timeoutMs: number;
  /** This model's effort steps, weakest first — what a level MEANS here. */
  private readonly ladder: readonly string[];

  constructor(provider: ActiveModel) {
    this.providerId = provider.id;
    this.providerName = provider.name;
    this.baseURL = provider.baseURL.replace(/\/+$/, "");
    this.apiKey = provider.apiKey;
    this.modalities = provider.modalities;
    // Resolved once, here, rather than threaded through every call site: the
    // deadline is a property of the endpoint, and the endpoint is what this
    // object is. See llm/timeouts.ts for why it is not a constant any more.
    this.timeoutMs = streamTimeoutMs(provider);
    this.ladder = effortLadder(provider.kind, provider.effortLevels);
  }

  async stream(
    request: LLMRequest,
    onEvent: (event: LLMEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.baseURL}/v1/messages`;

    // Convert tools to Anthropic format
    const tools = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: sanitizeMaxTokens(request.max_tokens),
      system: request.system,
      messages: fitToModalities(request.messages, this.modalities).map((m) => ({
        role: m.role,
        content: toAnthropicContent(m.content),
      })),
      tools: tools && tools.length > 0 ? tools : undefined,
      stream: true,
    };
    applyThinking(body, request, this.ladder);

    // The watchdog aborts the REQUEST, not just the reader: cancelling the
    // reader leaves the server generating into a socket nobody reads, and on
    // llama.cpp that means a slot held by an answer no one will ever see.
    const watchdog = new AbortController();
    let timedOut = false;
    const wire = signal
      ? AbortSignal.any([signal, watchdog.signal])
      : watchdog.signal;

    // Stop before the first byte is still Stop, not an error — see the
    // OpenAI-compatible client for the long version.
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: wire,
      });
    } catch (err) {
      const stopped =
        signal?.aborted === true ||
        (err instanceof DOMException && err.name === "AbortError");
      onEvent({
        type: "error",
        error: stopped
          ? "Aborted"
          : err instanceof Error
            ? err.message
            : "Unknown error",
      });
      return;
    }

    if (!response.ok) {
      const errorText = await response.text();
      onEvent({ type: "error", error: `API ${response.status}: ${errorText}` });
      return;
    }

    if (!response.body) {
      onEvent({ type: "error", error: "No response body" });
      return;
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentToolId = "";
    let currentToolName = "";
    let currentToolInput = "";

    // Stream watchdog: give up when the connection has gone quiet for longer
    // than this endpoint's deadline. Not a constant — see llm/timeouts.ts.
    const timeoutMs = this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function armWatchdog(): void {
      disarmWatchdog();
      if (timeoutMs <= 0) return; // configured to wait as long as it takes
      timer = setTimeout(() => {
        timedOut = true;
        console.error(
          `[stream ${request.model}] WATCHDOG fired — ${timeoutMs / 1000}s of silence, aborting the request (this truncates the response)`,
        );
        onEvent({
          type: "error",
          error: `Stream timed out after ${timeoutMs / 1000}s of silence`,
        });
        watchdog.abort();
      }, timeoutMs);
    }

    function disarmWatchdog(): void {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    // Helper: wait for the next chunk OR the abort signal (whichever fires
    // first). Without this, reader.read() can stay parked forever even after
    // the user clicks Stop — the fetch is aborted but the reader was already
    // awaiting the next chunk.
    function guardedRead(): Promise<ReadableStreamReadResult<Uint8Array>> {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const onAbort = (): void => {
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        reader
          .read()
          .then((result) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(result);
          })
          .catch((err) => {
            signal?.removeEventListener("abort", onAbort);
            reject(err);
          });
      });
    }

    // ─── Diagnostics ─────────────────────────────────────────────────────
    // A one-line summary is always logged to the main-process stderr (the
    // `npm run dev` terminal) so a truncated/stalled/cut-off response leaves a
    // trace: text length, stop_reason, event counts, leftover buffer. Set
    // MONET_DEBUG_STREAM=1 for per-event/raw-line logging.
    const debug = !!process.env.MONET_DEBUG_STREAM;
    const tag = `[stream ${request.model}]`;
    const t0 = Date.now();
    let textLen = 0;
    // Last ~80 chars of assistant text — logged at stream end so a "response
    // looks cut off" report can be checked against what the adapter actually
    // received (UI truncation vs the model/provider stopping early).
    let textTail = "";
    // Output that is not the answer, counted for the same reason: a turn that
    // thought, or called a tool, and then lost the connection did not come
    // back empty. See llm/stream-end.ts.
    let reasoningLen = 0;
    let toolUseCount = 0;
    let sawMessageStop = false;
    let finalStopReason: string | undefined;
    const counts: Record<string, number> = {};
    // First content delta → message_stop is the writing time; what came
    // before it was the prompt being read.
    let firstDeltaAt: number | null = null;

    const emitMessageStop = (event: AnthropicSSEEvent): void => {
      sawMessageStop = true;
      onEvent({
        type: "message_stop",
        stop_reason: finalStopReason ?? "end_turn",
        timing:
          event.usage && firstDeltaAt !== null
            ? {
                generationMs: Date.now() - firstDeltaAt,
                outputTokens: event.usage.output_tokens,
              }
            : undefined,
        usage: event.usage
          ? {
              input_tokens: event.usage.input_tokens,
              output_tokens: event.usage.output_tokens,
              cache_creation_input_tokens: event.usage.cache_creation_input_tokens,
              cache_read_input_tokens: event.usage.cache_read_input_tokens,
            }
          : undefined,
      });
    };

    // Parse and dispatch a single SSE line. Shared by the streaming loop and
    // the end-of-stream flush so the final buffered text/message_stop is never
    // dropped (the old flush only recovered a lone message_stop → truncation).
    const processSSELine = (line: string): void => {
      if (!line.startsWith("data: ")) return;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") return;
      let event: AnthropicSSEEvent;
      try {
        event = JSON.parse(data);
      } catch {
        if (debug) console.error(`${tag} unparseable SSE: ${data.slice(0, 160)}`);
        return;
      }
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      if (debug) console.error(`${tag} < ${event.type}`);

      switch (event.type) {
        case "content_block_start":
          if (event.content_block?.type === "tool_use") {
            currentToolId = event.content_block.id || "";
            currentToolName = event.content_block.name || "";
            currentToolInput = "";
          }
          break;
        case "content_block_delta":
          if (firstDeltaAt === null) firstDeltaAt = Date.now();
          if (event.delta?.type === "text_delta" && event.delta.text) {
            textLen += event.delta.text.length;
            textTail = (textTail + event.delta.text).slice(-80);
            onEvent({ type: "text_delta", text: event.delta.text });
          } else if (
            event.delta?.type === "thinking_delta" &&
            event.delta.thinking
          ) {
            // Extended-thinking tokens — surfaced to the UI (Thinking mode) but
            // never added to the model context.
            reasoningLen += event.delta.thinking.length;
            onEvent({ type: "reasoning_delta", text: event.delta.thinking });
          } else if (
            event.delta?.type === "input_json_delta" &&
            event.delta.partial_json
          ) {
            currentToolInput += event.delta.partial_json;
          }
          break;
        case "content_block_stop":
          if (currentToolId) {
            try {
              onEvent({
                type: "tool_use",
                id: currentToolId,
                name: currentToolName,
                input: JSON.parse(currentToolInput),
              });
              toolUseCount++;
            } catch {
              onEvent({ type: "error", error: "Failed to parse tool input" });
            }
            currentToolId = "";
            currentToolName = "";
            currentToolInput = "";
          }
          break;
        case "message_delta":
          // Carries the final stop_reason (end_turn / max_tokens / tool_use).
          if (event.delta?.stop_reason) finalStopReason = event.delta.stop_reason;
          break;
        case "message_stop":
          emitMessageStop(event);
          break;
        case "error":
          onEvent({ type: "error", error: event.error?.message || "Unknown error" });
          break;
      }
    };

    armWatchdog();

    try {
      while (true) {
        const { done, value } = await guardedRead();
        if (done) break;

        armWatchdog(); // reset timeout on every chunk

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processSSELine(line);
      }

      // Stream ended. Flush the decoder and process EVERY remaining buffered
      // line — the final text delta and/or message_stop can still be sitting
      // in `buffer` with no trailing newline.
      buffer += decoder.decode();
      for (const line of buffer.split("\n")) processSSELine(line);

      // If the provider closed the stream without a message_stop (abrupt close,
      // or OpenAI-style [DONE]), synthesize one so the turn actually completes
      // instead of the UI staying stuck "streaming" — UNLESS nothing came back
      // at all, in which case the connection dropped and saying "end_turn"
      // sends the harness off nudging a model that never spoke. See
      // llm/stream-end.ts.
      if (!sawMessageStop) {
        const dropped = droppedStream({
          finishReason: finalStopReason,
          textLen,
          reasoningLen,
          toolCalls: toolUseCount,
          progressChunks: 0,
          leftover: buffer.trim().length,
        });
        console.error(
          `${tag} stream ended WITHOUT message_stop (stop_reason=${finalStopReason ?? "unknown"}, text=${textLen}) — ${dropped ? "dropped" : "synthesizing"}`,
        );
        if (dropped && !timedOut) {
          onEvent({ type: "error", error: dropped });
          return;
        }
        onEvent({
          type: "message_stop",
          stop_reason: finalStopReason ?? "end_turn",
        });
      }

      console.error(
        `${tag} done in ${Date.now() - t0}ms: text=${textLen} chars, stop_reason=${finalStopReason ?? "n/a"}, max_tokens=${body.max_tokens}, events=${JSON.stringify(counts)}, leftover=${buffer.trim().length}, tail=${JSON.stringify(textTail.slice(-60))}`,
      );
    } catch (err) {
      // AbortError from guardedRead means user clicked Stop — not a real error.
      // Unless it was the watchdog that aborted, and then the error the user
      // needs to read has already been sent; a second "Aborted" on top of it
      // would only say the truncation was their own doing.
      if (err instanceof DOMException && err.name === "AbortError") {
        if (!timedOut) onEvent({ type: "error", error: "Aborted" });
      } else if (!timedOut) {
        const message = err instanceof Error ? err.message : "Unknown error";
        onEvent({ type: "error", error: message });
      }
    } finally {
      disarmWatchdog();
      // After the stream is consumed or errored, cancel any lingering I/O and
      // release the lock. `cancel()` is a no-op on a closed stream; `releaseLock()`
      // is safe after cancel because cancel closes the stream synchronously.
      try {
        reader.cancel().catch(() => {});
      } catch {}
      // releaseLock() on an already-released reader throws — swallow it.
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  async complete(
    request: LLMRequest,
    signal?: AbortSignal,
  ): Promise<{
    role: "assistant";
    content: string;
  }> {
    const url = `${this.baseURL}/v1/messages`;

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: sanitizeMaxTokens(request.max_tokens),
      system: request.system,
      messages: fitToModalities(request.messages, this.modalities).map((m) => ({
        role: m.role,
        content: toAnthropicContent(m.content),
      })),
      stream: false,
    };
    applyThinking(body, request, this.ladder);

    // A completion has no stream to keep it alive, so the same number bounds
    // the whole request rather than the gaps in it. Background work — the
    // nightly consolidation, the clarifier, the judge — comes through here,
    // and without a deadline a local model that wedges wedges it forever.
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: withDeadline(signal, this.timeoutMs),
      });
    } catch (err) {
      throw asDeadlineError(err, this.timeoutMs, signal);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const text =
      data.content
        ?.filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("") || "";

    return { role: "assistant", content: text };
  }
}
