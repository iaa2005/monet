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

import { APP_NAME } from "@shared/brand.js";
import type { ActiveModel } from "../provider/types.js";
import type {
  LLMAdapter,
  LLMEvent,
  LLMMessage,
  LLMRequest,
  LLMUsage,
} from "./adapter.js";
import { sanitizeMaxTokens } from "./adapter.js";
import { droppedStream } from "./stream-end.js";
import { effortIndex, effortLadder } from "@shared/effort.js";
import {
  asDeadlineError,
  isLocalEndpoint,
  streamTimeoutMs,
  withDeadline,
} from "./timeouts.js";

interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChunk {
  choices?: {
    delta?: {
      content?: string | null;
      // Reasoning tokens: OpenRouter normalises to `reasoning`; DeepSeek and
      // some OpenAI-compat servers use `reasoning_content`.
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  /** OpenRouter: the company that served this reply ("Novita", "OpenAI"). */
  provider?: string | null;
  /**
   * llama.cpp, when `return_progress` was asked for: how much of the prompt
   * has been read. Arrives on its own chunks during prefill, before any
   * content delta. `total` is the whole prompt; `cache` is the part that was
   * already in the server's cache and cost nothing.
   */
  prompt_progress?: {
    total?: number;
    cache?: number;
    processed?: number;
    time_ms?: number;
  } | null;
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

  /** Silence before the stream is abandoned. 0 = wait indefinitely. */
  private readonly timeoutMs: number;
  /** Whether to ask for prefill progress — see `return_progress` below. */
  private readonly wantsProgress: boolean;
  /** This model's effort steps, weakest first — see @shared/effort.ts. */
  private readonly ladder: readonly string[];

  constructor(provider: ActiveModel) {
    this.providerId = provider.id;
    this.providerName = provider.name;
    this.baseURL = provider.baseURL.replace(/\/+$/, "");
    this.apiKey = provider.apiKey;
    this.isOpenRouter =
      provider.kind === "openrouter" || /openrouter\.ai/i.test(provider.baseURL);
    this.timeoutMs = streamTimeoutMs(provider);
    this.wantsProgress =
      provider.kind === "monet-local" || isLocalEndpoint(provider.baseURL);
    this.ladder = effortLadder(provider.kind, provider.effortLevels);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    if (this.isOpenRouter) {
      // Attribution headers OpenRouter asks apps to send.
      h["HTTP-Referer"] = "https://github.com/iaa2005/monet";
      h["X-Title"] = APP_NAME;
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
    // A step this model does not have is not a step: the composer offers the
    // model's own ladder, but a routine or a sub-agent can name anything, and
    // an unknown value would either be rejected by the server or — worse —
    // silently ignored while the user believes it was asked for.
    const effort =
      request.effort && effortIndex(request.effort, this.ladder) >= 0
        ? request.effort
        : undefined;
    if (effort) {
      // OpenRouter exposes a UNIFIED `reasoning` object it normalises to each
      // underlying provider, and accepts the full effort set (minimal…max).
      // Everything else takes the flat `reasoning_effort` with whatever its
      // own ladder says — for llama.cpp that is low…xhigh, for OpenAI
      // minimal…high, and the ladder is where that distinction lives now
      // rather than in a clamp here. Reasoning models reject a custom
      // temperature, so send reasoning OR temperature.
      if (this.isOpenRouter) body.reasoning = { effort };
      else body.reasoning_effort = effort;
    } else if (request.temperature != null) {
      body.temperature = request.temperature;
    }
    // OpenRouter: which company runs the model. Everything except the tier
    // lives inside the `provider` object — there is no top-level fallbacks
    // parameter. `order` is a preference; `only` is what actually pins a
    // company (verified against the live API: only:["novita"] came back served
    // by Novita, only:["baidu"] by Baidu).
    if (this.isOpenRouter && request.routing) {
      const r = request.routing;
      const provider: Record<string, unknown> = {};
      if (r.providers?.length) provider.order = r.providers;
      if (r.only?.length) provider.only = r.only;
      if (r.ignore?.length) provider.ignore = r.ignore;
      if (r.sort) provider.sort = r.sort;
      if (r.allowFallbacks !== undefined) provider.allow_fallbacks = r.allowFallbacks;
      if (Object.keys(provider).length) body.provider = provider;
      // Top-level, not inside `provider`. Only ever a value the API defines:
      // an unknown one is accepted with a 200 and silently reroutes.
      if (r.serviceTier === "flex" || r.serviceTier === "priority")
        body.service_tier = r.serviceTier;
    }
    if (stream) {
      body.stream_options = { include_usage: true };
      // Reading a long prompt on a local server is minutes of silence, and
      // silence is indistinguishable from a dead connection. llama.cpp will
      // narrate the prefill if asked; measured, it sends a chunk per batch.
      // Only asked of local endpoints: a remote API that does not know the
      // field would at best ignore it and at worst refuse the request.
      if (this.wantsProgress) body.return_progress = true;
    }
    return body;
  }

  async stream(
    request: LLMRequest,
    onEvent: (event: LLMEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.baseURL}/chat/completions`;
    const body = this.buildBody(request, true);

    // The watchdog aborts the REQUEST, not just the reader: cancelling the
    // reader leaves the server generating into a socket nobody reads, and on
    // llama.cpp that means a slot held by an answer no one will ever see.
    const watchdog = new AbortController();
    let timedOut = false;
    const wire = signal
      ? AbortSignal.any([signal, watchdog.signal])
      : watchdog.signal;

    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: wire,
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
    // OpenRouter names the serving company on the chunks; the last word wins.
    let servedBy: string | undefined;

    // Same watchdog/guarded-read pattern as AnthropicClient, and the same
    // per-endpoint deadline — see llm/timeouts.ts.
    const timeoutMs = this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const disarmWatchdog = (): void => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const armWatchdog = (): void => {
      disarmWatchdog();
      if (timeoutMs <= 0) return; // configured to wait as long as it takes
      timer = setTimeout(() => {
        timedOut = true;
        console.error(
          `${tag} WATCHDOG fired — ${timeoutMs / 1000}s of silence, aborting the request`,
        );
        onEvent({
          type: "error",
          error: `Stream timed out after ${timeoutMs / 1000}s of silence`,
        });
        watchdog.abort();
      }, timeoutMs);
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
    // Reasoning is output too — a turn that thought and then lost the
    // connection is not a turn that produced nothing.
    let reasoningLen = 0;
    let chunkCount = 0;
    let toolDeltaCount = 0;
    let progressSeen = 0;
    let lastProgress: { processed: number; total: number; cache: number } | undefined;

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
      if (typeof chunk.provider === "string" && chunk.provider) servedBy = chunk.provider;
      // Prefill narration. Emitted before anything else is looked at: these
      // chunks carry an empty delta, and the early `if (!choice) return` below
      // would otherwise drop the only sign of life a long prompt gives.
      const pp = chunk.prompt_progress;
      if (pp && typeof pp.total === "number") {
        progressSeen++;
        // Kept for the post-mortem: where the reading had got to when the
        // stream stopped is what says whether the prompt was the problem.
        lastProgress = { processed: pp.processed ?? 0, total: pp.total, cache: pp.cache ?? 0 };
        onEvent({
          type: "prompt_progress",
          processed: pp.processed ?? 0,
          total: pp.total,
          cache: pp.cache ?? 0,
        });
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
      const reasoning = delta.reasoning ?? delta.reasoning_content;
      if (typeof reasoning === "string" && reasoning) {
        reasoningLen += reasoning.length;
        onEvent({ type: "reasoning_delta", text: reasoning });
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

      // A stream with no verdict and no output did not finish — it broke.
      // Reported before the tool calls are flushed, because there are none:
      // this is the case where NOTHING came back. See llm/stream-end.ts.
      const dropped = droppedStream({
        finishReason,
        textLen,
        reasoningLen,
        toolCalls: toolCalls.size,
        progressChunks: progressSeen,
        ...(lastProgress ? { lastProgress } : {}),
        leftover: buffer.trim().length,
      });
      if (dropped && !timedOut) {
        console.error(
          `${tag} dropped after ${Date.now() - t0}ms: chunks=${chunkCount}, progress=${progressSeen}, leftover=${buffer.trim().length}`,
        );
        onEvent({ type: "error", error: dropped });
        return;
      }

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
        servedBy,
      });

      console.error(
        `${tag} done in ${Date.now() - t0}ms: text=${textLen} chars, stop_reason=${mapStopReason(finishReason)}, max_tokens=${body.max_tokens}, chunks=${chunkCount}, progress=${progressSeen}${lastProgress ? ` (prompt ${lastProgress.total} tokens, ${lastProgress.cache} reused)` : ""}, tool_calls=${toolCalls.size} (${toolDeltaCount} deltas), leftover=${buffer.trim().length}, tail=${JSON.stringify(textTail.slice(-60))}`,
      );
    } catch (err) {
      // A timeout has already said what happened; anything after it is the
      // abort we ourselves asked for.
      if (err instanceof DOMException && err.name === "AbortError") {
        if (!timedOut) onEvent({ type: "error", error: "Aborted" });
      } else if (!timedOut) {
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

  /**
   * One answer, whole. Collected from the STREAM rather than asked for as a
   * single JSON body.
   *
   * A non-streaming request sends no byte until the answer is finished, and
   * Node's fetch gives up on a response whose headers have not arrived in
   * 300 seconds — undici's default, and not something a caller's own
   * deadline can extend. On a local model writing at 3.4 tokens a second, a
   * compaction summary takes longer than that to begin, so every summary
   * ended in "fetch failed" while the server went on writing it for nobody.
   * The stream sends its first bytes at once and the watchdog restarts on
   * each of them, which is the behaviour the rest of this file already has.
   */
  async complete(
    request: LLMRequest,
    signal?: AbortSignal,
  ): Promise<{ role: "assistant"; content: string }> {
    let content = "";
    let reasoning = "";
    let error: string | undefined;
    await this.stream(
      request,
      (e) => {
        if (e.type === "text_delta") content += e.text;
        else if (e.type === "reasoning_delta") reasoning += e.text;
        else if (e.type === "error" && !error) error = e.error;
      },
      signal,
    );
    if (error && !content.trim()) throw new Error(error);
    if (content.trim()) return { role: "assistant", content };
    // A thinking model (deepseek-reasoner and friends) streams its chain of
    // thought into reasoning and the answer into content. When the budget
    // runs out mid-thought, content comes back EMPTY while the thinking holds
    // the real work — and every caller here wants JSON, which the model has
    // usually already written inside that thinking. Returning "" made Reflect
    // report "empty response" and the routine drafter silently fail.
    return { role: "assistant", content: reasoning };
  }
}
