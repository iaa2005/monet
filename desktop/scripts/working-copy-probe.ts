/**
 * When the chat says it is working, and when it offers to copy.
 *
 * Both were reported wrong in the same screenshot: a model writing a large
 * file streams its tool INPUT for minutes with no visible text, and the old
 * rule ("the last assistant message is flagged streaming and has content")
 * read that as text arriving — so the Working row vanished and a Copy button
 * appeared under a half-finished turn while the stop button was still red.
 *
 * The logic lives in chat/turn-state.ts precisely so it can be asserted
 * without a browser: these are decisions about a data shape, not about pixels.
 */

import {
  copyTargets,
  shouldShowWorking,
  type TurnItem,
} from "../src/renderer/components/chat/turn-state";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

const said = (content: string): TurnItem => ({
  kind: "message",
  role: "assistant",
  content,
});
const asked = (content: string): TurnItem => ({
  kind: "message",
  role: "user",
  content,
});
const tools = (): TurnItem => ({ kind: "other" });

// ── 1. Working: the signal is text GROWTH, not a streaming flag ───────
{
  check(
    "an idle chat shows no working row",
    !shouldShowWorking({ streaming: false, textFlowing: false }),
  );
  check(
    "a run that has produced nothing yet shows one",
    shouldShowWorking({ streaming: true, textFlowing: false }),
  );
  check(
    "text actively arriving replaces it with the text",
    !shouldShowWorking({ streaming: true, textFlowing: true }),
  );
  // The reported bug: the message is flagged streaming and HAS content, but
  // nothing has grown for a while — the tokens are going into a tool input.
  // That is working, not writing.
  check(
    "a long tool input after some text still counts as working",
    shouldShowWorking({ streaming: true, textFlowing: false }),
  );
  check(
    "and a finished run never shows it, whatever the text did",
    !shouldShowWorking({ streaming: false, textFlowing: true }),
  );
}

// ── 2. Copy belongs to a FINISHED turn ────────────────────────────────
{
  const turn: TurnItem[] = [asked("do it"), said("done"), tools()];
  check(
    "a finished turn offers copy under its last item",
    copyTargets(turn, false).get(2) === "done",
    JSON.stringify([...copyTargets(turn, false)]),
  );
  check(
    "the same turn offers nothing while it is still running",
    copyTargets(turn, true).size === 0,
    JSON.stringify([...copyTargets(turn, true)]),
  );

  // Only the LAST turn is unfinished — earlier ones keep their button.
  const two: TurnItem[] = [
    asked("first"),
    said("first answer"),
    asked("second"),
    said("second answer"),
  ];
  const mid = copyTargets(two, true);
  check(
    "an earlier turn keeps its copy button while a new one runs",
    mid.get(1) === "first answer",
    JSON.stringify([...mid]),
  );
  check("and the running turn has none", !mid.has(3), JSON.stringify([...mid]));

  check(
    "several assistant messages in one turn copy as one block",
    copyTargets([asked("q"), said("a"), tools(), said("b")], false).get(3) ===
      "a\n\nb",
    JSON.stringify([...copyTargets([asked("q"), said("a"), tools(), said("b")], false)]),
  );
  check(
    "a turn with no assistant text has nothing to copy",
    copyTargets([asked("hi")], false).size === 0,
  );
  check("an empty chat has nothing to copy", copyTargets([], false).size === 0);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL WORKING/COPY CHECKS PASSED");
process.exit(failures ? 1 : 0);
