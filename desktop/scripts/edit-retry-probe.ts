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
  keepUserTurns: number;
  totalUserTurns?: number;
}[] = [];
let rewindOk = true;

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
    rewindTranscript: async (
      sessionId: string,
      keepUserTurns: number,
      totalUserTurns?: number,
    ) => {
      truncations.push({ sessionId, keepUserTurns, totalUserTurns });
      return { fidelity: "full" as const, removed: 2 };
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
    "the transcript is cut to the turns kept",
    truncations.length === 1 && truncations[0].keepUserTurns === 2,
    truncations,
  );
  check(
    "…and it says how many turns the CHAT has, so main can spot a compaction",
    truncations[0]?.totalUserTurns === 3,
    truncations[0],
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
    truncations.length === 1 && truncations[0].keepUserTurns === 0,
    truncations,
  );
  check(
    "…and still offers the prompt for editing",
    useChatStore.getState().composerDraft === "write the parser",
    useChatStore.getState().composerDraft,
  );
  check("the chat is empty", useChatStore.getState().messages.length === 0);
}

// ─── The picker's rewind: to a checkpoint, keeping the turn ─────────────
//
// Same two steps, opposite ends. rewindAndEdit removes the turn and offers
// the prompt back; rewindTo (the checkpoint picker) restores THAT snapshot
// and keeps everything up to and including it. Confusing them either loses
// a turn nobody asked to lose or restores one turn too few.

{
  useChatStore.getState().setCurrentSessionId("s3");
  // The previous block left a prompt in the box; this path must not add one.
  useChatStore.getState().setComposerDraft("");
  turn("one", "sha-1", "s3");
  turn("two", "sha-2", "s3");
  const msgs = useChatStore.getState().messages;
  const secondReply = msgs[3];
  rewinds.length = 0;
  truncations.length = 0;

  await useChatStore.getState().rewindTo(secondReply.id);
  check(
    "the picker restores the checkpoint it was pointed at",
    rewinds.length === 1 && rewinds[0].sha === "sha-2",
    rewinds,
  );
  check(
    "…and keeps the turn that made it",
    useChatStore.getState().messages.length === 4,
    useChatStore.getState().messages.length,
  );
  check(
    "…truncating the transcript to the same place",
    truncations.length === 1 && truncations[0].keepUserTurns === 2,
    truncations,
  );
  check(
    "…and leaves the composer alone — this one is not an edit",
    useChatStore.getState().composerDraft === "",
    useChatStore.getState().composerDraft,
  );

  rewindOk = false;
  truncations.length = 0;
  await useChatStore.getState().rewindTo(secondReply.id);
  check(
    "it too refuses to truncate after a failed restore",
    truncations.length === 0,
    truncations,
  );
  rewindOk = true;
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

console.log(
  failures ? `\n${failures} FAILED` : "\nREWIND-AND-EDIT KEEPS ITS ORDER",
);
process.exit(failures ? 1 : 0);
