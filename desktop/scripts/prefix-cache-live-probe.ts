/**
 * Where the volatile blocks sit, measured against a real server.
 *
 * A server reuses its KV cache for the longest common PREFIX of the token
 * sequence, so what a changed block costs is not its own size — it is the
 * size of everything standing after it. `buildDirectives` put the browser
 * state and the deferred-tool inventory at the very FRONT of the system
 * prompt, ahead of the vendor prompt, the app's own blocks and the entire
 * conversation. Both are rebuilt constantly: the browser block from a
 * dev-server scan that refreshes every sixty seconds, the inventory the
 * moment ToolSearch reveals a tool.
 *
 * Measured on Qwen3.8-27B, a 1,763-token prompt, changing one line:
 *
 *   at the front of the system prompt    23 / 1763 reused — 99% re-read
 *   at the end of the system prompt    1732 / 1763 reused —  2% re-read
 *   at the tail of the messages        1740 / 1767 reused —  2% re-read
 *
 * On the real prompt, at the ten tokens a second this machine reads at, 99%
 * of 11,660 tokens is nineteen minutes. Per turn. Because a port scan came
 * back.
 *
 * This probe is that experiment, kept runnable:
 *
 *   MONET_LIVE_URL=http://127.0.0.1:17190/v1 \
 *   MONET_LIVE_MODEL=qwen3.8-27b-q4_k_m \
 *   npm run smoke:prefix
 *
 * It is slow — three full prefills of a cold prompt, several minutes — and
 * skipped, loudly, without a model to talk to.
 */

const URL_ = process.env.MONET_LIVE_URL ?? "http://127.0.0.1:17190/v1";
const MODEL = process.env.MONET_LIVE_MODEL ?? "";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};

/** Stands in for the vendor prompt and the app's blocks: large and stable. */
const STABLE =
  "You are an agent inside a desktop application. " +
  "Work carefully, read before you write, and say what you did. ".repeat(120);
const VOLATILE_A = "Open in the Browser panel: http://localhost:5173 (Vite).";
const VOLATILE_B = "Open in the Browser panel: http://localhost:3000 (Next).";

interface Progress {
  total: number;
  cache: number;
}

async function ask(
  messages: { role: string; content: string }[],
): Promise<Progress> {
  const res = await fetch(`${URL_}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      // The only way to see the cache from outside: every progress chunk
      // carries how many prompt tokens did NOT have to be read.
      return_progress: true,
      max_tokens: 1,
      messages,
    }),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: Progress = { total: 0, cache: 0 };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const p = (JSON.parse(payload) as { prompt_progress?: Progress })
          .prompt_progress;
        if (p) {
          out.total = p.total ?? out.total;
          out.cache = p.cache ?? out.cache;
        }
      } catch {
        /* a chunk that is not progress */
      }
    }
  }
  return out;
}

/** Ask twice, changing only the volatile line, and report the second. */
async function reuse(
  build: (volatile: string) => { role: string; content: string }[],
): Promise<Progress> {
  await ask(build(VOLATILE_A));
  return ask(build(VOLATILE_B));
}

async function main(): Promise<void> {
  if (!MODEL) {
    console.log("SKIPPED: set MONET_LIVE_MODEL to a loaded model.");
    return;
  }
  const user = { role: "user", content: "Say OK." };

  const front = await reuse((v) => [
    { role: "system", content: `${v}\n\n${STABLE}` },
    user,
  ]);
  const tail = await reuse((v) => [
    { role: "system", content: STABLE },
    user,
    { role: "user", content: v },
  ]);

  const pct = (p: Progress): number =>
    Math.round((100 * (p.total - p.cache)) / p.total);
  console.log(`  front of system: ${front.cache}/${front.total} reused — ${pct(front)}% re-read`);
  console.log(`  message tail:    ${tail.cache}/${tail.total} reused — ${pct(tail)}% re-read`);

  // The failure being guarded is total: a line at the front throws the whole
  // prompt away. Anything under half re-read is the cache doing its job.
  check("at the front, the prompt is re-read wholesale", pct(front) > 90, pct(front));
  check("at the tail, it is not", pct(tail) < 10, pct(tail));
  check(
    "which is the entire reason turnTailBlocks exists",
    tail.cache > front.cache * 10,
    { front: front.cache, tail: tail.cache },
  );
}

void main().then(() => {
  console.log(failures ? `\n${failures} FAILED` : "\nALL PREFIX-CACHE CHECKS PASSED");
  process.exit(failures ? 1 : 0);
});
