/**
 * A harness line must never land between a tool call and its result.
 *
 * Reported from a real run, twice in one session:
 *
 *   API 400: messages.16: `tool_use` ids were found without `tool_result`
 *   blocks immediately after: call_00_bdbyfzsVVMbz3HrEOq3M6602
 *
 * The cause was a reconnaissance note written one statement too early — at
 * that point the last message in the array is the assistant's, carrying
 * this turn's tool_use blocks, and a harness line pushed there becomes a
 * user message BETWEEN the call and its result. The next request is
 * refused outright, and the 400 says nothing about the line that caused it.
 *
 * Three of these notes exist (the empty-reply nudge, the step-budget
 * warning, the recon hand-over) and more will be added, so the rule is
 * enforced where it cannot be forgotten: appendUserText REFUSES that shape.
 * A lost sentence costs a sentence; a lost run costs the work.
 *
 *   npm run smoke:harnessnote
 */

import { appendUserText } from "../src/main/agent/empty-turn.js";
import {
  danglingToolIds,
  resultsOutOfPlace,
} from "../src/main/agent/turn-context.js";
import type { LLMMessage } from "../src/main/llm/adapter.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

const userText = (text: string): LLMMessage => ({ role: "user", content: text });
const assistantCall = (id: string): LLMMessage => ({
  role: "assistant",
  content: [
    { type: "text", text: "let me look" },
    { type: "tool_use", id, name: "Read", input: { file_path: "x" } },
  ],
});
const toolResult = (id: string): LLMMessage => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "contents" }],
});

// ─── The shape that broke a live run ────────────────────────────────────

{
  const msgs: LLMMessage[] = [userText("do the thing"), assistantCall("call_1")];
  const where = appendUserText(msgs, "[harness] out of looking turns");
  check("appending beside an unanswered tool call is REFUSED", where === "refused", where);
  check("…and nothing was added", msgs.length === 2, msgs.length);

  // The result arrives, and the transcript is whole.
  msgs.push(toolResult("call_1"));
  check(
    "so the transcript has no dangling call",
    danglingToolIds(msgs).uses.length === 0 && resultsOutOfPlace(msgs).length === 0,
    { dangling: danglingToolIds(msgs), misplaced: resultsOutOfPlace(msgs) },
  );
}

// ─── What it would have looked like without the guard ───────────────────

{
  // Hand-built, to state exactly what the provider rejected.
  const broken: LLMMessage[] = [
    userText("do the thing"),
    assistantCall("call_1"),
    userText("[harness] out of looking turns"),
    toolResult("call_1"),
  ];
  check(
    "THE OLD SHAPE IS DETECTABLY BROKEN — a call with no result after it",
    resultsOutOfPlace(broken).includes("call_1"),
    resultsOutOfPlace(broken),
  );
  check(
    "…and the presence check alone would have called it fine",
    danglingToolIds(broken).uses.length === 0,
    danglingToolIds(broken),
  );
}

// ─── Where the notes DO belong ──────────────────────────────────────────

{
  const msgs: LLMMessage[] = [
    userText("do the thing"),
    assistantCall("call_1"),
    toolResult("call_1"),
  ];
  const where = appendUserText(msgs, "[harness] 3 steps left");
  check("after the results, the line JOINS them", where === "merged", where);
  check("…without adding a message", msgs.length === 3, msgs.length);
  const last = msgs[2];
  check(
    "…as a text block beside the result",
    Array.isArray(last.content) &&
      last.content.some((b) => b.type === "tool_result") &&
      last.content.some((b) => b.type === "text"),
    last.content,
  );
  check(
    "…and the transcript is still whole",
    resultsOutOfPlace(msgs).length === 0,
  );
}

// ─── The other shapes it has always had to handle ───────────────────────

{
  const first: LLMMessage[] = [userText("hello")];
  check(
    "an empty first reply merges into the user's own prompt",
    appendUserText(first, ".") === "merged" && first.length === 1,
    first,
  );

  const afterText: LLMMessage[] = [
    userText("hi"),
    { role: "assistant", content: "here is the plan" },
  ];
  check(
    "after plain assistant TEXT it pushes — legal, and no call to orphan",
    appendUserText(afterText, "[harness] carry on") === "pushed",
    afterText.map((m) => m.role),
  );
  check(
    "…and that is still a whole transcript",
    resultsOutOfPlace(afterText).length === 0,
  );

  check("an empty list does not throw", appendUserText([], ".") === "pushed");
}

// ─── A parallel batch, which is where it bit hardest ────────────────────

{
  // The live failure named TWO ids on one message: a parallel tool batch.
  const msgs: LLMMessage[] = [
    userText("look at both"),
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_a", name: "Read", input: {} },
        { type: "tool_use", id: "call_b", name: "Grep", input: {} },
      ],
    },
  ];
  check(
    "a parallel batch is refused just the same",
    appendUserText(msgs, "[harness] note") === "refused",
  );
  msgs.push({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_a", content: "a" },
      { type: "tool_result", tool_use_id: "call_b", content: "b" },
    ],
  });
  check(
    "…and both results land together",
    resultsOutOfPlace(msgs).length === 0,
    resultsOutOfPlace(msgs),
  );
}

console.log(
  failures
    ? `\n${failures} FAILED`
    : "\nNO HARNESS LINE COMES BETWEEN A CALL AND ITS RESULT",
);
process.exit(failures ? 1 : 0);
