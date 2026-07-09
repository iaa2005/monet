/**
 * Anthropic Messages API client.
 *
 * Pure HTTP implementation — no @anthropic-ai/sdk dependency.
 * Handles SSE streaming for Anthropic and DeepSeek (Anthropic-compatible).
 */

import type { LLMProvider } from "../provider/types.js";
import type {
  LLMAdapter,
  LLMContentBlock,
  LLMEvent,
  LLMRequest,
} from "./adapter.js";
import { sanitizeMaxTokens } from "./adapter.js";

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

  constructor(provider: LLMProvider) {
    this.providerId = provider.id;
    this.providerName = provider.name;
    this.baseURL = provider.baseURL.replace(/\/+$/, "");
    this.apiKey = provider.apiKey;
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
      messages: request.messages.map((m) => ({
        role: m.role,
        content: toAnthropicContent(m.content),
      })),
      tools: tools && tools.length > 0 ? tools : undefined,
      stream: true,
    };
    if (request.temperature != null) body.temperature = request.temperature;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });

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

    // Stream watchdog: abort on silence > 10s (prevent infinite hang
    // when the server sends partial output then stalls).
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const STREAM_TIMEOUT_MS = 300_000; // 5 min — DeepSeek can pause for a long time mid-generation

    function armWatchdog(): void {
      disarmWatchdog();
      watchdog = setTimeout(() => {
        console.error(
          `[stream ${request.model}] WATCHDOG fired — ${STREAM_TIMEOUT_MS / 1000}s of silence, cancelling reader (this truncates the response)`,
        );
        onEvent({
          type: "error",
          error: `Stream timed out after ${STREAM_TIMEOUT_MS / 1000}s of silence`,
        });
        reader.cancel().catch(() => {});
      }, STREAM_TIMEOUT_MS);
    }

    function disarmWatchdog(): void {
      if (watchdog != null) {
        clearTimeout(watchdog);
        watchdog = null;
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
    let sawMessageStop = false;
    let finalStopReason: string | undefined;
    const counts: Record<string, number> = {};

    const emitMessageStop = (event: AnthropicSSEEvent): void => {
      sawMessageStop = true;
      onEvent({
        type: "message_stop",
        stop_reason: finalStopReason ?? "end_turn",
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
          if (event.delta?.type === "text_delta" && event.delta.text) {
            textLen += event.delta.text.length;
            textTail = (textTail + event.delta.text).slice(-80);
            onEvent({ type: "text_delta", text: event.delta.text });
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
      // instead of the UI staying stuck "streaming".
      if (!sawMessageStop) {
        console.error(
          `${tag} stream ended WITHOUT message_stop (stop_reason=${finalStopReason ?? "unknown"}, text=${textLen}) — synthesizing`,
        );
        onEvent({
          type: "message_stop",
          stop_reason: finalStopReason ?? "end_turn",
        });
      }

      console.error(
        `${tag} done in ${Date.now() - t0}ms: text=${textLen} chars, stop_reason=${finalStopReason ?? "n/a"}, max_tokens=${body.max_tokens}, events=${JSON.stringify(counts)}, leftover=${buffer.trim().length}, tail=${JSON.stringify(textTail.slice(-60))}`,
      );
    } catch (err) {
      // AbortError from guardedRead means user clicked Stop — not a real error
      if (err instanceof DOMException && err.name === "AbortError") {
        onEvent({ type: "error", error: "Aborted" });
      } else {
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
      messages: request.messages.map((m) => ({
        role: m.role,
        content: toAnthropicContent(m.content),
      })),
      stream: false,
    };
    if (request.temperature != null) body.temperature = request.temperature;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });

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
