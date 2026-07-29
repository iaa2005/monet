/**
 * Where the "Stopped" badge lands.
 *
 * Reported live: the badge appeared on the PREVIOUS answer — above the user's
 * own new message — instead of on the turn that was actually stopped.
 *
 * Cause: stopping a turn before it emits text leaves an empty assistant
 * message. `markInterrupted` filters empty assistant messages out, then looked
 * for "the last assistant message" across the WHOLE transcript. With this
 * turn's message gone, that search walked past the user's prompt and stamped
 * the reply from the turn before, which had finished normally.
 *
 * Check 1 is that exact transcript and fails on the old code. Check 5 covers
 * the second half: the standalone note was written out as prose and so lacked
 * the marker's leading blank line, which is what the badge test looks for — it
 * rendered as literal text with an emoji rather than a badge.
 */

import { INTERRUPT_MARK, markInterrupted } from "../src/renderer/stores/chatStore";
import type { ChatMessage } from "../src/renderer/types/chat";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

let seq = 0;
const m = (
  role: ChatMessage["role"],
  content: string,
  over: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: `m${++seq}`,
  role,
  content,
  timestamp: seq,
  ...over,
});

/** What ChatView uses to decide whether to draw the badge. */
const badged = (msg: ChatMessage): boolean => msg.content.includes(INTERRUPT_MARK);

// ── 1. The reported transcript ────────────────────────────────────────
{
  const prior = m("assistant", "PDF-документ уже готов в sandbox. Что дальше?");
  const out = markInterrupted([
    m("user", "Сделай PDF"),
    prior,
    m("user", "Загрузи в Dropbox"),
    m("assistant", "", { isStreaming: true }),
  ]);

  const priorNow = out.find((x) => x.id === prior.id)!;
  check(
    "the previous answer is left alone",
    !badged(priorNow),
    JSON.stringify(priorNow.content.slice(-40)),
  );
  check(
    "its text is not modified at all",
    priorNow.content === prior.content,
    JSON.stringify(priorNow.content.slice(-40)),
  );
  const marked = out.filter(badged);
  check("exactly one message carries the badge", marked.length === 1, marked.length);
  check(
    "and it sits after the user's new prompt",
    out.indexOf(marked[0]!) > out.findIndex((x) => x.content === "Загрузи в Dropbox"),
    JSON.stringify(out.map((x) => `${x.role}:${x.content.slice(0, 12)}`)),
  );
}

// ── 2. Stopped after the turn had written something ───────────────────
{
  const out = markInterrupted([
    m("user", "hi"),
    m("assistant", "Here is the first half", { isStreaming: true }),
  ]);
  check("marks the answer it interrupted", badged(out[1]!), JSON.stringify(out[1]!.content));
  check("keeping the text it had already written", out[1]!.content.startsWith("Here is the first half"));
  check("no extra note is appended", out.length === 2, out.length);
}

// ── 3. Stopped mid-tools, after earlier text in the SAME turn ─────────
{
  const out = markInterrupted([
    m("user", "build it"),
    m("assistant", "Running the build now"),
    m("tool", "npm run build"),
    m("assistant", "", { isStreaming: true }),
  ]);
  const marked = out.filter(badged);
  check("a tool message does not hide this turn's answer", marked.length === 1, marked.length);
  check(
    "the mark goes on this turn's text, not a new note",
    marked[0]!.content.startsWith("Running the build now"),
    JSON.stringify(marked[0]!.content),
  );
}

// ── 4. Stopped mid-tools with no text in this turn ────────────────────
{
  const prior = m("assistant", "Done with the last task.");
  const out = markInterrupted([
    prior,
    m("user", "now deploy"),
    m("tool", "kubectl apply"),
    m("assistant", "", { isStreaming: true }),
  ]);
  check("the earlier turn stays clean", !badged(out.find((x) => x.id === prior.id)!));
  check("a standalone note is added instead", badged(out[out.length - 1]!));
  check("as an assistant message", out[out.length - 1]!.role === "assistant");
}

// ── 5. The note must render as a badge, not as text ───────────────────
{
  const out = markInterrupted([m("user", "go"), m("assistant", "", { isStreaming: true })]);
  const note = out[out.length - 1]!;
  check("the standalone note passes the badge test", badged(note), JSON.stringify(note.content));
  // stripInterrupt() removes the marker before rendering; what is left is what
  // the user actually reads. A bare note should leave nothing but the badge.
  const visible = note.content.endsWith(INTERRUPT_MARK)
    ? note.content.slice(0, -INTERRUPT_MARK.length)
    : note.content;
  check("and leaves no stray prose behind it", visible === "", JSON.stringify(visible));
}

// ── 6. Stopping twice must not stack marks ────────────────────────────
{
  const once = markInterrupted([m("user", "hi"), m("assistant", "partial", { isStreaming: true })]);
  const twice = markInterrupted(once);
  const count = (s: string): number => s.split(INTERRUPT_MARK).length - 1;
  check("the mark is not doubled", count(twice[1]!.content) === 1, count(twice[1]!.content));
  check("and no second note appears", twice.length === once.length, `${once.length} → ${twice.length}`);
}
{
  // Same, for the standalone-note shape.
  const once = markInterrupted([m("user", "go"), m("assistant", "", { isStreaming: true })]);
  const twice = markInterrupted(once);
  check("a bare note is not duplicated", twice.length === once.length, `${once.length} → ${twice.length}`);
}

// ── 7. Housekeeping the old version also did ──────────────────────────
{
  const out = markInterrupted([
    m("user", "hi"),
    m("assistant", "text", { isStreaming: true }),
    m("assistant", "", { isStreaming: true }),
  ]);
  check("empty assistant messages are dropped", out.every((x) => x.content !== ""), out.length);
  check("nothing is left streaming", out.every((x) => !x.isStreaming));
}
{
  // No user message at all (a resumed or seeded transcript) must not crash.
  const out = markInterrupted([m("assistant", "orphan text")]);
  check("a transcript with no user message still marks something", out.some(badged));
}
check("an empty transcript yields just the note", markInterrupted([]).length === 1);

console.log(failures ? `\n${failures} FAILED` : "\nALL INTERRUPT CHECKS PASSED");
process.exit(failures ? 1 : 0);
