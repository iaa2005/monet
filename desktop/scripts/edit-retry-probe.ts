/**
 * "Rewind to here" — the button under a prompt that puts the folder back and
 * hands the prompt to the composer to edit and resend.
 *
 * It is the only place where a file restore and a transcript truncation have
 * to happen in one order, and the order is the whole point:
 *
 *   - the checkpoint it restores to is the one from BEFORE this turn, which
 *     is the previous message's, not this one's. Off by one turn and it
 *     reverts the work the user wanted to keep, or none of it;
 *   - when the restore FAILS, nothing is truncated. Throwing away the
 *     conversation after failing to put the files back leaves the user with
 *     neither;
 *   - the first turn has no earlier checkpoint, so it truncates without
 *     restoring rather than refusing.
 *
 * Drives the real chatStore with a stubbed bridge, so what is checked is the
 * sequence the app actually sends.
 *
 *   npm run smoke:editretry
 */

import { useChatStore } from "@/stores/chatStore";

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

// ─── Stub the preload bridge ────────────────────────────────────────────

const rewinds: { sessionId: string; sha: string }[] = [];
const truncations: {
  sessionId: string;
  beforePromptId: string;
}[] = [];
let rewindOk = true;
/** Make the transcript's turns unaddressable — bound to no bubble on screen,
 * like a chat whose prompts predate id binding. */
let unanchored = false;

const bridge = {
  checkpoints: {
    rewind: async (sessionId: string, sha: string) => {
      rewinds.push({ sessionId, sha });
      return rewindOk
        ? { ok: true, restored: 2, deleted: 1, skipped: [] }
        : { ok: false, error: "another folder owns this store" };
    },
    diffStat: async () => null,
  },
  chat: {
    rewindTranscript: async (sessionId: string, beforePromptId: string) => {
      truncations.push({ sessionId, beforePromptId });
      return { ok: true as const, removed: 2 };
    },
    // What the transcript says its prompts are. The rewind asks this BEFORE
    // touching anything, so a prompt with no bound turn costs nothing instead
    // of leaving the folder in one turn's state and the conversation in
    // another's. Normally every prompt on screen is bound, which is what
    // `unanchored` exists to break.
    turnContext: async () => {
      const mine = useChatStore
        .getState()
        .messages.filter((m) => m.role === "user" && !m.injected)
        .map((m) => ({ id: m.id, inContext: true }));
      return unanchored
        ? mine.map((_m, i) => ({ id: `legacy-${i}`, inContext: true }))
        : mine;
    },
    send: async () => ({ ok: true }),
  },
  artifacts: {
    readText: async () => ({ ok: false as const }),
    readBytes: async () => ({ ok: false as const }),
  },
  sessions: { getById: async () => null, save: async () => {} },
};

(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { electronAPI: unknown }).electronAPI = bridge;
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

// ─── Three turns, each leaving its checkpoint ───────────────────────────

/** One complete turn: the prompt, a reply, and the snapshot taken after it. */
function turn(text: string, sha: string, session = "s1"): string {
  const store = useChatStore.getState();
  const msg = store.addUserMessage(text);
  useChatStore.getState().startStreaming();
  useChatStore
    .getState()
    .handleLLMEvent(session, { type: "text_delta", text: `re: ${text}` });
  useChatStore.getState().handleLLMEvent(session, { type: "checkpoint", sha });
  useChatStore
    .getState()
    .handleLLMEvent(session, { type: "message_stop", stop_reason: "end_turn" });
  useChatStore.getState().finishStreaming();
  return msg.id;
}

useChatStore.getState().setCurrentSessionId("s1");
const first = turn("write the parser", "sha-after-1");
const second = turn("now add tests", "sha-after-2");
const third = turn("and a benchmark", "sha-after-3");

{
  const msgs = useChatStore.getState().messages;
  check("three turns are on screen", msgs.length === 6, msgs.map((m) => m.role));
  check(
    "and each assistant message carries its checkpoint",
    msgs.filter((m) => m.checkpointSha).length === 3,
    msgs.map((m) => m.checkpointSha),
  );
}

// ─── Rewinding to the LAST prompt ───────────────────────────────────────

