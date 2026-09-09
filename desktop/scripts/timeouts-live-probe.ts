/**
 * The watchdog and the prefill narration, against a real llama.cpp.
 *
 * The unit probe (timeouts-probe.ts) checks the arithmetic. This checks the
 * thing the arithmetic is for: that a local model reading a long prompt keeps
 * the connection visibly alive, so a watchdog far shorter than the prefill
 * does not fire. Before this change the watchdog was a 300-second constant
 * and the prefill on this machine ran to half an hour — it fired on the first
 * turn of every chat, and the loop then re-sent the whole request.
 *
 * Needs a Monet Local (or bare llama.cpp router) with a model loaded:
 *
 *   MONET_LIVE_URL=http://127.0.0.1:17190/v1 \
 *   MONET_LIVE_MODEL=qwen3.8-27b-q4_k_m \
 *   npm run smoke:timeouts:live
 *
 * Skipped, loudly, when that is not there — a probe that quietly passes with
 * nothing behind it is worse than no probe.
 */

import { OpenAICompatClient } from "../src/main/llm/openai-compat-client";
import type { ActiveModel } from "../src/main/provider/types";
import type { LLMEvent } from "../src/main/llm/adapter";

const URL_ = process.env.MONET_LIVE_URL ?? "http://127.0.0.1:17190/v1";
const MODEL = process.env.MONET_LIVE_MODEL ?? "";
/** Deliberately far shorter than the prefill it has to survive. */
const WATCHDOG_SEC = 20;
/** How long to watch before calling it a pass. */
const OBSERVE_MS = 75_000;

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};

const endpoint = (over: Partial<ActiveModel> = {}): ActiveModel => ({
  id: "live",
  name: "Monet Local",
  kind: "monet-local",
  apiKey: "",
  baseURL: URL_,
  model: MODEL,
  maxTokens: 16,
  contextLimit: 36_352,
  ...over,
});

// ─── What goes on the wire ──────────────────────────────────────────────
// Checked without a server: only a local endpoint is asked to narrate its
// prefill. A remote API that does not know the field would at best ignore it.
{
  const body = (p: Partial<ActiveModel>): Record<string, unknown> =>
    (
      new OpenAICompatClient(endpoint(p)) as unknown as {
        buildBody: (r: unknown, s: boolean) => Record<string, unknown>;
      }
    ).buildBody(
      { model: "m", system: "", messages: [], max_tokens: 8 },
      true,
    );

  check("a local endpoint asks for prefill progress", body({}).return_progress === true);
  check(
    "an API is not asked",
    body({ kind: "openai", baseURL: "https://api.openai.com/v1" }).return_progress ===
      undefined,
  );
  check(
    "and a non-streaming call never is",
    (
      new OpenAICompatClient(endpoint()) as unknown as {
        buildBody: (r: unknown, s: boolean) => Record<string, unknown>;
      }
    ).buildBody({ model: "m", system: "", messages: [], max_tokens: 8 }, false)
      .return_progress === undefined,
  );
}

async function live(): Promise<void> {
  if (!MODEL) {
    console.log("\nSKIPPED the live half: set MONET_LIVE_MODEL to a loaded model.");
    return;
  }

  // Long enough that the prefill cannot finish inside the watchdog: at the
  // ten tokens a second measured on this machine, six thousand tokens is ten
  // minutes of reading.
  const filler =
    "The quick brown fox jumps over the lazy dog near the river bank while the old miller counts sacks of flour. ".repeat(
      260,
    );

  const client = new OpenAICompatClient(endpoint({ streamTimeoutSec: WATCHDOG_SEC }));
  const events: LLMEvent[] = [];
  const stop = new AbortController();
  const t0 = Date.now();

  const run = client.stream(
    {
      model: MODEL,
      system: "",
      messages: [{ role: "user", content: `${filler}\n\nReply with OK.` }],
      max_tokens: 16,
    },
    (e) => events.push(e),
    stop.signal,
  );

  await new Promise((r) => setTimeout(r, OBSERVE_MS));

  const progress = events.filter((e) => e.type === "prompt_progress");
  const errors = events.filter((e) => e.type === "error");
  const elapsed = Date.now() - t0;

  check(
    `the prefill is narrated (${progress.length} chunks in ${Math.round(elapsed / 1000)}s)`,
    progress.length >= 3,
    progress.length,
  );
  // The whole point: the connection outlived a watchdog set to a fraction of
  // the prefill, because the progress chunks are bytes and bytes rearm it.
  check(
    `no timeout, with the watchdog at ${WATCHDOG_SEC}s and ${Math.round(elapsed / 1000)}s elapsed`,
    errors.length === 0,
    errors,
  );
  const last = progress[progress.length - 1];
  if (last && last.type === "prompt_progress") {
    check("and it is climbing", last.processed > 0, last);
    check("towards a total it knows", last.total > last.processed, last);
  }

  // Stop must reach the SERVER, not just the reader: a cancelled reader
  // leaves llama.cpp holding a slot for an answer nobody is listening to.
  //
  // Not instant, and it cannot be: llama.cpp notices a dropped client only
  // between prompt batches, so the wait is one batch — about three seconds at
  // the `-b 32` this machine is configured with, and the best part of a
  // minute at 512. Measured rather than asserted tightly, because the number
  // belongs to the user's batch size, not to this code.
  stop.abort();
  await run.catch(() => {});
  const freeBy = Date.now() + 45_000;
  let freedAfter = -1;
  const slotsUrl = `${URL_.replace(/\/v1$/, "")}/slots?model=${encodeURIComponent(MODEL)}`;
  const abortedAt = Date.now();
  while (Date.now() < freeBy) {
    try {
      const slots = (await fetch(slotsUrl).then((r) => r.json())) as {
        is_processing?: boolean;
      }[];
      if (slots[0]?.is_processing === false) {
        freedAfter = Date.now() - abortedAt;
        break;
      }
    } catch {
      /* the router is busy answering; ask again */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  check(
    `Stop reaches the server and frees the slot (${(freedAfter / 1000).toFixed(1)}s)`,
    freedAfter >= 0,
    freedAfter,
  );
}

void live().then(() => {
  console.log(failures ? `\n${failures} FAILED` : "\nALL LIVE TIMEOUT CHECKS PASSED");
  process.exit(failures ? 1 : 0);
});
