/**
 * The working row's label and clock.
 *
 * The row used to read `Working…` and nothing else, so a turn that had been
 * stuck for six minutes and one making steady progress rendered identically.
 * These checks pin the three things it now claims to know — what is running,
 * for how long, and that it degrades to filler only when there is genuinely
 * nothing factual to say.
 *
 * The filler rotation is the part worth testing rather than eyeballing: it is
 * derived arithmetic (elapsed / 5s + seed) with a modulo that must stay in
 * range for every input, including the negative elapsed a clock adjustment can
 * produce.
 */

import {
  formatElapsed,
  runningCalls,
  workingLabel,
} from "../src/renderer/components/chat/WorkingIndicator";
import type { ChatMessage, ToolCall } from "../src/renderer/types/chat";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const call = (over: Partial<ToolCall> = {}): ToolCall => ({
  id: "t1",
  name: "Bash",
  input: {},
  status: "running",
  ...over,
});

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  role: "assistant",
  content: "",
  timestamp: 0,
  ...over,
});

// ── Elapsed formatting ────────────────────────────────────────────────
check("0s at the start", formatElapsed(0) === "0s", formatElapsed(0));
check("seconds under a minute", formatElapsed(38_000) === "38s", formatElapsed(38_000));
check("rounds down, never up", formatElapsed(59_999) === "59s", formatElapsed(59_999));
check("switches to minutes at 60s", formatElapsed(60_000) === "1m", formatElapsed(60_000));
check("minutes and seconds", formatElapsed(421_000) === "7m 1s", formatElapsed(421_000));
check("drops a zero seconds part", formatElapsed(120_000) === "2m", formatElapsed(120_000));
// A backwards clock (NTP step, sleep/wake) must not render "-3s".
check("never goes negative", formatElapsed(-5_000) === "0s", formatElapsed(-5_000));

// ── A running tool always beats filler ────────────────────────────────
{
  const l = workingLabel([call({ name: "Bash", input: { command: "npm run build" } })], 0, 0);
  check("names the command being run", l === "Running command · npm run build", l);
}
{
  const l = workingLabel(
    [call({ name: "Read", input: { file_path: "D:\\Projects\\claude-code\\desktop\\src\\app.ts" } })],
    0,
    0,
  );
  check("shows a file's basename, not its full path", l === "Reading · app.ts", l);
}
{
  const l = workingLabel([call({ name: "Grep", input: { pattern: "orphanedMachine" } })], 0, 0);
  check("shows a grep pattern", l === "Searching · orphanedMachine", l);
}
{
  // Unknown tools (MCP servers ship their own) must still render.
  const l = workingLabel([call({ name: "mcp__figma__get_metadata", input: {} })], 0, 0);
  check("falls back to the raw tool name", l === "mcp__figma__get_metadata", l);
}
{
  const long = "x".repeat(200);
  const l = workingLabel([call({ name: "Bash", input: { command: long } })], 0, 0);
  const arg = l.split(" · ")[1] ?? "";
  check(
    "truncates a long argument to one line",
    arg.length <= 44 && arg.endsWith("…"),
    `${arg.length} chars of argument`,
  );
}
{
  const l = workingLabel([call({ id: "a" }), call({ id: "b" }), call({ id: "c" })], 0, 0);
  check("counts parallel tools instead of naming one", l === "Running 3 tools", l);
}
{
  // A multi-line command would otherwise break the row's layout.
  const l = workingLabel([call({ input: { command: "git add -A\ngit commit" } })], 0, 0);
  check("collapses newlines in the preview", !l.includes("\n"), JSON.stringify(l));
}

// ── Filler, only when nothing is running ──────────────────────────────
{
  // The real property is two DISJOINT vocabularies that swap at the minute
  // mark — sample each side across many windows and seeds rather than pinning
  // one phrase, which would only test that I copied a string correctly.
  const sample = (from: number, to: number): Set<string> => {
    const out = new Set<string>();
    for (let ms = from; ms < to; ms += 2_500)
      for (const seed of [0, 1, 2, 3, 4]) out.add(workingLabel([], ms, seed));
    return out;
  };
  const early = sample(0, 60_000);
  const late = sample(60_000, 300_000);
  check("early filler is a plain verb", workingLabel([], 0, 0) === "Working");
  check(
    "the two vocabularies never overlap",
    [...late].every((w) => !early.has(w)),
    JSON.stringify([...late].filter((w) => early.has(w))),
  );
  check(
    "past a minute every phrase acknowledges the wait",
    [...late].every((w) => /still|yet|time|through/i.test(w)),
    JSON.stringify([...late]),
  );
  check("the switch happens exactly at 60s", workingLabel([], 59_999, 0) !== workingLabel([], 60_000, 0));
}
{
  // The word must actually change, or this is the old static row with a clock.
  const seen = new Set<string>();
  for (let s = 0; s < 40; s += 5) seen.add(workingLabel([], s * 1000, 0));
  check("the filler rotates over time", seen.size >= 4, `${seen.size} distinct in 40s`);
}
{
  // Within one 5s window the label must be stable — a word that changed every
  // render tick would flicker once a second.
  const a = workingLabel([], 6_000, 0);
  const b = workingLabel([], 9_999, 0);
  check("but holds steady inside one window", a === b, `${a} / ${b}`);
  check("and moves on at the boundary", workingLabel([], 10_000, 0) !== a);
}
{
  // Every seed and every elapsed must land on a real word: a negative modulo
  // would return undefined and blank the row.
  let bad = 0;
  for (const seed of [0, 1, 7, 1e12, 1_772_000_000_000]) {
    for (const ms of [-9_000, 0, 3_000, 61_000, 3_600_000]) {
      const l = workingLabel([], ms, seed);
      if (typeof l !== "string" || !l.length) bad++;
    }
  }
  check("never produces an empty label", bad === 0, `${bad} bad`);
}
{
  const seeds = new Set([0, 1, 2, 3].map((s) => workingLabel([], 0, s)));
  check("different chats start on different words", seeds.size > 1, `${seeds.size} distinct`);
}

// ── Which calls count as running ──────────────────────────────────────
{
  const messages = [
    msg({ id: "1", toolCall: call({ id: "done", status: "done" }) }),
    msg({ id: "2", toolCall: call({ id: "err", status: "error" }) }),
    msg({ id: "3", toolCall: call({ id: "run", status: "running" }) }),
    msg({ id: "4", toolCall: call({ id: "wait", status: "pending" }) }),
    msg({ id: "5", content: "hello" }),
  ];
  const r = runningCalls(messages);
  check(
    "counts running and pending, not finished ones",
    r.map((c) => c.id).join(",") === "run,wait",
    JSON.stringify(r.map((c) => c.id)),
  );
  check("an empty transcript yields nothing", runningCalls([]).length === 0);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL WORKING-INDICATOR CHECKS PASSED");
process.exit(failures ? 1 : 0);