{
  await useChatStore.getState().rewindAndEdit(third);
  check(
    "it restores the checkpoint from before that turn",
    rewinds.length === 1 && rewinds[0].sha === "sha-after-2",
    rewinds,
  );
  check(
    "…not the one that turn itself left",
    rewinds[0]?.sha !== "sha-after-3",
    rewinds[0],
  );
  check(
    "the transcript is cut just before the prompt being edited",
    truncations.length === 1 && truncations[0].beforePromptId === third,
    truncations,
  );
  const msgs = useChatStore.getState().messages;
  check("the screen is cut to the same place", msgs.length === 4, msgs.length);
  check(
    "and the prompt is in the composer to edit",
    useChatStore.getState().composerDraft === "and a benchmark",
    useChatStore.getState().composerDraft,
  );
}

// ─── A restore that fails must not take the conversation with it ────────

{
  rewinds.length = 0;
  truncations.length = 0;
  rewindOk = false;
  const before = useChatStore.getState().messages.length;

  await useChatStore.getState().rewindAndEdit(second);

  check("it tried to restore", rewinds.length === 1, rewinds);
  check(
    "THE TRANSCRIPT IS NOT TRUNCATED WHEN THE FILES COULD NOT BE PUT BACK",
    truncations.length === 0,
    truncations,
  );
  check(
    "…nor is the screen",
    useChatStore.getState().messages.length === before,
    { now: useChatStore.getState().messages.length, was: before },
  );
  check(
    "…and the failure is shown rather than swallowed",
    /another folder/.test(useChatStore.getState().error ?? ""),
    useChatStore.getState().error,
  );
  rewindOk = true;
}

// ─── The first turn has nothing to restore to ───────────────────────────

{
  rewinds.length = 0;
  truncations.length = 0;
  await useChatStore.getState().rewindAndEdit(first);
  check(
    "the first prompt rewinds without a checkpoint instead of refusing",
    rewinds.length === 0,
    rewinds,
  );
  check(
    "…and still truncates to nothing",
    truncations.length === 1 && truncations[0].beforePromptId === first,
    truncations,
  );
  check(
    "…and still offers the prompt for editing",
    useChatStore.getState().composerDraft === "write the parser",
    useChatStore.getState().composerDraft,
  );
  check("the chat is empty", useChatStore.getState().messages.length === 0);
}

// ─── What it must refuse ────────────────────────────────────────────────

{
  rewinds.length = 0;
  truncations.length = 0;
  useChatStore.getState().setCurrentSessionId("s2");
  const p = turn("something", "sha-s2", "s2");
  const assistantId = useChatStore.getState().messages[1].id;

  await useChatStore.getState().rewindAndEdit(assistantId);
  check(
    "an assistant message is not a prompt to rewind to",
    rewinds.length === 0 && truncations.length === 0,
    { rewinds, truncations },
  );

  useChatStore.getState().startStreaming();
  await useChatStore.getState().rewindAndEdit(p);
  check(
    "and it refuses while the model is still answering",
    truncations.length === 0,
    truncations,
  );
  useChatStore.getState().finishStreaming();
}

// ─── AN UNANCHORED PROMPT COSTS NOTHING, INSTEAD OF COSTING THE HISTORY ─
//
// A prompt sent before bubble ids were bound to transcript turns has no
// anchor to cut at. The count-based ancestor of this check was chat-wide:
// one harness note folded into a user-role message anywhere and EVERY rewind
// in the chat refused, forever. The anchor is per-prompt, and it is asked
// first — the refusal stops the whole operation before the folder, the
// transcript or the screen has moved.
{
  rewinds.length = 0;
  truncations.length = 0;
  useChatStore.getState().setCurrentSessionId("s3");
  const only = turn("one prompt", "sha-s3", "s3");
  // The transcript has turns, but none of them is bound to this bubble.
  unanchored = true;
  const before = useChatStore.getState().messages.length;

  await useChatStore.getState().rewindAndEdit(only);
  check(
    "NOTHING IS UNDONE WHEN THE PROMPT HAS NO BOUND TURN",
    rewinds.length === 0 && truncations.length === 0,
    { rewinds, truncations },
  );
  check(
    "…and the screen is left exactly as it was",
    useChatStore.getState().messages.length === before,
    { now: useChatStore.getState().messages.length, was: before },
  );
  check(
    "…and it says so rather than doing something else",
    /no model-facing turn/.test(useChatStore.getState().error ?? ""),
    useChatStore.getState().error,
  );
}

console.log(
  failures ? `\n${failures} FAILED` : "\nREWIND-AND-EDIT KEEPS ITS ORDER",
);
process.exit(failures ? 1 : 0);
