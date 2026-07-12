/**
 * OpenAI-compatible chat client — OpenRouter, llama.cpp, LM Studio, vLLM…
 *
 * Pure HTTP/SSE implementation (no SDK), with FULL tool-calling support:
 * converts our internal Anthropic-style content blocks (text / image /
 * tool_use / tool_result) to OpenAI chat messages and back, and mirrors the
 * stream diagnostics of AnthropicClient (one summary line per stream).
 *
 * Replaces the old thin OpenAIClient, which passed no tools at all and
 * JSON.stringify'd block content — unusable for agentic runs.
 */

import type { LLMProvider } from "../provider/types.js";
import type {
  LLMAdapter,
  LLMEvent,
  LLMMessage,
  LLMRequest,
  LLMUsage,
} from "./adapter.js";
import { sanitizeMaxTokens } from "./adapter.js";

interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChunk {
  choices?: {
    delta?: { content?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

function mapStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    default:
      return reason || "end_turn";
  }
}

/** Convert our Anthropic-style history to OpenAI chat messages. */
function toOpenAIMessages(
  system: string,
  messages: LLMMessage[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      const toolCalls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) =>
          b.type === "tool_use"
            ? {
                id: b.id,
                type: "function",
                function: {
                  name: b.name,
                  arguments: JSON.stringify(b.input ?? {}),
                },
              }
            : null,
        )
        .filter(Boolean);
      const msg: Record<string, unknown> = {
        role: "assistant",
        content: text || null,
      };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    // User message with blocks. Tool results MUST come right after the
    // assistant tool_calls message, each as its own role:"tool" message.
    for (const b of m.content) {
      if (b.type === "tool_result") {
        // Array content (Computer Use: text + screenshot image) — OpenAI's
        // tool role takes text only, so keep the text and note the image.
        const content =
          typeof b.content === "string"
            ? b.content
            : b.content
                .map((p) =>
                  p.type === "text" ? p.text : "[screenshot omitted]",
                )
                .join("\n");
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content });
      }
    }
    const parts: Record<string, unknown>[] = [];
    for (const b of m.content) {
      if (b.type === "text" && b.text) {
        parts.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${b.source.media_type};base64,${b.source.data}`,
          },
        });
      } else if (b.type === "audio") {
        // OpenAI-style input_audio (gpt-4o-audio, OpenRouter audio models).
        const mt = b.source.media_type;
        const format = /wav/i.test(mt)
          ? "wav"
          : /mpeg|mp3/i.test(mt)
            ? "mp3"
            : (mt.split("/")[1] ?? "mp3");
        parts.push({
          type: "input_audio",
          input_audio: { data: b.source.data, format },
        });
      } else if (b.type === "document" || b.type === "video") {
        // File part with a data URL — OpenRouter forwards these to models
        // with document/video understanding (Gemini, Mistral OCR, …).
        parts.push({
          type: "file",
          file: {
            filename:
              b.name || (b.type === "video" ? "video.mp4" : "document.pdf"),
            file_data: `data:${b.source.media_type};base64,${b.source.data}`,
          },
        });
      }
    }
    if (parts.length === 1 && parts[0].type === "text") {
      out.push({ role: m.role, content: (parts[0] as { text: string }).text });
    } else if (parts.length > 0) {
      out.push({ role: m.role, content: parts });
    }
  }
  return out;
}

export class OpenAICompatClient implements LLMAdapter {
  readonly providerId: string;
  readonly providerName: string;
  private baseURL: string;
  private apiKey: string;
  private isOpenRouter: boolean;

  constructor(provider: LLMProvider) {
    this.providerId = provider.id;
    this.providerName = provider.name;
    this.baseURL = provider.baseURL.replace(/\/+$/, "");
    this.apiKey = provider.apiKey;
    this.isOpenRouter =
      provider.kind === "openrouter" || /openrouter\.ai/i.test(provider.baseURL);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    if (this.isOpenRouter) {
      // Attribution headers OpenRouter asks apps to send.
      h["HTTP-Referer"] = "https://github.com/iaa2005/monet";
      h["X-Title"] = "Monet (Claude Code Desktop)";
    }
    return h;
  }

  private buildBody(
    request: LLMRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const tools = request.tools?.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request.system, request.messages),
      max_tokens: sanitizeMaxTokens(request.max_tokens),
      stream,
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (request.effort) {
      // Reasoning models take reasoning_effort and usually reject a custom
      // temperature, so send one or the other.
      body.reasoning_effort = request.effort;
    } else if (request.temperature != null) {
      body.temperature = request.temperature;
    }
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  async stream(
    request: LLMRequest,
    onEvent: (event: LLMEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.baseURL}/chat/completions`;
    const body = this.buildBody(request, true);

    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
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

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Accumulate streamed tool calls by index (ids/names arrive on the first
    // delta of each call, arguments dribble in over many).
    const toolCalls = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let finishReason: string | null | undefined;
    let usage: LLMUsage | undefined;

    // Same watchdog/guarded-read pattern as AnthropicClient.
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const STREAM_TIMEOUT_MS = 300_000;
    const disarmWatchdog = (): void => {
      if (watchdog != null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };
    const armWatchdog = (): void => {
      disarmWatchdog();
      watchdog = setTimeout(() => {
        console.error(
          `${tag} WATCHDOG fired — ${STREAM_TIMEOUT_MS / 1000}s of silence, cancelling reader`,
        );
        onEvent({
          type: "error",
          error: `Stream timed out after ${STREAM_TIMEOUT_MS / 1000}s of silence`,
        });
        reader.cancel().catch(() => {});
      }, STREAM_TIMEOUT_MS);
    };
    const guardedRead = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const onAbort = (): void =>
          reject(new DOMException("Aborted", "AbortError"));
        signal?.addEventListener("abort", onAbort, { once: true });
        reader
          .read()
          .then((r) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(r);
          })
          .catch((err) => {
            signal?.removeEventListener("abort", onAbort);
            reject(err);
          });
      });

    // Diagnostics — mirrors AnthropicClient's one-line stream summary.
    const tag = `[stream ${request.model}]`;
    const t0 = Date.now();
    let textLen = 0;
    let textTail = "";
    let chunkCount = 0;
    let toolDeltaCount = 0;

    const processLine = (line: string): void => {
      if (!line.startsWith("data: ")) return;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") return;
      let chunk: OpenAIChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      chunkCount++;
      if (chunk.error?.message) {
        onEvent({ type: "error", error: chunk.error.message });
        return;
      }
      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens ?? 0,
          output_tokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) return;
      if (typeof delta.content === "string" && delta.content) {
        textLen += delta.content.length;
        textTail = (textTail + delta.content).slice(-80);
        onEvent({ type: "text_delta", text: delta.content });
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          toolDeltaCount++;
          const acc = toolCalls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolCalls.set(tc.index, acc);
        }
      }
    };

    armWatchdog();
    try {
      while (true) {
        const { done, value } = await guardedRead();
        if (done) break;
        armWatchdog();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      }
      buffer += decoder.decode();
      for (const line of buffer.split("\n")) processLine(line);

      // Emit accumulated tool calls (index order), then the terminal stop.
      for (const [index, tc] of [...toolCalls.entries()].sort(
        (a, b) => a[0] - b[0],
      )) {
        try {
          onEvent({
            type: "tool_use",
            id: tc.id || `call_${index}`,
            name: tc.name,
            input: tc.args ? JSON.parse(tc.args) : {},
          });
        } catch {
          onEvent({
            type: "error",
            error: `Failed to parse tool input for ${tc.name}`,
          });
        }
      }
      onEvent({
        type: "message_stop",
        stop_reason: mapStopReason(finishReason),
        usage,
      });

      console.error(
        `${tag} done in ${Date.now() - t0}ms: text=${textLen} chars, stop_reason=${mapStopReason(finishReason)}, max_tokens=${body.max_tokens}, chunks=${chunkCount}, tool_calls=${toolCalls.size} (${toolDeltaCount} deltas), leftover=${buffer.trim().length}, tail=${JSON.stringify(textTail.slice(-60))}`,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        onEvent({ type: "error", error: "Aborted" });
      } else {
        const message = err instanceof Error ? err.message : "Unknown error";
        onEvent({ type: "error", error: message });
      }
    } finally {
      disarmWatchdog();
      try {
        reader.cancel().catch(() => {});
      } catch {
        /* closed */
      }
      try {
        reader.releaseLock();
      } catch {
        /* released */
      }
    }
  }

  async complete(
    request: LLMRequest,
    signal?: AbortSignal,
  ): Promise<{ role: "assistant"; content: string }> {
    const url = `${this.baseURL}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(request, false)),
      signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API ${response.status}: ${errorText}`);
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    return {
      role: "assistant",
      content: data.choices?.[0]?.message?.content ?? "",
    };
  }
}
