/**
 * A stream that stops is not a stream that ended.
 *
 * Reported from a real run, on a 27B reading a long prompt on the CPU:
 *
 *   done in 252352ms: text=0 chars, stop_reason=end_turn, chunks=10,
 *   progress=10, tool_calls=0, leftover=38
 *   [agent] empty reply (stop_reason=end_turn) — nudging (1/2)
 *
 * Ten chunks, every one of them prefill progress. No answer, no finish
 * reason, and a final frame cut mid-line. The client filled the missing
 * verdict with `end_turn`, the agent read that as a model answering with
 * nothing, and the cure for THAT is the nudge — which re-sent the whole
 * request into the same wall for another four minutes.
 *
 * Two halves are checked: the verdict itself (pure, every case), and the
 * client against a server that really does hang up mid-stream.
 *
 *   npm run smoke:streamend
 */

import { createServer, type Server } from "node:http";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};

const { droppedStream } = await import("../src/main/llm/stream-end.js");
const { OpenAICompatClient } = await import(
  "../src/main/llm/openai-compat-client.js"
);
type LLMEvent = import("../src/main/llm/adapter.js").LLMEvent;
type ActiveModel = import("../src/main/provider/types.js").ActiveModel;

const END = {
  finishReason: undefined,
  textLen: 0,
  reasoningLen: 0,
  toolCalls: 0,
  progressChunks: 0,
  leftover: 0,
};

// ─── The verdict ────────────────────────────────────────────────────────

check(
  "THE REPORTED RUN IS CALLED WHAT IT WAS — a dropped connection",
  !!droppedStream({ ...END, progressChunks: 10, leftover: 38 }),
);
check(
  "…and says the server was still reading the prompt",
  /reading the prompt/i.test(
    droppedStream({ ...END, progressChunks: 10, leftover: 38 }) ?? "",
  ),
  droppedStream({ ...END, progressChunks: 10, leftover: 38 }),
);
check(
  "…and mentions the frame that was cut off",
  /cut off/i.test(droppedStream({ ...END, progressChunks: 10, leftover: 38 }) ?? ""),
);
// THE DISTINCTION THIS EXISTS FOR. Both of these are "no verdict, no
// output"; only the narration says which. The field case was the second —
// the router log had `progress = 1.00` five seconds before the child exited
// with 0xC0000005, and the crash was a full GPU offload the driver could not
// hold, nothing whatever to do with the prompt.
{
  const early = droppedStream({
    ...END,
    progressChunks: 3,
    lastProgress: { processed: 1200, total: 12240 },
  });
  const done = droppedStream({
    ...END,
    progressChunks: 10,
    leftover: 38,
    lastProgress: { processed: 12240, total: 12240 },
  });
  check("a prefill that died part-way says how far it got", /1,200 of 12,240/.test(early ?? ""), early);
  check("…and blames the prompt, which is fair there", /prompt is what the machine/.test(early ?? ""));
  check(
    "A PREFILL THAT FINISHED IS NOT BLAMED ON THE PROMPT",
    /finished reading the prompt/.test(done ?? ""),
    done,
  );
  check(
    "…it says the backend process died, and to read its log",
    /shortening it will not help/.test(done ?? "") && /server's own log/.test(done ?? ""),
  );
  // A batch short of the end is still "it finished" — llama.cpp narrates in
  // ubatch steps and the last one need not land exactly on the total.
  check(
    "one batch short of the end counts as finished",
    /finished reading the prompt/.test(
      droppedStream({ ...END, progressChunks: 9, lastProgress: { processed: 12_190, total: 12_240 } }) ?? "",
    ),
  );
}

check(
  "a drop with no progress chunks is still a drop, worded plainly",
  /without saying why/i.test(droppedStream(END) ?? ""),
  droppedStream(END),
);

// The three ways a stream is fine. Each of these firing would put a red box
// under a perfectly good answer, which is worse than the bug being fixed.
check(
  "a finish_reason means it ended, whatever else is odd",
  droppedStream({ ...END, finishReason: "stop" }) === null,
);
check(
  "an EMPTY reply that said 'stop' is a model going quiet, not a drop",
  droppedStream({ ...END, finishReason: "stop", progressChunks: 4 }) === null,
);
check(
  "text with no verdict is left alone — some servers are careless",
  droppedStream({ ...END, textLen: 120 }) === null,
);
check(
  "so is a turn that only thought",
  droppedStream({ ...END, reasoningLen: 400 }) === null,
);
check(
  "so is a turn that only called tools",
  droppedStream({ ...END, toolCalls: 1 }) === null,
);

// ─── Against a server that hangs up ─────────────────────────────────────

/**
 * How the stub finishes.
 *
 * `cut-mid-frame` is the field case, reproduced exactly: a half-written SSE
 * frame and then a clean end of body. That is what leaves `leftover=38` in
 * the log — the connection closed properly, the ANSWER did not.
 */
type Ending = "cut-mid-frame" | "cut-clean" | "proper";

function serve(
  mode: Ending,
  chunks: string[],
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    for (const c of chunks) res.write(`data: ${c}\n\n`);
    if (mode === "proper") {
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    // The real failure: the last frame is half-written and then the body
    // simply stops. No socket error, no verdict — the client sees a clean
    // end of stream, which is exactly why it used to call it end_turn.
    if (mode === "cut-mid-frame") res.write('data: {"choices":[{"delta"');
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

const progress = (n: number): string =>
  JSON.stringify({
    choices: [{ delta: {} }],
    prompt_progress: { total: 6040, cache: 0, processed: n, time_ms: 1000 },
  });
const text = (t: string): string =>
  JSON.stringify({ choices: [{ delta: { content: t } }] });

const endpoint = (url: string): ActiveModel => ({
  id: "stub",
  name: "stub",
  kind: "monet-local",
  apiKey: "",
  baseURL: url,
  model: "qwen3.8-27b-q4_k_m",
  maxTokens: 64,
  contextLimit: 8192,
  // No watchdog: this probe is about the connection ending, and a timeout
  // firing instead would report the same failure for the wrong reason.
  streamTimeoutSec: 0,
});

async function run(
  mode: Ending,
  chunks: string[],
): Promise<{ events: LLMEvent[]; stop?: string; error?: string }> {
  const s = await serve(mode, chunks);
  const events: LLMEvent[] = [];
  try {
    await new OpenAICompatClient(endpoint(s.url)).stream(
      {
        model: "qwen3.8-27b-q4_k_m",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      },
      (e) => events.push(e),
    );
  } finally {
    await s.close();
  }
  const stop = events.find((e) => e.type === "message_stop");
  const err = events.find((e) => e.type === "error");
  return {
    events,
    ...(stop && stop.type === "message_stop" ? { stop: stop.stop_reason } : {}),
    ...(err && err.type === "error" ? { error: err.error } : {}),
  };
}

// The reported case, reproduced: nothing but prefill narration, then gone.
{
  const r = await run("cut-mid-frame", [progress(554), progress(1200), progress(2400)]);
  check(
    "THE PREFILL THAT DIED IS REPORTED AS AN ERROR, not an empty answer",
    !!r.error,
    r.events.map((e) => e.type),
  );
  check(
    "…and it is NOT dressed up as a finished turn",
    r.stop === undefined,
    r.stop,
  );
  check(
    "…the progress the user watched is still delivered",
    r.events.filter((e) => e.type === "prompt_progress").length === 3,
  );
  check(
    "…and the message says what the server was doing",
    /reading the prompt/i.test(r.error ?? ""),
    r.error,
  );
  check(
    "…and how far it had got, from the last progress chunk",
    /2,400 of 6,040/.test(r.error ?? ""),
    r.error,
  );
}

// A drop with no narration at all — a plain OpenAI server going away.
{
  const r = await run("cut-clean", []);
  check("a bare hang-up is an error too", !!r.error, r.error);
  check("with no message_stop pretending otherwise", r.stop === undefined);
}

// The half that must not regress: an answer that arrived and finished.
{
  const r = await run("proper", [text("Hello"), text(" there")]);
  check("a proper stream still ends properly", r.stop === "end_turn", r.stop);
  check("with no error invented for it", !r.error, r.error);
  check(
    "and its text intact",
    r.events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("") === "Hello there",
  );
}

// An answer that arrived and was then cut off: truncated, but there. Saying
// "the connection dropped" here would put a red box under a real reply.
{
  const r = await run("cut-mid-frame", [text("Half an ans")]);
  check(
    "a stream cut AFTER text is not called a drop",
    !r.error,
    r.error,
  );
  check("…it ends, and the words that arrived are kept", r.stop === "end_turn", r.stop);
}

console.log(failures ? `\n${failures} FAILED` : "\nSTREAM-END CHECKS PASSED");
process.exitCode = failures ? 1 : 0;
